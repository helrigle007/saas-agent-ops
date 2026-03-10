# SaaS Agent Ops

Multi-agent operations system for a SaaS product. These agents run on a dedicated server and handle operational tasks (community monitoring, content creation, outreach, email triage, SEO intel, user lifecycle emails). Every agent output queues to Supabase for human review before any action is taken. Nothing auto-publishes or auto-sends.

## Architecture

```
Server (Ubuntu Server ARM64) — always-on
├── 6 agents + 1 digest, each on cron schedules
├── All agents write to admin_review_queue in Supabase
├── Observability: run logs + decision logs + prompt versioning in Supabase
├── Local backup logs via pino + pino-roll (rotating JSON)
└── Health endpoint on :3001 for admin portal to ping

Supabase (shared with main app)
├── admin_review_queue      — pending items for human review
├── admin_agent_runs        — every execution logged (timing, tokens, cost)
├── admin_agent_decisions   — every AI call logged (full prompt + response)
├── admin_agent_prompts     — versioned prompts for A/B comparison
├── admin_outreach_targets  — cold email target database
├── admin_thread_cache      — discovered forum threads
└── admin_content_pipeline  — content ideas and drafts (shared with main app)
```

## Tech Stack

- **Runtime**: Node.js 20 LTS
- **Language**: TypeScript (compiled to JS for production)
- **AI**: Anthropic API (Claude Haiku for cost-efficient tasks, Sonnet for heavy work)
- **Database**: Supabase (Postgres) via @supabase/supabase-js
- **Email monitoring**: Gmail API via googleapis
- **Scheduling**: node-cron (in-process)
- **Process management**: PM2 or systemd
- **Logging**: pino + pino-roll (local) + Supabase writes (remote)
- **Health check**: Express on :3001

## Project Structure

```
saas-agent-ops/
├── src/
│   ├── agents/                    # One file per agent — each exports a run() function
│   │   ├── scout.ts               # Community monitoring + reply drafting
│   │   ├── scribe-radar.ts        # Trend scanning across communities/web
│   │   ├── scribe-draft.ts        # Content drafting from pipeline
│   │   ├── outreach.ts            # Cold email personalization
│   │   ├── inbox.ts               # Gmail monitoring + response drafting
│   │   ├── watchdog.ts            # SEO + competitor intel
│   │   ├── nurture.ts             # User lifecycle emails
│   │   └── digest.ts              # Morning briefing summary
│   ├── lib/
│   │   ├── supabase.ts            # Supabase client (service role key)
│   │   ├── anthropic.ts           # Anthropic API wrapper with token counting + cost tracking
│   │   ├── gmail.ts               # Gmail API client (OAuth2, read-only)
│   │   ├── logger.ts              # pino setup — dual output to local files + Supabase
│   │   ├── queue.ts               # Write to admin_review_queue (shared by all agents)
│   │   ├── run-logger.ts          # Write to admin_agent_runs (timing, tokens, cost)
│   │   ├── decision-logger.ts     # Write to admin_agent_decisions (full prompt/response)
│   │   └── health.ts              # Express server on :3001 for /health endpoint
│   ├── prompts/                   # All agent prompts — plain text, versioned, easy to diff
│   ├── types/
│   │   └── index.ts               # Shared types (mirrors Supabase table schemas)
│   └── scheduler.ts               # node-cron master schedule — registers all agent crons
├── docs/
│   └── migrations-reference.sql   # Schema reference (actual migrations in main app repo)
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Agent Roster

| Agent | Schedule | What it does | API cost/run |
|-------|----------|-------------|--------------|
| **Scout** | 6 AM, 12 PM, 6 PM | Discovers community threads, reads existing comments, identifies gaps, drafts replies only where value can be added | ~$0.30 |
| **Scribe (Radar)** | 1 AM | Scans communities + web for trending topics, cross-references Scout's thread cache for patterns, surfaces content ideas | ~$0.20 |
| **Scribe (Draft)** | 2 AM | Picks next content pipeline item, researches via web search, drafts full blog post/guide/social post with SEO optimization | ~$0.45 |
| **Outreach** | 7 AM | Researches outreach targets, drafts personalized cold emails | ~$0.15 |
| **Inbox** | Every 30 min | Polls Gmail, classifies emails, cross-references Supabase context, drafts responses | ~$0.00–0.05 |
| **Watchdog** | Daily 8 AM + Weekly Sun 3 AM | Monitors competitors, checks keyword rankings, scans for market changes | ~$0.10–0.30 |
| **Nurture** | Every hour | Monitors user behavior in Supabase (inactive users, upgrade candidates), drafts lifecycle emails | ~$0.08 |
| **Digest** | 8:30 AM | Summarizes all pending review items into a morning briefing | ~$0.05 |

## Critical Design Principles

### 1. Human-in-the-loop is non-negotiable
Every agent writes to `admin_review_queue` with status `pending`. Nothing gets posted, published, or sent without explicit human approval through the admin portal.

### 2. Scout reads before it writes
Scout fetches and analyzes existing thread comments before deciding whether to draft a reply. If the topic is already well-covered, it logs a skip (with reason) and moves on.

### 3. Scribe has two jobs
**Trend Radar** (1 AM) scans for what the community is discussing and surfaces content ideas. **Content Drafting** (2 AM) picks items from the pipeline and produces full drafts.

### 4. Everything is logged
Three tiers of observability:
- **Run logs** (`admin_agent_runs`): Every execution — timing, items found/queued/skipped, token counts, cost
- **Decision logs** (`admin_agent_decisions`): Every AI call — full system prompt, user prompt, raw response, parsed output
- **Prompt versions** (`admin_agent_prompts`): Versioned prompt text for A/B comparison

## Key Conventions

### Agent structure
Every agent file exports the same interface:
```typescript
export interface AgentResult {
  items_found: number;
  items_queued: number;
  items_skipped: number;
  errors: Array<{ step: string; message: string; recoverable: boolean }>;
  warnings: Array<{ step: string; message: string }>;
  summary: string;
}

export async function run(): Promise<AgentResult> { ... }
```

### Prompt files
Prompts live in `src/prompts/` as plain `.txt` files, NOT embedded in code. This makes them easy to diff, review, and version independently.

### Error handling
Agents must be resilient — a single platform failure shouldn't kill the whole run:
- Wrap each platform/step in try/catch
- Log errors but continue to next platform
- Return `run_status: 'partial'` if some steps failed but others succeeded
- Never throw unhandled exceptions — the scheduler must stay alive

### Testing
- Unit tests for prompt loading, queue writes, token counting, cost calculation
- Integration tests mock the Anthropic API and Supabase client
- Test files co-located: `src/agents/__tests__/agent.test.ts`
- Run with `npm test` (vitest)

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_TARGET_EMAIL=
HEALTH_PORT=3001
```
