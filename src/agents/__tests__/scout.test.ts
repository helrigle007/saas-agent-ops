import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnthropicCallResult } from '../../types';
import type { SafeResult } from '../../lib/supabase';

// Mock all shared libs before importing the agent
vi.mock('../../lib/anthropic', () => ({
  callAnthropic: vi.fn(),
}));

vi.mock('../../lib/queue', () => ({
  queueForReview: vi.fn().mockResolvedValue('queue-item-123'),
  isDuplicate: vi.fn().mockResolvedValue(false),
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
  safeInsert: vi.fn().mockResolvedValue({ data: [{ id: 'cached-1' }], tableExists: true, error: null }),
  safeSelect: vi.fn().mockResolvedValue({ data: [], tableExists: true, error: null }),
  safeUpdate: vi.fn().mockResolvedValue({ data: [], tableExists: true, error: null }),
}));

vi.mock('../../lib/decision-logger', () => ({
  linkDecisionToQueueItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/tools', () => ({
  threadDiscoveryTool: { name: 'report_threads', description: 'test', input_schema: {} },
  commentAnalysisTool: { name: 'report_comment_analysis', description: 'test', input_schema: {} },
  replyDraftingTool: { name: 'draft_reply', description: 'test', input_schema: {} },
}));

import { run } from '../scout';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview, isDuplicate } from '../../lib/queue';
import { safeSelect } from '../../lib/supabase';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockIsDuplicate = vi.mocked(isDuplicate);
const mockSafeSelect = vi.mocked(safeSelect);

function makeAnthropicResult(parsedOutput: Record<string, unknown> | null, overrides?: Partial<AnthropicCallResult>): AnthropicCallResult {
  return {
    text: '',
    parsedOutput,
    inputTokens: 100,
    outputTokens: 50,
    costCents: 0.5,
    model: 'claude-haiku-4-5-20251001',
    latencyMs: 200,
    decisionId: 'decision-123',
    ...overrides,
  };
}

