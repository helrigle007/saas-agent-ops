import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnthropicCallOptions, AnthropicCallResult, ContentPipelineRow, QueueItemInput } from '../../types';
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
  contentDraftingTool: { name: 'draft_content', description: 'mock', input_schema: {} },
}));

import { run } from '../scribe-draft';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { safeSelect, safeUpdate } from '../../lib/supabase';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockSafeSelect = vi.mocked(safeSelect);
const mockSafeUpdate = vi.mocked(safeUpdate);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

function makePipelineItem(overrides: Partial<ContentPipelineRow> = {}): ContentPipelineRow {
  return {
    id: 'pipeline-001',
    title: 'How to Set Up Project Tracking for Remote Teams',
    content_type: 'blog_post',
    status: 'idea',
    priority: 'high',
    source: 'scribe-radar',
    source_threads: [{ url: 'https://reddit.com/r/SaaS/123', title: 'remote teams question' }],
    trend_score: 0.85,
    outline: null,
    draft: null,
    seo_metadata: null,
    target_date: '2026-03-15',
    created_at: '2026-03-09T01:00:00Z',
    updated_at: '2026-03-09T01:00:00Z',
    ...overrides,
  };
}

function makeAiResult(overrides: Partial<AnthropicCallResult> = {}): AnthropicCallResult {
  return {
    text: '',
    parsedOutput: {
      title: 'How to Set Up Project Tracking for Remote Teams',
      slug: 'set-up-project-tracking-remote-teams',
      content_type: 'blog_post',
      body: '# How to Set Up Project Tracking for Remote Teams\n\nFull article content here...',
      meta_title: 'Project Tracking for Remote Teams | TrackBoard',
      meta_description: 'Learn how to set up project tracking for remote teams, including async workflows and integration tips.',
      target_keywords: ['project tracking remote teams', 'remote team collaboration'],
      word_count: 1420,
      outline: '1. Introduction\n2. Remote Challenges\n3. Tracking Methods\n4. Common Mistakes',
      sources: ['https://trackboard.app/guides/remote-teams'],
    },
    inputTokens: 5000,
    outputTokens: 3000,
    costCents: 6.0,
    model: 'claude-sonnet-4-20250514',
    latencyMs: 8500,
    decisionId: 'decision-001',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSafeUpdate.mockResolvedValue({ data: null, tableExists: true, error: null });
});

describe('scribe-draft agent', () => {
  it('drafts content from an available pipeline item and queues it', async () => {
    const item = makePipelineItem();
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(1);
    expect(result.items_skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.summary).toContain('blog_post');
  });

  it('returns skipped when no pipeline items are available', async () => {
    mockSafeSelect.mockResolvedValue({
      data: [],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.items_queued).toBe(0);
    expect(result.summary).toContain('skipped');
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('transitions pipeline status from idea -> drafting -> drafted', async () => {
    const item = makePipelineItem({ status: 'idea' });
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    // First update: status -> drafting
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_content_pipeline',
      expect.objectContaining({ status: 'drafting' }),
      'id',
      'pipeline-001',
    );

    // Second update: status -> drafted
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_content_pipeline',
      expect.objectContaining({ status: 'drafted' }),
      'id',
      'pipeline-001',
    );
  });

  it('uses Sonnet model for content drafting', async () => {
    const item = makePipelineItem();
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    expect(mockCallAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'sonnet',
        agent: 'scribe-draft',
        enableWebSearch: true,
      }),
    );
  });

  it('links decision to queue item after queuing', async () => {
    const item = makePipelineItem();
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult({ decisionId: 'dec-123' }));
    mockQueueForReview.mockResolvedValue('queue-456');

    await run();

    expect(mockLinkDecision).toHaveBeenCalledWith('dec-123', 'queue-456');
  });

  it('reverts pipeline status when AI returns invalid draft', async () => {
    const item = makePipelineItem({ status: 'outlined' });
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult({ parsedOutput: null }));

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(0);
    expect(result.items_skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].step).toBe('content_drafting');

    // Should revert to original status
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_content_pipeline',
      expect.objectContaining({ status: 'outlined' }),
      'id',
      'pipeline-001',
    );
  });

  it('reverts pipeline status when AI call throws', async () => {
    const item = makePipelineItem({ status: 'idea' });
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockRejectedValue(new Error('API rate limited'));

    const result = await run();

    expect(result.items_found).toBe(1);
    expect(result.items_queued).toBe(0);
    expect(result.items_skipped).toBe(1);
    expect(result.errors[0].message).toBe('API rate limited');

    // Should revert to original status
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_content_pipeline',
      expect.objectContaining({ status: 'idea' }),
      'id',
      'pipeline-001',
    );
  });

  it('handles table not existing gracefully', async () => {
    mockSafeSelect.mockResolvedValue({
      data: null,
      tableExists: false,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    const result = await run();

    expect(result.items_found).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].step).toBe('fetch_pipeline');
  });

  it('prioritizes urgent items over lower priority ones', async () => {
    const normalItem = makePipelineItem({ id: 'normal-001', priority: 'normal', target_date: '2026-03-12' });
    const urgentItem = makePipelineItem({ id: 'urgent-001', priority: 'urgent', target_date: '2026-03-20' });

    mockSafeSelect.mockResolvedValue({
      data: [normalItem, urgentItem],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    // Should update the urgent item (sorted first)
    expect(mockSafeUpdate).toHaveBeenCalledWith(
      'admin_content_pipeline',
      expect.objectContaining({ status: 'drafting' }),
      'id',
      'urgent-001',
    );
  });

  it('passes correct queue content structure', async () => {
    const item = makePipelineItem();
    mockSafeSelect.mockResolvedValue({
      data: [item],
      tableExists: true,
      error: null,
    } as SafeResult<ContentPipelineRow[]>);

    mockCallAnthropic.mockResolvedValue(makeAiResult());
    mockQueueForReview.mockResolvedValue('queue-001');

    await run();

    expect(mockQueueForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'scribe-draft',
        task_type: 'blog_post_draft',
        content: expect.objectContaining({
          pipeline_item_id: 'pipeline-001',
          content_type: 'blog_post',
          word_count: 1420,
          seo: expect.objectContaining({
            meta_title: expect.any(String),
            meta_description: expect.any(String),
            target_keywords: expect.any(Array),
          }),
        }),
      }),
    );
  });
});
