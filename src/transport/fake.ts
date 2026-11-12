import type { InboundMessage, OutboundMessage, Transport } from './types.js';

export interface FakeSent extends OutboundMessage {
  transportMessageId: string;
}

/**
 * How the fake numbers chat messages (I19). 'per-chat' (default, like a Telegram private
 * chat): each chat (agent address + other party) counts its own messages, both directions.
 * 'per-bot': one counter for all of an agent's chats, so a stranger's message makes a gap
 * in the owner's chat. 'none': no numbering (outbound ids 'fake-out-<n>', inbound unnumbered).
 */
export type FakeNumbering = 'per-chat' | 'per-bot' | 'none';

/** In-memory transport for tests, the demo and local dev. Records every send. */
export class FakeTransport implements Transport {
  readonly name = 'fake' as const;
  readonly sent: FakeSent[] = [];
  private failuresLeft = 0;
  private failAlways = false;
  private counter = 0;
  private readonly counters = new Map<string, number>();
  /** Inbound transport id → its chat number, so a redelivery keeps its number. */
  private readonly numbered = new Map<string, string>();

  constructor(private readonly opts: { numbering?: FakeNumbering } = {}) {}

  get numbering(): FakeNumbering {
    return this.opts.numbering ?? 'per-chat';
  }

  /** Make the next `n` sends throw. */
  failNext(n = 1): void {
    this.failuresLeft = n;
  }

  /** Make every send throw until called again with false. */
  setFailing(failing: boolean): void {
    this.failAlways = failing;
  }

  /** The chat between an agent address and another party. */
  static chat(agentAddress: string, address: string): string {
    return `${agentAddress}/${address}`;
  }

  /** Takes the next number of the chat ('<chat>:<n>'), or undefined without numbering. */
  private next(agentAddress: string, address: string): string | undefined {
    if (this.numbering === 'none') return undefined;
    const chat = FakeTransport.chat(agentAddress, address);
    const key = this.numbering === 'per-bot' ? agentAddress : chat;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return `${chat}:${n}`;
  }

  /** Simulates `n` messages of this chat the app never sees (a gap in the numbering). */
  skip(agentAddress: string, address: string, n = 1): void {
    for (let i = 0; i < n; i++) this.next(agentAddress, address);
  }

  /** A button press is not a chat message (Telegram callback_query): it takes no number. */
  numberInbound(msg: InboundMessage): string | undefined {
    if (msg.kind === 'button') return undefined;
    const known = this.numbered.get(msg.transportMessageId);
    if (known) return known;
    const id = this.next(msg.agentAddress, msg.fromAddress);
    if (id) this.numbered.set(msg.transportMessageId, id);
    return id;
  }

  async send(msg: OutboundMessage): Promise<{ transportMessageId: string }> {
    if (this.failAlways || this.failuresLeft > 0) {
      if (this.failuresLeft > 0) this.failuresLeft -= 1;
      throw new Error('fake transport: send failed');
    }
    this.counter += 1;
    const transportMessageId = this.next(msg.agentAddress, msg.toAddress) ?? `fake-out-${this.counter}`;
    this.sent.push({ ...msg, ...(msg.buttons ? { buttons: [...msg.buttons] } : {}), transportMessageId });
    return { transportMessageId };
  }

  textsTo(address: string): string[] {
    return this.sent.filter((m) => m.toAddress === address).map((m) => m.text);
  }
}
