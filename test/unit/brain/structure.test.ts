import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';
import { scriptBrain, toolUse } from './script.js';

const root = join(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('structure', () => {
  it('Clock discipline: no Date.now() or argument-less new Date() in src/ outside clock.ts', () => {
    const offenders = files(root)
      .filter((f) => relative(root, f) !== 'clock.ts')
      .filter((f) => /Date\.now\s*\(|new Date\s*\(\s*\)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('Brain tools get no gateway: the only owner sends are the final reply and approval prompts', () => {
    for (const f of files(join(root, 'brain/tools'))) {
      expect(readFileSync(f, 'utf8'), relative(root, f)).not.toMatch(/\bgateway\b|sendToOwner|sendCanned|\.transport\b/);
    }
  });
});

describe('action_log coverage (I15) for a Brain turn and an approval', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('logs model turn, tool calls, denied calls, approval changes, calendar write and draft', async () => {
    w = await createTestWorld();
    scriptBrain(w, w.alex, [
      [
        toolUse('t1', 'request_calendar_event', { title: 'Dinner', start: '2026-11-13T19:00:00-05:00', end: '2026-11-13T20:30:00-05:00' }),
        toolUse('t2', 'draft_email', { to: ['sam@example.com'], subject: 'Hi', body: 'Hi' }),
        toolUse('t3', 'send_email', {}),
        toolUse('t4', 'get_schedule', { from: 'tomorrow', to: 'later' }),
      ],
      'Done.',
    ]);
    await w.ownerSays(w.alex, 'dinner friday');
    await w.ownerSays(w.alex, 'yes');
    const actions = (await w.actions({ agentId: w.alex.agent.id })).map((a) => a.action);
    for (const action of [
      'inbound.received',
      'brain.turn',
      'tool.call',
      'tool.denied',
      'approval.requested',
      'gmail.draft_created',
      'flag.raised',
      'outbound.sent',
      'approval.approved',
      'calendar.event_created',
      'approval.executed',
    ]) {
      expect(actions, action).toContain(action);
    }
    const denied = await w.actions({ action: 'tool.denied' });
    expect(denied.map((d) => [d.detail.tool, d.detail.reason])).toEqual([
      ['send_email', 'unknown_tool'],
      ['get_schedule', 'invalid_input'],
    ]);
    // No secrets or bodies in the log: tool calls carry names and outcomes only.
    const all = JSON.stringify(await w.actions());
    expect(all).not.toContain('sam@example.com');
  });
});
