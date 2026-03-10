// ============================================================
// Enums
// ============================================================

export type AgentName =
  | 'scout'
  | 'scribe-radar'
  | 'scribe-draft'
  | 'outreach'
  | 'inbox'
  | 'watchdog'
  | 'nurture'
  | 'digest';

export type RunStatus = 'success' | 'partial' | 'error' | 'skipped';

export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'rejected'
  | 'executed';

export type Priority = 'urgent' | 'high' | 'normal' | 'medium' | 'low';

export type OutreachStatus =
  | 'new'
  | 'researched'
  | 'drafted'
  | 'sent'
  | 'replied'
  | 'converted'
  | 'dead';

export type ThreadCacheStatus =
  | 'new'
  | 'queued'
  | 'replied'
  | 'analyzed'
  | 'drafted'
  | 'skipped'
  | 'monitoring'
  | 'posted';

export type ContentType =
  | 'blog_post'
  | 'state_guide'
  | 'social_post'
  | 'forum_seed'
  | 'email_campaign';

export type ContentPipelineStatus =
  | 'idea'
  | 'outlined'
  | 'drafting'
  | 'drafted'
  | 'review'
  | 'published'
  | 'archived'
  | 'rejected';

// ============================================================
// Agent Result — returned by every agent's run() function
// ============================================================

export interface AgentError {
  step: string;
  message: string;
  recoverable: boolean;
}

export interface AgentWarning {
  step: string;
  message: string;
}

export interface AgentResult {
  items_found: number;
  items_queued: number;
  items_skipped: number;
  errors: AgentError[];
  warnings: AgentWarning[];
  summary: string;
}

// ============================================================
// Supabase Table Row Types
// ============================================================

export interface ReviewQueueRow {
  id: string;
  agent: AgentName;
  task_type: string;
  status: ReviewStatus;
  priority: Priority;
  title: string;
  content: Record<string, unknown>;
  reasoning: string | null;
  confidence: number | null;
  source_url: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_notes: string | null;
  executed_at: string | null;
  expires_at: string | null;
}

export interface AgentRunRow {
  id: string;
  agent: AgentName;
  run_status: RunStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  items_found: number;
  items_queued: number;
  items_skipped: number;
  api_calls: number;
  api_input_tokens: number;
  api_output_tokens: number;
  api_cost_cents: number;
  search_calls: number;
  errors: AgentError[] | null;
  warnings: AgentWarning[] | null;
  run_config: Record<string, unknown> | null;
  summary: string | null;
  created_at: string;
}

export interface AgentDecisionRow {
  id: string;
  run_id: string;
  agent: AgentName;
  decision_type: string;
  prompt_system: string | null;
  prompt_user: string | null;
  raw_response: string | null;
  parsed_output: Record<string, unknown> | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  queue_item_id: string | null;
  review_outcome: string | null;
  edit_distance: number | null;
  created_at: string;
}

export interface AgentPromptRow {
  id: string;
  agent: AgentName;
  prompt_name: string;
  version: number;
  prompt_text: string;
  change_notes: string | null;
  active: boolean;
  created_at: string;
}

export interface OutreachTargetRow {
  id: string;
  category: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  website: string | null;
  state: string | null;
  notes: string | null;
  status: OutreachStatus;
  last_contacted_at: string | null;
  follow_up_at: string | null;
  created_at: string;
}

export interface ThreadCacheRow {
  id: string;
  platform: string;
  thread_url: string;
  thread_title: string;
  thread_snippet: string | null;
  relevance_score: number | null;
  relevance_reason: string | null;
  suggested_goal: string | null;
  engagement_goal: string | null;
  status: ThreadCacheStatus;
  comment_count: number | null;
  gap_analysis: Record<string, unknown> | null;
  discovered_at: string;
  expires_at: string | null;
  post_age: string | null;
  reply_count: number | null;
  is_resolved: boolean | null;
  saturation_note: string | null;
  last_checked_at: string;
}

export interface ContentPipelineRow {
  id: string;
  title: string;
  content_type: ContentType;
  status: ContentPipelineStatus;
  priority: Priority;
  description: string | null;
  target_keywords: string[] | null;
  target_platform: string | null;
  source: string | null;
  source_threads: Record<string, unknown>[] | null;
  trend_score: number | null;
  outline: string | null;
  draft: string | null;
  seo_metadata: Record<string, unknown> | null;
  assigned_date: string | null;
  due_date: string | null;
  target_date: string | null;
  published_date: string | null;
  published_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Queue Input — what agents pass to queueForReview()
// ============================================================

export interface QueueItemInput {
  agent: AgentName;
  task_type: string;
  title: string;
  content: Record<string, unknown>;
  reasoning?: string;
  confidence?: number;
  priority?: Priority;
  source_url?: string;
  expires_at?: Date;
}

// ============================================================
// Anthropic API Wrapper Types
// ============================================================

export interface AnthropicCallOptions {
  agent: AgentName;
  decisionType: string;
  systemPrompt: string;
  userPrompt: string;
  model?: 'haiku' | 'sonnet';
  tools?: AnthropicToolDefinition[];
  toolChoice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
  enableWebSearch?: boolean;
  maxTokens?: number;
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicCallResult {
  text: string;
  parsedOutput: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model: string;
  latencyMs: number;
  decisionId: string | null;
}

// ============================================================
// Health Endpoint Types
// ============================================================

export interface AgentHealthStatus {
  last_run: string | null;
  status: RunStatus | 'never';
  next_run: string | null;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime_hours: number;
  agents: Record<AgentName, AgentHealthStatus>;
  api_cost_today_cents: number;
}

// ============================================================
// Run Context — stored in AsyncLocalStorage
// ============================================================

export interface RunContext {
  runId: string;
  agent: AgentName;
  startedAt: Date;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  searchCalls: number;
}
