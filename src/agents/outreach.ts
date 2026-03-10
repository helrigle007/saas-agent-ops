import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect, safeUpdate } from '../lib/supabase';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { targetResearchTool, emailDraftingTool } from '../lib/tools';
import type { AgentResult, OutreachTargetRow } from '../types';

const log = createAgentLogger('outreach');

const MAX_TARGETS_PER_RUN = 5;

/**
 * Outreach Agent
 *
 * Researches outreach targets (agencies, enterprise teams, consultancies,
 * SaaS reviewers, newsletter operators) and drafts personalized cold emails.
 * Each target goes through research then email drafting.
 *
 * Runs daily at 7 AM.
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentResult['errors'] = [];
  const warnings: AgentResult['warnings'] = [];
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // Step 1: Query for new targets OR targets with follow_up_at <= today
  log.info('Looking for outreach targets');

  const today = new Date().toISOString().split('T')[0];

  // Fetch new targets
  const newResult = await safeSelect<OutreachTargetRow>('admin_outreach_targets', (query) =>
    query
      .eq('status', 'new')
      .limit(MAX_TARGETS_PER_RUN),
  );

  if (!newResult.tableExists) {
    warnings.push({ step: 'fetch_targets', message: 'admin_outreach_targets table does not exist yet' });
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: 'Outreach targets table not available — skipped run',
    };
  }

  // Fetch follow-up targets
  const followUpResult = await safeSelect<OutreachTargetRow>('admin_outreach_targets', (query) =>
    query
      .eq('status', 'sent')
      .lte('follow_up_at', today)
      .limit(MAX_TARGETS_PER_RUN),
  );

  if (newResult.error) {
    errors.push({ step: 'fetch_new_targets', message: newResult.error, recoverable: true });
  }
  if (followUpResult.error) {
    errors.push({ step: 'fetch_followup_targets', message: followUpResult.error, recoverable: true });
  }

  // Combine and limit
  const newTargets = newResult.data ?? [];
  const followUpTargets = followUpResult.data ?? [];
  const allTargets = [...newTargets, ...followUpTargets].slice(0, MAX_TARGETS_PER_RUN);

  if (allTargets.length === 0) {
    log.info('No outreach targets ready');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: 'No outreach targets found — skipped run',
    };
  }

  log.info({ count: allTargets.length, new: newTargets.length, follow_up: followUpTargets.length }, 'Found outreach targets');

  // Step 2: Process each target with try/catch
  for (const target of allTargets) {
    try {
      await processTarget(target, errors, warnings);
      itemsQueued++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ step: `target_${target.id}`, message, recoverable: true });
      itemsSkipped++;
      log.error({ target_id: target.id, target_name: target.name, error: message }, 'Failed to process target');
    }
  }

  const summary = `Processed ${allTargets.length} targets: ${itemsQueued} emails drafted, ${itemsSkipped} failed`;
  log.info({ items_found: allTargets.length, items_queued: itemsQueued, items_skipped: itemsSkipped }, summary);

  return {
    items_found: allTargets.length,
    items_queued: itemsQueued,
    items_skipped: itemsSkipped,
    errors,
    warnings,
    summary,
  };
}

/**
 * Research and draft an email for a single outreach target.
 */
