import { safeInsert, safeUpdate } from './supabase';
import { logger } from './logger';
import { getRunContext } from './run-logger';
import type { AgentName } from '../types';

const log = logger.child({ module: 'decision-logger' });

export interface DecisionLogInput {
  agent: AgentName;
  decisionType: string;
  promptSystem: string;
  promptUser: string;
  rawResponse: string;
  parsedOutput: Record<string, unknown> | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Log an AI decision to admin_agent_decisions.
 * Returns the decision row ID (or null if table doesn't exist).
 */
export async function logDecision(input: DecisionLogInput): Promise<string | null> {
  const ctx = getRunContext();

  const row = {
    run_id: ctx?.runId ?? null,
    agent: input.agent,
    decision_type: input.decisionType,
    prompt_system: input.promptSystem,
    prompt_user: input.promptUser,
    raw_response: input.rawResponse,
    parsed_output: input.parsedOutput,
    model: input.model,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    latency_ms: input.latencyMs,
  };

  // Also log to local file for backup
  log.debug(
    {
      agent: input.agent,
      decision_type: input.decisionType,
      model: input.model,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      latency_ms: input.latencyMs,
    },
    'AI decision logged',
  );

  const result = await safeInsert('admin_agent_decisions', row);

  if (!result.tableExists) {
    log.debug('admin_agent_decisions table not yet created — decision logged locally only');
    return null;
  }

  if (result.error) {
    log.error({ error: result.error }, 'Failed to log decision to Supabase');
    return null;
  }

  const firstRow = result.data?.[0] as Record<string, unknown> | undefined;
  return (firstRow?.id as string) ?? null;
}

/**
 * Link a decision log entry to the review queue item it produced.
 */
export async function linkDecisionToQueueItem(
  decisionId: string,
  queueItemId: string,
): Promise<void> {
  const result = await safeUpdate(
    'admin_agent_decisions',
    { queue_item_id: queueItemId },
    'id',
    decisionId,
  );

  if (result.error) {
    log.error(
      { decisionId, queueItemId, error: result.error },
      'Failed to link decision to queue item',
    );
  }
}
