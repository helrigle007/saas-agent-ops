import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect } from '../lib/supabase';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { pollUnread, markAsRead, getGmailClient } from '../lib/gmail';
import type { EmailMessage } from '../lib/gmail';
import { emailClassificationTool, responseDraftingTool } from '../lib/tools';
import type { AgentResult, AgentError, AgentWarning, OutreachTargetRow } from '../types';

const log = createAgentLogger('inbox');

type EmailCategory =
  | 'outreach_reply'
  | 'user_support'
  | 'user_feedback'
  | 'transactional'
  | 'spam_noise'
  | 'urgent';

interface ClassificationResult {
  category: EmailCategory;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  summary: string;
  requires_response: boolean;
  related_outreach_target?: string;
  related_user_email?: string;
}

interface ResponseDraftResult {
  subject: string;
  body: string;
  tone: string;
  confidence: number;
}

/**
 * Classify an email using the Anthropic API.
 */
async function classifyEmail(email: EmailMessage): Promise<ClassificationResult> {
  const systemPrompt = loadPrompt('inbox/email-classification', {
    from: email.from,
    subject: email.subject,
    body: email.body,
    snippet: email.snippet,
  });

  const result = await callAnthropic({
    agent: 'inbox',
    decisionType: 'email_classification',
    systemPrompt,
    userPrompt: `Classify this email:\n\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.body || email.snippet}`,
    tools: [emailClassificationTool],
    toolChoice: { type: 'tool', name: 'classify_email' },
  });

  const parsed = result.parsedOutput as unknown as ClassificationResult | null;
  if (!parsed) {
    throw new Error('Classification returned no structured output');
  }

  return parsed;
}

/**
 * Look up outreach target context for a reply email.
 */
async function getOutreachContext(
  fromEmail: string,
): Promise<Record<string, unknown> | null> {
  const result = await safeSelect<OutreachTargetRow>(
    'admin_outreach_targets',
    (query) => query.eq('contact_email', fromEmail).limit(1),
  );

  if (!result.tableExists) {
    log.warn('admin_outreach_targets table not found — skipping context lookup');
    return null;
  }

  if (result.error || !result.data || result.data.length === 0) {
    return null;
  }

  const target = result.data[0];
  return {
    outreach_target: {
      id: target.id,
      name: target.name,
      contact_name: target.contact_name,
      category: target.category,
      state: target.state,
      status: target.status,
      last_contacted_at: target.last_contacted_at,
      notes: target.notes,
    },
  };
}

/**
 * Look up user profile context for support/feedback emails.
 */
async function getUserContext(
  fromEmail: string,
): Promise<Record<string, unknown> | null> {
  const result = await safeSelect<Record<string, unknown>>(
    'profiles',
    (query) => query.eq('email', fromEmail).limit(1),
  );

  if (!result.tableExists) {
    log.warn('profiles table not found — skipping user context lookup');
    return null;
  }

  if (result.error || !result.data || result.data.length === 0) {
    return null;
  }

  const profile = result.data[0];
  return {
    user_profile: {
      id: profile.id,
      name: profile.full_name || profile.display_name || 'Unknown',
      email: profile.email,
      tier: profile.tier || 'free',
      state: profile.state,
      created_at: profile.created_at,
    },
  };
}

/**
 * Extract a clean email address from a "Name <email>" string.
 */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from.trim();
}

/**
 * Draft a response for an actionable email.
 */
async function draftResponse(
  email: EmailMessage,
  classification: ClassificationResult,
  context: Record<string, unknown> | null,
): Promise<{ draft: ResponseDraftResult; decisionId: string | null }> {
  const contextStr = context ? JSON.stringify(context, null, 2) : 'No additional context available.';

  const systemPrompt = loadPrompt('inbox/response-drafting', {
    category: classification.category,
    from: email.from,
    subject: email.subject,
    body: email.body || email.snippet,
    context: contextStr,
  });

  const result = await callAnthropic({
    agent: 'inbox',
    decisionType: 'response_drafting',
    systemPrompt,
    userPrompt: `Draft a response to this ${classification.category} email.\n\nFrom: ${email.from}\nSubject: ${email.subject}\nSummary: ${classification.summary}\n\nFull body:\n${email.body || email.snippet}\n\nContext:\n${contextStr}`,
    tools: [responseDraftingTool],
    toolChoice: { type: 'tool', name: 'draft_response' },
  });

  const parsed = result.parsedOutput as unknown as ResponseDraftResult | null;
  if (!parsed) {
    throw new Error('Response drafting returned no structured output');
  }

  return { draft: parsed, decisionId: result.decisionId };
}

/**
 * Determine priority for a queue item based on classification.
 */
function mapPriority(classification: ClassificationResult): 'urgent' | 'high' | 'normal' | 'low' {
  if (classification.category === 'urgent') return 'urgent';
  if (classification.category === 'outreach_reply') return 'high';
  if (classification.priority === 'urgent') return 'urgent';
  return classification.priority;
}

