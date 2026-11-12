/**
 * I19 E2, independence from appearance: every neutralizer that changes what a text looks
 * like (neutralizeReply, quoteFolded, foldReservedLineHeads) is mocked to the identity, so the
 * fooled model's forgery reaches the owner character for character. The same attacks still
 * cause no action: safety rests on approval_deliveries and the transport numbering only.
 */
import { vi } from 'vitest';
import { describeForgedPromptAttacks } from './attacks.js';

vi.mock('../../../src/brain/reply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/brain/reply.js')>()),
  neutralizeReply: (s: string) => s,
  quoteFolded: (s: string) => `“${s}”`,
}));
vi.mock('../../../src/brain/lineHeads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/brain/lineHeads.js')>()),
  foldReservedLineHeads: (s: string) => s,
}));

describeForgedPromptAttacks('I19 with the appearance layer switched off: the same forgeries still cause no action', true);
