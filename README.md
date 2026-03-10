# saas-agent-ops

<p align="center"><img src="docs/dashbaord.png" width="720" /></p>

A multi-agent operations system that autonomously handles growth tasks for a SaaS product — community monitoring, content creation, cold outreach, email triage, SEO intelligence, and user lifecycle emails. Every output queues for human review before any action is taken.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Server (Node.js)                   │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  Scout   │  │  Scribe  │  │ Outreach │  │  Inbox   │     │
│  │ (forums) │  │(content) │  │ (email)  │  │ (gmail)  │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │             │             │             │           │
│  ┌────┴─────┐  ┌────┴─────┐                                 │
│  │ Watchdog │  │ Nurture  │      ┌──────────┐               │
│  │  (SEO)   │  │(lifecycle│      │  Digest  │               │
│  └────┬─────┘  └────┬─────┘      │(briefing)│               │
│       │             │            └────┬─────┘               │
│       └─────────────┴─────────────────┘                     │
│                          │                                  │
│              ┌───────────┴───────────┐                      │
│              │  Anthropic API        │                      │
│              │  (Haiku + Sonnet)     │                      │
│              └───────────────────────┘                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │       Supabase          │
              │  ┌───────────────────┐  │
              │  │ admin_review_queue│◄─┼── All agents write here
              │  │ admin_agent_runs  │  │   (human reviews before action)
              │  │ admin_agent_dec.  │  │
              │  │ admin_agent_prmpt │  │
              │  │ admin_thread_cache│  │
              │  │ admin_content_pipe│  │
              │  │ admin_outreach_tgt│  │
              │  └───────────────────┘  │
              └─────────────────────────┘
```

## Agent Roster

| Agent | Schedule | What it does |
|-------|----------|-------------|
| **Scout** | 3x/day | Discovers relevant community threads, analyzes existing comments, identifies gaps, drafts replies only where genuine value can be added |
| **Scribe Radar** | 1 AM | Scans communities + web for trending topics, cross-references thread cache, surfaces content ideas |
| **Scribe Draft** | 2 AM | Picks highest-priority pipeline item, researches via web search, drafts full content piece with SEO metadata |
| **Outreach** | 7 AM | Researches outreach targets via web, drafts personalized cold emails with UTM tracking |
| **Inbox** | Every 30 min | Polls Gmail, classifies emails (support/outreach reply/spam), cross-references Supabase for context, drafts responses |
| **Watchdog** | Daily + Weekly | Monitors competitor activity, tracks keyword rankings, identifies backlink opportunities |
| **Nurture** | Every hour | Detects user lifecycle signals (inactive, upgrade candidate, onboarding stall), drafts personalized emails |
| **Digest** | 8:30 AM | Summarizes all pending review items and agent activity into a scannable morning briefing |

## Key Design Decisions

| Decision | Chose | Rationale |
|----------|-------|-----------|
| **Human-in-the-loop** | Every output queued for review | Non-negotiable. Agents draft — humans decide. Nothing auto-publishes. |
| **Read before write** | Scout analyzes existing comments before drafting | Avoids redundant replies. Gap detection is the key differentiator. |
| **Haiku default, Sonnet for drafts** | Claude Haiku everywhere except content drafting | ~60% cost savings. Haiku handles classification and short-form well. Sonnet's quality matters for 1,500-word articles. |
| **Prompts in .txt files** | Separate files in `src/prompts/`, not inline code | Prompt tuning is the #1 maintenance task. Plain text is easier to diff, review, and version. |
| **Three-tier observability** | Run logs → Decision logs → Prompt versions | Different questions need different granularity. "Did it work?" vs "Why did it produce that?" vs "Did my prompt change help?" |
| **Resilient error handling** | Per-step try/catch, partial success status | A single API timeout shouldn't kill an entire agent run. Log the error, continue to next step. |
| **Structured output via tool_use** | AI "calls" a tool to return JSON | Reliable structured extraction. Each agent decision type has a defined schema. |

## Tech Stack

- **Runtime**: Node.js 20 LTS + TypeScript
- **AI**: Anthropic API (Claude Haiku + Sonnet) with web search tool
- **Database**: Supabase (Postgres)
- **Email**: Gmail API (OAuth2, read-only)
- **Scheduling**: node-cron (in-process)
- **Process management**: PM2 or systemd
- **Logging**: pino + pino-roll (local rotating files) + Supabase (remote)
- **Testing**: vitest (62 tests)
- **Health check**: Express endpoint on :3001

## Quick Start

```bash
git clone <repo>
cd saas-agent-ops
npm install
cp .env.example .env   # Fill in API keys
npm run build           # Compile TypeScript
npm test                # Run 62 tests
npm start               # Start with cron schedules
```

### Development

```bash
npm run dev             # Run with tsx (no compile step)
npm run test:watch      # Watch mode for tests
```

### Production (PM2)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Project Structure

```
src/
├── agents/           # 8 agents, each exports run(): Promise<AgentResult>
│   └── __tests__/    # Co-located tests with mocked Anthropic + Supabase
├── lib/              # Shared infrastructure (API wrapper, queue, logging)
├── prompts/          # 14 plain-text prompt files, organized by agent
├── types/            # TypeScript types mirroring Supabase schemas
└── scheduler.ts      # Cron registration for all agents
```

## Estimated Cost

~$68/month across all agents at current run frequencies (mostly Claude Haiku at $0.25/$1.25 per million input/output tokens).
