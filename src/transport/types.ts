export type TransportName = 'fake' | 'telegram';

export interface InboundMessage {
  transport: TransportName;
  /** Which agent endpoint received it. */
  agentAddress: string;
  /** Sender's stable id on this transport. */
  fromAddress: string;
  /** Display name — untrusted. */
  fromName?: string;
  kind: 'text' | 'button' | 'unsupported';
  /** '' when unsupported. */
  text: string;
  /** e.g. "approve:<approvalId>" */
  buttonPayload?: string;
  /** Unique per transport — idempotency key. */
  transportMessageId: string;
  replyToTransportMessageId?: string;
  /**
   * I19: this message's place in its chat, '<chat>:<message number>' (the same shape as
   * outbound ids). The transport numbers every message of a chat, in both directions, in
   * order. Absent when the transport gives no numbering: typed answers then fail closed.
   */
  chatMessageId?: string;
  receivedAt: Date;
}

export type OutboundPurpose = 'reply' | 'approval' | 'question' | 'flag' | 'digest' | 'ack' | 'canned' | 'transcript';

export interface OutboundButton {
  id: string;
  label: string;
}

export interface OutboundMessage {
  agentAddress: string;
  toAddress: string;
  text: string;
  buttons?: OutboundButton[];
  purpose: OutboundPurpose;
}

export interface Transport {
  readonly name: TransportName;
  /** Returns '<chat>:<message number>' (for a multi-part send: of the last part). */
  send(msg: OutboundMessage): Promise<{ transportMessageId: string }>;
  /**
   * Test transports only: the chat number of an inbound message delivered straight to
   * app.ingest without one. Real transports set chatMessageId when they normalize.
   */
  numberInbound?(msg: InboundMessage): string | undefined;
}

/**
 * A send that failed. `permanent`: retrying cannot help (the user blocked the bot, the
 * chat does not exist, the request is invalid). Otherwise the send may succeed later,
 * not before `retryAfterMs` when the transport says so. Messages never contain secrets.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** Short machine-readable cause, e.g. 'forbidden', 'rate_limited', 'network'. */
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = permanent ? 'PermanentTransportError' : 'RetryableTransportError';
  }
}

export class PermanentTransportError extends TransportError {
  constructor(message: string, reason: string) {
    super(message, true, reason);
  }
}

export class RetryableTransportError extends TransportError {
  constructor(message: string, reason: string, retryAfterMs?: number) {
    super(message, false, reason, retryAfterMs);
  }
}
