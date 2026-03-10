import { callAnthropic } from '../lib/anthropic';
import { queueForReview, isDuplicate } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeInsert, safeSelect, safeUpdate } from '../lib/supabase';
import { threadDiscoveryTool, commentAnalysisTool, replyDraftingTool } from '../lib/tools';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import type { AgentResult, AgentError, AgentWarning, ThreadCacheRow } from '../types';

const log = createAgentLogger('scout');

// Platforms and their search context
const PLATFORMS = [
  {
    id: 'reddit',
    name: 'Reddit',
    searchContext: 'Reddit subreddits r/SaaS, r/startups, and r/projectmanagement',
  },
  {
    id: 'indiehackers',
    name: 'IndieHackers',
    searchContext: 'IndieHackers.com community (indiehackers.com)',
  },
  {
    id: 'producthunt',
    name: 'ProductHunt',
    searchContext: 'Product Hunt discussions (producthunt.com)',
  },
] as const;

interface DiscoveredThread {
  platform: string;
  thread_url: string;
  thread_title: string;
  thread_snippet?: string;
  relevance_score: number;
  engagement_goal: string;
  reasoning?: string;
}

interface CommentAnalysis {
  total_replies: number;
  quality_summary: string;
  conversation_tone: string;
  gaps: Array<{
    type: string;
    description: string;
    severity: string;
  }>;
  recommendation: 'draft' | 'skip' | 'monitor';
  recommendation_reason: string;
}

interface ReplyDraft {
  reply_text: string;
  addresses_gap: string;
  tone_check?: string;
  confidence: number;
}

