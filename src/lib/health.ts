import express from 'express';
import { logger } from './logger';
import type { AgentName, AgentHealthStatus, HealthResponse, RunStatus } from '../types';

const log = logger.child({ module: 'health' });

const startTime = Date.now();

// In-memory state for health reporting
const agentHealth: Record<string, AgentHealthStatus> = {};
let costTodayCents = 0;
let costResetDate = new Date().toDateString();

const ALL_AGENTS: AgentName[] = [
  'scout', 'scribe-radar', 'scribe-draft', 'outreach',
  'inbox', 'watchdog', 'nurture', 'digest',
];

// Initialize all agents as "never run"
for (const agent of ALL_AGENTS) {
  agentHealth[agent] = { last_run: null, status: 'never', next_run: null };
}

/**
 * Update agent health after a run completes.
 */
export function updateAgentHealth(agent: AgentName, status: RunStatus, lastRun: Date, nextRun?: Date): void {
  agentHealth[agent] = {
    last_run: lastRun.toISOString(),
    status,
    next_run: nextRun?.toISOString() ?? null,
  };
}

/**
 * Add to today's cost tracker.
 */
export function addCostCents(cents: number): void {
  // Reset daily counter if date changed
  const today = new Date().toDateString();
  if (today !== costResetDate) {
    costTodayCents = 0;
    costResetDate = today;
  }
  costTodayCents += cents;
}

/**
 * Start the health check server on the configured port.
 */
export function startHealthServer(): void {
  const port = parseInt(process.env.HEALTH_PORT || '3001', 10);
  const app = express();

  app.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - startTime;
    const uptimeHours = Math.round((uptimeMs / 3600000) * 10) / 10;

    // Check if any agent has had a recent error
    const hasRecentError = Object.values(agentHealth).some((a) => a.status === 'error');
    const allNeverRun = Object.values(agentHealth).every((a) => a.status === 'never');

    let status: HealthResponse['status'] = 'healthy';
    if (hasRecentError) status = 'degraded';
    if (allNeverRun && uptimeMs > 3600000) status = 'unhealthy'; // No agents run after 1 hour

    const response: HealthResponse = {
      status,
      uptime_hours: uptimeHours,
      agents: agentHealth as Record<AgentName, AgentHealthStatus>,
      api_cost_today_cents: Math.round(costTodayCents),
    };

    res.json(response);
  });

  app.listen(port, () => {
    log.info({ port }, 'Health server started');
  });
}
