import { url, type GoogleApi } from './api.js';
import { buildRawDraft, validateRecipients, validateSubject, type ReplyContext } from './draft.js';
import { GoogleRequestError } from './errors.js';
import { bodyText, decodeEntities, header, type GPart } from './mime.js';
import type { EmailFull, EmailSummary, GmailProvider, NewDraft } from './types.js';

const ME = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** search() never fetches more than this many messages, whatever `max` asks for. */
export const MAX_SEARCH_RESULTS = 25;
const SUMMARY_HEADERS = ['From', 'To', 'Subject', 'Date'];

interface GMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

/**
 * Gmail: read and draft only. There is no send method and the HTTP allow-list has no
 * send endpoint (I8).
 */
export class GoogleGmail implements GmailProvider {
  constructor(private readonly api: GoogleApi) {}

  async search(ownerId: string, query: string, max: number): Promise<EmailSummary[]> {
    const limit = Math.max(1, Math.min(Math.floor(max) || 1, MAX_SEARCH_RESULTS));
    const list = await this.api.call<{ messages?: { id?: string }[] }>(ownerId, 'gmailRead', {
      method: 'GET',
      url: url(`${ME}/messages`, { q: query, maxResults: limit }),
    });
    const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').slice(0, limit);
    const out: EmailSummary[] = [];
    for (const id of ids) {
      const m = await this.fetch(ownerId, id, { format: 'metadata', metadataHeaders: SUMMARY_HEADERS });
      out.push(summary(m));
    }
    return out;
  }

  async getMessage(ownerId: string, id: string): Promise<EmailFull> {
    const m = await this.fetch(ownerId, id, { format: 'full' });
    return { ...summary(m), bodyText: bodyText(m.payload) };
  }

  async createDraft(ownerId: string, draft: NewDraft): Promise<{ draftId: string }> {
    validateRecipients(draft.to);
    validateSubject(draft.subject);
    let threadId: string | undefined;
    let reply: ReplyContext | undefined;
    if (draft.replyToMessageId) {
      // Threading needs the original's Message-ID, which is a read.
      const original = await this.api.call<GMessage>(ownerId, 'gmailRead', {
        method: 'GET',
        url: url(`${ME}/messages/${encodeURIComponent(draft.replyToMessageId)}`, { format: 'metadata', metadataHeaders: ['Message-ID', 'References'] }),
      });
      threadId = original.threadId;
      reply = { messageId: header(original.payload, 'Message-ID').trim(), references: header(original.payload, 'References') };
    }
    const raw = buildRawDraft({ to: draft.to, subject: draft.subject, body: draft.body, ...(reply ? { reply } : {}) });
    const res = await this.api.call<{ id?: string }>(ownerId, 'gmailDraft', {
      method: 'POST',
      url: `${ME}/drafts`,
      json: { message: { raw, ...(threadId ? { threadId } : {}) } },
    });
    if (!res.id) throw new GoogleRequestError('google drafts.create: response without id');
    return { draftId: res.id };
  }

  private async fetch(ownerId: string, id: string, query: Record<string, string | string[]>): Promise<GMessage> {
    const m = await this.api.call<GMessage>(ownerId, 'gmailRead', { method: 'GET', url: url(`${ME}/messages/${encodeURIComponent(id)}`, query) });
    if (!m.id) throw new GoogleRequestError('google messages.get: response without id');
    return m;
  }
}

function summary(m: GMessage): EmailSummary {
  const ms = Number(m.internalDate);
  const fallback = Date.parse(header(m.payload, 'Date'));
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To'),
    subject: header(m.payload, 'Subject'),
    snippet: decodeEntities(m.snippet ?? ''),
    date: new Date(Number.isFinite(ms) && ms > 0 ? ms : Number.isNaN(fallback) ? 0 : fallback),
  };
}
