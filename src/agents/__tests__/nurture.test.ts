import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing the module under test
vi.mock('../../lib/anthropic', () => ({
  callAnthropic: vi.fn(),
}));

vi.mock('../../lib/queue', () => ({
  queueForReview: vi.fn(),
  isDuplicate: vi.fn(),
}));

vi.mock('../../lib/prompt-loader', () => ({
  loadPrompt: vi.fn().mockReturnValue('mocked prompt'),
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
  safeInsert: vi.fn(),
  supabase: {},
}));

vi.mock('../../lib/decision-logger', () => ({
  linkDecisionToQueueItem: vi.fn(),
}));

vi.mock('../../lib/tools', () => ({
  lifecycleEmailTool: { name: 'draft_lifecycle_email', description: '', input_schema: {} },
}));

import { run } from '../nurture';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect } from '../../lib/supabase';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

describe('Nurture Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues emails for triggered users', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Mock safeSelect calls in order:
    // 1. findNoFirstHour — profiles query
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'user-1',
        full_name: 'Jake Miller',
        email: 'jake@example.com',
        state: 'CA',
        tier: 'free',
        created_at: threeDaysAgo,
      }],
      tableExists: true,
      error: null,
    });

    // 2. findNoFirstHour — hour_entries query
    mockSafeSelect.mockResolvedValueOnce({
      data: [], // No hour entries
      tableExists: true,
      error: null,
    });

    // 3. findInactive7d — hour_entries query
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 4. findUpgradeCandidates — hour_entries query
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 5. findPendingVerification — hour_entries query
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 6. wasRecentlyNurtured — admin_review_queue query (no recent nurtures)
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // AI drafting call
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Quick question, Jake',
        body: 'Hey Jake, logging your first hour takes about 2 minutes...',
        trigger: 'no_first_hour',
        personalization_notes: 'Remote user, no projects created yet',
        confidence: 0.88,
      },
      inputTokens: 150,
      outputTokens: 80,
      costCents: 0.015,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 250,
      decisionId: 'dec-n1',
    });

    mockQueueForReview.mockResolvedValue('queue-n1');

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify queue was called with correct payload
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'nurture',
        task_type: 'nurture_email',
        content: expect.objectContaining({
          trigger: 'no_first_hour',
          user_id: 'user-1',
          subject: 'Quick question, Jake',
          body: expect.stringContaining('Jake'),
        }),
      }),
    );

    // Verify decision was linked
    expect(mockLinkDecision).toHaveBeenCalledWith('dec-n1', 'queue-n1');
  });

  it('skips recently nurtured users (dedup)', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // 1. findNoFirstHour — profiles
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'user-dup',
        full_name: 'Already Nurtured',
        email: 'dup@example.com',
        state: 'TX',
        tier: 'free',
        created_at: threeDaysAgo,
      }],
      tableExists: true,
      error: null,
    });

    // 2. findNoFirstHour — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 3. findInactive7d — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 4. findUpgradeCandidates — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 5. findPendingVerification — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 6. wasRecentlyNurtured — finds recent nurture email
    mockSafeSelect.mockResolvedValueOnce({
      data: [{ id: 'existing-nurture' }],
      tableExists: true,
      error: null,
    });

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(0);
    expect(result.items_skipped).toBe(1);
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('handles missing tables gracefully', async () => {
    // All signal queries return tableExists: false
    mockSafeSelect.mockResolvedValue({
      data: null,
      tableExists: false,
      error: null,
    });

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('processes multiple trigger types in one run', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. findNoFirstHour — profiles (one user with no hours)
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'user-new',
        full_name: 'New User',
        email: 'new@example.com',
        state: 'NY',
        tier: 'free',
        created_at: threeDaysAgo,
      }],
      tableExists: true,
      error: null,
    });

    // 2. findNoFirstHour — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [
        { user_id: 'user-inactive' },
        { user_id: 'user-inactive' },
        { user_id: 'user-inactive' },
      ],
      tableExists: true,
      error: null,
    });

    // 3. findInactive7d — hour_entries (user-inactive has old entries)
    mockSafeSelect.mockResolvedValueOnce({
      data: [
        { user_id: 'user-inactive', created_at: tenDaysAgo },
        { user_id: 'user-inactive', created_at: thirtyDaysAgo },
        { user_id: 'user-inactive', created_at: thirtyDaysAgo },
      ],
      tableExists: true,
      error: null,
    });

    // 4. findInactive7d — profiles for inactive user
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'user-inactive',
        full_name: 'Inactive User',
        email: 'inactive@example.com',
        state: 'FL',
        tier: 'free',
        created_at: thirtyDaysAgo,
      }],
      tableExists: true,
      error: null,
    });

    // 5. findUpgradeCandidates — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 6. findPendingVerification — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 7. wasRecentlyNurtured for user-new
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 8. wasRecentlyNurtured for user-inactive
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // AI calls for both users
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Quick start tip',
        body: 'Hey New, logging your first hour is easy...',
        trigger: 'no_first_hour',
        confidence: 0.85,
      },
      inputTokens: 100,
      outputTokens: 60,
      costCents: 0.01,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 200,
      decisionId: 'dec-new',
    });

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Still tracking hours?',
        body: 'Hey Inactive, just checking in...',
        trigger: 'inactive_7d',
        confidence: 0.82,
      },
      inputTokens: 120,
      outputTokens: 70,
      costCents: 0.012,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 220,
      decisionId: 'dec-inactive',
    });

    mockQueueForReview.mockResolvedValueOnce('queue-new');
    mockQueueForReview.mockResolvedValueOnce('queue-inactive');

    const result = await run();

    expect(result.items_found).toBe(2);
    expect(result.items_queued).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify both AI calls were made
    expect(mockCallAnthropic).toHaveBeenCalledTimes(2);

    // Verify both queue calls
    expect(mockQueueForReview).toHaveBeenCalledTimes(2);

    // Verify different triggers
    const firstCall = mockQueueForReview.mock.calls[0][0];
    const secondCall = mockQueueForReview.mock.calls[1][0];
    expect(firstCall.content).toEqual(expect.objectContaining({ trigger: 'no_first_hour' }));
    expect(secondCall.content).toEqual(expect.objectContaining({ trigger: 'inactive_7d' }));
  });

  it('continues processing when one user fails', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // 1. findNoFirstHour — profiles (two users)
    mockSafeSelect.mockResolvedValueOnce({
      data: [
        {
          id: 'user-fail',
          full_name: 'Fail User',
          email: 'fail@example.com',
          state: 'OH',
          tier: 'free',
          created_at: threeDaysAgo,
        },
        {
          id: 'user-ok',
          full_name: 'OK User',
          email: 'ok@example.com',
          state: 'CA',
          tier: 'free',
          created_at: threeDaysAgo,
        },
      ],
      tableExists: true,
      error: null,
    });

    // 2. findNoFirstHour — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 3. findInactive7d — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 4. findUpgradeCandidates — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 5. findPendingVerification — hour_entries
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 6. wasRecentlyNurtured for user-fail
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 7. wasRecentlyNurtured for user-ok
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // First AI call fails
    mockCallAnthropic.mockRejectedValueOnce(new Error('API rate limit'));

    // Second AI call succeeds
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Getting started',
        body: 'Hey OK, logging hours is simple...',
        trigger: 'no_first_hour',
        confidence: 0.87,
      },
      inputTokens: 100,
      outputTokens: 60,
      costCents: 0.01,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 200,
      decisionId: 'dec-ok',
    });

    mockQueueForReview.mockResolvedValue('queue-ok');

    const result = await run();

    expect(result.items_found).toBe(2);
    expect(result.items_queued).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toContain('user-fail');
    expect(result.errors[0].recoverable).toBe(true);
  });

  it('handles signal query failures gracefully', async () => {
    // 1. findNoFirstHour — profiles query fails
    mockSafeSelect.mockRejectedValueOnce(new Error('Connection timeout'));

    // 2. findInactive7d — hour_entries works but empty
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 3. findUpgradeCandidates — hour_entries works but empty
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    // 4. findPendingVerification — hour_entries works but empty
    mockSafeSelect.mockResolvedValueOnce({
      data: [],
      tableExists: true,
      error: null,
    });

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toContain('no_first_hour');
    expect(result.errors[0].recoverable).toBe(true);
  });
});
