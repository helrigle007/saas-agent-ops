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

vi.mock('../../lib/decision-logger', () => ({
  linkDecisionToQueueItem: vi.fn(),
}));

vi.mock('../../lib/tools', () => ({
  competitorScanTool: { name: 'report_competitor_intel', description: 'mock', input_schema: {} },
  seoCheckTool: { name: 'report_seo_status', description: 'mock', input_schema: {} },
}));

import { run } from '../watchdog';
import { callAnthropic } from '../../lib/anthropic';
import { queueForReview } from '../../lib/queue';
import { linkDecisionToQueueItem } from '../../lib/decision-logger';

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockQueueForReview = vi.mocked(queueForReview);
const mockLinkDecision = vi.mocked(linkDecisionToQueueItem);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Watchdog Agent', () => {
  describe('daily mode', () => {
    it('queues competitor alerts found during daily scan', async () => {
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          alerts: [
            {
              alert_type: 'competitor_pricing',
              title: 'RivalBoard lowered pricing',
              details: 'RivalBoard dropped monthly plan from $9.99 to $7.99',
              implications: 'May need to revisit our pricing strategy',
              recommended_action: 'Monitor for 2 weeks, consider matching',
              evidence_url: 'https://rivalboard.com/pricing',
              priority: 'high',
            },
            {
              alert_type: 'mention',
              title: 'TrackBoard mentioned on Reddit',
              details: 'User recommended TrackBoard in r/SaaS thread',
              implications: 'Positive brand awareness signal',
              evidence_url: 'https://reddit.com/r/SaaS/123',
              priority: 'low',
            },
          ],
        },
        inputTokens: 500,
        outputTokens: 300,
        costCents: 0.05,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 2000,
        decisionId: 'dec-123',
      });

      mockQueueForReview
        .mockResolvedValueOnce('queue-1')
        .mockResolvedValueOnce('queue-2');

      const result = await run('daily');

      expect(result.items_found).toBe(2);
      expect(result.items_queued).toBe(2);
      expect(result.items_skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify callAnthropic was called once (competitor scan only, no SEO in daily)
      expect(mockCallAnthropic).toHaveBeenCalledTimes(1);
      expect(mockCallAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'watchdog',
          decisionType: 'competitor_scan_daily',
          enableWebSearch: true,
        }),
      );

      // Verify both alerts were queued
      expect(mockQueueForReview).toHaveBeenCalledTimes(2);
      expect(mockQueueForReview).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'watchdog',
          task_type: 'competitor_alert',
          title: '[competitor_pricing] RivalBoard lowered pricing',
          priority: 'high',
        }),
      );

      // Verify decision was linked to queue items
      expect(mockLinkDecision).toHaveBeenCalledTimes(2);
      expect(mockLinkDecision).toHaveBeenCalledWith('dec-123', 'queue-1');
      expect(mockLinkDecision).toHaveBeenCalledWith('dec-123', 'queue-2');
    });

    it('returns zero items when no alerts found (daily)', async () => {
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: { alerts: [] },
        inputTokens: 400,
        outputTokens: 50,
        costCents: 0.01,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 1500,
        decisionId: 'dec-456',
      });

      const result = await run('daily');

      expect(result.items_found).toBe(0);
      expect(result.items_queued).toBe(0);
      expect(result.items_skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockQueueForReview).not.toHaveBeenCalled();
    });

    it('does not run SEO check in daily mode', async () => {
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: { alerts: [] },
        inputTokens: 400,
        outputTokens: 50,
        costCents: 0.01,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 1500,
        decisionId: null,
      });

      await run('daily');

      // Only one call (competitor scan), no SEO check
      expect(mockCallAnthropic).toHaveBeenCalledTimes(1);
      expect(mockCallAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ decisionType: 'competitor_scan_daily' }),
      );
    });
  });

  describe('weekly mode', () => {
    it('queues alerts + SEO report in weekly mode', async () => {
      // First call: competitor scan
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          alerts: [
            {
              alert_type: 'new_competitor',
              title: 'New app: TradeTracker',
              details: 'New project tracking app launched on App Store',
              implications: 'Additional competitor in the market',
              priority: 'normal',
            },
          ],
        },
        inputTokens: 800,
        outputTokens: 400,
        costCents: 0.08,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 3000,
        decisionId: 'dec-weekly-1',
      });

      // Second call: SEO check
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          keyword_rankings: [
            { keyword: 'project tracking app', position: 5, change: 'up' },
            { keyword: 'team task management tool', position: 12, change: 'stable' },
            { keyword: 'kanban board software', position: 3, change: 'new' },
          ],
          backlink_opportunities: [
            {
              source_url: 'https://saasreview.com/best-project-tools',
              context: 'Listicle of best project tools, does not mention TrackBoard',
              opportunity_type: 'resource_suggestion',
            },
          ],
          summary: 'TrackBoard ranking stable for core keywords. One new ranking for kanban board software.',
        },
        inputTokens: 1000,
        outputTokens: 600,
        costCents: 0.10,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 4000,
        decisionId: 'dec-weekly-2',
      });

      mockQueueForReview
        .mockResolvedValueOnce('queue-w1')  // competitor alert
        .mockResolvedValueOnce('queue-w2'); // SEO report

      const result = await run('weekly');

      // 1 alert + 1 SEO report = 2 items found, 2 queued
      expect(result.items_found).toBe(2);
      expect(result.items_queued).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Verify two AI calls (competitor scan + SEO check)
      expect(mockCallAnthropic).toHaveBeenCalledTimes(2);
      expect(mockCallAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ decisionType: 'competitor_scan_weekly' }),
      );
      expect(mockCallAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ decisionType: 'seo_check' }),
      );

      // Verify SEO report was queued with correct content
      expect(mockQueueForReview).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'watchdog',
          task_type: 'seo_report',
          content: expect.objectContaining({
            report_type: 'weekly_seo',
            keyword_rankings: expect.arrayContaining([
              expect.objectContaining({ keyword: 'project tracking app', position: 5 }),
            ]),
            backlink_opportunities: expect.arrayContaining([
              expect.objectContaining({ source_url: 'https://saasreview.com/best-project-tools' }),
            ]),
          }),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('handles web search failure gracefully', async () => {
      mockCallAnthropic.mockRejectedValueOnce(new Error('Web search API timeout'));

      const result = await run('daily');

      expect(result.items_found).toBe(0);
      expect(result.items_queued).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        step: 'competitor_scan',
        message: 'Web search API timeout',
        recoverable: true,
      });
    });

    it('handles SEO check failure but still returns competitor alerts in weekly mode', async () => {
      // Competitor scan succeeds with one alert
      mockCallAnthropic.mockResolvedValueOnce({
        text: '',
        parsedOutput: {
          alerts: [
            {
              alert_type: 'mention',
              title: 'TrackBoard mentioned in blog',
              details: 'Featured in trade publication article',
              priority: 'normal',
            },
          ],
        },
        inputTokens: 500,
        outputTokens: 200,
        costCents: 0.04,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 2000,
        decisionId: 'dec-err-1',
      });

      // SEO check fails
      mockCallAnthropic.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      mockQueueForReview.mockResolvedValueOnce('queue-err-1');

      const result = await run('weekly');

      // Competitor alert was found and queued, SEO failed
      expect(result.items_found).toBe(1);
      expect(result.items_queued).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        step: 'seo_check',
        message: 'Rate limit exceeded',
        recoverable: true,
      });
    });

    it('handles unparseable AI response with warning', async () => {
      mockCallAnthropic.mockResolvedValueOnce({
        text: 'I could not complete the scan.',
        parsedOutput: null,
        inputTokens: 300,
        outputTokens: 50,
        costCents: 0.01,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 1000,
        decisionId: null,
      });

      const result = await run('daily');

      expect(result.items_found).toBe(0);
      expect(result.items_queued).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('No structured output');
    });
  });
});
