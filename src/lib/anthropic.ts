import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';
import { logDecision } from './decision-logger';
import { trackApiCall } from './run-logger';
import type { AnthropicCallOptions, AnthropicCallResult } from '../types';

const log = logger.child({ module: 'anthropic' });

const client = new Anthropic();

// Model IDs
const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-20250514',
} as const;

// Cost per million tokens (from env or defaults)
function getCostRates(model: 'haiku' | 'sonnet') {
  if (model === 'haiku') {
    return {
      inputPerM: parseFloat(process.env.ANTHROPIC_HAIKU_INPUT_COST_PER_M || '0.25'),
      outputPerM: parseFloat(process.env.ANTHROPIC_HAIKU_OUTPUT_COST_PER_M || '1.25'),
    };
  }
  return {
    inputPerM: parseFloat(process.env.ANTHROPIC_SONNET_INPUT_COST_PER_M || '3.00'),
    outputPerM: parseFloat(process.env.ANTHROPIC_SONNET_OUTPUT_COST_PER_M || '15.00'),
  };
}

/**
 * Calculate cost in cents from token counts and model.
 */
function calculateCostCents(inputTokens: number, outputTokens: number, model: 'haiku' | 'sonnet'): number {
  const rates = getCostRates(model);
  return (inputTokens * rates.inputPerM / 1_000_000 + outputTokens * rates.outputPerM / 1_000_000) * 100;
}

/**
 * Call the Anthropic API with full observability.
 *
 * Supports:
 * - web_search tool for agents that need internet access
 * - tool_use for structured JSON output (preferred over text parsing)
 * - Automatic token tracking and cost calculation
 * - Decision logging to admin_agent_decisions
 */
export async function callAnthropic(options: AnthropicCallOptions): Promise<AnthropicCallResult> {
  const model = options.model || 'haiku';
  const modelId = MODELS[model];
  const maxTokens = options.maxTokens || (model === 'sonnet' ? 16384 : 8192);

  // Build tools array
  const tools: Anthropic.Messages.Tool[] = [];

  if (options.enableWebSearch) {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    } as unknown as Anthropic.Messages.Tool);
  }

  if (options.tools) {
    for (const tool of options.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Messages.Tool.InputSchema,
      });
    }
  }

  const startMs = Date.now();

  try {
    const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: modelId,
      max_tokens: maxTokens,
      system: options.systemPrompt,
      messages: [{ role: 'user', content: options.userPrompt }],
    };

    if (tools.length > 0) {
      requestParams.tools = tools;
    }

    if (options.toolChoice) {
      requestParams.tool_choice = options.toolChoice as Anthropic.Messages.ToolChoice;
    }

    const response = await client.messages.create(requestParams);

    const latencyMs = Date.now() - startMs;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costCents = calculateCostCents(inputTokens, outputTokens, model);

    // Extract text and tool_use results
    let text = '';
    let parsedOutput: Record<string, unknown> | null = null;
    const hasSearch = options.enableWebSearch;

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        // If this is one of our output tools (not web_search), capture its input as parsedOutput
        if (block.name !== 'web_search') {
          parsedOutput = block.input as Record<string, unknown>;
        }
      }
    }

    // Track in run context
    trackApiCall(inputTokens, outputTokens, costCents, hasSearch || false);

    // Log the decision
    const decisionId = await logDecision({
      agent: options.agent,
      decisionType: options.decisionType,
      promptSystem: options.systemPrompt,
      promptUser: options.userPrompt,
      rawResponse: JSON.stringify(response.content),
      parsedOutput,
      model: modelId,
      inputTokens,
      outputTokens,
      latencyMs,
    });

    log.debug(
      {
        agent: options.agent,
        decision_type: options.decisionType,
        model: modelId,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_cents: Math.round(costCents * 100) / 100,
        latency_ms: latencyMs,
      },
      'Anthropic API call completed',
    );

    return {
      text,
      parsedOutput,
      inputTokens,
      outputTokens,
      costCents,
      model: modelId,
      latencyMs,
      decisionId,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ agent: options.agent, decision_type: options.decisionType, error: message, latency_ms: latencyMs }, 'Anthropic API call failed');
    throw err;
  }
}
