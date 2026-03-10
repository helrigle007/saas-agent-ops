import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';

const log = logger.child({ module: 'supabase' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  log.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — database operations will fail');
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder',
);

// PostgreSQL error code for "relation does not exist"
const RELATION_NOT_FOUND = '42P01';

export interface SafeResult<T> {
  data: T | null;
  tableExists: boolean;
  error: string | null;
}

/**
 * Insert rows with resilience to missing tables.
 * Returns { data, tableExists, error } instead of throwing.
 */
export async function safeInsert<T extends Record<string, unknown>>(
  table: string,
  rows: T | T[],
): Promise<SafeResult<T[]>> {
  try {
    const { data, error } = await supabase
      .from(table)
      .insert(Array.isArray(rows) ? rows : [rows])
      .select();

    if (error) {
      if (error.code === RELATION_NOT_FOUND) {
        log.warn({ table }, 'Table does not exist — skipping insert');
        return { data: null, tableExists: false, error: null };
      }
      log.error({ table, error: error.message }, 'Insert failed');
      return { data: null, tableExists: true, error: error.message };
    }

    return { data: data as T[], tableExists: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ table, error: message }, 'Insert threw exception');
    return { data: null, tableExists: true, error: message };
  }
}

/**
 * Select rows with resilience to missing tables.
 * Pass a query builder function for filters/ordering.
 */
export async function safeSelect<T>(
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryFn?: (query: any) => any,
): Promise<SafeResult<T[]>> {
  try {
    let query: unknown = supabase.from(table).select('*');
    if (queryFn) {
      query = queryFn(query);
    }

    const { data, error } = await (query as Promise<{ data: T[] | null; error: { code?: string; message: string } | null }>);

    if (error) {
      if (error.code === RELATION_NOT_FOUND) {
        log.warn({ table }, 'Table does not exist — returning empty');
        return { data: null, tableExists: false, error: null };
      }
      log.error({ table, error: error.message }, 'Select failed');
      return { data: null, tableExists: true, error: error.message };
    }

    return { data: data as T[], tableExists: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ table, error: message }, 'Select threw exception');
    return { data: null, tableExists: true, error: message };
  }
}

/**
 * Update rows with resilience to missing tables.
 */
export async function safeUpdate<T extends Record<string, unknown>>(
  table: string,
  values: Partial<T>,
  matchColumn: string,
  matchValue: unknown,
): Promise<SafeResult<T[]>> {
  try {
    const { data, error } = await supabase
      .from(table)
      .update(values)
      .eq(matchColumn, matchValue)
      .select();

    if (error) {
      if (error.code === RELATION_NOT_FOUND) {
        log.warn({ table }, 'Table does not exist — skipping update');
        return { data: null, tableExists: false, error: null };
      }
      log.error({ table, error: error.message }, 'Update failed');
      return { data: null, tableExists: true, error: error.message };
    }

    return { data: data as T[], tableExists: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ table, error: message }, 'Update threw exception');
    return { data: null, tableExists: true, error: message };
  }
}
