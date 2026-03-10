import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnthropicCallResult } from '../../types';
import type { SafeResult } from '../../lib/supabase';

// Mock all shared libs before importing the agent
vi.mock('../../lib/anthropic', () => ({
  callAnthropic: vi.fn(),
}));

vi.mock('../../lib/queue', () => ({
  queueForReview: vi.fn().mockResolvedValue('queue-item-456'),
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
  safeInsert: vi.fn().mockResolvedValue({ data: [], tableExists: true, error: null }),
  safeSelect: vi.fn().mockResolvedValue({ data: [], tableExists: true, error: null }),
  safeUpdate: vi.fn().mockResolvedValue({ data: [], tableExists: true, error: null }),
}));

vi.mock('../../lib/tools', () => ({
  trendRadarTool: { name: 'report_trends', description: 'test', input_schema: {} },
}));

import { run } from '../scribe-radar';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect } from '../../lib/supabase';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);

function makeAnthropicResult(parsedOutput: Record<string, unknown> | null, overrides?: Partial<AnthropicCallResult>): AnthropicCallResult {
  return {
    text: '',
    parsedOutput,
    inputTokens: 150,
    outputTokens: 80,
    costCents: 0.6,
    model: 'claude-haiku-4-5-20251001',
    latencyMs: 300,
    decisionId: 'decision-456',
    ...overrides,
  };
}

function makeTrendResult(trends: Array<Record<string, unknown>>): AnthropicCallResult {
  return makeAnthropicResult({ trends });
}

