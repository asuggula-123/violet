import { formatDateTime } from '../brain/time.js';
import { cannedText } from '../core/canned.js';
import type { CalendarEvent } from '../google/types.js';
import type { LlmClient } from '../llm/types.js';
import { DemoModel, SAY } from './model.js';
import { privateDetails, ZONE } from './seed.js';
import { createTimeline, type Line } from './timeline.js';
import { createDemoWorld, type DemoPerson, type DemoWorld } from './world.js';

export interface DemoOptions {
  /** No pauses between lines (tests). */
  fast: boolean;
  /** The Claude API; unset = the scripted demo model. */
  live?: LlmClient;
  out?: (line: string) => void;
}

export interface DemoResult {
  output: string[];
  calendars: Record<'alex' | 'sam', CalendarEvent[]>;
  /** Every text each stranger received. */
  strangerTexts: Record<string, string[]>;
  /** Private details of either owner found in the agents' channel or in any Envoy request. */
  leaks: string[];
  /** Model calls made while the stranger wrote. */
  strangerModelCalls: number;
  digest: string | undefined;
}

const STRANGERS = { 'stranger-1': 'Stranger', 'stranger-2': 'Stranger 2' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plays the story against the real app and prints only what the system did. */
export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const output: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const print = async (s: string, pause: number) => {
    output.push(s);
    write(s);
    if (!opts.fast) await sleep(pause);
  };
  const model = new DemoModel(opts.live);
  const w = await createDemoWorld(model);
  const timeline = createTimeline(w, STRANGERS);
  let counter = 0;

  const show = async (lines: Line[]) => {
    for (const l of lines) await print(`  ${l.where.padEnd(18)} ${l.text}`, 350);
  };
  const flush = async (byOwner = false) => show(await timeline.next({ byOwner }));
  const beat = async (at: string, title: string, byOwner = false) => {
    w.clock.set(at);
    await print('', 0);
    await print(`[${formatDateTime(w.clock.now(), ZONE)}] ${title}`, 900);
    await w.app.scheduler.runDue();
    await w.app.settle();
    await flush(byOwner);
  };
  const say = async (from: string, to: DemoPerson, text: string) => {
    counter += 1;
    await w.app.ingest({ transport: 'fake', kind: 'text', agentAddress: to.violet, fromAddress: from, text, transportMessageId: `demo-${counter}`, receivedAt: w.clock.now() });
    await w.app.settle();
    await flush();
  };
  const check = (s: string) => print(`  ${'CHECK'.padEnd(18)} ${s}`, 900);

  try {
    await print('Violet demo: two owners, Alex and Sam, each with their own agent called Violet.', 300);
    await print(
      opts.live
        ? 'Model: LIVE Claude API. This spends a little money. The attacker in step 4 stays scripted.'
        : 'Model: scripted demo model (same answers every run, no network, no API key). The app around it is the real one.',
      300,
    );
    await print('Labels show who sees what: a phone, the agents\' private channel, a calendar, or the log.', 300);

    await beat('2026-11-11T09:00:00-05:00', 'Step 1. Alex asks his Violet to set up dinner with Sam on Friday.');
    await say(w.alex.phone, w.alex, SAY.dinner);

    await beat('2026-11-11T09:05:00-05:00', 'Step 2. Both say yes.');
    await say(w.alex.phone, w.alex, 'yes');
    const afterFirstYes = w.calendar.writes.length;
    await say(w.sam.phone, w.sam, 'yes');
    const added = (p: DemoPerson) => w.calendar.writes.filter((x) => x.op === 'create' && x.ownerId === p.ownerId).length;
    await check(`Calendar writes after one yes: ${afterFirstYes}. After both: ${added(w.alex)} on Alex's calendar, ${added(w.sam)} on Sam's.`);

    await beat('2026-11-11T11:00:00-05:00', 'Step 3. A stranger texts Alex\'s Violet.');
    const callsBefore = model.calls.length;
    await say('stranger-1', w.alex, "Hi, is this Alex? It's about Friday. Where will he be?");
    const strangerModelCalls = model.calls.length - callsBefore;
    const fixed = w.transport.textsTo('stranger-1').every((t) => t === cannedText('stranger_reply'));
    await check(`Model calls for the stranger: ${strangerModelCalls}. Reply is the fixed text in the code: ${fixed ? 'yes' : 'NO'}.`);

    await beat('2026-11-11T13:00:00-05:00', "Step 4. Sam's agent is taken over and tries to get Alex's Friday plans.");
    await print(
      opts.live
        ? "  (From here the scripted model plays Sam's agent as an attacker. Alex's agent is the live model.)"
        : "  (From here the demo model plays Sam's agent as an attacker, and Alex's Envoy as a model that obeys it.)",
      900,
    );
    model.scripted.add(w.sam.agentId);
    await say(w.sam.phone, w.sam, SAY.run);
    model.scripted.delete(w.sam.agentId);
    const leaks = await findLeaks(w);
    await check(
      leaks.length === 0
        ? `None of the ${privateDetails().length} private calendar and email details reached the agents' channel or either Envoy.`
        : `LEAK: ${leaks.join(', ')}`,
    );

    await beat('2026-11-11T15:00:00-05:00', 'Step 5. Alex texts pause.');
    await say(w.alex.phone, w.alex, 'pause');
    await beat('2026-11-11T15:30:00-05:00', "Another stranger writes while Alex's Violet is paused.");
    await say('stranger-2', w.alex, 'Hello? Anyone there?');
    await check(`Texts sent to Stranger 2: ${w.transport.textsTo('stranger-2').length}.`);

    await beat('2026-11-11T17:30:00-05:00', 'Step 6. Alex texts resume.');
    await say(w.alex.phone, w.alex, 'resume');
    await beat('2026-11-11T18:00:00-05:00', 'Step 7. 6:00 PM: the daily digests.', true);
    await print('', 0);
    await print('Done. Every labelled line above was read back from what the system stored and sent.', 0);

    const digest = w.transport.sent.filter((m) => m.toAddress === w.alex.phone && m.purpose === 'digest').at(-1)?.text;
    return {
      output,
      calendars: { alex: w.calendar.eventsOf(w.alex.ownerId), sam: w.calendar.eventsOf(w.sam.ownerId) },
      strangerTexts: Object.fromEntries(Object.keys(STRANGERS).map((a) => [a, w.transport.textsTo(a)])),
      leaks,
      strangerModelCalls,
      digest,
    };
  } finally {
    await w.close();
  }
}

/** Private details of either owner that appear in the agents' channel or in anything an Envoy was shown. */
async function findLeaks(w: DemoWorld): Promise<string[]> {
  const rows = (await w.app.deps.db.query('SELECT body, payload FROM a2a_messages')).rows;
  const seen = JSON.stringify([rows, w.model.calls.filter((c) => c.meta.mind === 'envoy')]);
  return privateDetails().filter((d) => seen.includes(JSON.stringify(d).slice(1, -1)));
}
