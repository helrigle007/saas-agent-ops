import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnthropicCallResult, OutreachTargetRow } from '../../types';
import type { SafeResult } from '../../lib/supabase';

// Mock all shared libs before importing the agent
vi.mock('../../lib/anthropic', () => ({
  callAnthropic: vi.fn(),
}));

vi.mock('../../lib/queue', () => ({
  queueForReview: vi.fn(),
  isDuplicate: vi.fn(),
}));

vi.mock('../../lib/prompt-loader', () => ({
  loadPrompt: vi.fn().mockReturnValue('mock system prompt'),
}));

vi.mock('../../lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  createAgentLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../lib/supabase', () => ({
  safeSelect: vi.fn(),
  safeUpdate: vi.fn(),
  safeInsert: vi.fn(),
}));

vi.mock('../../lib/decision-logger', () => ({
  linkDecisionToQueueItem: vi.fn(),
}));

vi.mock('../../lib/tools', () => ({
  targetResearchTool: { name: 'report_research', description: 'mock', input_schema: {} },
  emailDraftingTool: { name: 'draft_email', description: 'mock', input_schema: {} },
}));

import { run } from '../outreach';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect, safeUpdate } from '../../lib/supabase';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);
const mockSafeUpdate = vi.mocked(safeUpdate);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

function makeTarget(overrides: Partial<OutreachTargetRow> = {}): OutreachTargetRow {
  return {
    id: 'target-001',
    category: 'Digital Agency',
    name: 'Digital Agency 11 Los Angeles',
    contact_name: 'Sarah Chen',
    contact_email: 'ops@acmedigital.co',
    website: 'https://acmedigital.co',
    state: 'Remote',
    notes: null,
    status: 'new',
    last_contacted_at: null,
    follow_up_at: null,
    created_at: '2026-03-08T00:00:00Z',
    ...overrides,
  };
}

function makeResearchResult(overrides: Partial<AnthropicCallResult> = {}): AnthropicCallResult {
  return {
    text: '',
    parsedOutput: {
      organization_summary: 'Digital Agency 11 is one of the largest electrical worker unions in Southern Remote with over 10,000 members.',
      program_size: '45 team members across 3 offices',
      key_personnel: 'Sarah Chen, Operations Lead',
      pain_points: ['Spreadsheet-based project tracking', 'Client reporting overhead'],
      personalization_hooks: ['Recently expanded to a third office', 'Growing their SaaS client vertical'],
      relevance_score: 0.9,
    },
    inputTokens: 2000,
    outputTokens: 500,
    costCents: 0.08,
    model: 'claude-haiku-4-5-20251001',
    latencyMs: 2000,
    decisionId: 'research-dec-001',
    ...overrides,
  };
}

function makeEmailResult(overrides: Partial<AnthropicCallResult> = {}): AnthropicCallResult {
  return {
    text: '',
    parsedOutput: {
      subject: 'Free project tracking tool for your team',
      body: 'Hi Sarah,\n\nWith Acme Digital expanding into the SaaS vertical, your team likely has more projects to juggle than ever. TrackBoard is a free tool that lets them track tasks from any device and auto-generates progress reports for clients.\n\nWould it be worth a quick look? Here is the link: https://trackboard.app?utm_source=email&utm_medium=outreach&utm_campaign=digital-agency\n\nBest,\nThe TrackBoard Team',
      personalization_notes: 'Referenced their SaaS vertical expansion',
      confidence: 0.85,
      follow_up_days: 5,
    },
    inputTokens: 1500,
    outputTokens: 300,
    costCents: 0.05,
    model: 'claude-haiku-4-5-20251001',
    latencyMs: 1500,
    decisionId: 'email-dec-001',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSafeUpdate.mockResolvedValue({ data: null, tableExists: true, error: null });
});

