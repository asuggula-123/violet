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
  send(msg: OutboundMessage): Promise<{ transportMessageId: string }>;
}
