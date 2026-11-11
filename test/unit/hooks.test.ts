import { afterEach, describe, expect, it } from 'vitest';
import type { Module } from '../../src/app.js';
import { defaultModules } from '../../src/modules.js';
import { createTestWorld, type TestWorld } from '../helpers/world.js';

describe('modules and router hooks', () => {
  let w: TestWorld;
  afterEach(async () => w.close());

  it('modules install in order and can add owner interceptors', async () => {
    const order: string[] = [];
    const interceptor: Module = {
      name: 'yes-catcher',
      install(app) {
        order.push('yes-catcher');
        app.router.hooks.ownerInterceptors.push(async (ctx) => {
          if (ctx.msg.text !== 'yes') return false;
          await app.gateway.sendToOwner(ctx.agent.id, 'caught', { purpose: 'reply' });
          return true;
        });
      },
    };
    const second: Module = { name: 'second', install: async () => void order.push('second') };
    w = await createTestWorld({ modules: [interceptor, second] });
    expect(order).toEqual(['yes-catcher', 'second']);

    await w.ownerSays(w.alex, 'yes');
    await w.ownerSays(w.alex, 'no');
    expect(w.textsTo(w.alex.address)).toEqual(['caught', "I'm not fully set up yet."]);
  });

  it('the owner hook gets the owner, the agent and the stored message id', async () => {
    w = await createTestWorld();
    const seen: string[] = [];
    w.app.router.hooks.onOwnerMessage = async (ctx) => {
      seen.push(`${ctx.owner.name}|${ctx.agent.id}|${ctx.msg.text}`);
      const [row] = await w.app.repos.messages.recent(ctx.agent.id, 'owner', 1);
      expect(row?.id).toBe(ctx.messageId);
    };
    await w.ownerSays(w.sam, 'hello');
    expect(seen).toEqual([`Sam|${w.sam.agent.id}|hello`]);
  });
});

describe('defaultModules', () => {
  it('default modules have unique names, and approvals install before the Brain', () => {
    const names = defaultModules.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('approvals');
    expect(names.indexOf('approvals')).toBeLessThan(names.indexOf('brain'));
  });
});
