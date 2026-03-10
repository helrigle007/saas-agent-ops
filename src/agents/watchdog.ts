import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { competitorScanTool, seoCheckTool } from '../lib/tools';
import type { AgentResult, AgentError, AgentWarning } from '../types';

const log = createAgentLogger('watchdog');

const TARGET_KEYWORDS = [
  'project tracking app',
  'team task management tool',
  'project management SaaS',
  'kanban board software',
  'project time tracking',
  'agile project tracker',
  'team productivity dashboard',
  'project collaboration tool',
  'task management for teams',
  'project planning software',
];

/**
 * Watchdog Agent — SEO + competitor intel.
 *
 * Daily mode (8 AM Mon-Sat): lightweight mention/alert check.
 * Weekly mode (Sunday 3 AM): deep RivalBoard monitor + SEO keyword rankings + backlinks.
 */
export async function run(mode: 'daily' | 'weekly' = 'daily'): Promise<AgentResult> {
  log.info({ mode }, `Watchdog starting ${mode} scan`);

  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];
  let itemsFound = 0;
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // ── Step 1: Competitor scan (both modes) ──────────────────────────
  try {
    const scanResult = await runCompetitorScan(mode);
    itemsFound += scanResult.alertsFound;
    itemsQueued += scanResult.alertsQueued;
    itemsSkipped += scanResult.alertsSkipped;

    if (scanResult.warnings.length > 0) {
      warnings.push(...scanResult.warnings);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ step: 'competitor_scan', error: message }, 'Competitor scan failed');
    errors.push({ step: 'competitor_scan', message, recoverable: true });
  }

  // ── Step 2: SEO check (weekly mode only) ──────────────────────────
  if (mode === 'weekly') {
    try {
      const seoResult = await runSeoCheck();
      itemsFound += seoResult.itemsFound;
      itemsQueued += seoResult.itemsQueued;

      if (seoResult.warnings.length > 0) {
        warnings.push(...seoResult.warnings);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ step: 'seo_check', error: message }, 'SEO check failed');
      errors.push({ step: 'seo_check', message, recoverable: true });
    }
  }

  const summary =
    mode === 'daily'
      ? `Daily scan: ${itemsFound} alerts found, ${itemsQueued} queued, ${itemsSkipped} skipped`
      : `Weekly scan: ${itemsFound} items found, ${itemsQueued} queued (includes SEO report)`;

  log.info({ itemsFound, itemsQueued, itemsSkipped, mode }, summary);

  return {
    items_found: itemsFound,
    items_queued: itemsQueued,
    items_skipped: itemsSkipped,
    errors,
    warnings,
    summary,
  };
}

// ─── Competitor Scan ─────────────────────────────────────────────────

interface CompetitorScanResult {
  alertsFound: number;
  alertsQueued: number;
  alertsSkipped: number;
  warnings: AgentWarning[];
}

async function runCompetitorScan(mode: 'daily' | 'weekly'): Promise<CompetitorScanResult> {
  const warnings: AgentWarning[] = [];

  const systemPrompt = loadPrompt('watchdog/competitor-scan', { mode });

  const userPrompt =
    mode === 'daily'
      ? 'Run the daily competitor and market scan. Report any noteworthy findings from the last 48 hours.'
      : 'Run the weekly deep competitive analysis. Cover RivalBoard, market landscape, regulatory changes, and industry signals.';

  log.info({ mode }, 'Running competitor scan');

  const result = await callAnthropic({
    agent: 'watchdog',
    decisionType: `competitor_scan_${mode}`,
    systemPrompt,
    userPrompt,
    model: 'haiku',
    tools: [competitorScanTool],
    toolChoice: { type: 'tool', name: 'report_competitor_intel' },
    enableWebSearch: true,
  });

  const parsed = result.parsedOutput;
  if (!parsed || !Array.isArray(parsed.alerts)) {
    warnings.push({ step: 'competitor_scan', message: 'No structured output from competitor scan' });
    return { alertsFound: 0, alertsQueued: 0, alertsSkipped: 0, warnings };
  }

  const alerts = parsed.alerts as Array<{
    alert_type: string;
    title: string;
    details: string;
    implications?: string;
    recommended_action?: string;
    evidence_url?: string;
    priority?: string;
  }>;

  if (alerts.length === 0) {
    log.info({ mode }, 'No competitor alerts found');
    return { alertsFound: 0, alertsQueued: 0, alertsSkipped: 0, warnings };
  }

  let alertsQueued = 0;

  for (const alert of alerts) {
    try {
      const queueItemId = await queueForReview({
        agent: 'watchdog',
        task_type: 'competitor_alert',
        title: `[${alert.alert_type}] ${alert.title}`,
        content: {
          alert_type: alert.alert_type,
          competitor: alert.alert_type.startsWith('competitor_') ? 'RivalBoard' : undefined,
          details: alert.details,
          implications: alert.implications ?? '',
          recommended_action: alert.recommended_action ?? '',
          evidence_url: alert.evidence_url ?? '',
        },
        reasoning: alert.implications ?? alert.details,
        confidence: 0.7,
        priority: (alert.priority as 'urgent' | 'high' | 'normal' | 'low') ?? 'normal',
        source_url: alert.evidence_url,
      });

      if (queueItemId && result.decisionId) {
        await linkDecisionToQueueItem(result.decisionId, queueItemId);
      }

      alertsQueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ step: 'queue_alert', alert_title: alert.title, error: message }, 'Failed to queue competitor alert');
      warnings.push({ step: 'queue_alert', message: `Failed to queue: ${alert.title}` });
    }
  }

  log.info({ alertsFound: alerts.length, alertsQueued, mode }, 'Competitor scan complete');

  return {
    alertsFound: alerts.length,
    alertsQueued,
    alertsSkipped: alerts.length - alertsQueued,
    warnings,
  };
}

