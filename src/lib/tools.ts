import type { AnthropicToolDefinition } from '../types';

/**
 * Anthropic tool_use schemas for structured output.
 * Each agent decision type defines its expected JSON shape as a tool schema.
 * The AI "calls" the tool to return structured data instead of free-text.
 */

// ============================================================
// Scout Tools
// ============================================================

export const threadDiscoveryTool: AnthropicToolDefinition = {
  name: 'report_threads',
  description: 'Report discovered forum threads with relevance scores',
  input_schema: {
    type: 'object',
    properties: {
      threads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: ['reddit', 'indiehackers', 'producthunt'] },
            thread_url: { type: 'string' },
            thread_title: { type: 'string' },
            thread_snippet: { type: 'string' },
            relevance_score: { type: 'number', minimum: 0, maximum: 1 },
            engagement_goal: { type: 'string', enum: ['credibility', 'helpful', 'soft-promote', 'direct-link'] },
            reasoning: { type: 'string' },
          },
          required: ['platform', 'thread_url', 'thread_title', 'relevance_score', 'engagement_goal'],
        },
      },
    },
    required: ['threads'],
  },
};

export const commentAnalysisTool: AnthropicToolDefinition = {
  name: 'report_comment_analysis',
  description: 'Report analysis of existing thread comments and identified gaps',
  input_schema: {
    type: 'object',
    properties: {
      total_replies: { type: 'number' },
      quality_summary: { type: 'string' },
      conversation_tone: { type: 'string' },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['misinformation', 'unanswered_followup', 'missing_context', 'missing_perspective', 'outdated_info'] },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['type', 'description', 'severity'],
        },
      },
      recommendation: { type: 'string', enum: ['draft', 'skip', 'monitor'] },
      recommendation_reason: { type: 'string' },
    },
    required: ['total_replies', 'quality_summary', 'gaps', 'recommendation', 'recommendation_reason'],
  },
};

export const replyDraftingTool: AnthropicToolDefinition = {
  name: 'draft_reply',
  description: 'Draft a forum reply that addresses identified gaps',
  input_schema: {
    type: 'object',
    properties: {
      reply_text: { type: 'string' },
      addresses_gap: { type: 'string' },
      tone_check: { type: 'string', enum: ['natural', 'slightly_formal', 'too_formal'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['reply_text', 'addresses_gap', 'confidence'],
  },
};

// ============================================================
// Scribe Tools
// ============================================================

export const trendRadarTool: AnthropicToolDefinition = {
  name: 'report_trends',
  description: 'Report trending topics and content ideas from forum/web scanning',
  input_schema: {
    type: 'object',
    properties: {
      trends: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content_type: { type: 'string', enum: ['blog_post', 'state_guide', 'social_post', 'forum_seed', 'email_campaign'] },
            trend_score: { type: 'number', minimum: 0, maximum: 1 },
            priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
            source: { type: 'string' },
            source_threads: { type: 'array', items: { type: 'string' } },
            reasoning: { type: 'string' },
            angle: { type: 'string' },
            target_keywords: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'content_type', 'trend_score', 'priority', 'source', 'reasoning'],
        },
      },
    },
    required: ['trends'],
  },
};

export const contentDraftingTool: AnthropicToolDefinition = {
  name: 'draft_content',
  description: 'Draft full content piece with SEO metadata',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      slug: { type: 'string' },
      content_type: { type: 'string' },
      body: { type: 'string' },
      meta_title: { type: 'string' },
      meta_description: { type: 'string' },
      target_keywords: { type: 'array', items: { type: 'string' } },
      word_count: { type: 'number' },
      outline: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'slug', 'body', 'meta_title', 'meta_description', 'target_keywords', 'word_count'],
  },
};

// ============================================================
// Outreach Tools
// ============================================================

