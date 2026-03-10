import cron from 'node-cron';
import { logger } from './lib/logger';
import { executeAgentRun } from './lib/run-logger';
import { run as runScout } from './agents/scout';
import { run as runScribeRadar } from './agents/scribe-radar';
import { run as runScribeDraft } from './agents/scribe-draft';
import { run as runOutreach } from './agents/outreach';
import { run as runInbox } from './agents/inbox';
import { run as runWatchdog } from './agents/watchdog';
import { run as runNurture } from './agents/nurture';
import { run as runDigest } from './agents/digest';

const log = logger.child({ module: 'scheduler' });

/**
 * Register all agent cron schedules.
 * Cron expressions use server local time.
 */
export function registerCrons(): void {
  // Scout — 6 AM, 12 PM, 6 PM
  cron.schedule('0 6,12,18 * * *', async () => {
    await executeAgentRun('scout', runScout);
  });

  // Scribe Radar — 1 AM daily
  cron.schedule('0 1 * * *', async () => {
    await executeAgentRun('scribe-radar', runScribeRadar);
  });

  // Scribe Draft — 2 AM daily
  cron.schedule('0 2 * * *', async () => {
    await executeAgentRun('scribe-draft', runScribeDraft);
  });

  // Outreach — 7 AM daily
  cron.schedule('0 7 * * *', async () => {
    await executeAgentRun('outreach', runOutreach);
  });

  // Inbox — every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await executeAgentRun('inbox', runInbox);
  });

  // Watchdog Daily — 8 AM Mon-Sat
  cron.schedule('0 8 * * 1-6', async () => {
    await executeAgentRun('watchdog', () => runWatchdog('daily'));
  });

  // Watchdog Weekly — Sunday 3 AM
  cron.schedule('0 3 * * 0', async () => {
    await executeAgentRun('watchdog', () => runWatchdog('weekly'));
  });

  // Nurture — every hour
  cron.schedule('0 * * * *', async () => {
    await executeAgentRun('nurture', runNurture);
  });

  // Digest — 8:30 AM daily
  cron.schedule('30 8 * * *', async () => {
    await executeAgentRun('digest', runDigest);
  });

  log.info('All cron schedules registered');
}
