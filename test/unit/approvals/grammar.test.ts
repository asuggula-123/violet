import { describe, expect, it } from 'vitest';
import { parseDecision } from '../../../src/approvals/resolver.js';

describe('approval reply grammar (8.3)', () => {
  const yes = ['yes', 'Yes', 'YES', 'y', 'yep', 'yeah', 'ok', 'OK', 'okay', 'sure', 'approve', 'do it', 'Do it!', 'go ahead', 'go  ahead', '👍', '👍🏽', '👍️', 'yes.', ' yes ', 'yes!!'];
  const no = ['no', 'No', 'n', 'nope', 'nah', "don't", 'don’t', 'decline', 'cancel', '👎', '👎🏿', 'no.'];
  const neither = ['yes please', 'no thanks', 'yesterday', 'okay so what about lunch', 'sure, but later', 'y?', 'maybe', '', 'nono', 'yes no', '👍👍', 'ok #', 'approve #abc', '#7 yes', 'yes 7 8'];

  it.each(yes)('"%s" is yes', (t) => expect(parseDecision(t)).toEqual({ decision: 'approved' }));
  it.each(no)('"%s" is no', (t) => expect(parseDecision(t)).toEqual({ decision: 'denied' }));
  it.each(neither)('"%s" is not a decision', (t) => expect(parseDecision(t)).toBeNull());

  it.each([
    ['yes #7', 'approved', 7],
    ['yes 7', 'approved', 7],
    ['Yes#7', 'approved', 7],
    ['ok # 12', 'approved', 12],
    ['👍 3', 'approved', 3],
    ['no #2', 'denied', 2],
    ['cancel 9.', 'denied', 9],
    ["don't #4", 'denied', 4],
  ] as const)('"%s" → %s #%d', (t, decision, ref) => expect(parseDecision(t)).toEqual({ decision, ref }));
});
