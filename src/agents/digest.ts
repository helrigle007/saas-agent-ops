import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect } from '../lib/supabase';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { morningBriefingTool } from '../lib/tools';
import type { AgentResult, AgentError, AgentWarning, ReviewQueueRow, AgentRunRow, AgentName } from '../types';

const log = createAgentLogger('digest');

/**
 * Digest Agent — morning briefing summary.
 *
 * Runs at 8:30 AM daily.
 * Queries pending review items and recent agent runs,
 * then composes a concise briefing for the human operator.
 */
export async function run(): Promise<AgentResult> {
  log.info('Digest starting morning briefing');

  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];

  // ── Step 1: Fetch pending review items ────────────────────────────
  let pendingItems: ReviewQueueRow[] = [];
  try {
    const result = await safeSelect<ReviewQueueRow>('admin_review_queue', (query) =>
      query.eq('status', 'pending').order('created_at', { ascending: false }),
    );

    if (!result.tableExists) {
      warnings.push({ step: 'fetch_pending', message: 'admin_review_queue table not yet created' });
    } else if (result.error) {
      errors.push({ step: 'fetch_pending', message: result.error, recoverable: true });
    } else {
      pendingItems = result.data ?? [];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ step: 'fetch_pending', error: message }, 'Failed to fetch pending items');
    errors.push({ step: 'fetch_pending', message, recoverable: true });
  }

  // ── Step 2: Fetch recent agent runs (last 24h) ───────────────────
  let recentRuns: AgentRunRow[] = [];
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const result = await safeSelect<AgentRunRow>('admin_agent_runs', (query) =>
      query.gte('started_at', twentyFourHoursAgo).order('started_at', { ascending: false }),
    );

    if (!result.tableExists) {
      warnings.push({ step: 'fetch_runs', message: 'admin_agent_runs table not yet created' });
    } else if (result.error) {
      errors.push({ step: 'fetch_runs', message: result.error, recoverable: true });
    } else {
      recentRuns = result.data ?? [];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ step: 'fetch_runs', error: message }, 'Failed to fetch recent runs');
    errors.push({ step: 'fetch_runs', message, recoverable: true });
  }

  // ── Step 3: Calculate stats ───────────────────────────────────────
  const totalPending = pendingItems.length;
  const totalCost24hCents = recentRuns.reduce((sum, run) => sum + (run.api_cost_cents ?? 0), 0);

  // Group pending items by agent
  const pendingByAgent = groupByAgent(pendingItems);

  // Format data for the prompt
  const pendingItemsSummary = formatPendingItems(pendingItems, pendingByAgent);
  const recentRunsSummary = formatRecentRuns(recentRuns);

  log.info(
    { totalPending, totalCost24hCents, recentRunCount: recentRuns.length },
    'Data gathered for briefing',
  );

  // ── Step 4: Compose briefing via AI ───────────────────────────────
  try {
    const systemPrompt = loadPrompt('digest/morning-briefing', {
      pending_items: pendingItemsSummary,
      recent_runs: recentRunsSummary,
      cost_24h: String(totalCost24hCents),
    });

    const userPrompt = 'Compose the morning briefing based on the data provided.';

    const result = await callAnthropic({
      agent: 'digest',
      decisionType: 'morning_briefing',
      systemPrompt,
      userPrompt,
      model: 'haiku',
      tools: [morningBriefingTool],
      toolChoice: { type: 'tool', name: 'compose_briefing' },
    });

    const parsed = result.parsedOutput;
    if (!parsed || !parsed.headline) {
      errors.push({
        step: 'compose_briefing',
        message: 'No structured output from briefing composition',
        recoverable: false,
      });

      return {
        items_found: totalPending,
        items_queued: 0,
        items_skipped: 0,
        errors,
        warnings,
        summary: `Briefing composition failed — ${totalPending} pending items unprocessed`,
      };
    }

    // ── Step 5: Queue the briefing ────────────────────────────────────
    const briefingContent = {
      headline: parsed.headline as string,
      sections: parsed.sections as Array<{
        agent: string;
        summary: string;
        items_pending: number;
        highlights?: string[];
        concerns?: string[];
      }>,
      total_pending: parsed.total_pending as number ?? totalPending,
      total_cost_24h_cents: parsed.total_cost_24h_cents as number ?? totalCost24hCents,
      action_items: (parsed.action_items as string[]) ?? [],
    };

    const queueItemId = await queueForReview({
      agent: 'digest',
      task_type: 'morning_briefing',
      title: briefingContent.headline,
      content: briefingContent,
      reasoning: `Morning briefing: ${totalPending} pending items, $${(totalCost24hCents / 100).toFixed(2)} spent in last 24h`,
      confidence: 0.95,
      priority: 'high',
    });

    if (queueItemId && result.decisionId) {
      await linkDecisionToQueueItem(result.decisionId, queueItemId);
    }

    const summary = `Morning briefing queued: ${totalPending} pending items, ${recentRuns.length} runs in 24h, $${(totalCost24hCents / 100).toFixed(2)} spent`;
    log.info(summary);

    return {
      items_found: totalPending,
      items_queued: 1,
      items_skipped: 0,
      errors,
      warnings,
      summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ step: 'compose_briefing', error: message }, 'Briefing composition failed');
    errors.push({ step: 'compose_briefing', message, recoverable: false });

    return {
      items_found: totalPending,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: `Briefing failed: ${message}`,
    };
  }
}

