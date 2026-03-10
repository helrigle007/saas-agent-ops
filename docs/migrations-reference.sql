-- SaaS Agent Ops Tables — Reference Only
-- Actual migrations live in the main main app repo (supabase/migrations/)
-- This file exists so agent developers can see the schemas without switching repos.

-- ============================================================
-- admin_review_queue — All agent outputs land here for human review
-- ============================================================
CREATE TABLE admin_review_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'edited', 'rejected', 'executed')),
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  reasoning TEXT,
  confidence DECIMAL(3,2),
  source_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_notes TEXT,
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_review_status ON admin_review_queue(status);
CREATE INDEX idx_review_agent ON admin_review_queue(agent);
CREATE INDEX idx_review_priority ON admin_review_queue(priority);
CREATE INDEX idx_review_created ON admin_review_queue(created_at DESC);

-- ============================================================
-- admin_agent_runs — Every agent execution logged
-- ============================================================
CREATE TABLE admin_agent_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent TEXT NOT NULL,
  run_status TEXT NOT NULL
    CHECK (run_status IN ('success', 'partial', 'error', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL,
  items_found INTEGER DEFAULT 0,
  items_queued INTEGER DEFAULT 0,
  items_skipped INTEGER DEFAULT 0,
  api_calls INTEGER DEFAULT 0,
  api_input_tokens INTEGER DEFAULT 0,
  api_output_tokens INTEGER DEFAULT 0,
  api_cost_cents INTEGER DEFAULT 0,
  search_calls INTEGER DEFAULT 0,
  errors JSONB,
  warnings JSONB,
  run_config JSONB,
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_agent ON admin_agent_runs(agent);
CREATE INDEX idx_agent_runs_status ON admin_agent_runs(run_status);
CREATE INDEX idx_agent_runs_started ON admin_agent_runs(started_at DESC);

-- ============================================================
-- admin_agent_decisions — Every AI call logged (full prompt + response)
-- ============================================================
CREATE TABLE admin_agent_decisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID REFERENCES admin_agent_runs(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  prompt_system TEXT,
  prompt_user TEXT,
  raw_response TEXT,
  parsed_output JSONB,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  queue_item_id UUID REFERENCES admin_review_queue(id) ON DELETE SET NULL,
  review_outcome TEXT,
  edit_distance INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_decisions_run ON admin_agent_decisions(run_id);
CREATE INDEX idx_decisions_agent ON admin_agent_decisions(agent);
CREATE INDEX idx_decisions_type ON admin_agent_decisions(decision_type);
CREATE INDEX idx_decisions_created ON admin_agent_decisions(created_at DESC);

-- ============================================================
-- admin_agent_prompts — Versioned prompt tracking
-- ============================================================
CREATE TABLE admin_agent_prompts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent TEXT NOT NULL,
  prompt_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  change_notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_prompt_version ON admin_agent_prompts(agent, prompt_name, version);

-- ============================================================
-- admin_outreach_targets — Cold email target database
-- ============================================================
CREATE TABLE admin_outreach_targets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  website TEXT,
  state TEXT,
  notes TEXT,
  status TEXT DEFAULT 'new'
    CHECK (status IN ('new', 'researched', 'drafted', 'sent', 'replied', 'converted', 'dead')),
  last_contacted_at TIMESTAMPTZ,
  follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- admin_thread_cache — Discovered forum threads (Scout writes, Scribe reads)
-- ============================================================
CREATE TABLE admin_thread_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL,
  thread_url TEXT NOT NULL UNIQUE,
  thread_title TEXT NOT NULL,
  thread_snippet TEXT,
  relevance_score DECIMAL(3,2),
  engagement_goal TEXT,
  status TEXT DEFAULT 'new'
    CHECK (status IN ('new', 'analyzed', 'drafted', 'skipped', 'monitoring', 'posted')),
  comment_count INTEGER,
  gap_analysis JSONB,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_thread_cache_platform ON admin_thread_cache(platform);
CREATE INDEX idx_thread_cache_status ON admin_thread_cache(status);
CREATE INDEX idx_thread_cache_discovered ON admin_thread_cache(discovered_at DESC);

-- ============================================================
-- admin_content_pipeline — Content ideas and drafts
-- (Shared with main app — Scribe Radar writes ideas, Scribe Draft reads)
-- ============================================================
CREATE TABLE admin_content_pipeline (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('blog_post', 'state_guide', 'social_post', 'forum_seed', 'email_campaign')),
  status TEXT DEFAULT 'idea'
    CHECK (status IN ('idea', 'outlined', 'drafting', 'drafted', 'review', 'published', 'rejected')),
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  source TEXT,
  source_threads JSONB,
  trend_score DECIMAL(3,2),
  outline TEXT,
  draft TEXT,
  seo_metadata JSONB,
  target_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_content_pipeline_status ON admin_content_pipeline(status);
CREATE INDEX idx_content_pipeline_type ON admin_content_pipeline(content_type);
