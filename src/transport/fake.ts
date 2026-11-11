import type { OutboundMessage, Transport } from './types.js';

export interface FakeSent extends OutboundMessage {
  transportMessageId: string;
}

/** In-memory transport for tests, the demo and local dev. Records every send. */
export class FakeTransport implements Transport {
  readonly name = 'fake' as const;
  readonly sent: FakeSent[] = [];
  private failuresLeft = 0;
  private failAlways = false;
  private counter = 0;

  /** Make the next `n` sends throw. */
  failNext(n = 1): void {
    this.failuresLeft = n;
  }

  /** Make every send throw until called again with false. */
  setFailing(failing: boolean): void {
    this.failAlways = failing;
  }

  async send(msg: OutboundMessage): Promise<{ transportMessageId: string }> {
    if (this.failAlways || this.failuresLeft > 0) {
      if (this.failuresLeft > 0) this.failuresLeft -= 1;
      throw new Error('fake transport: send failed');
    }
    this.counter += 1;
    const transportMessageId = `fake-out-${this.counter}`;
    this.sent.push({ ...msg, ...(msg.buttons ? { buttons: [...msg.buttons] } : {}), transportMessageId });
    return { transportMessageId };
  }

  textsTo(address: string): string[] {
    return this.sent.filter((m) => m.toAddress === address).map((m) => m.text);
  }
}
