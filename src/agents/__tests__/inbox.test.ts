import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailMessage } from '../../lib/gmail';

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

vi.mock('../../lib/gmail', () => ({
  pollUnread: vi.fn(),
  markAsRead: vi.fn(),
  getGmailClient: vi.fn(),
}));

vi.mock('../../lib/tools', () => ({
  emailClassificationTool: { name: 'classify_email', description: '', input_schema: {} },
  responseDraftingTool: { name: 'draft_response', description: '', input_schema: {} },
}));

import { run } from '../inbox';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect } from '../../lib/supabase';
import { pollUnread, markAsRead, getGmailClient } from '../../lib/gmail';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);
const mockPollUnread = vi.mocked(pollUnread);
const mockMarkAsRead = vi.mocked(markAsRead);
const mockGetGmailClient = vi.mocked(getGmailClient);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'msg-123',
    threadId: 'thread-456',
    from: 'test@example.com',
    to: 'hello@trackboard.app',
    subject: 'Test email',
    date: '2026-03-10T10:00:00Z',
    snippet: 'This is a test email snippet',
    body: 'This is the full test email body.',
    labels: ['INBOX', 'UNREAD'],
    ...overrides,
  };
}

describe('Inbox Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when Gmail is not configured', async () => {
    mockGetGmailClient.mockReturnValue(null);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 'init', message: 'Gmail not configured' }),
      ]),
    );
    expect(result.summary).toContain('Gmail not configured');
    expect(mockPollUnread).not.toHaveBeenCalled();
  });

  it('returns items_found: 0 when no unread emails', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([]);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(0);
    expect(result.summary).toBe('No unread emails');
  });

  it('classifies and drafts response for actionable emails', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([makeEmail()]);

    // Classification call
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        category: 'user_support',
        priority: 'normal',
        summary: 'User asking about project creation',
        requires_response: true,
        related_user_email: 'test@example.com',
      },
      inputTokens: 100,
      outputTokens: 50,
      costCents: 0.01,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 200,
      decisionId: 'dec-1',
    });

    // User profile lookup
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'user-1',
        full_name: 'Jake Miller',
        email: 'test@example.com',
        tier: 'free',
        state: 'CA',
        created_at: '2026-01-01',
      }],
      tableExists: true,
      error: null,
    });

    // Response drafting call
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Re: Test email',
        body: 'Hey Jake, here is how to create projects...',
        tone: 'support',
        confidence: 0.9,
      },
      inputTokens: 200,
      outputTokens: 100,
      costCents: 0.02,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 300,
      decisionId: 'dec-2',
    });

    mockQueueForReview.mockResolvedValue('queue-1');

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify classification was called
    expect(mockCallAnthropic).toHaveBeenCalledTimes(2);

    // Verify queue was called with correct payload shape
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'inbox',
        task_type: 'email_response',
        content: expect.objectContaining({
          email_id: 'msg-123',
          from: 'test@example.com',
          subject: 'Test email',
          category: 'user_support',
          draft_response: expect.objectContaining({
            subject: 'Re: Test email',
            body: expect.stringContaining('Jake'),
          }),
        }),
      }),
    );

    // Verify email was marked as read
    expect(mockMarkAsRead).toHaveBeenCalledWith('msg-123');

    // Verify decision was linked to queue item
    expect(mockLinkDecision).toHaveBeenCalledWith('dec-2', 'queue-1');
  });

  it('marks spam emails as read but does not queue them', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([
      makeEmail({ id: 'spam-1', subject: 'Buy cheap watches!' }),
    ]);

    // Classification: spam
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        category: 'spam_noise',
        priority: 'low',
        summary: 'Marketing spam',
        requires_response: false,
      },
      inputTokens: 80,
      outputTokens: 30,
      costCents: 0.005,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 150,
      decisionId: 'dec-spam',
    });

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(0);
    expect(result.items_skipped).toBe(1);
    expect(mockMarkAsRead).toHaveBeenCalledWith('spam-1');
    expect(mockQueueForReview).not.toHaveBeenCalled();
  });

  it('cross-references outreach targets for outreach replies', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([
      makeEmail({
        id: 'reply-1',
        from: 'director@tradeschool.edu',
        subject: 'Re: Partnership opportunity with TrackBoard',
        body: 'Thanks for reaching out. We are interested in learning more.',
      }),
    ]);

    // Classification: outreach_reply
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        category: 'outreach_reply',
        priority: 'high',
        summary: 'Trade school responding to our outreach',
        requires_response: true,
        related_outreach_target: 'director@tradeschool.edu',
      },
      inputTokens: 100,
      outputTokens: 50,
      costCents: 0.01,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 200,
      decisionId: 'dec-3',
    });

    // Outreach target lookup
    mockSafeSelect.mockResolvedValueOnce({
      data: [{
        id: 'target-1',
        name: 'Metro Trade School',
        contact_name: 'Director Smith',
        contact_email: 'director@tradeschool.edu',
        category: 'trade_school',
        state: 'CA',
        status: 'sent',
        last_contacted_at: '2026-03-05',
        notes: 'Large agency with 200+ active projects',
        website: 'https://tradeschool.edu',
        follow_up_at: null,
        created_at: '2026-03-01',
      }],
      tableExists: true,
      error: null,
    });

    // Response drafting
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        subject: 'Re: Partnership opportunity with TrackBoard',
        body: 'Great to hear from you! I would love to set up a quick call...',
        tone: 'follow_up',
        confidence: 0.92,
      },
      inputTokens: 300,
      outputTokens: 150,
      costCents: 0.03,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 350,
      decisionId: 'dec-4',
    });

    mockQueueForReview.mockResolvedValue('queue-2');

    const result = await run();

    expect(result.items_queued).toBe(1);

    // Verify outreach target was looked up
    expect(mockSafeSelect).toHaveBeenCalledWith(
      'admin_outreach_targets',
      expect.any(Function),
    );

    // Verify the queue item includes context
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          category: 'outreach_reply',
          context: expect.objectContaining({
            outreach_target: expect.objectContaining({
              name: 'Metro Trade School',
              contact_name: 'Director Smith',
            }),
          }),
        }),
        priority: 'high',
      }),
    );
  });

  it('handles transactional emails as low-priority digest items', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([
      makeEmail({ id: 'txn-1', subject: 'Your Stripe receipt' }),
    ]);

    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        category: 'transactional',
        priority: 'low',
        summary: 'Stripe payment receipt',
        requires_response: false,
      },
      inputTokens: 80,
      outputTokens: 30,
      costCents: 0.005,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 150,
      decisionId: 'dec-txn',
    });

    mockQueueForReview.mockResolvedValue('queue-txn');

    const result = await run();

    expect(result.items_queued).toBe(1);
    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'email_transactional',
        priority: 'low',
      }),
    );
    expect(mockMarkAsRead).toHaveBeenCalledWith('txn-1');
  });

  it('continues processing when one email fails', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockResolvedValue([
      makeEmail({ id: 'fail-1', subject: 'Bad email' }),
      makeEmail({ id: 'good-1', subject: 'Good email' }),
    ]);

    // First email: classification fails
    mockCallAnthropic.mockRejectedValueOnce(new Error('API timeout'));

    // Second email: works fine
    mockCallAnthropic.mockResolvedValueOnce({
      text: '',
      parsedOutput: {
        category: 'spam_noise',
        priority: 'low',
        summary: 'Spam',
        requires_response: false,
      },
      inputTokens: 50,
      outputTokens: 20,
      costCents: 0.003,
      model: 'claude-haiku-4-5-20251001',
      latencyMs: 100,
      decisionId: null,
    });

    const result = await run();

    expect(result.items_found).toBe(2);
    expect(result.items_skipped).toBe(1); // The spam email
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toContain('fail-1');
    expect(result.errors[0].recoverable).toBe(true);
  });

  it('handles Gmail poll failure gracefully', async () => {
    mockGetGmailClient.mockReturnValue({} as ReturnType<typeof getGmailClient>);
    mockPollUnread.mockRejectedValue(new Error('Gmail API quota exceeded'));

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toBe('poll');
    expect(result.summary).toContain('Failed to poll Gmail');
  });
});