describe('Scout Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: thread cache returns empty (no duplicates)
    mockSafeSelect.mockResolvedValue({ data: [], tableExists: true, error: null });

    // Default: no duplicates in queue
    mockIsDuplicate.mockResolvedValue(false);

    // Default: queue succeeds
    mockQueueForReview.mockResolvedValue('queue-item-123');
  });

  it('returns a valid AgentResult on a successful run', async () => {
    // Thread discovery returns 1 thread per platform with high relevance
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        return makeAnthropicResult({
          threads: [
            {
              platform: 'reddit',
              thread_url: `https://reddit.com/r/SaaS/test-${options.decisionType}`,
              thread_title: 'Best project tracking tools for small teams?',
              thread_snippet: 'We just started scaling our team...',
              relevance_score: 0.8,
              engagement_goal: 'helpful',
            },
          ],
        });
      }
      if (options.decisionType === 'comment_analysis') {
        return makeAnthropicResult({
          total_replies: 3,
          quality_summary: 'Partially answered',
          conversation_tone: 'friendly',
          gaps: [
            { type: 'missing_context', description: 'No one mentioned team size considerations', severity: 'medium' },
          ],
          recommendation: 'draft',
          recommendation_reason: 'Team size context missing',
        });
      }
      if (options.decisionType === 'reply_drafting') {
        return makeAnthropicResult({
          reply_text: 'For a 5-person team you want something lightweight. Most enterprise tools have too much overhead for that size.',
          addresses_gap: 'Added small team perspective',
          tone_check: 'natural',
          confidence: 0.85,
        });
      }
      return makeAnthropicResult(null);
    });

    const result = await run();

    expect(result).toHaveProperty('items_found');
    expect(result).toHaveProperty('items_queued');
    expect(result).toHaveProperty('items_skipped');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.summary).toBe('string');
    expect(result.items_found).toBeGreaterThan(0);
    expect(result.items_queued).toBeGreaterThan(0);
  });

  it('skips threads below 0.6 relevance score', async () => {
    // All platforms return low-relevance threads
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        return makeAnthropicResult({
          threads: [
            {
              platform: 'reddit',
              thread_url: `https://reddit.com/low-relevance-${options.decisionType}`,
              thread_title: 'Off-topic discussion',
              thread_snippet: 'Something not related...',
              relevance_score: 0.3,
              engagement_goal: 'credibility',
            },
          ],
        });
      }
      // comment_analysis and reply_drafting should NOT be called
      return makeAnthropicResult(null);
    });

    const result = await run();

    // Should have found threads but skipped all (low relevance)
    expect(result.items_found).toBeGreaterThan(0);
    expect(result.items_queued).toBe(0);
    expect(result.items_skipped).toBeGreaterThan(0);

    // Verify comment_analysis was never called
    const commentAnalysisCalls = mockCallAnthropic.mock.calls.filter(
      ([opts]) => opts.decisionType === 'comment_analysis',
    );
    expect(commentAnalysisCalls.length).toBe(0);
  });

  it('does not re-queue duplicate threads already in cache', async () => {
    const existingUrl = 'https://reddit.com/r/SaaS/existing-thread';

    // Thread discovery returns a thread that already exists in cache
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        return makeAnthropicResult({
          threads: [
            {
              platform: 'reddit',
              thread_url: existingUrl,
              thread_title: 'Already cached thread',
              relevance_score: 0.9,
              engagement_goal: 'helpful',
            },
          ],
        });
      }
      return makeAnthropicResult(null);
    });

    // Thread cache returns this URL as existing
    mockSafeSelect.mockResolvedValue({
      data: [{ thread_url: existingUrl }] as unknown[],
      tableExists: true,
      error: null,
    } as SafeResult<unknown[]>);

    const result = await run();

    // The thread was found but deduplicated, so nothing queued
    expect(result.items_found).toBeGreaterThan(0);
    expect(result.items_queued).toBe(0);

    // comment_analysis should not be called since thread was deduped
    const commentAnalysisCalls = mockCallAnthropic.mock.calls.filter(
      ([opts]) => opts.decisionType === 'comment_analysis',
    );
    expect(commentAnalysisCalls.length).toBe(0);
  });

  it('handles platform failure gracefully (partial success)', async () => {
    let callCount = 0;

    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        callCount++;
        // First platform throws an error
        if (callCount === 1) {
          throw new Error('Reddit API timeout');
        }
        // Second and third platforms succeed with high-relevance threads
        return makeAnthropicResult({
          threads: [
            {
              platform: 'indiehackers',
              thread_url: `https://indiehackers.com/thread-${callCount}`,
              thread_title: 'Project tracking question',
              relevance_score: 0.85,
              engagement_goal: 'helpful',
            },
          ],
        });
      }
      if (options.decisionType === 'comment_analysis') {
        return makeAnthropicResult({
          total_replies: 2,
          quality_summary: 'Needs more info',
          conversation_tone: 'casual',
          gaps: [{ type: 'unanswered_followup', description: 'OP asked follow-up no one answered', severity: 'high' }],
          recommendation: 'draft',
          recommendation_reason: 'Unanswered follow-up',
        });
      }
      if (options.decisionType === 'reply_drafting') {
        return makeAnthropicResult({
          reply_text: 'Yeah for distributed teams you really want async updates baked in...',
          addresses_gap: 'Addressed follow-up about async workflows',
          tone_check: 'natural',
          confidence: 0.8,
        });
      }
      return makeAnthropicResult(null);
    });

    const result = await run();

    // Should have errors from the failed platform
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].step).toContain('discovery');
    expect(result.errors[0].recoverable).toBe(true);

    // But should still have queued items from other platforms
    expect(result.items_queued).toBeGreaterThan(0);
    expect(result.summary).toContain('errors');
  });

  it('queues skip log for threads where analysis recommends skip', async () => {
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        return makeAnthropicResult({
          threads: [
            {
              platform: 'reddit',
              thread_url: `https://reddit.com/r/SaaS/well-answered-${options.decisionType}`,
              thread_title: 'Basic project tracking question',
              relevance_score: 0.75,
              engagement_goal: 'credibility',
            },
          ],
        });
      }
      if (options.decisionType === 'comment_analysis') {
        return makeAnthropicResult({
          total_replies: 12,
          quality_summary: 'Thoroughly answered by multiple experienced users',
          conversation_tone: 'friendly',
          gaps: [],
          recommendation: 'skip',
          recommendation_reason: 'Thread is well-covered with accurate information from multiple sources',
        });
      }
      return makeAnthropicResult(null);
    });

    const result = await run();

    // Should have skip log queue calls
    const skipLogCalls = mockQueueForReview.mock.calls.filter(
      ([input]) => input.task_type === 'forum_skip_log',
    );
    expect(skipLogCalls.length).toBeGreaterThan(0);
    expect(skipLogCalls[0][0].priority).toBe('low');

    // No reply drafts should have been queued
    const replyCalls = mockQueueForReview.mock.calls.filter(
      ([input]) => input.task_type === 'forum_reply',
    );
    expect(replyCalls.length).toBe(0);
  });

  it('does not queue reply if isDuplicate returns true', async () => {
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        return makeAnthropicResult({
          threads: [
            {
              platform: 'reddit',
              thread_url: `https://reddit.com/r/SaaS/dup-thread-${options.decisionType}`,
              thread_title: 'Already queued thread',
              relevance_score: 0.9,
              engagement_goal: 'helpful',
            },
          ],
        });
      }
      if (options.decisionType === 'comment_analysis') {
        return makeAnthropicResult({
          total_replies: 2,
          quality_summary: 'Needs more info',
          conversation_tone: 'casual',
          gaps: [{ type: 'unanswered_followup', description: 'Needs answer', severity: 'high' }],
          recommendation: 'draft',
          recommendation_reason: 'Gap found',
        });
      }
      if (options.decisionType === 'reply_drafting') {
        return makeAnthropicResult({
          reply_text: 'Some draft text',
          addresses_gap: 'Addressed gap',
          confidence: 0.8,
        });
      }
      return makeAnthropicResult(null);
    });

    // isDuplicate returns true — a pending forum_reply already exists for this URL
    mockIsDuplicate.mockResolvedValue(true);

    const result = await run();

    // forum_reply should NOT be queued
    const replyCalls = mockQueueForReview.mock.calls.filter(
      ([input]) => input.task_type === 'forum_reply',
    );
    expect(replyCalls.length).toBe(0);
    expect(result.items_skipped).toBeGreaterThan(0);
  });

  it('returns correct queue payload structure for forum_reply', async () => {
    mockCallAnthropic.mockImplementation(async (options) => {
      if (options.decisionType.startsWith('thread_discovery')) {
        // Only return from the first platform to simplify
        if (options.decisionType === 'thread_discovery_reddit') {
          return makeAnthropicResult({
            threads: [
              {
                platform: 'reddit',
                thread_url: 'https://reddit.com/r/SaaS/payload-test',
                thread_title: 'Testing payload structure',
                thread_snippet: 'Some snippet text',
                relevance_score: 0.9,
                engagement_goal: 'credibility',
              },
            ],
          });
        }
        return makeAnthropicResult({ threads: [] });
      }
      if (options.decisionType === 'comment_analysis') {
        return makeAnthropicResult({
          total_replies: 5,
          quality_summary: 'Partial coverage',
          conversation_tone: 'technical',
          gaps: [{ type: 'misinformation', description: 'Wrong pricing tier referenced', severity: 'high' }],
          recommendation: 'draft',
          recommendation_reason: 'Misinformation needs correction',
        });
      }
      if (options.decisionType === 'reply_drafting') {
        return makeAnthropicResult({
          reply_text: 'Actually they changed that in their latest pricing update...',
          addresses_gap: 'Corrected pricing reference',
          tone_check: 'natural',
          confidence: 0.9,
        });
      }
      return makeAnthropicResult(null);
    });

    await run();

    const replyCalls = mockQueueForReview.mock.calls.filter(
      ([input]) => input.task_type === 'forum_reply',
    );
    expect(replyCalls.length).toBe(1);

    const payload = replyCalls[0][0];
    expect(payload.agent).toBe('scout');
    expect(payload.task_type).toBe('forum_reply');
    expect(payload.source_url).toBe('https://reddit.com/r/SaaS/payload-test');
    expect(payload.priority).toBe('normal');
    expect(payload.confidence).toBe(0.9);

    const content = payload.content;
    expect(content).toHaveProperty('platform', 'reddit');
    expect(content).toHaveProperty('thread_url');
    expect(content).toHaveProperty('thread_title');
    expect(content).toHaveProperty('thread_snippet');
    expect(content).toHaveProperty('comment_analysis');
    expect(content).toHaveProperty('draft_reply');
    expect(content).toHaveProperty('suggested_goal', 'credibility');

    const analysis = content.comment_analysis as Record<string, unknown>;
    expect(analysis).toHaveProperty('total_replies');
    expect(analysis).toHaveProperty('quality_summary');
    expect(analysis).toHaveProperty('identified_gap');
    expect(analysis).toHaveProperty('reply_strategy');
    expect(analysis).toHaveProperty('conversation_tone');
  });
});
