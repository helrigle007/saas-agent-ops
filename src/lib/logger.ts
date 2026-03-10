import pino from 'pino';
import path from 'path';
import type { AgentName } from '../types';

const logsDir = path.join(process.cwd(), 'logs');

/**
 * Root logger with dual transport:
 * - stdout for PM2/systemd capture
 * - rotating local files for backup/debug
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      // stdout — PM2/systemd captures this
      {
        target: 'pino/file',
        options: { destination: 1 },
        level: 'info',
      },
      // Rotating run log file (30-day retention)
      {
        target: 'pino-roll',
        options: {
          file: path.join(logsDir, 'agent-runs'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          limit: { count: 30 },
          mkdir: true,
        },
        level: 'info',
      },
      // Rotating error log file
      {
        target: 'pino-roll',
        options: {
          file: path.join(logsDir, 'agent-errors'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          limit: { count: 30 },
          mkdir: true,
        },
        level: 'error',
      },
      // API call log (7-day retention)
      {
        target: 'pino-roll',
        options: {
          file: path.join(logsDir, 'api-calls'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          limit: { count: 7 },
          mkdir: true,
        },
        level: 'debug',
      },
    ],
  },
});

/**
 * Create a child logger scoped to a specific agent.
 */
export function createAgentLogger(agent: AgentName) {
  return logger.child({ agent });
}
