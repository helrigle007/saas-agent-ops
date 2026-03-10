import { callAnthropic } from '../lib/anthropic';
import { queueForReview } from '../lib/queue';
import { loadPrompt } from '../lib/prompt-loader';
import { createAgentLogger } from '../lib/logger';
import { safeSelect } from '../lib/supabase';
import { linkDecisionToQueueItem } from '../lib/decision-logger';
import { lifecycleEmailTool } from '../lib/tools';
import type { AgentResult, AgentError, AgentWarning } from '../types';

const log = createAgentLogger('nurture');

type NurtureTrigger =
  | 'no_first_hour'
  | 'inactive_7d'
  | 'upgrade_candidate'
  | 'pending_verification';

interface TriggeredUser {
  trigger: NurtureTrigger;
  user_id: string;
  user_name: string;
  user_email: string;
  user_state: string;
  user_tier: string;
  user_stats: string;
  days_inactive?: number;
}

interface LifecycleEmailResult {
  subject: string;
  body: string;
  trigger: string;
  personalization_notes?: string;
  confidence: number;
}

/**
 * Find users who created their account 48+ hours ago but have zero hour entries.
 */
async function findNoFirstHour(): Promise<TriggeredUser[]> {
  // Check profiles table first
  const profilesResult = await safeSelect<Record<string, unknown>>(
    'profiles',
    (query) =>
      query
        .lt('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
        .select('id, full_name, display_name, email, state, tier, created_at'),
  );

  if (!profilesResult.tableExists) {
    log.warn('profiles table not found — skipping no_first_hour signal');
    return [];
  }

  if (profilesResult.error || !profilesResult.data || profilesResult.data.length === 0) {
    return [];
  }

  // Check hour_entries table
  const hoursResult = await safeSelect<Record<string, unknown>>(
    'hour_entries',
    (query) => query.select('user_id'),
  );

  if (!hoursResult.tableExists) {
    log.warn('hour_entries table not found — skipping no_first_hour signal');
    return [];
  }

  // Get set of user IDs that have logged hours
  const usersWithHours = new Set<string>();
  if (hoursResult.data) {
    for (const entry of hoursResult.data) {
      usersWithHours.add(entry.user_id as string);
    }
  }

  // Filter to users with zero hours
  const triggered: TriggeredUser[] = [];
  for (const profile of profilesResult.data) {
    const userId = profile.id as string;
    if (!usersWithHours.has(userId)) {
      const createdAt = new Date(profile.created_at as string);
      const daysSinceCreation = Math.floor(
        (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );

      triggered.push({
        trigger: 'no_first_hour',
        user_id: userId,
        user_name: (profile.full_name || profile.display_name || 'there') as string,
        user_email: (profile.email || '') as string,
        user_state: (profile.state || 'Unknown') as string,
        user_tier: (profile.tier || 'free') as string,
        user_stats: `Account created ${daysSinceCreation} days ago, 0 hours logged`,
      });
    }
  }

  return triggered;
}

/**
 * Find users who were active but haven't logged hours in 7+ days.
 */
async function findInactive7d(): Promise<TriggeredUser[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get users who have logged hours before
  const recentResult = await safeSelect<Record<string, unknown>>(
    'hour_entries',
    (query) => query.select('user_id, created_at').order('created_at', { ascending: false }),
  );

  if (!recentResult.tableExists) {
    log.warn('hour_entries table not found — skipping inactive_7d signal');
    return [];
  }

  if (recentResult.error || !recentResult.data || recentResult.data.length === 0) {
    return [];
  }

  // Group by user to find their most recent entry and total count
  const userLastEntry = new Map<string, { lastEntry: string; count: number }>();
  for (const entry of recentResult.data) {
    const userId = entry.user_id as string;
    const existing = userLastEntry.get(userId);
    if (!existing) {
      userLastEntry.set(userId, { lastEntry: entry.created_at as string, count: 1 });
    } else {
      existing.count++;
    }
  }

  // Filter to users whose last entry is 7+ days ago and have at least 3 entries (were "regular")
  const inactiveUserIds: string[] = [];
  const userStats = new Map<string, { lastEntry: string; count: number }>();
  for (const [userId, data] of userLastEntry.entries()) {
    if (data.count >= 3 && data.lastEntry < sevenDaysAgo) {
      inactiveUserIds.push(userId);
      userStats.set(userId, data);
    }
  }

  if (inactiveUserIds.length === 0) return [];

  // Get profiles for inactive users
  const profilesResult = await safeSelect<Record<string, unknown>>(
    'profiles',
    (query) => query.in('id', inactiveUserIds),
  );

  if (!profilesResult.tableExists || profilesResult.error || !profilesResult.data) {
    return [];
  }

  const triggered: TriggeredUser[] = [];
  for (const profile of profilesResult.data) {
    const userId = profile.id as string;
    const stats = userStats.get(userId);
    if (!stats) continue;

    const lastEntryDate = new Date(stats.lastEntry);
    const daysInactive = Math.floor(
      (Date.now() - lastEntryDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    triggered.push({
      trigger: 'inactive_7d',
      user_id: userId,
      user_name: (profile.full_name || profile.display_name || 'there') as string,
      user_email: (profile.email || '') as string,
      user_state: (profile.state || 'Unknown') as string,
      user_tier: (profile.tier || 'free') as string,
      user_stats: `Logged ${stats.count} hours over their active period. Last entry ${daysInactive} days ago.`,
      days_inactive: daysInactive,
    });
  }

  return triggered;
}

/**
 * Find free-tier users with 100+ hours logged who are still active.
 */
async function findUpgradeCandidates(): Promise<TriggeredUser[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get hour counts per user
  const hoursResult = await safeSelect<Record<string, unknown>>(
    'hour_entries',
    (query) => query.select('user_id, created_at'),
  );

  if (!hoursResult.tableExists) {
    log.warn('hour_entries table not found — skipping upgrade_candidate signal');
    return [];
  }

  if (hoursResult.error || !hoursResult.data || hoursResult.data.length === 0) {
    return [];
  }

  // Group by user: count entries + most recent
  const userEntries = new Map<string, { count: number; lastEntry: string }>();
  for (const entry of hoursResult.data) {
    const userId = entry.user_id as string;
    const createdAt = entry.created_at as string;
    const existing = userEntries.get(userId);
    if (!existing) {
      userEntries.set(userId, { count: 1, lastEntry: createdAt });
    } else {
      existing.count++;
      if (createdAt > existing.lastEntry) {
        existing.lastEntry = createdAt;
      }
    }
  }

  // Filter: 100+ entries AND active in last 7 days
  const candidateUserIds: string[] = [];
  const candidateStats = new Map<string, { count: number; lastEntry: string }>();
  for (const [userId, data] of userEntries.entries()) {
    if (data.count >= 100 && data.lastEntry >= sevenDaysAgo) {
      candidateUserIds.push(userId);
      candidateStats.set(userId, data);
    }
  }

  if (candidateUserIds.length === 0) return [];

  // Get profiles — only free tier
  const profilesResult = await safeSelect<Record<string, unknown>>(
    'profiles',
    (query) => query.in('id', candidateUserIds).eq('tier', 'free'),
  );

  if (!profilesResult.tableExists || profilesResult.error || !profilesResult.data) {
    return [];
  }

  const triggered: TriggeredUser[] = [];
  for (const profile of profilesResult.data) {
    const userId = profile.id as string;
    const stats = candidateStats.get(userId);
    if (!stats) continue;

    triggered.push({
      trigger: 'upgrade_candidate',
      user_id: userId,
      user_name: (profile.full_name || profile.display_name || 'there') as string,
      user_email: (profile.email || '') as string,
      user_state: (profile.state || 'Unknown') as string,
      user_tier: 'free',
      user_stats: `Logged ${stats.count} hours. Active in last 7 days. Free tier.`,
    });
  }

  return triggered;
}

/**
 * Find supervisor verifications pending for 5+ days.
 */
async function findPendingVerification(): Promise<TriggeredUser[]> {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  // Check for a verification-related table
  const result = await safeSelect<Record<string, unknown>>(
    'hour_entries',
    (query) =>
      query
        .eq('verification_status', 'pending')
        .lt('created_at', fiveDaysAgo)
        .select('user_id, created_at'),
  );

  if (!result.tableExists) {
    log.warn('hour_entries table not found — skipping pending_verification signal');
    return [];
  }

  if (result.error || !result.data || result.data.length === 0) {
    return [];
  }

  // Group by user
  const userPending = new Map<string, { count: number; oldest: string }>();
  for (const entry of result.data) {
    const userId = entry.user_id as string;
    const createdAt = entry.created_at as string;
    const existing = userPending.get(userId);
    if (!existing) {
      userPending.set(userId, { count: 1, oldest: createdAt });
    } else {
      existing.count++;
      if (createdAt < existing.oldest) {
        existing.oldest = createdAt;
      }
    }
  }

  const userIds = Array.from(userPending.keys());
  if (userIds.length === 0) return [];

  const profilesResult = await safeSelect<Record<string, unknown>>(
    'profiles',
    (query) => query.in('id', userIds),
  );

  if (!profilesResult.tableExists || profilesResult.error || !profilesResult.data) {
    return [];
  }

  const triggered: TriggeredUser[] = [];
  for (const profile of profilesResult.data) {
    const userId = profile.id as string;
    const pending = userPending.get(userId);
    if (!pending) continue;

    const daysPending = Math.floor(
      (Date.now() - new Date(pending.oldest).getTime()) / (1000 * 60 * 60 * 24),
    );

    triggered.push({
      trigger: 'pending_verification',
      user_id: userId,
      user_name: (profile.full_name || profile.display_name || 'there') as string,
      user_email: (profile.email || '') as string,
      user_state: (profile.state || 'Unknown') as string,
      user_tier: (profile.tier || 'free') as string,
      user_stats: `${pending.count} verifications pending for ${daysPending}+ days`,
    });
  }

  return triggered;
}

/**
 * Check if a user was already targeted by nurture in the last 7 days.
 */
async function wasRecentlyNurtured(userId: string): Promise<boolean> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await safeSelect<Record<string, unknown>>(
    'admin_review_queue',
    (query) =>
      query
        .eq('agent', 'nurture')
        .eq('task_type', 'nurture_email')
        .gte('created_at', sevenDaysAgo)
        .contains('content', { user_id: userId }),
  );

  if (!result.tableExists || result.error) {
    return false;
  }

  return (result.data?.length ?? 0) > 0;
}

/**
 * Draft a lifecycle email for a triggered user.
 */
async function draftLifecycleEmail(
  user: TriggeredUser,
): Promise<{ email: LifecycleEmailResult; decisionId: string | null }> {
  const systemPrompt = loadPrompt('nurture/lifecycle-email', {
    trigger: user.trigger,
    user_name: user.user_name,
    user_state: user.user_state,
    user_tier: user.user_tier,
    user_stats: user.user_stats,
    days_inactive: String(user.days_inactive ?? 0),
  });

  const result = await callAnthropic({
    agent: 'nurture',
    decisionType: 'lifecycle_email',
    systemPrompt,
    userPrompt: `Draft a ${user.trigger} lifecycle email for this user.\n\nName: ${user.user_name}\nState: ${user.user_state}\nTier: ${user.user_tier}\nStats: ${user.user_stats}`,
    tools: [lifecycleEmailTool],
    toolChoice: { type: 'tool', name: 'draft_lifecycle_email' },
  });

  const parsed = result.parsedOutput as unknown as LifecycleEmailResult | null;
  if (!parsed) {
    throw new Error('Lifecycle email drafting returned no structured output');
  }

  return { email: parsed, decisionId: result.decisionId };
}

/**
 * Build a human-readable summary for the user.
 */
function buildUserSummary(user: TriggeredUser): string {
  const firstName = user.user_name.split(' ')[0] || user.user_name;
  return `${firstName}, ${user.user_state} user, ${user.user_tier === 'free' ? 'Free' : 'Pro'} tier. ${user.user_stats}`;
}

/**
 * Nurture agent: monitors user behavior in Supabase,
 * identifies lifecycle triggers, and drafts personalized
 * emails for human review.
 */
export async function run(): Promise<AgentResult> {
  const errors: AgentError[] = [];
  const warnings: AgentWarning[] = [];
  let itemsFound = 0;
  let itemsQueued = 0;
  let itemsSkipped = 0;

  // Step 1: Run all behavior signal queries
  const allTriggered: TriggeredUser[] = [];

  const signalQueries: Array<{ name: string; fn: () => Promise<TriggeredUser[]> }> = [
    { name: 'no_first_hour', fn: findNoFirstHour },
    { name: 'inactive_7d', fn: findInactive7d },
    { name: 'upgrade_candidate', fn: findUpgradeCandidates },
    { name: 'pending_verification', fn: findPendingVerification },
  ];

  for (const signal of signalQueries) {
    try {
      const users = await signal.fn();
      log.info({ signal: signal.name, count: users.length }, 'Signal query complete');
      allTriggered.push(...users);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ signal: signal.name, error: message }, 'Signal query failed');
      errors.push({
        step: `signal:${signal.name}`,
        message,
        recoverable: true,
      });
    }
  }

  itemsFound = allTriggered.length;

  if (allTriggered.length === 0) {
    log.info('No triggered users found');
    return {
      items_found: 0,
      items_queued: 0,
      items_skipped: 0,
      errors,
      warnings,
      summary: errors.length > 0
        ? `No triggered users found (${errors.length} signal query errors)`
        : 'No triggered users found',
    };
  }

  log.info({ total: allTriggered.length }, 'Triggered users found');

  // Step 2 & 3: Dedup and process each user
  for (const user of allTriggered) {
    try {
      // Dedup: skip if recently nurtured
      const recentlyNurtured = await wasRecentlyNurtured(user.user_id);
      if (recentlyNurtured) {
        log.info(
          { userId: user.user_id, trigger: user.trigger },
          'User recently nurtured — skipping',
        );
        itemsSkipped++;
        continue;
      }

      // Draft lifecycle email
      const { email, decisionId } = await draftLifecycleEmail(user);

      // Queue for review
      const queueId = await queueForReview({
        agent: 'nurture',
        task_type: 'nurture_email',
        title: `[${user.trigger}] ${email.subject}`,
        content: {
          trigger: user.trigger,
          user_id: user.user_id,
          user_summary: buildUserSummary(user),
          subject: email.subject,
          body: email.body,
          personalization_notes: email.personalization_notes || '',
        },
        reasoning: `Trigger: ${user.trigger}. ${user.user_stats}`,
        confidence: email.confidence,
        priority: user.trigger === 'upgrade_candidate' ? 'high' : 'normal',
      });

      // Link decision to queue item
      if (decisionId && queueId) {
        await linkDecisionToQueueItem(decisionId, queueId);
      }

      if (queueId) {
        itemsQueued++;
        log.info(
          { userId: user.user_id, trigger: user.trigger, queueId },
          'Nurture email drafted and queued',
        );
      } else {
        itemsSkipped++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { userId: user.user_id, trigger: user.trigger, error: message },
        'Failed to process triggered user',
      );
      errors.push({
        step: `nurture:${user.trigger}:${user.user_id}`,
        message,
        recoverable: true,
      });
    }
  }

  const summary = `Found ${itemsFound} triggered users: ${itemsQueued} emails queued, ${itemsSkipped} skipped, ${errors.length} errors`;
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