/**
 * Scout Agent — Forum monitoring + reply drafting
 *
 * Runs 3x/day (6 AM, 12 PM, 6 PM). For each platform:
 * 1. Discovers relevant threads via web search
 * 2. Deduplicates against thread cache
 * 3. Analyzes comments on high-relevance threads
 * 4. Drafts replies only where a genuine gap exists
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];
  let itemsFound = 0;
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // Step 1: Discover threads across all platforms
  const allNewThreads: DiscoveredThread[] = [];

  for (const platform of PLATFORMS) {
    try {
      const threads = await discoverThreads(platform.id, platform.searchContext);
      log.info({ platform: platform.id, threads_found: threads.length }, 'Thread discovery complete');

      // Dedup against thread cache
      const newThreads = await deduplicateThreads(threads);
      log.info({ platform: platform.id, new_threads: newThreads.length, total_found: threads.length }, 'Deduplication complete');

      // Cache new threads
      for (const thread of newThreads) {
        await cacheThread(thread);
      }

      allNewThreads.push(...newThreads);
      itemsFound += threads.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ platform: platform.id, error: message }, 'Platform discovery failed');
      errors.push({
        step: `discovery_${platform.id}`,
        message,
        recoverable: true,
      });
    }
  }

  // Step 2: Analyze and draft for high-relevance threads
  const highRelevanceThreads = allNewThreads.filter((t) => t.relevance_score > 0.6);
  log.info({ high_relevance_count: highRelevanceThreads.length, total_new: allNewThreads.length }, 'Filtering for high-relevance threads');

  for (const thread of highRelevanceThreads) {
    try {
      const analysis = await analyzeComments(thread);

      if (!analysis) {
        warnings.push({ step: 'comment_analysis', message: `No analysis returned for: ${thread.thread_title}` });
        continue;
      }

      if (analysis.recommendation === 'skip') {
        // Queue a skip log for audit trail
        await queueForReview({
          agent: 'scout',
          task_type: 'forum_skip_log',
          title: `Skip: ${thread.thread_title}`,
          content: {
            platform: thread.platform,
            thread_url: thread.thread_url,
            thread_title: thread.thread_title,
            reason: analysis.recommendation_reason,
            total_replies: analysis.total_replies,
            quality_summary: analysis.quality_summary,
          },
          reasoning: analysis.recommendation_reason,
          priority: 'low',
          source_url: thread.thread_url,
        });
        await updateThreadStatus(thread.thread_url, 'skipped', analysis);
        itemsSkipped++;
        continue;
      }

      if (analysis.recommendation === 'monitor') {
        await updateThreadStatus(thread.thread_url, 'monitoring', analysis);
        itemsSkipped++;
        continue;
      }

      // recommendation === 'draft'
      const draftResult = await draftReply(thread, analysis);

      if (!draftResult) {
        warnings.push({ step: 'reply_drafting', message: `No draft returned for: ${thread.thread_title}` });
        itemsSkipped++;
        continue;
      }

      // Check for duplicate queue items before queuing
      const alreadyQueued = await isDuplicate('scout', 'forum_reply', thread.thread_url);
      if (alreadyQueued) {
        log.info({ thread_url: thread.thread_url }, 'Reply already queued — skipping');
        itemsSkipped++;
        continue;
      }

      // Queue the reply for human review
      const queueItemId = await queueForReview({
        agent: 'scout',
        task_type: 'forum_reply',
        title: `Reply to ${thread.platform}: ${thread.thread_title}`,
        content: {
          platform: thread.platform,
          thread_url: thread.thread_url,
          thread_title: thread.thread_title,
          thread_snippet: thread.thread_snippet || '',
          comment_analysis: {
            total_replies: analysis.total_replies,
            quality_summary: analysis.quality_summary,
            identified_gap: analysis.gaps.length > 0
              ? analysis.gaps[0].description
              : analysis.recommendation_reason,
            reply_strategy: analysis.recommendation_reason,
            conversation_tone: analysis.conversation_tone,
          },
          draft_reply: draftResult.reply_text,
          suggested_goal: thread.engagement_goal,
        },
        reasoning: `Gap: ${draftResult.addresses_gap}. Tone: ${draftResult.tone_check || 'natural'}.`,
        confidence: draftResult.confidence,
        priority: 'normal',
        source_url: thread.thread_url,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      });

      // Link the decision log to the queue item
      if (queueItemId && draftResult._decisionId) {
        await linkDecisionToQueueItem(draftResult._decisionId, queueItemId);
      }

      await updateThreadStatus(thread.thread_url, 'drafted', analysis);
      itemsQueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ thread_url: thread.thread_url, error: message }, 'Thread processing failed');
      errors.push({
        step: `process_thread`,
        message: `${thread.thread_title}: ${message}`,
        recoverable: true,
      });
    }
  }

  // Low-relevance threads are implicitly skipped (not counted unless they were in allNewThreads)
  const lowRelevanceCount = allNewThreads.filter((t) => t.relevance_score <= 0.6).length;
  itemsSkipped += lowRelevanceCount;

  const summary = `Scout: found ${itemsFound} threads, ${allNewThreads.length} new, ${itemsQueued} replies drafted, ${itemsSkipped} skipped, ${errors.length} errors`;
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

async function discoverThreads(platformId: string, searchContext: string): Promise<DiscoveredThread[]> {
  const systemPrompt = loadPrompt('scout/thread-discovery', {
    platform: searchContext,
  });

  const userPrompt = `Search ${searchContext} for recent threads about project tracking tools, team productivity, workflow automation, integrations, and SaaS pricing comparisons. Return the most relevant threads from the last 30 days.`;

  const result = await callAnthropic({
    agent: 'scout',
    decisionType: `thread_discovery_${platformId}`,
    systemPrompt,
    userPrompt,
    tools: [threadDiscoveryTool],
    toolChoice: { type: 'tool', name: 'report_threads' },
    enableWebSearch: true,
  });

  if (!result.parsedOutput) {
    log.warn({ platform: platformId }, 'No parsed output from thread discovery');
    return [];
  }

  const threads = (result.parsedOutput.threads as DiscoveredThread[]) || [];

  // Normalize platform field
  return threads.map((t) => ({
    ...t,
    platform: t.platform || platformId,
  }));
}

async function deduplicateThreads(threads: DiscoveredThread[]): Promise<DiscoveredThread[]> {
  if (threads.length === 0) return [];

  const urls = threads.map((t) => t.thread_url);

  const existing = await safeSelect<ThreadCacheRow>('admin_thread_cache', (query) =>
    query.in('thread_url', urls),
  );

  if (!existing.tableExists || existing.error) {
    // Can't dedup — return all threads as new
    return threads;
  }

  const existingUrls = new Set((existing.data || []).map((r) => r.thread_url));
  return threads.filter((t) => !existingUrls.has(t.thread_url));
}

async function cacheThread(thread: DiscoveredThread): Promise<void> {
  const now = new Date().toISOString();
  await safeInsert('admin_thread_cache', {
    platform: thread.platform,
    thread_url: thread.thread_url,
    thread_title: thread.thread_title,
    thread_snippet: thread.thread_snippet || null,
    relevance_score: thread.relevance_score,
    engagement_goal: thread.engagement_goal,
    status: 'new',
    discovered_at: now,
    last_checked_at: now,
  });
}

async function analyzeComments(thread: DiscoveredThread): Promise<CommentAnalysis | null> {
  const systemPrompt = loadPrompt('scout/comment-analysis', {
    thread_title: thread.thread_title,
    thread_url: thread.thread_url,
    thread_content: thread.thread_snippet || '(thread content will be fetched via web search)',
  });

  const userPrompt = `Fetch and analyze the comments on this thread: ${thread.thread_url}\n\nThread title: "${thread.thread_title}"\n\nRead the existing replies and determine if there is a gap worth addressing. Be conservative — most threads should be skipped.`;

  const result = await callAnthropic({
    agent: 'scout',
    decisionType: 'comment_analysis',
    systemPrompt,
    userPrompt,
    tools: [commentAnalysisTool],
    toolChoice: { type: 'tool', name: 'report_comment_analysis' },
    enableWebSearch: true,
  });

  if (!result.parsedOutput) {
    return null;
  }

  return result.parsedOutput as unknown as CommentAnalysis;
}

async function draftReply(
  thread: DiscoveredThread,
  analysis: CommentAnalysis,
): Promise<(ReplyDraft & { _decisionId: string | null }) | null> {
  const primaryGap = analysis.gaps.length > 0
    ? analysis.gaps[0].description
    : analysis.recommendation_reason;

  const conversationContext = `${analysis.total_replies} existing replies. Tone: ${analysis.conversation_tone}. Quality: ${analysis.quality_summary}`;

  const systemPrompt = loadPrompt('scout/reply-drafting', {
    thread_title: thread.thread_title,
    identified_gap: primaryGap,
    conversation_context: conversationContext,
  });

  const userPrompt = `Draft a reply for the thread "${thread.thread_title}" that addresses this gap: ${primaryGap}`;

  const result = await callAnthropic({
    agent: 'scout',
    decisionType: 'reply_drafting',
    systemPrompt,
    userPrompt,
    tools: [replyDraftingTool],
    toolChoice: { type: 'tool', name: 'draft_reply' },
  });

  if (!result.parsedOutput) {
    return null;
  }

  const draft = result.parsedOutput as unknown as ReplyDraft;
  return {
    ...draft,
    _decisionId: result.decisionId,
  };
}

async function updateThreadStatus(
  threadUrl: string,
  status: string,
  analysis: CommentAnalysis,
): Promise<void> {
  await safeUpdate(
    'admin_thread_cache',
    {
      status,
      gap_analysis: analysis as unknown as Record<string, unknown>,
      last_checked_at: new Date().toISOString(),
    },
    'thread_url',
    threadUrl,
  );
}
