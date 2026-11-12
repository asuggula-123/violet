/**
 * R1 (I15): a detail the action log (jsonb) could not store, for example a tool name the model
 * wrote with a NUL or a lone surrogate, is made storable, so the row is written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../helpers/world.js';

let w: TestWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('R1: the action log stores any detail', () => {
  it('a NUL and a lone surrogate, in a value and in a key, nested: the row is written, both replaced', async () => {
    w = await createTestWorld();
    await w.app.actionLog.write({
      agentId: w.alex.agent.id,
      actor: 'brain',
      action: 'tool.denied',
      detail: { tool: 'list\uD800x\u0000', nested: [{ ['k\uDC00']: 'ok 😀' }] },
    });
    const [row] = await w.actions({ action: 'tool.denied', agentId: w.alex.agent.id });
    expect(row?.detail).toEqual({ tool: 'list�x', nested: [{ 'k�': 'ok 😀' }] });
  });
});
