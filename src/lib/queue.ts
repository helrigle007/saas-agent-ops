import { safeInsert, safeSelect } from './supabase';
import { logger } from './logger';
import type { QueueItemInput, ReviewQueueRow } from '../types';

const log = logger.child({ module: 'queue' });

/**
 * Write an item to the admin_review_queue for human review.
 * Returns the queue item ID (or null if table doesn't exist).
 */
export async function queueForReview(input: QueueItemInput): Promise<string | null> {
  const row = {
    agent: input.agent,
    task_type: input.task_type,
    title: input.title,
    content: input.content,
    reasoning: input.reasoning ?? null,
    confidence: input.confidence ?? null,
    priority: input.priority ?? 'normal',
    source_url: input.source_url ?? null,
    expires_at: input.expires_at?.toISOString() ?? null,
  };

  log.info(
    {
      agent: input.agent,
      task_type: input.task_type,
      title: input.title,
      priority: row.priority,
      confidence: row.confidence,
    },
    'Queuing item for review',
  );

  const result = await safeInsert<Record<string, unknown>>('admin_review_queue', row);

  if (!result.tableExists) {
    log.warn('admin_review_queue table not yet created — item logged locally only');
    return null;
  }

  if (result.error) {
    log.error({ error: result.error, title: input.title }, 'Failed to queue item');
    return null;
  }

  const id = result.data?.[0]?.id as string ?? null;
  log.info({ id, title: input.title }, 'Item queued for review');
  return id;
}

/**
 * Check if a similar item already exists in the queue (pending status).
 * Used to prevent duplicate entries across agent runs.
 */
export async function isDuplicate(
  agent: string,
  taskType: string,
  sourceUrl: string,
): Promise<boolean> {
  const result = await safeSelect<ReviewQueueRow>('admin_review_queue', (query) =>
    query
      .eq('agent', agent)
      .eq('task_type', taskType)
      .eq('source_url', sourceUrl)
      .eq('status', 'pending'),
  );

  if (!result.tableExists || result.error) {
    return false; // Can't check — assume not duplicate
  }

  return (result.data?.length ?? 0) > 0;
}