// ─── Helper Functions ────────────────────────────────────────────────

interface AgentPendingGroup {
  agent: AgentName;
  count: number;
  priorities: Record<string, number>;
  avgConfidence: number;
  items: ReviewQueueRow[];
}

function groupByAgent(items: ReviewQueueRow[]): Map<AgentName, AgentPendingGroup> {
  const groups = new Map<AgentName, AgentPendingGroup>();

  for (const item of items) {
    const existing = groups.get(item.agent);
    if (existing) {
      existing.count++;
      existing.priorities[item.priority] = (existing.priorities[item.priority] ?? 0) + 1;
      existing.items.push(item);
    } else {
      groups.set(item.agent, {
        agent: item.agent,
        count: 1,
        priorities: { [item.priority]: 1 },
        avgConfidence: 0,
        items: [item],
      });
    }
  }

  // Calculate average confidence per group
  for (const group of groups.values()) {
    const confidences = group.items
      .map((i) => i.confidence)
      .filter((c): c is number => c !== null);
    group.avgConfidence =
      confidences.length > 0
        ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
        : 0;
  }

  return groups;
}

function formatPendingItems(
  items: ReviewQueueRow[],
  byAgent: Map<AgentName, AgentPendingGroup>,
): string {
  if (items.length === 0) {
    return 'No pending review items.';
  }

  const lines: string[] = [`Total pending: ${items.length}`, ''];

  for (const [agent, group] of byAgent) {
    lines.push(`--- ${agent} (${group.count} items, avg confidence: ${(group.avgConfidence * 100).toFixed(0)}%) ---`);
    const priorityStr = Object.entries(group.priorities)
      .map(([p, c]) => `${p}: ${c}`)
      .join(', ');
    lines.push(`  Priorities: ${priorityStr}`);

    for (const item of group.items.slice(0, 5)) {
      const confidence = item.confidence !== null ? ` (${(item.confidence * 100).toFixed(0)}%)` : '';
      lines.push(`  - [${item.priority}]${confidence} ${item.title}`);
    }

    if (group.items.length > 5) {
      lines.push(`  ... and ${group.items.length - 5} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatRecentRuns(runs: AgentRunRow[]): string {
  if (runs.length === 0) {
    return 'No agent runs in the last 24 hours.';
  }

  const lines: string[] = [`Total runs: ${runs.length}`, ''];

  for (const run of runs) {
    const status = run.run_status;
    const cost = (run.api_cost_cents / 100).toFixed(2);
    const duration = (run.duration_ms / 1000).toFixed(1);
    lines.push(
      `[${status}] ${run.agent} — ${run.items_found} found, ${run.items_queued} queued, ${run.items_skipped} skipped | ${duration}s | $${cost}`,
    );

    if (run.errors && run.errors.length > 0) {
      for (const err of run.errors) {
        lines.push(`  ERROR: ${err.step} — ${err.message}`);
      }
    }
  }

  return lines.join('\n');
}
