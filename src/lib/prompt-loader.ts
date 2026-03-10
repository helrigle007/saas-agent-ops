import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const log = logger.child({ module: 'prompt-loader' });

// Use process.cwd() to resolve prompts — avoids __dirname issues after TS compilation
const PROMPTS_DIR = path.join(process.cwd(), 'src', 'prompts');

/**
 * Load a prompt template from src/prompts/ and interpolate {{variables}}.
 *
 * @param promptPath - Slash-separated path relative to prompts dir, e.g. "scout/reply-drafting"
 * @param variables - Key-value pairs to interpolate into {{key}} placeholders
 * @returns The resolved prompt text
 */
export function loadPrompt(
  promptPath: string,
  variables: Record<string, string> = {},
): string {
  const filePath = path.join(PROMPTS_DIR, `${promptPath}.txt`);

  if (!fs.existsSync(filePath)) {
    log.error({ path: filePath }, 'Prompt file not found');
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  let text = fs.readFileSync(filePath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }

  // Warn about unresolved placeholders
  const unresolved = text.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    log.warn(
      { path: promptPath, unresolved },
      'Prompt has unresolved placeholders',
    );
  }

  return text;
}

/**
 * Get the prompt version hash (first 8 chars of content hash) for tracking.
 */
export function getPromptVersion(promptPath: string): string {
  const filePath = path.join(PROMPTS_DIR, `${promptPath}.txt`);
  if (!fs.existsSync(filePath)) return 'unknown';

  const content = fs.readFileSync(filePath, 'utf-8');
  // Simple hash — enough for version tracking, not crypto
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8);
}