describe('outreach agent', () => {
  it('researches and drafts emails for available targets', async () => {
    const target = makeTarget();

    // First safeSelect call: new targets
    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // Second safeSelect call: follow-up targets
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // Research call then email call
    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(1);
    expect(result.items_skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Should have made 2 AI calls (research + email)
    expect(mockCallAnthropic).toHaveBeenCalledTimes(2);

    // Should have queued 1 email
    expect(mockQueueForReview).toHaveBeenCalledTimes(1);
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'outreach',
        task_type: 'cold_email',
        content: expect.objectContaining({
          target_id: 'target-001',
          recipient_name: 'Sarah Chen',
          subject: 'Free project tracking tool for your team',
        }),
      }),
    );
  });

  it('returns skipped when no targets are available', async () => {
    // New targets: empty
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // Follow-up targets: empty
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(0);
    expect(result.summary).toContain('skipped');
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('handles individual target failure gracefully (partial success)', async () => {
    const target1 = makeTarget({ id: 'target-001', name: 'Digital Agency 11' });
    const target2 = makeTarget({ id: 'target-002', name: 'Digital Agency 40' });

    // New targets
    mockSafeSelect.mockResolvedValueOnce({
      data: [target1, target2],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // Follow-up targets
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // Target 1: research succeeds, email fails
    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult()); // research target 1
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult({ parsedOutput: null })); // email target 1 — invalid

    // Target 2: both succeed
    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult()); // research target 2
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult()); // email target 2

    mockQueueForReview.mockResolvedValue('queue-002');

    const result = await run();

    expect(result.items_found).toBe(2);
    expect(result.items_queued).toBe(1);
    expect(result.items_skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('sets follow_up_at date based on AI response', async () => {
    const target = makeTarget();

    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult({
      parsedOutput: {
        subject: 'Test',
        body: 'Test body',
        confidence: 0.8,
        follow_up_days: 7,
      },
    }));
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    // Check that safeUpdate was called to set status to 'drafted' with a follow_up_at
    const draftedCall = mockSafeUpdate.mock.calls.find(
      (call) => call[0] === 'admin_outreach_targets' && (call[1] as Record<string, unknown>).status === 'drafted',
    );
    expect(draftedCall).toBeDefined();
    const updateValues = draftedCall![1] as Record<string, unknown>;
    expect(updateValues.follow_up_at).toBeDefined();

    // follow_up_at should be approximately 7 days from now
    const followUpDate = new Date(updateValues.follow_up_at as string);
    const now = new Date();
    const diffDays = Math.round((followUpDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(6);
    expect(diffDays).toBeLessThanOrEqual(8);
  });

  it('transitions target status: new -> researched -> drafted', async () => {
    const target = makeTarget({ status: 'new' });

    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    // Should update to 'researched' first
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_outreach_targets',
      expect.objectContaining({ status: 'researched' }),
      'id',
      'target-001',
    );

    // Then to 'drafted'
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_outreach_targets',
      expect.objectContaining({ status: 'drafted' }),
      'id',
      'target-001',
    );
  });

  it('handles table not existing gracefully', async () => {
    mockSafeSelect.mockResolvedValueOnce({
      data: null,
      tableExists: false,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].step).toBe('fetch_targets');
  });

  it('links decision to queue item', async () => {
    const target = makeTarget();

    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult({ decisionId: 'email-dec-999' }));
    mockQueueForReview.mockResolvedValue('queue-888');

    await run();

    expect(mockLinkDecision).toHaveBeenCalledWith('email-dec-999', 'queue-888');
  });

  it('uses Haiku model for both research and email drafting', async () => {
    const target = makeTarget();

    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    // Both calls should use haiku (the default, or explicit 'haiku')
    const calls = mockCallAnthropic.mock.calls;
    expect(calls).toHaveLength(2);
    // Research call
    expect(calls[0][0].model).toBe('haiku');
    expect(calls[0][0].enableWebSearch).toBe(true);
    // Email call
    expect(calls[1][0].model).toBe('haiku');
  });

  it('includes UTM link with target category in queue content', async () => {
    const target = makeTarget({ category: 'Startup Accelerator' });

    mockSafeSelect.mockResolvedValueOnce({
      data: [target],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
    mockCallAnthropic.mockResolvedValueOnce(makeEmailResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          utm_link: expect.stringContaining('utm_campaign=startup-accelerator'),
        }),
      }),
    );
  });

  it('processes multiple targets in sequence', async () => {
    const target1 = makeTarget({ id: 'target-001', name: 'Digital Agency 11' });
    const target2 = makeTarget({ id: 'target-002', name: 'Summit Startup Accelerator' });
    const target3 = makeTarget({ id: 'target-003', name: 'Horizon Remote Agency' });

    mockSafeSelect.mockResolvedValueOnce({
      data: [target1, target2, target3],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<OutreachTargetRow[]>);

    // 3 targets x 2 calls each = 6 AI calls
    for (let i = 0; i < 3; i++) {
      mockCallAnthropic.mockResolvedValueOnce(makeResearchResult());
      mockCallAnthropic.mockResolvedValueOnce(makeEmailResult());
    }
    mockQueueForReview.mockResolvedValue('queue-001');

    const result = await run();

    expect(result.items_found).toBe(3);
    expect(result.items_queued).toBe(3);
    expect(mockCallAnthropic).toHaveBeenCalledTimes(6);
    expect(mockQueueForReview).toHaveBeenCalledTimes(3);
  });
});
