import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all shared lib modules before importing the agent ──────────
vi.mock('../../lib/anthropic', () => ({
  callAnthropic: vi.fn(),
}));

vi.mock('../../lib/queue', () => ({
  queueForReview: vi.fn(),
}));

vi.mock('../../lib/prompt-loader', () => ({
  loadPrompt: vi.fn().mockReturnValue('mocked prompt text'),
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  createAgentLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../lib/supabase', () => ({
  safeSelect: vi.fn(),
}));

vi.mock('../../lib/decision-logger', () => ({
  linkDecisionToQueueItem: vi.fn(),
}));

vi.mock('../../lib/tools', () => ({
  morningBriefingTool: { name: 'compose_briefing', description: 'mock', input_schema: {} },
}));

import { run } from '../digest';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect } from '../../lib/supabase';
import { loadPrompt } from '../../lib/prompt-loader';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);
const mockLoadPrompt = vi.mocked(loadPrompt);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPrompt.mockReturnValue('mocked prompt text');
});

// ── Test Data Factories ─────────────────────────────────────────────

function makePendingItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    agent: 'scout' as const,
    task_type: 'forum_reply',
    status: 'pending' as const,
    priority: 'normal' as const,
    title: 'Reply to thread about project templates',
    content: {},
    reasoning: 'Gap found in thread',
    confidence: 0.85,
    source_url: 'https://reddit.com/r/SaaS/123',
    created_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_notes: null,
    executed_at: null,
    expires_at: null,
    ...overrides,
  };
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    agent: 'scout' as const,
    run_status: 'success' as const,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 5000,
    items_found: 3,
    items_queued: 2,
    items_skipped: 1,
    api_calls: 4,
    api_input_tokens: 2000,
    api_output_tokens: 1000,
    api_cost_cents: 12,
    search_calls: 2,
    errors: null,
    warnings: null,
    run_config: null,
    summary: 'Scout run completed',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Digest Agent', () => {
  it('queues briefing with pending items from multiple agents', async () => {
    const pendingItems = [
      makePendingItem({ id: 'item-1', agent: 'scout', title: 'Reply to project templates thread', confidence: 0.85, priority: 'normal' }),
      makePendingItem({ id: 'item-2', agent: 'scout', title: 'Reply to project tracking thread', confidence: 0.72, priority: 'high' }),
      makePendingItem({ id: 'item-3', agent: 'outreach', title: 'Email to Acme Agency', confidence: 0.90, priority: 'normal' }),
      makePendingItem({ id: 'item-4', agent: 'watchdog', title: '[competitor_pricing] RivalBoard update', confidence: 0.70, priority: 'high' }),
    ];

    const recentRuns = [
      makeRunRow({ id: 'run-1', agent: 'scout', api_cost_cents: 30 }),
      makeRunRow({ id: 'run-2', agent: 'outreach', api_cost_cents: 15 }),
      makeRunRow({ id: 'run-3', agent: 'watchdog', api_cost_cents: 10 }),
    ];

    // First safeSelect call: pending items
    mockSafeSelect.mockResolvedValueOnce({
      data: pendingItems,
      tableExists: true,
      error: null,
    });

    // Second safeSelect call: recent runs
    mockSafeSelect.mockResolvedValueOnce({
      data: recentRuns,
      tableExists: true,
      error: null,
    });

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        headline: '4 items pending — Scout has 2 replies, Watchdog flagged competitor pricing change',
        sections: [
          {
            agent: 'scout',
            summary: '2 forum replies ready for review, both addressing project tracking questions',
            items_pending: 2,
            highlights: ['Reply to project templates thread (85% confidence)'],
            concerns: [],
          },
          {
            agent: 'outreach',
            summary: '1 cold email draft for agency',
            items_pending: 1,
            highlights: ['Acme Agency email (90% confidence)'],
            concerns: [],
          },
          {
            agent: 'watchdog',
            summary: '1 competitor alert about RivalBoard pricing',
            items_pending: 1,
            highlights: ['RivalBoard pricing change detected'],
            concerns: [],
          },
        ],
        total_pending: 4,
        total_cost_24h_cents: 55,
        action_items: [
          'Review RivalBoard pricing alert (high priority)',
          'Review Scout reply to project tracking thread (high priority)',
          'Approve Acme Agency outreach email',
          'Review Scout project templates reply',
        ],
      },
      inputTokens: 600,
      outputTokens: 400,
      costCents: 0.06,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 1500,
      decisionId: 'dec-digest-1',
    });

    mockQueueForReview.mockResolvedValueOnce('queue-briefing-1');

    const result = await run();

    expect(result.items_found).toBe(4);
    expect(result.items_queued).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify the briefing was queued with high priority
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'digest',
        task_type: 'morning_briefing',
        priority: 'high',
        content: expect.objectContaining({
          headline: expect.stringContaining('4 items pending'),
          total_pending: 4,
          total_cost_24h_cents: 55,
          sections: expect.arrayContaining([
            expect.objectContaining({ agent: 'scout', items_pending: 2 }),
            expect.objectContaining({ agent: 'outreach', items_pending: 1 }),
            expect.objectContaining({ agent: 'watchdog', items_pending: 1 }),
          ]),
          action_items: expect.arrayContaining([
            expect.stringContaining('RivalBoard'),
          ]),
        }),
      }),
    );

    // Verify decision was linked to queue item
    expect(mockLinkDecision).toHaveBeenCalledWith('dec-digest-1', 'queue-briefing-1');
  });

  it('still queues summary when no pending items exist', async () => {
    // No pending items
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // No recent runs
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        headline: 'All clear — no pending items, no agent activity in last 24h',
        sections: [],
        total_pending: 0,
        total_cost_24h_cents: 0,
        action_items: [],
      },
      inputTokens: 300,
      outputTokens: 100,
      costCents: 0.02,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 800,
      decisionId: 'dec-empty-1',
    });

    mockQueueForReview.mockResolvedValueOnce('queue-empty-1');

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Still queued a briefing
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'digest',
        task_type: 'morning_briefing',
        content: expect.objectContaining({
          headline: expect.stringContaining('All clear'),
          total_pending: 0,
        }),
      }),
    );
  });

  it('groups items by agent correctly', async () => {
    const pendingItems = [
      makePendingItem({ id: 'i1', agent: 'scout', title: 'Scout item 1', confidence: 0.80 }),
      makePendingItem({ id: 'i2', agent: 'scout', title: 'Scout item 2', confidence: 0.60 }),
      makePendingItem({ id: 'i3', agent: 'scout', title: 'Scout item 3', confidence: 0.90 }),
      makePendingItem({ id: 'i4', agent: 'outreach', title: 'Outreach item 1', confidence: 0.75 }),
      makePendingItem({ id: 'i5', agent: 'scribe-draft', title: 'Scribe item 1', confidence: 0.95 }),
    ];

    mockSafeSelect.mockResolvedValueOnce({
      data: pendingItems,
      tableExists: true,
      error: null,
    });

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        headline: '5 items pending across 3 agents',
        sections: [
          { agent: 'scout', summary: '3 items', items_pending: 3 },
          { agent: 'outreach', summary: '1 item', items_pending: 1 },
          { agent: 'scribe-draft', summary: '1 item', items_pending: 1 },
        ],
        total_pending: 5,
        total_cost_24h_cents: 0,
        action_items: [],
      },
      inputTokens: 500,
      outputTokens: 200,
      costCents: 0.03,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 1000,
      decisionId: null,
    });

    mockQueueForReview.mockResolvedValueOnce('queue-groups-1');

    const result = await run();

    expect(result.items_found).toBe(5);
    expect(result.items_queued).toBe(1);

    // Verify loadPrompt was called with formatted pending items
    expect(mockLoadPrompt).toHaveBeenCalledWith('digest/morning-briefing', {
      pending_items: expect.stringContaining('scout (3 items'),
      recent_runs: expect.stringContaining('No agent runs'),
      cost_24h: '0',
    });
  });

  it('calculates cost from recent runs correctly', async () => {
    const recentRuns = [
      makeRunRow({ id: 'r1', agent: 'scout', api_cost_cents: 30 }),
      makeRunRow({ id: 'r2', agent: 'scout', api_cost_cents: 28 }),
      makeRunRow({ id: 'r3', agent: 'outreach', api_cost_cents: 15 }),
      makeRunRow({ id: 'r4', agent: 'watchdog', api_cost_cents: 10 }),
      makeRunRow({ id: 'r5', agent: 'inbox', api_cost_cents: 5 }),
    ];

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    mockSafeSelect.mockResolvedValueOnce({
      data: recentRuns,
      tableExists: true,
      error: null,
    });

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        headline: 'No pending items — agents ran 5 times, $0.88 spent',
        sections: [],
        total_pending: 0,
        total_cost_24h_cents: 88,
        action_items: [],
      },
      inputTokens: 400,
      outputTokens: 150,
      costCents: 0.03,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 900,
      decisionId: null,
    });

    mockQueueForReview.mockResolvedValueOnce('queue-cost-1');

    const result = await run();

    // Total cost should be 30 + 28 + 15 + 10 + 5 = 88 cents
    expect(mockLoadPrompt).toHaveBeenCalledWith('digest/morning-briefing', {
      pending_items: expect.any(String),
      recent_runs: expect.any(String),
      cost_24h: '88',
    });

    expect(result.summary).toContain('$0.88');
  });

  describe('error handling', () => {
    it('handles database query failures gracefully', async () => {
      // Pending items query fails
      mockSafeSelect.mockResolvedValueOnce({
        data: null,
        tableExists: true,
        error: 'Connection timeout',
      });

      // Runs query succeeds
      mockSafeSelect.mockResolvedValueOnce({
        data: [],
        tableExists: true,
        error: null,
      });

      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          headline: 'Briefing compiled with partial data — review queue query failed',
          sections: [],
          total_pending: 0,
          total_cost_24h_cents: 0,
          action_items: ['Investigate admin_review_queue connection issues'],
        },
        inputTokens: 300,
        outputTokens: 100,
        costCents: 0.02,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 800,
        decisionId: null,
      });

      mockQueueForReview.mockResolvedValueOnce('queue-err-1');

      const result = await run();

      // Should still produce a briefing despite the error
      expect(result.items_queued).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].step).toBe('fetch_pending');
      expect(result.errors[0].recoverable).toBe(true);
    });

    it('handles AI composition failure', async () => {
      mockSafeSelect.mockResolvedValueOnce({
        data: [makePendingItem()],
        tableExists: true,
        error: null,
      });

      mockSafeSelect.mockResolvedValueOnce({
        data: [],
        tableExists: true,
        error: null,
      });

      mockCallAnthropic.mockRejectedValueOnce(new Error('API rate limit'));

      const result = await run();

      expect(result.items_found).toBe(1);
      expect(result.items_queued).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].step).toBe('compose_briefing');
      expect(result.summary).toContain('Briefing failed');
    });

    it('handles missing table gracefully', async () => {
      mockSafeSelect.mockResolvedValueOnce({
        data: null,
        tableExists: false,
        error: null,
      });

      mockSafeSelect.mockResolvedValueOnce({
        data: null,
        tableExists: false,
        error: null,
      });

      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          headline: 'System initializing — tables not yet created',
          sections: [],
          total_pending: 0,
          total_cost_24h_cents: 0,
          action_items: ['Run database migrations to create agent tables'],
        },
        inputTokens: 200,
        outputTokens: 80,
        costCents: 0.01,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 600,
        decisionId: null,
      });

      mockQueueForReview.mockResolvedValueOnce('queue-init-1');

      const result = await run();

      expect(result.items_queued).toBe(1);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0].step).toBe('fetch_pending');
      expect(result.warnings[1].step).toBe('fetch_runs');
    });
  });
});