export const targetResearchTool: AnthropicToolDefinition = {
  name: 'report_research',
  description: 'Report research findings about an outreach target',
  input_schema: {
    type: 'object',
    properties: {
      organization_summary: { type: 'string' },
      program_size: { type: 'string' },
      key_personnel: { type: 'string' },
      pain_points: { type: 'array', items: { type: 'string' } },
      personalization_hooks: { type: 'array', items: { type: 'string' } },
      relevance_score: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['organization_summary', 'pain_points', 'personalization_hooks', 'relevance_score'],
  },
};

export const emailDraftingTool: AnthropicToolDefinition = {
  name: 'draft_email',
  description: 'Draft a personalized outreach email',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      personalization_notes: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      follow_up_days: { type: 'number' },
    },
    required: ['subject', 'body', 'confidence', 'follow_up_days'],
  },
};

// ============================================================
// Inbox Tools
// ============================================================

export const emailClassificationTool: AnthropicToolDefinition = {
  name: 'classify_email',
  description: 'Classify an incoming email and determine required action',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['outreach_reply', 'user_support', 'user_feedback', 'transactional', 'spam_noise', 'urgent'] },
      priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
      summary: { type: 'string' },
      requires_response: { type: 'boolean' },
      related_outreach_target: { type: 'string' },
      related_user_email: { type: 'string' },
    },
    required: ['category', 'priority', 'summary', 'requires_response'],
  },
};

export const responseDraftingTool: AnthropicToolDefinition = {
  name: 'draft_response',
  description: 'Draft an email response',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      tone: { type: 'string', enum: ['professional', 'friendly', 'support', 'follow_up'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['subject', 'body', 'tone', 'confidence'],
  },
};

// ============================================================
// Watchdog Tools
// ============================================================

export const competitorScanTool: AnthropicToolDefinition = {
  name: 'report_competitor_intel',
  description: 'Report competitor intelligence findings',
  input_schema: {
    type: 'object',
    properties: {
      alerts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            alert_type: { type: 'string', enum: ['competitor_pricing', 'competitor_feature', 'new_competitor', 'mention', 'market_shift', 'backlink_opportunity'] },
            title: { type: 'string' },
            details: { type: 'string' },
            implications: { type: 'string' },
            recommended_action: { type: 'string' },
            evidence_url: { type: 'string' },
            priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
          },
          required: ['alert_type', 'title', 'details', 'priority'],
        },
      },
    },
    required: ['alerts'],
  },
};

export const seoCheckTool: AnthropicToolDefinition = {
  name: 'report_seo_status',
  description: 'Report SEO keyword ranking and backlink status',
  input_schema: {
    type: 'object',
    properties: {
      keyword_rankings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            position: { type: 'number' },
            url: { type: 'string' },
            change: { type: 'string', enum: ['up', 'down', 'stable', 'new', 'lost'] },
          },
          required: ['keyword', 'position', 'change'],
        },
      },
      backlink_opportunities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source_url: { type: 'string' },
            context: { type: 'string' },
            opportunity_type: { type: 'string' },
          },
          required: ['source_url', 'context'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['keyword_rankings', 'summary'],
  },
};

// ============================================================
// Nurture Tools
// ============================================================

export const lifecycleEmailTool: AnthropicToolDefinition = {
  name: 'draft_lifecycle_email',
  description: 'Draft a lifecycle/nurture email for a user trigger',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      trigger: { type: 'string' },
      personalization_notes: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['subject', 'body', 'trigger', 'confidence'],
  },
};

// ============================================================
// Digest Tools
// ============================================================

export const morningBriefingTool: AnthropicToolDefinition = {
  name: 'compose_briefing',
  description: 'Compose the morning briefing summary',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string' },
            summary: { type: 'string' },
            items_pending: { type: 'number' },
            highlights: { type: 'array', items: { type: 'string' } },
            concerns: { type: 'array', items: { type: 'string' } },
          },
          required: ['agent', 'summary', 'items_pending'],
        },
      },
      total_pending: { type: 'number' },
      total_cost_24h_cents: { type: 'number' },
      action_items: { type: 'array', items: { type: 'string' } },
    },
    required: ['headline', 'sections', 'total_pending', 'total_cost_24h_cents'],
  },
};