describe('Scribe Radar Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueForReview.mockResolvedValue('queue-item-456');
  });

  it('returns a valid AgentResult on a successful run', async () => {
    // Thread cache has threads
    let selectCallCount = 0;
    mockSafeSelect.mockImplementation(async (table) => {
      selectCallCount++;
      if (table === 'admin_thread_cache') {
        return {
          data: [
            {
              id: '1',
              platform: 'reddit',
              thread_url: 'https://reddit.com/r/SaaS/thread1',
              thread_title: 'Project tracking for distributed teams',
              thread_snippet: 'Our team works across three time zones...',
              relevance_score: 0.8,
              status: 'new',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            {
              id: '2',
              platform: 'indiehackers',
              thread_url: 'https://indiehackers.com/thread2',
              thread_title: 'AI features coming to PM tools',
              thread_snippet: 'Has anyone tried the new AI planning features...',
              relevance_score: 0.9,
              status: 'analyzed',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            {
              id: '3',
              platform: 'reddit',
              thread_url: 'https://reddit.com/r/startups/thread3',
              thread_title: 'Asana pricing changing again?',
              thread_snippet: 'Heard a rumor about...',
              relevance_score: 0.7,
              status: 'new',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            {
              id: '4',
              platform: 'producthunt',
              thread_url: 'https://forums.producthunt.com/thread4',
              thread_title: 'Best way to track client project hours',
              thread_snippet: 'My team lead doesnt...',
              relevance_score: 0.85,
              status: 'new',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            {
              id: '5',
              platform: 'reddit',
              thread_url: 'https://reddit.com/r/SaaS/thread5',
              thread_title: 'Migrating projects from Jira to Linear',
              thread_snippet: 'Switching tools next quarter...',
              relevance_score: 0.75,
              status: 'new',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return {
          data: [
            {
              id: 'p1',
              title: 'Complete Guide to Agile Project Setup',
              content_type: 'state_guide',
              status: 'drafted',
              priority: 'high',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    // AI returns trend ideas
    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Distributed Team Project Tracking Guide',
          content_type: 'blog_post',
          trend_score: 0.85,
          priority: 'high',
          source: 'reddit threads',
          source_threads: ['https://reddit.com/r/SaaS/thread1'],
          reasoning: 'Multiple threads about distributed team coordination',
          angle: 'Step-by-step for teams working across time zones',
          target_keywords: ['distributed team project tracking', 'migrate project data'],
        },
        {
          title: 'AI in PM Tools: What Changes for Teams',
          content_type: 'blog_post',
          trend_score: 0.9,
          priority: 'urgent',
          source: 'indiehackers + web',
          source_threads: ['https://indiehackers.com/thread2'],
          reasoning: 'AI features generating lots of questions',
          angle: 'Practical impact of AI features on day-to-day project management',
          target_keywords: ['AI project management', 'AI features PM tools'],
        },
        {
          title: 'How Different Teams Track Projects Differently',
          content_type: 'blog_post',
          trend_score: 0.7,
          priority: 'normal',
          source: 'startups subreddit',
          source_threads: ['https://reddit.com/r/startups/thread3'],
          reasoning: 'Confusion around different workflow methodologies',
        },
      ]),
    );

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
    expect(result.items_found).toBe(3);
    expect(result.items_queued).toBe(3);
    expect(result.errors.length).toBe(0);
  });

  it('deduplicates against existing pipeline titles', async () => {
    // Thread cache has enough threads (>= 5)
    mockSafeSelect.mockImplementation(async (table) => {
      if (table === 'admin_thread_cache') {
        return {
          data: Array.from({ length: 6 }, (_, i) => ({
            id: `t${i}`,
            platform: 'reddit',
            thread_url: `https://reddit.com/thread${i}`,
            thread_title: `Thread ${i}`,
            relevance_score: 0.8,
            status: 'new',
            discovered_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })),
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return {
          data: [
            {
              id: 'existing-1',
              title: 'Guide to Agile Sprint Planning',
              content_type: 'state_guide',
              status: 'idea',
              priority: 'normal',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    // AI returns ideas, one of which duplicates the existing pipeline
    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Guide to Agile Sprint Planning',
          content_type: 'state_guide',
          trend_score: 0.8,
          priority: 'high',
          source: 'reddit',
          reasoning: 'Same as existing pipeline item',
        },
        {
          title: 'Asana vs Monday: Feature Comparison for Small Teams',
          content_type: 'blog_post',
          trend_score: 0.75,
          priority: 'normal',
          source: 'forums',
          reasoning: 'New topic not in pipeline',
        },
      ]),
    );

    const result = await run();

    // One idea should be skipped (duplicate), one queued
    expect(result.items_found).toBe(2);
    expect(result.items_queued).toBe(1);
    expect(result.items_skipped).toBe(1);

    // Verify the queued idea is the non-duplicate
    expect(mockQueueForReview).toHaveBeenCalledTimes(1);
    const queuedContent = mockQueueForReview.mock.calls[0][0];
    expect(queuedContent.title).toBe('Asana vs Monday: Feature Comparison for Small Teams');
  });

  it('enables web search when thread cache is sparse', async () => {
    // Thread cache returns fewer than 5 threads
    mockSafeSelect.mockImplementation(async (table) => {
      if (table === 'admin_thread_cache') {
        return {
          data: [
            {
              id: 't1',
              platform: 'reddit',
              thread_url: 'https://reddit.com/sparse1',
              thread_title: 'Only one thread',
              relevance_score: 0.6,
              status: 'new',
              discovered_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Web-sourced trend idea',
          content_type: 'blog_post',
          trend_score: 0.7,
          priority: 'normal',
          source: 'web search',
          reasoning: 'Found via web search due to sparse cache',
        },
      ]),
    );

    const result = await run();

    // Verify that callAnthropic was called with enableWebSearch: true
    expect(mockCallAnthropic).toHaveBeenCalledTimes(1);
    const callOptions = mockCallAnthropic.mock.calls[0][0];
    expect(callOptions.enableWebSearch).toBe(true);

    // Should still work and queue items
    expect(result.items_queued).toBe(1);
    expect(result.summary).toContain('sparse');
  });

  it('does not enable web search when thread cache is sufficient', async () => {
    // Thread cache returns >= 5 threads
    mockSafeSelect.mockImplementation(async (table) => {
      if (table === 'admin_thread_cache') {
        return {
          data: Array.from({ length: 8 }, (_, i) => ({
            id: `t${i}`,
            platform: 'reddit',
            thread_url: `https://reddit.com/thread${i}`,
            thread_title: `Active thread ${i}`,
            relevance_score: 0.8,
            status: 'new',
            discovered_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })),
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Cache-sourced idea',
          content_type: 'blog_post',
          trend_score: 0.8,
          priority: 'normal',
          source: 'thread cache',
          reasoning: 'Pattern from cached threads',
        },
      ]),
    );

    await run();

    // Verify web search was NOT enabled
    expect(mockCallAnthropic).toHaveBeenCalledTimes(1);
    const callOptions = mockCallAnthropic.mock.calls[0][0];
    expect(callOptions.enableWebSearch).toBe(false);
  });

  it('handles empty thread cache gracefully', async () => {
    mockSafeSelect.mockImplementation(async (table) => {
      if (table === 'admin_thread_cache') {
        return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Web-only trend',
          content_type: 'social_post',
          trend_score: 0.6,
          priority: 'normal',
          source: 'web search',
          reasoning: 'No cache data, sourced from web',
        },
      ]),
    );

    const result = await run();

    // Should still succeed with web search fallback
    expect(result.errors.length).toBe(0);
    expect(result.items_queued).toBe(1);
    expect(mockCallAnthropic.mock.calls[0][0].enableWebSearch).toBe(true);
  });

  it('handles tables not existing yet', async () => {
    mockSafeSelect.mockResolvedValue({
      data: null,
      tableExists: false,
      error: null,
    } as SafeResult<unknown[]>);

    mockCallAnthropic.mockResolvedValue(
      makeTrendResult([
        {
          title: 'Some trend',
          content_type: 'blog_post',
          trend_score: 0.7,
          priority: 'normal',
          source: 'web',
          reasoning: 'test',
        },
      ]),
    );

    const result = await run();

    // Should handle gracefully — sparse cache triggers web search
    expect(result.errors.length).toBe(0);
    expect(result.items_queued).toBe(1);
  });

  it('limits queued ideas to MAX_IDEAS_PER_RUN (5)', async () => {
    mockSafeSelect.mockImplementation(async (table) => {
      if (table === 'admin_thread_cache') {
        return {
          data: Array.from({ length: 10 }, (_, i) => ({
            id: `t${i}`,
            platform: 'reddit',
            thread_url: `https://reddit.com/thread${i}`,
            thread_title: `Thread ${i}`,
            relevance_score: 0.8,
            status: 'new',
            discovered_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })),
          tableExists: true,
          error: null,
        } as SafeResult<unknown[]>;
      }
      if (table === 'admin_content_pipeline') {
        return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
      }
      return { data: [], tableExists: true, error: null } as SafeResult<unknown[]>;
    });

    // Return 8 ideas (more than the 5 limit)
    mockCallAnthropic.mockResolvedValue(
      makeTrendResult(
        Array.from({ length: 8 }, (_, i) => ({
          title: `Trend idea ${i}`,
          content_type: 'blog_post',
          trend_score: 0.9 - i * 0.05,
          priority: 'normal',
          source: 'cache',
          reasoning: `Reasoning for idea ${i}`,
        })),
      ),
    );

    const result = await run();

    // Only 5 should be queued, 3 skipped
    expect(result.items_found).toBe(8);
    expect(result.items_queued).toBe(5);
    expect(result.items_skipped).toBe(3);
    expect(mockQueueForReview).toHaveBeenCalledTimes(5);
  });
});
