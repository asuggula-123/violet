import { sanitize } from '../core/sanitize.js';

/**
 * Word matching for releases (I11): the owner-verbatim exception and the EgressGuard.
 *
 * Tokenization: NFKD, combining marks dropped (café → cafe), lowercased; a token is a
 * maximal run of letters and digits (\p{L}\p{N}). Everything else separates tokens, so
 * "Luigi's" → `luigi` `s` and "7:30pm" → `7` `30pm`.
 */
export function tokens(text: string): string[] {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Glue words: never significant (they carry no private detail). Includes contraction pieces. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  `a an the and or but nor so yet to of for in on at by with from about as into onto over under up down out off
   is are was were be been being am do does did have has had it its this that these those there here
   i me my mine we us our you your yours he him his she her they them their
   s t d ll re ve m please can could would will shall should may might must let lets if then than also just not
   no yes ok okay hi hello hey tell ask say said what when where which who how whether`.split(/\s+/),
);

/**
 * Ordinary words that a private calendar phrase may contain without being private:
 * weekdays, months, times of day, meals, generic event and scheduling words. A private
 * field's word in this list never blocks a release on its own.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  `monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
   january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
   today tomorrow tonight yesterday morning afternoon evening night noon midnight week weekend weekly day days daily month year
   hour hours minute minutes min mins am pm time times next last early late soon now later before after during until between
   start starts end ends begin all
   dinner lunch breakfast brunch coffee tea drinks drink meal snack food eat
   meeting meet meetup call chat catch appointment event party plans plan date trip visit pickup pick dropoff drop
   school work home office kids kid children family together free busy available availability
   go going come coming get have make take see want need like book booked cancel move change works good great fine sure
   maybe still around back first second new old big small quick long short open done ok
   one two three four five six seven eight nine ten half quarter`.split(/\s+/),
);

/** Text the owner's Violet released: one line, NFKC, inner double quotes made single, number signs dropped (so the prompt shows it exactly). */
export function canonicalRelease(text: string, max: number): string {
  return sanitize(sanitize(text.normalize('NFKC'), max).replace(/["“”„‟″‶❝❞〝-〟＂]/g, "'").replace(/[#＃﹟]/g, ''), max);
}

const significant = (t: string, allowed: ReadonlySet<string>) => !STOP_WORDS.has(t) && !allowed.has(t);

/** Tokens on each side of a name that must be the owner's own (rule 4 of ownerSaidIt). */
export const NAME_CONTEXT = 2;

/**
 * The owner-verbatim exception (I11), fail closed. `names` are both owners' first names and
 * the agents' names. The released text's tokens must satisfy all of:
 *  1. every token — stop words and names included — occurs in the owner's own message at
 *     least as many times as in that text (multiset containment, per text: a topic and a
 *     brief are each checked against the whole message), so a glue word the owner did not
 *     type (e.g. "not", "no", "never", "can't") cannot flip or extend what they said, a name
 *     cannot be added or repeated, and repeating the owner's words cannot carry extra data;
 *  2. at least one token other than a name is significant (not a stop word), so text made
 *     only of glue words, names, emoji or punctuation never passes vacuously;
 *  3. at least a third of the tokens other than names are significant, which bounds how
 *     much an ordering of the owner's own glue words could encode (names neither satisfy
 *     nor dilute this ratio);
 *  4. every name in the text stands in the owner's own phrasing: the up to NAME_CONTEXT
 *     tokens before and after it (as far as the released text goes) equal the tokens around
 *     one occurrence of that name in the owner's message. So names cannot be swapped or
 *     moved to change who does what ("Alex will pick up the kids" never becomes "Sam will
 *     pick up the kids"); a release that rephrases around a name is held for the owner.
 */
export function ownerSaidIt(ownerText: string, texts: string[], names: string[]): boolean {
  const nameSet = new Set(names.flatMap(tokens));
  const own = tokens(ownerText);
  const said = new Map<string, number>();
  for (const t of own) said.set(t, (said.get(t) ?? 0) + 1);
  const perText = texts.map(tokens);
  for (const used of perText) {
    const counts = new Map<string, number>();
    for (const t of used) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) if ((said.get(t) ?? 0) < n) return false;
    for (let i = 0; i < used.length; i++) {
      if (!nameSet.has(used[i]!)) continue;
      const lo = Math.max(0, i - NAME_CONTEXT);
      const hi = Math.min(used.length - 1, i + NAME_CONTEXT);
      const fits = own.some((t, j) => {
        if (t !== used[i]) return false;
        for (let k = lo; k <= hi; k++) if (own[j + k - i] !== used[k]) return false;
        return true;
      });
      if (!fits) return false;
    }
  }
  const rest = perText.flat().filter((t) => !nameSet.has(t));
  if (rest.length === 0) return false;
  const sig = rest.filter((t) => !STOP_WORDS.has(t)).length;
  return sig >= 1 && sig * 3 >= rest.length;
}

const isCommon = (t: string) => COMMON_WORDS.has(t) || /^\d+$/.test(t);

/**
 * EgressGuard phrase match. A release is blocked when, for some private field (an event's
 * title, location, description or one attendee), either
 *  1. single word: a token of the field with ≥ 3 characters that is not a stop word, not a
 *     common word, not all digits, appears in the release and not in the owner's message; or
 *  2. run: two consecutive significant tokens of the field (stop words skipped), not both
 *     common, appear consecutively (stop words skipped) in the release and not in the
 *     owner's message. This catches multi-word names built from short tokens ("Dr Ng").
 * Returns the matched private words (for the log only, never shown to a model), or [].
 */
export function privateMatches(release: string, ownerText: string, fields: string[], names: string[]): string[] {
  const allowed = new Set(names.flatMap(tokens));
  const sig = (s: string) => tokens(s).filter((t) => significant(t, allowed));
  const rel = sig(release);
  const relSet = new Set(rel);
  const own = sig(ownerText);
  const ownSet = new Set(own);
  const pairs = (xs: string[]) => new Set(xs.slice(1).map((t, i) => `${xs[i]} ${t}`));
  const relPairs = pairs(rel);
  const ownPairs = pairs(own);
  const hits = new Set<string>();
  for (const field of fields) {
    const f = sig(field);
    for (const t of f) if (t.length >= 3 && !isCommon(t) && relSet.has(t) && !ownSet.has(t)) hits.add(t);
    for (const p of pairs(f)) {
      const [a, b] = p.split(' ') as [string, string];
      if (!(isCommon(a) && isCommon(b)) && relPairs.has(p) && !ownPairs.has(p)) hits.add(p);
    }
  }
  return [...hits];
}
