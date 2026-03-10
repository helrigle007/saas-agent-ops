import { google, gmail_v1 } from 'googleapis';
import { logger } from './logger';

const log = logger.child({ module: 'gmail' });

let gmailClient: gmail_v1.Gmail | null = null;

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  labels: string[];
}

/**
 * Initialize the Gmail client with OAuth2 credentials.
 * Call once at startup.
 */
export function initGmail(): gmail_v1.Gmail | null {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    log.warn('Gmail credentials not set — Inbox agent will be disabled');
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  log.info('Gmail client initialized');
  return gmailClient;
}

/**
 * Get the initialized Gmail client (or null if not configured).
 */
export function getGmailClient(): gmail_v1.Gmail | null {
  return gmailClient;
}

/**
 * Poll for unread emails in the target inbox.
 */
export async function pollUnread(maxResults = 10): Promise<EmailMessage[]> {
  if (!gmailClient) {
    log.warn('Gmail not initialized — skipping poll');
    return [];
  }

  const targetEmail = process.env.GMAIL_TARGET_EMAIL;
  if (!targetEmail) {
    log.warn('GMAIL_TARGET_EMAIL not set — skipping poll');
    return [];
  }

  try {
    const response = await gmailClient.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults,
    });

    const messages = response.data.messages || [];
    if (messages.length === 0) return [];

    const fullMessages: EmailMessage[] = [];
    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        const full = await getMessageFull(msg.id);
        if (full) fullMessages.push(full);
      } catch (err) {
        log.error({ messageId: msg.id, error: (err as Error).message }, 'Failed to fetch message');
      }
    }

    return fullMessages;
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Gmail poll failed');
    return [];
  }
}

/**
 * Get full message details including body.
 */
export async function getMessageFull(messageId: string): Promise<EmailMessage | null> {
  if (!gmailClient) return null;

  const response = await gmailClient.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = response.data;
  const headers = msg.payload?.headers || [];

  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  // Extract body from message parts
  let body = '';
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
  } else if (msg.payload?.parts) {
    const textPart = msg.payload.parts.find(
      (p) => p.mimeType === 'text/plain',
    );
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    }
  }

  return {
    id: msg.id || messageId,
    threadId: msg.threadId || '',
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    snippet: msg.snippet || '',
    body,
    labels: msg.labelIds || [],
  };
}

/**
 * Mark an email as read by removing the UNREAD label.
 */
export async function markAsRead(messageId: string): Promise<void> {
  if (!gmailClient) return;

  await gmailClient.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });

  log.debug({ messageId }, 'Email marked as read');
}
