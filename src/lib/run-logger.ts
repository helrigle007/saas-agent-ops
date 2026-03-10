import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { safeInsert } from './supabase';
import { logger } from './logger';
import type { AgentName, AgentResult, RunContext, RunStatus } from '../types';
import { updateAgentHealth, addCostCents } from './health';

const log = logger.child({ module: 'run-logger' });

const asyncLocalStorage = new AsyncLocalStorage<RunContext>();

/**
 * Get the current run context from AsyncLocalStorage.
 * Returns undefined if called outside an agent run.
 */
export function getRunContext(): RunContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Increment API call counters in the current run context.
 * Called by the anthropic wrapper after each API call.
 */
export function trackApiCall(inputTokens: number, outputTokens: number, costCents: number, isSearch: boolean): void {
  const ctx = asyncLocalStorage.getStore();
  if (!ctx) return;

  ctx.apiCalls++;
  ctx.inputTokens += inputTokens;
  ctx.outputTokens += outputTokens;
  ctx.costCents += costCents;
  if (isSearch) ctx.searchCalls++;
}

/**
 * Execute an agent's run() function with full observability:
 * - AsyncLocalStorage context for token/cost tracking
 * - Timing
 * - Writes run log to admin_agent_runs
 * - Updates health endpoint status
 */
export async function executeAgentRun(
  agent: AgentName,
  runFn: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();

  const ctx: RunContext = {
    runId,
    agent,
    startedAt,
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    searchCalls: 0,
  };

  log.info({ agent, runId }, 'Agent run starting');

  let result: AgentResult;
  let runStatus: RunStatus;

  try {
    result = await asyncLocalStorage.run(ctx, runFn);

    if (result.errors.length > 0 && result.items_queued === 0 && result.items_found === 0) {
      runStatus = 'error';
    } else if (result.errors.length > 0) {
      runStatus = 'partial';
    } else if (result.items_found === 0) {
      runStatus = 'skipped';
    } else {
      runStatus = 'success';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ agent, runId, error: message }, 'Agent run failed with uncaught exception');

    result = {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors: [{ step: 'run', message, recoverable: false }],
      warnings: [],
      summary: `Run failed: ${message}`,
    };
    runStatus = 'error';
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // Log to Supabase
  const runRow = {
    id: runId,
    agent,
    run_status: runStatus,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    items_found: result.items_found,
    items_queued: result.items_queued,
    items_skipped: result.items_skipped,
    api_calls: ctx.apiCalls,
    api_input_tokens: ctx.inputTokens,
    api_output_tokens: ctx.outputTokens,
    api_cost_cents: Math.round(ctx.costCents),
    search_calls: ctx.searchCalls,
    errors: result.errors.length > 0 ? result.errors : null,
    warnings: result.warnings.length > 0 ? result.warnings : null,
    summary: result.summary,
  };

  await safeInsert('admin_agent_runs', runRow);

  // Update health endpoint
  updateAgentHealth(agent, runStatus, finishedAt);
  addCostCents(Math.round(ctx.costCents));

  log.info(
    {
      agent,
      runId,
      runStatus,
      durationMs,
      items_found: result.items_found,
      items_queued: result.items_queued,
      items_skipped: result.items_skipped,
      apiCalls: ctx.apiCalls,
      costCents: Math.round(ctx.costCents * 100) / 100,
    },
    result.summary,
  );

  return result;
}
