import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect } from '../lib/supabase';
import { trendRadarTool } from '../lib/tools';
import type { AgentResult, AgentError, AgentWarning, ThreadCacheRow, ContentPipelineRow } from '../types';

const log = createAgentLogger('scribe-radar');

// Minimum threads from cache before we supplement with web search
const SPARSE_THRESHOLD = 5;

// Maximum content ideas to queue per run
const MAX_IDEAS_PER_RUN = 5;

interface TrendIdea {
  title: string;
  content_type: string;
  trend_score: number;
  priority: string;
  source: string;
  source_threads?: string[];
  reasoning: string;
  angle?: string;
  target_keywords?: string[];
}

/**
 * Scribe Radar Agent — Trend scanning + content idea generation
 *
 * Runs daily at 1 AM. Analyzes Scout's thread cache for patterns,
 * supplements with web search if data is sparse, and surfaces
 * content ideas for the pipeline.
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];
  let itemsFound = 0;
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // Step 1: Fetch recent threads from cache (last 48 hours)
  let recentThreads: ThreadCacheRow[] = [];
  try {
    recentThreads = await fetchRecentThreads();
    log.info({ thread_count: recentThreads.length }, 'Fetched recent threads from cache');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Failed to fetch thread cache');
    errors.push({ step: 'fetch_thread_cache', message, recoverable: true });
  }

  // Step 2: Fetch existing pipeline to avoid duplicates
  let existingPipeline: ContentPipelineRow[] = [];
  try {
    existingPipeline = await fetchExistingPipeline();
    log.info({ pipeline_count: existingPipeline.length }, 'Fetched existing pipeline');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Failed to fetch content pipeline');
    errors.push({ step: 'fetch_pipeline', message, recoverable: true });
  }

  // Step 3: Build context strings for the prompt
  const recentThreadsSummary = formatThreadsForPrompt(recentThreads);
  const existingPipelineSummary = formatPipelineForPrompt(existingPipeline);

  // Step 4: Call AI for trend analysis
  // If thread cache is sparse, enable web search for supplementary data
  const isSparse = recentThreads.length < SPARSE_THRESHOLD;
  if (isSparse) {
    log.info({ thread_count: recentThreads.length, threshold: SPARSE_THRESHOLD }, 'Sparse thread cache — enabling web search for trends');
  }

  let ideas: TrendIdea[] = [];
  try {
    ideas = await analyzeTrends(recentThreadsSummary, existingPipelineSummary, isSparse);
    itemsFound = ideas.length;
    log.info({ ideas_count: ideas.length }, 'Trend analysis complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Trend analysis failed');
    errors.push({ step: 'trend_analysis', message, recoverable: false });
  }

  // Step 5: Filter duplicates against existing pipeline
  const existingTitlesLower = new Set(existingPipeline.map((p) => p.title.toLowerCase()));
  const filteredIdeas = ideas.filter((idea) => {
    const titleLower = idea.title.toLowerCase();
    // Check for exact title match
    if (existingTitlesLower.has(titleLower)) {
      log.info({ title: idea.title }, 'Skipping duplicate idea — exact title match');
      itemsSkipped++;
      return false;
    }
    // Check for significant overlap (one title contains the other)
    for (const existing of existingTitlesLower) {
      if (titleLower.includes(existing) || existing.includes(titleLower)) {
        log.info({ title: idea.title, existing_match: existing }, 'Skipping duplicate idea — title overlap');
        itemsSkipped++;
        return false;
      }
    }
    return true;
  });

  // Step 6: Queue top ideas (limit to MAX_IDEAS_PER_RUN)
  const ideasToQueue = filteredIdeas
    .sort((a, b) => b.trend_score - a.trend_score)
    .slice(0, MAX_IDEAS_PER_RUN);

  for (const idea of ideasToQueue) {
    try {
      await queueForReview({
        agent: 'scribe-radar',
        task_type: 'content_idea',
        title: idea.title,
        content: {
          content_type: idea.content_type,
          trend_score: idea.trend_score,
          source: idea.source,
          source_threads: idea.source_threads || [],
          reasoning: idea.reasoning,
          angle: idea.angle || '',
          target_keywords: idea.target_keywords || [],
          priority: idea.priority,
        },
        reasoning: idea.reasoning,
        confidence: idea.trend_score,
        priority: idea.priority as 'urgent' | 'high' | 'normal' | 'low',
      });
      itemsQueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ title: idea.title, error: message }, 'Failed to queue content idea');
      errors.push({
        step: 'queue_idea',
        message: `${idea.title}: ${message}`,
        recoverable: true,
      });
    }
  }

  // Count remaining filtered ideas that exceeded MAX_IDEAS_PER_RUN as skipped
  if (filteredIdeas.length > MAX_IDEAS_PER_RUN) {
    itemsSkipped += filteredIdeas.length - MAX_IDEAS_PER_RUN;
  }

  const summary = `Scribe Radar: analyzed ${recentThreads.length} cached threads${isSparse ? ' (sparse — web search enabled)' : ''}, found ${itemsFound} ideas, queued ${itemsQueued}, skipped ${itemsSkipped}, ${errors.length} errors`;
  log.info({ items_found: itemsFound, items_queued: itemsQueued, items_skipped: itemsSkipped }, summary);

  return {
    items_found: itemsFound,
    items_queued: itemsQueued,
    items_skipped: itemsSkipped,
    errors,
    warnings,
    summary,
  };
}

// ============================================================
// Internal Functions
// ============================================================

async function fetchRecentThreads(): Promise<ThreadCacheRow[]> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const result = await safeSelect<ThreadCacheRow>('admin_thread_cache', (query) =>
    query
      .gte('discovered_at', cutoff)
      .order('discovered_at', { ascending: false }),
  );

  if (!result.tableExists) {
    log.warn('admin_thread_cache table not yet created');
    return [];
  }

  if (result.error) {
    throw new Error(`Thread cache query failed: ${result.error}`);
  }

  return result.data || [];
}

async function fetchExistingPipeline(): Promise<ContentPipelineRow[]> {
  const result = await safeSelect<ContentPipelineRow>('admin_content_pipeline', (query) =>
    query
      .in('status', ['idea', 'outlined', 'drafting', 'drafted', 'review'])
      .order('created_at', { ascending: false })
      .limit(50),
  );

  if (!result.tableExists) {
    log.warn('admin_content_pipeline table not yet created');
    return [];
  }

  if (result.error) {
    throw new Error(`Content pipeline query failed: ${result.error}`);
  }

  return result.data || [];
}

function formatThreadsForPrompt(threads: ThreadCacheRow[]): string {
  if (threads.length === 0) {
    return '(No recent threads in cache. Rely on web search for current trends.)';
  }

  return threads
    .map((t) => {
      const parts = [
        `- [${t.platform}] "${t.thread_title}"`,
        `  URL: ${t.thread_url}`,
        `  Relevance: ${t.relevance_score ?? 'unknown'}`,
        `  Status: ${t.status}`,
      ];
      if (t.thread_snippet) {
        parts.push(`  Snippet: ${t.thread_snippet.slice(0, 200)}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

function formatPipelineForPrompt(pipeline: ContentPipelineRow[]): string {
  if (pipeline.length === 0) {
    return '(No existing content in pipeline. All ideas are fresh.)';
  }

  return pipeline
    .map((p) => `- [${p.status}] "${p.title}" (${p.content_type}, priority: ${p.priority})`)
    .join('\n');
}

async function analyzeTrends(
  recentThreadsSummary: string,
  existingPipelineSummary: string,
  enableWebSearch: boolean,
): Promise<TrendIdea[]> {
  const systemPrompt = loadPrompt('scribe/trend-radar', {
    recent_threads: recentThreadsSummary,
    existing_pipeline: existingPipelineSummary,
  });

  const userPrompt = enableWebSearch
    ? 'Analyze the thread cache data above and also search the web for current trending topics in SaaS productivity, project management, and team collaboration. The thread cache is sparse, so supplement with web research. Return 3-5 content ideas.'
    : 'Analyze the thread cache data above for patterns and content opportunities. Return 3-5 content ideas based on what the community is discussing.';

  const result = await callAnthropic({
    agent: 'scribe-radar',
    decisionType: 'trend_analysis',
    systemPrompt,
    userPrompt,
    tools: [trendRadarTool],
    toolChoice: { type: 'tool', name: 'report_trends' },
    enableWebSearch,
  });

  if (!result.parsedOutput) {
    log.warn('No parsed output from trend analysis');
    return [];
  }

  return (result.parsedOutput.trends as TrendIdea[]) || [];
}
