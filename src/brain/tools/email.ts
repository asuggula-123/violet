import { z } from 'zod';
import { quote } from '../../core/sanitize.js';
import { GoogleError } from '../../google/errors.js';
import { ToolError } from '../../llm/tools.js';
import { formatDateTime } from '../time.js';
import type { BrainTool } from '../types.js';
import { wrapUntrusted } from '../untrusted.js';
import { cap, line, type BrainToolDeps } from './deps.js';

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const BODY_MAX = 8_000;

const searchInput = z.object({
  query: z.string().trim().min(1).max(300).describe('Gmail search query, e.g. "from:school subject:trip"'),
  max_results: z.number().int().min(1).max(20).optional().describe('Default 10'),
});
const readInput = z.object({ id: z.string().trim().min(1).max(200).describe('Message id from search_email') });
const draftInput = z.object({
  to: z.array(z.string().trim().regex(EMAIL, 'must be an email address')).min(1).max(20),
  subject: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20_000),
  reply_to_id: z.string().trim().min(1).max(200).optional().describe('Message id this draft replies to'),
});

export function emailTools(d: BrainToolDeps): BrainTool[] {
  const search: BrainTool<z.infer<typeof searchInput>> = {
    name: 'search_email',
    description: "Search the owner's Gmail. Returns ids, senders, subjects and snippets (untrusted).",
    input: searchInput,
    taints: true,
    async handler(input, ctx) {
      const found = await d.gmail.search(ctx.owner.id, input.query, input.max_results ?? 10);
      if (found.length === 0) return 'No emails found.';
      const rows = found.map(
        (m) =>
          `- id: ${line(m.id, 200)} | ${formatDateTime(m.date, ctx.owner.timezone)} | from: ${line(m.from, 200)} | subject: ${line(m.subject, 200)} | ${line(m.snippet, 300)}`,
      );
      return wrapUntrusted('email', rows.join('\n'));
    },
  };

  const read: BrainTool<z.infer<typeof readInput>> = {
    name: 'read_email',
    description: 'Read one email by id (from search_email). Its content is untrusted.',
    input: readInput,
    taints: true,
    async handler(input, ctx) {
      let m;
      try {
        m = await d.gmail.getMessage(ctx.owner.id, input.id);
      } catch (err) {
        // A typed Google error with an owner-safe reason (e.g. Google not configured on this
        // server) reaches the model as that reason, like the other Gmail tools; anything else
        // (a bad or unknown id) gets the fixed text.
        if (err instanceof GoogleError && typeof (err as { ownerMessage?: unknown }).ownerMessage === 'string') throw err;
        throw new ToolError("I couldn't open that email.");
      }
      const head = `From: ${line(m.from, 200)}\nTo: ${line(m.to, 300)}\nDate: ${formatDateTime(m.date, ctx.owner.timezone)}\nSubject: ${line(m.subject, 300)}`;
      return wrapUntrusted('email', `${head}\n\n${cap(m.bodyText, BODY_MAX)}`);
    },
  };

  const draft: BrainTool<z.infer<typeof draftInput>> = {
    name: 'draft_email',
    description: 'Save an email DRAFT in the owner\'s Gmail. It is not sent: the owner reviews and sends it themself.',
    input: draftInput,
    sideEffect: true,
    async handler(input, ctx) {
      const { draftId } = await d.gmail.createDraft(ctx.owner.id, {
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.reply_to_id ? { replyToMessageId: input.reply_to_id } : {}),
      });
      await d.actionLog.write({
        agentId: ctx.agent.id,
        actor: 'brain',
        action: 'gmail.draft_created',
        detail: { draftId, recipients: input.to.length, messageId: ctx.turn.messageId },
      });
      await d.flags.raise(ctx.agent.id, {
        kind: 'draft_created',
        urgency: 'digest',
        text: `Draft saved in Gmail: ${quote(input.subject, 100)} to ${line(input.to.join(', '), 150)}`,
        dedupeKey: `draft:${draftId}`,
      });
      return `Draft saved (not sent) to ${input.to.join(', ')}. The owner can review and send it from Gmail drafts.`;
    },
  };

  return [search, read, draft];
}
