import dotenv from 'dotenv';
dotenv.config();

import { logger } from './lib/logger';
import { startHealthServer } from './lib/health';
import { registerCrons } from './scheduler';
import { initGmail } from './lib/gmail';

const log = logger.child({ module: 'main' });

// Validate required env vars
const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  log.error({ missing }, 'Missing required environment variables');
  process.exit(1);
}

// Initialize services
log.info('Starting SaaS Agent Ops...');

// Gmail client (optional — Inbox agent disabled if not configured)
initGmail();

// Health endpoint
startHealthServer();

// Register all cron schedules
registerCrons();

log.info('SaaS Agent Ops started successfully');

// Graceful shutdown
function shutdown(signal: string) {
  log.info({ signal }, 'Received shutdown signal');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep process alive
process.on('uncaughtException', (err) => {
  log.fatal({ error: err.message, stack: err.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection');
});
