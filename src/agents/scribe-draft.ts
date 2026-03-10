import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect, safeUpdate } from '../lib/supabase';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { contentDraftingTool } from '../lib/tools';
import type { AgentResult, ContentPipelineRow } from '../types';

const log = createAgentLogger('scribe-draft');

/**
 * Scribe Draft Agent
 *
 * Picks the next content pipeline item (status 'idea' or 'outlined'),
 * researches the topic via web search, and drafts a full content piece
 * using Claude Sonnet for quality. Queues the draft for human review.
 *
 * Runs daily at 2 AM.
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentResult['errors'] = [];
  const warnings: AgentResult['warnings'] = [];

  // Step 1: Query for next pipeline item, prioritizing urgent/high items due this week
  log.info('Looking for next content pipeline item');

  const oneWeekFromNow = new Date();
  oneWeekFromNow.setDate(oneWeekFromNow.getDate() + 7);

  const result = await safeSelect<ContentPipelineRow>('admin_content_pipeline', (query) =>
    query
      .in('status', ['idea', 'outlined'])
      .order('priority', { ascending: true }) // urgent < high < normal < low alphabetically — need custom ordering
      .order('target_date', { ascending: true, nullsFirst: false })
      .limit(10),
  );

  if (!result.tableExists) {
    warnings.push({ step: 'fetch_pipeline', message: 'admin_content_pipeline table does not exist yet' });
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: 'Pipeline table not available — skipped run',
    };
  }

  if (result.error) {
    errors.push({ step: 'fetch_pipeline', message: result.error, recoverable: true });
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: `Failed to query pipeline: ${result.error}`,
    };
  }

  const candidates = result.data ?? [];

  // Sort by priority (urgent > high > normal > low), then by target_date
  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  candidates.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 3;
    const pb = priorityOrder[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;

    // Prefer items with a target_date this week
    const aDate = a.target_date ? new Date(a.target_date).getTime() : Infinity;
    const bDate = b.target_date ? new Date(b.target_date).getTime() : Infinity;
    return aDate - bDate;
  });

  const item = candidates[0] ?? null;

  if (!item) {
    log.info('No pipeline items ready for drafting');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: 'No pipeline items found — skipped run',
    };
  }

  log.info({ id: item.id, title: item.title, content_type: item.content_type, priority: item.priority }, 'Selected pipeline item for drafting');

  // Step 2: Update status to 'drafting'
  const updateResult = await safeUpdate(
    'admin_content_pipeline',
    { status: 'drafting', updated_at: new Date().toISOString() },
    'id',
    item.id,
  );

  if (updateResult.error) {
    warnings.push({ step: 'set_drafting', message: `Failed to set status to drafting: ${updateResult.error}` });
  }

  // Step 3: Research and draft via Sonnet with web search
  try {
    const sourceThreadsSummary = item.source_threads
      ? item.source_threads.map((t) => JSON.stringify(t)).join('\n')
      : 'None available';

    const systemPrompt = loadPrompt('scribe/content-drafting');
    const userPrompt = [
      `Content type: ${item.content_type}`,
      `Title: ${item.title}`,
      `Priority: ${item.priority}`,
      `Outline: ${item.outline || 'No outline provided — create one as part of the draft.'}`,
      `Source threads:\n${sourceThreadsSummary}`,
    ].join('\n\n');

    const aiResult = await callAnthropic({
      agent: 'scribe-draft',
      decisionType: 'content_drafting',
      systemPrompt,
      userPrompt,
      model: 'sonnet',
      tools: [contentDraftingTool],
      toolChoice: { type: 'tool', name: 'draft_content' },
      enableWebSearch: true,
      maxTokens: 16384,
    });

    const draft = aiResult.parsedOutput;

    if (!draft || !draft.body) {
      errors.push({ step: 'content_drafting', message: 'AI did not return a valid draft', recoverable: true });

      // Revert status
      await safeUpdate(
        'admin_content_pipeline',
        { status: item.status, updated_at: new Date().toISOString() },
        'id',
        item.id,
      );

      return {
        items_found: 1,
        items_queued: 0,
        items_skipped: 1,
        errors,
        warnings,
        summary: 'AI returned invalid draft — reverted pipeline item',
      };
    }

    // Step 4: Queue the draft for review
    const taskType = `${item.content_type.replace(/_/g, '_')}_draft`;

    const queueContent = {
      pipeline_item_id: item.id,
      content_type: item.content_type,
      title: (draft.title as string) || item.title,
      slug: (draft.slug as string) || '',
      body: draft.body as string,
      word_count: (draft.word_count as number) || 0,
      seo: {
        meta_title: (draft.meta_title as string) || '',
        meta_description: (draft.meta_description as string) || '',
        target_keywords: (draft.target_keywords as string[]) || [],
      },
      outline: (draft.outline as string) || '',
      sources: (draft.sources as string[]) || [],
    };

    const queueItemId = await queueForReview({
      agent: 'scribe-draft',
      task_type: taskType,
      title: `${item.content_type === 'blog_post' ? 'Blog' : item.content_type === 'state_guide' ? 'State Guide' : 'Content'}: ${queueContent.title}`,
      content: queueContent,
      reasoning: `Drafted from pipeline item "${item.title}" (priority: ${item.priority})`,
      confidence: 0.8,
      priority: item.priority,
    });

    // Step 5: Update pipeline status to 'drafted'
    await safeUpdate(
      'admin_content_pipeline',
      {
        status: 'drafted',
        draft: draft.body as string,
        seo_metadata: {
          meta_title: draft.meta_title,
          meta_description: draft.meta_description,
          target_keywords: draft.target_keywords,
        },
        updated_at: new Date().toISOString(),
      },
      'id',
      item.id,
    );

    // Step 6: Link decision to queue item
    if (aiResult.decisionId && queueItemId) {
      await linkDecisionToQueueItem(aiResult.decisionId, queueItemId);
    }

    log.info(
      {
        pipeline_item_id: item.id,
        queue_item_id: queueItemId,
        word_count: queueContent.word_count,
        content_type: item.content_type,
      },
      'Content draft queued for review',
    );

    return {
      items_found: 1,
      items_queued: 1,
      items_skipped: 0,
      errors,
      warnings,
      summary: `Drafted ${item.content_type}: "${queueContent.title}" (${queueContent.word_count} words)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ step: 'content_drafting', message, recoverable: true });

    // Revert status on failure
    await safeUpdate(
      'admin_content_pipeline',
      { status: item.status, updated_at: new Date().toISOString() },
      'id',
      item.id,
    );

    log.error({ error: message, pipeline_item_id: item.id }, 'Content drafting failed');

    return {
      items_found: 1,
      items_queued: 0,
      items_skipped: 1,
      errors,
      warnings,
      summary: `Drafting failed for "${item.title}": ${message}`,
    };
  }
}