async function processTarget(
  target: OutreachTargetRow,
  errors: AgentResult['errors'],
  warnings: AgentResult['warnings'],
): Promise<void> {
  log.info({ target_id: target.id, name: target.name, category: target.category }, 'Processing outreach target');

  // Step A: Research the target
  const researchPrompt = loadPrompt('outreach/target-research', {
    target_name: target.name,
    target_category: target.category,
    target_website: target.website || 'Not available',
    target_state: target.state || 'Unknown',
  });

  const researchResult = await callAnthropic({
    agent: 'outreach',
    decisionType: 'target_research',
    systemPrompt: researchPrompt,
    userPrompt: `Research this organization and find personalization hooks for outreach:\n\nName: ${target.name}\nCategory: ${target.category}\nWebsite: ${target.website || 'N/A'}\nState: ${target.state || 'N/A'}\nExisting notes: ${target.notes || 'None'}`,
    model: 'haiku',
    tools: [targetResearchTool],
    toolChoice: { type: 'tool', name: 'report_research' },
    enableWebSearch: true,
  });

  const research = researchResult.parsedOutput;

  if (!research) {
    warnings.push({ step: `research_${target.id}`, message: 'Research returned no structured output — proceeding with limited data' });
  }

  // Step B: Update target status to 'researched'
  const researchNotes = research
    ? [
        research.organization_summary || '',
        research.program_size ? `Program size: ${research.program_size}` : '',
        research.key_personnel ? `Key personnel: ${research.key_personnel}` : '',
        (research.pain_points as string[] | undefined)?.length ? `Pain points: ${(research.pain_points as string[]).join('; ')}` : '',
      ].filter(Boolean).join('\n')
    : target.notes || '';

  await safeUpdate(
    'admin_outreach_targets',
    { status: 'researched' as const, notes: researchNotes },
    'id',
    target.id,
  );

  // Step C: Draft the email
  const personalizationHooks = research
    ? (research.personalization_hooks as string[] || []).join('\n- ')
    : 'No research data available';

  const emailPrompt = loadPrompt('outreach/email-drafting', {
    target_name: target.name,
    contact_name: target.contact_name || 'Training Director',
    research_summary: researchNotes,
    personalization_hooks: personalizationHooks,
  });

  const utmCampaign = target.category.toLowerCase().replace(/\s+/g, '-');
  const utmLink = `https://trackboard.app?utm_source=email&utm_medium=outreach&utm_campaign=${utmCampaign}&utm_content=${target.id}`;

  const emailResult = await callAnthropic({
    agent: 'outreach',
    decisionType: 'email_drafting',
    systemPrompt: emailPrompt,
    userPrompt: `Draft a personalized cold email for this target.\n\nOrganization: ${target.name}\nContact: ${target.contact_name || 'Training Director'}\nEmail: ${target.contact_email || 'N/A'}\nCategory: ${target.category}\nState: ${target.state || 'N/A'}\n\nResearch summary:\n${researchNotes}\n\nPersonalization hooks:\n- ${personalizationHooks}\n\nUTM link to include: ${utmLink}`,
    model: 'haiku',
    tools: [emailDraftingTool],
    toolChoice: { type: 'tool', name: 'draft_email' },
  });

  const email = emailResult.parsedOutput;

  if (!email || !email.body) {
    throw new Error('AI did not return a valid email draft');
  }

  // Step D: Calculate follow-up date
  const followUpDays = (email.follow_up_days as number) || 5;
  const followUpDate = new Date();
  followUpDate.setDate(followUpDate.getDate() + followUpDays);
  const followUpDateStr = followUpDate.toISOString().split('T')[0];

  // Step E: Update target status to 'drafted'
  await safeUpdate(
    'admin_outreach_targets',
    {
      status: 'drafted' as const,
      follow_up_at: followUpDate.toISOString(),
    },
    'id',
    target.id,
  );

  // Step F: Queue email for review
  const queueContent = {
    target_id: target.id,
    recipient_name: target.contact_name || 'Training Director',
    recipient_email: target.contact_email || '',
    subject: (email.subject as string) || '',
    body: email.body as string,
    follow_up_date: followUpDateStr,
    research_summary: researchNotes,
    utm_link: utmLink,
  };

  const queueItemId = await queueForReview({
    agent: 'outreach',
    task_type: 'cold_email',
    title: `Email to ${target.name}: ${queueContent.subject}`,
    content: queueContent,
    reasoning: `${target.category} in ${target.state || 'unknown state'} — ${research ? `relevance: ${research.relevance_score}` : 'research limited'}`,
    confidence: (email.confidence as number) || 0.7,
    priority: 'normal',
  });

  // Step G: Link decision to queue item
  if (emailResult.decisionId && queueItemId) {
    await linkDecisionToQueueItem(emailResult.decisionId, queueItemId);
  }

  log.info(
    {
      target_id: target.id,
      target_name: target.name,
      queue_item_id: queueItemId,
      follow_up_date: followUpDateStr,
    },
    'Outreach email drafted and queued',
  );
}