/**
 * Inbox agent: polls Gmail for unread emails, classifies them,
 * cross-references Supabase for context, and drafts responses
 * for human review.
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];
  let itemsFound = 0;
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // Step 1: Check if Gmail is configured
  const gmailClient = getGmailClient();
  if (!gmailClient) {
    log.info('Gmail not configured — skipping inbox run');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors: [],
      warnings: [{ step: 'init', message: 'Gmail not configured' }],
      summary: 'Skipped: Gmail not configured',
    };
  }

  // Step 2: Poll for unread emails
  let emails: EmailMessage[];
  try {
    emails = await pollUnread();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Failed to poll Gmail');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors: [{ step: 'poll', message, recoverable: true }],
      warnings: [],
      summary: `Failed to poll Gmail: ${message}`,
    };
  }

  if (emails.length === 0) {
    log.info('No unread emails found');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors: [],
      warnings: [],
      summary: 'No unread emails',
    };
  }

  itemsFound = emails.length;
  log.info({ count: emails.length }, 'Unread emails found');

  // Step 3: Process each email
  for (const email of emails) {
    try {
      // 3a: Classify the email
      const classification = await classifyEmail(email);
      log.info(
        {
          emailId: email.id,
          from: email.from,
          subject: email.subject,
          category: classification.category,
          priority: classification.priority,
        },
        'Email classified',
      );

      // 3b: Handle by category
      if (classification.category === 'spam_noise') {
        await markAsRead(email.id);
        itemsSkipped++;
        log.info({ emailId: email.id, subject: email.subject }, 'Spam/noise — marked read, skipped');
        continue;
      }

      if (classification.category === 'transactional') {
        // Queue as low-priority for digest batch
        const queueId = await queueForReview({
          agent: 'inbox',
          task_type: 'email_transactional',
          title: `Transactional: ${email.subject}`,
          content: {
            email_id: email.id,
            from: email.from,
            subject: email.subject,
            category: 'transactional',
            original_body: email.body || email.snippet,
            summary: classification.summary,
          },
          priority: 'low',
        });

        await markAsRead(email.id);

        if (queueId) {
          itemsQueued++;
        } else {
          itemsSkipped++;
        }
        continue;
      }

      // 3c: For actionable emails, get context
      let context: Record<string, unknown> | null = null;
      const cleanEmail = extractEmail(email.from);

      if (classification.category === 'outreach_reply') {
        context = await getOutreachContext(cleanEmail);
        if (!context) {
          log.info({ from: cleanEmail }, 'No outreach target found for reply — drafting without context');
        }
      } else if (
        classification.category === 'user_support' ||
        classification.category === 'user_feedback'
      ) {
        context = await getUserContext(cleanEmail);
        if (!context) {
          log.info({ from: cleanEmail }, 'No user profile found — drafting without context');
        }
      }

      // 3d: Draft response
      if (!classification.requires_response) {
        // Queue without a draft (informational)
        const queueId = await queueForReview({
          agent: 'inbox',
          task_type: 'email_response',
          title: `[${classification.category}] ${email.subject}`,
          content: {
            email_id: email.id,
            from: email.from,
            subject: email.subject,
            category: classification.category,
            original_body: email.body || email.snippet,
            context: context || {},
            summary: classification.summary,
          },
          priority: mapPriority(classification),
        });

        await markAsRead(email.id);

        if (queueId) {
          itemsQueued++;
        } else {
          itemsSkipped++;
        }
        continue;
      }

      const { draft, decisionId } = await draftResponse(email, classification, context);

      // 3e: Queue for review
      const queueId = await queueForReview({
        agent: 'inbox',
        task_type: 'email_response',
        title: `Reply to ${email.from}: ${email.subject}`,
        content: {
          email_id: email.id,
          from: email.from,
          subject: email.subject,
          category: classification.category,
          original_body: email.body || email.snippet,
          context: context || {},
          draft_response: {
            subject: draft.subject,
            body: draft.body,
          },
        },
        reasoning: classification.summary,
        confidence: draft.confidence,
        priority: mapPriority(classification),
      });

      // Link decision to queue item
      if (decisionId && queueId) {
        await linkDecisionToQueueItem(decisionId, queueId);
      }

      // 3f: Mark as read
      await markAsRead(email.id);

      if (queueId) {
        itemsQueued++;
        log.info(
          { emailId: email.id, queueId, category: classification.category },
          'Email response drafted and queued',
        );
      } else {
        itemsSkipped++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ emailId: email.id, subject: email.subject, error: message }, 'Failed to process email');
      errors.push({
        step: `process_email:${email.id}`,
        message,
        recoverable: true,
      });
    }
  }

  const summary = `Processed ${itemsFound} emails: ${itemsQueued} queued, ${itemsSkipped} skipped, ${errors.length} errors`;
  log.info({ itemsFound, itemsQueued, itemsSkipped, errors: errors.length }, summary);

  return {
    items_found: itemsFound,
    items_queued: itemsQueued,
    items_skipped: itemsSkipped,
    errors,
    warnings,
    summary,
  };
}
