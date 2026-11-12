/**
 * R4 (I15): an attempt that fails and is rescheduled leaves one job.retry row: job type, lane
 * agent, attempt number and error class. No message text, no secrets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/llm/errors.js';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

let w: TestWorld;
afterEach(async () => w?.close());

describe('R4: job.retry', () => {
  it('a retryable model error in a Brain turn: one job.retry per rescheduled attempt, then the turn answers', async () => {
    w = await createTestWorld({ jobs: { backoffMs: () => 1_000 } });
    let calls = 0;
    w.llm.on({ agentId: w.alex.agent.id, mind: 'brain' }, () => {
      calls += 1;
      if (calls <= 2) throw new LlmError('rate_limited', true, 'model API rate limit SECRET-DETAIL', 429);
      return { content: [{ type: 'text', text: 'Hi.' }], stopReason: 'end_turn' };
    });
    await w.ownerSays(w.alex, 'hello');
    await w.advance({ seconds: 2 });
    await w.advance({ seconds: 2 });
    expect(w.textsTo(w.alex.address)).toEqual(['Hi.']);
    const retries = await w.actions({ action: 'job.retry' });
    expect(retries.map((r) => [r.agent_id, r.detail.type, r.detail.attempt, r.detail.error])).toEqual([
      [w.alex.agent.id, 'inbound.process', 1, 'LlmError:rate_limited'],
      [w.alex.agent.id, 'inbound.process', 2, 'LlmError:rate_limited'],
    ]);
    expect(JSON.stringify(retries)).not.toContain('SECRET-DETAIL');
  });

  it('a lane that is not an agent: agent id null; the last attempt is job.dead, not job.retry', async () => {
    w = await createTestWorld({ jobs: { maxAttempts: 2, backoffMs: () => 1_000 } });
    w.app.jobs.register('flaky', async () => {
      throw new TypeError('message with private words');
    });
    await w.app.jobs.enqueue('flaky', {}, { lane: 'L1' });
    await w.app.jobs.pump();
    w.clock.advance({ seconds: 1 });
    await w.app.jobs.pump();
    const retries = await w.actions({ action: 'job.retry' });
    expect(retries.map((r) => [r.agent_id, r.detail.type, r.detail.lane, r.detail.attempt, r.detail.error])).toEqual([[null, 'flaky', 'L1', 1, 'TypeError']]);
    expect(await w.actions({ action: 'job.dead' })).toHaveLength(1);
    expect(JSON.stringify(retries)).not.toContain('private words');
  });

  it('a stale running job that is requeued: one job.retry with error "stale"', async () => {
    w = await createTestWorld();
    w.app.jobs.register('work', async () => undefined);
    const at = new Date(w.clock.now().getTime() - 11 * 60_000);
    await w.db.query(
      `INSERT INTO jobs (id, type, lane, payload, status, attempts, max_attempts, run_at, locked_at, created_at)
       VALUES ('j1', 'work', $1, '{}'::jsonb, 'running', 1, 5, $2, $2, $2)`,
      [w.alex.agent.id, at],
    );
    await w.app.jobs.pump();
    const retries = await w.actions({ action: 'job.retry' });
    expect(retries.map((r) => [r.agent_id, r.detail.jobId, r.detail.attempt, r.detail.error])).toEqual([[w.alex.agent.id, 'j1', 1, 'stale']]);
  });
});