// ─── SEO Check ───────────────────────────────────────────────────────

interface SeoCheckResult {
  itemsFound: number;
  itemsQueued: number;
  warnings: AgentWarning[];
}

async function runSeoCheck(): Promise<SeoCheckResult> {
  const warnings: AgentWarning[] = [];

  const systemPrompt = loadPrompt('watchdog/seo-check', {
    target_keywords: TARGET_KEYWORDS.map((k) => `- "${k}"`).join('\n'),
  });

  const userPrompt =
    'Check the current keyword rankings for TrackBoard and identify backlink opportunities. Search each target keyword and report findings.';

  log.info('Running weekly SEO check');

  const result = await callAnthropic({
    agent: 'watchdog',
    decisionType: 'seo_check',
    systemPrompt,
    userPrompt,
    model: 'haiku',
    tools: [seoCheckTool],
    toolChoice: { type: 'tool', name: 'report_seo_status' },
    enableWebSearch: true,
    maxTokens: 8192,
  });

  const parsed = result.parsedOutput;
  if (!parsed || !Array.isArray(parsed.keyword_rankings)) {
    warnings.push({ step: 'seo_check', message: 'No structured output from SEO check' });
    return { itemsFound: 0, itemsQueued: 0, warnings };
  }

  const keywordRankings = parsed.keyword_rankings as Array<{
    keyword: string;
    position: number;
    url?: string;
    change: string;
  }>;

  const backlinkOpportunities = (parsed.backlink_opportunities ?? []) as Array<{
    source_url: string;
    context: string;
    opportunity_type?: string;
  }>;

  const seoSummary = (parsed.summary as string) ?? 'SEO check completed';

  // Calculate market signals from keyword data
  const marketSignals: string[] = [];
  const lostKeywords = keywordRankings.filter((k) => k.change === 'lost' || k.change === 'down');
  const gainedKeywords = keywordRankings.filter((k) => k.change === 'up' || k.change === 'new');

  if (lostKeywords.length > 0) {
    marketSignals.push(`${lostKeywords.length} keywords lost or declined in position`);
  }
  if (gainedKeywords.length > 0) {
    marketSignals.push(`${gainedKeywords.length} keywords gained or improved in position`);
  }

  // Queue the comprehensive SEO report
  try {
    const queueItemId = await queueForReview({
      agent: 'watchdog',
      task_type: 'seo_report',
      title: `Weekly SEO Report — ${keywordRankings.length} keywords tracked`,
      content: {
        report_type: 'weekly_seo',
        keyword_rankings: keywordRankings,
        backlink_opportunities: backlinkOpportunities,
        market_signals: marketSignals,
        summary: seoSummary,
      },
      reasoning: seoSummary,
      confidence: 0.8,
      priority: lostKeywords.length > 2 ? 'high' : 'normal',
    });

    if (queueItemId && result.decisionId) {
      await linkDecisionToQueueItem(result.decisionId, queueItemId);
    }

    log.info(
      { keywords: keywordRankings.length, backlinks: backlinkOpportunities.length },
      'SEO report queued',
    );

    return {
      itemsFound: 1,
      itemsQueued: 1,
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ step: 'queue_seo_report', error: message }, 'Failed to queue SEO report');
    warnings.push({ step: 'queue_seo_report', message: 'Failed to queue SEO report' });
    return { itemsFound: 1, itemsQueued: 0, warnings };
  }
}
