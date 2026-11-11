import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENVOY_TOOL_NAMES } from '../../../src/a2a/envoy.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { alexOpensDinner, honestDinnerEnvoys, scriptEnvoy, toolUse } from './helpers.js';

const src = join(import.meta.dirname, '../../../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const read = (f: string) => readFileSync(f, 'utf8');

describe('a2a structure', () => {
  it('nothing in src/a2a writes a calendar: bookings go through approvals.calendar (CalendarWriter, I6)', () => {
    for (const f of files(join(src, 'a2a'))) expect(read(f), relative(src, f)).not.toMatch(/\.createEvent\b|\.deleteEvent\b/);
  });

  it('the Envoy code reaches no private store: no event details, email, notes, contacts or owner thread', () => {
    for (const name of ['envoy.ts', 'envoyTools.ts', 'envoyPrompt.ts']) {
      const code = read(join(src, 'a2a', name));
      expect(code, name).not.toMatch(/listEvents|gmail|getMessage|contact_notes|contactNotes|FROM messages|repos\.|search_history|approvals\./i);
    }
  });

  it('only the resolver resolves approvals (I5): one statement, keyed by an inbound message id', () => {
    const callers = files(src).filter((f) => /\.resolvePending\(/.test(read(f))).map((f) => relative(src, f));
    expect(callers).toEqual(['approvals/resolver.ts']);
    const setters = files(src).filter((f) => /status\s*=\s*'approved'|SET status = \$3/.test(read(f))).map((f) => relative(src, f));
    expect(setters).toEqual(['approvals/repo.ts']);
  });
});

describe('a2a tools and approvals at run time', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('the Envoy sees exactly the seven tools (I9)', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    scriptEnvoy(w, w.sam, () => ['ok']);
    await w.ownerSays(w.alex, 'dinner with Sam');
    const req = w.llm.calls.find((c) => c.meta.mind === 'envoy')!;
    expect(req.tools.map((t) => t.name)).toEqual([...ENVOY_TOOL_NAMES]);
  });

  it('no approval is ever resolved without an inbound owner-thread message of its agent', async () => {
    w = await createTestWorld();
    alexOpensDinner(w);
    honestDinnerEnvoys(w);
    // A hostile Envoy on top: it asks for approvals in every way it can name.
    scriptEnvoy(w, w.alex, () => [[toolUse('x', 'approve', { all: true }), toolUse('y', 'resolve_approval', { id: '1', decision: 'yes' }), toolUse('z', 'accept', { proposal_seq: 2 })], 'ok']);
    await w.ownerSays(w.alex, 'Set up dinner with Sam on Friday evening');
    await w.app.settle();
    const decided = (await w.db.query<{ status: string }>(`SELECT status FROM approvals WHERE status NOT IN ('pending', 'cancelled', 'expired')`)).rows;
    expect(decided).toEqual([]);
    expect((await w.db.query(`SELECT id FROM approvals WHERE status = 'pending'`)).rows).toHaveLength(2);
    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.sam, 'yes');
    const rows = (
      await w.db.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.resolved_by_message_id AND m.agent_id = a.agent_id AND m.thread = 'owner' AND m.direction = 'in') AS ok
         FROM approvals a WHERE a.status IN ('approved', 'denied', 'executed', 'failed')`,
      )
    ).rows;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.ok)).toBe(true);
  });
});
