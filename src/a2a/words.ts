import { sanitize } from '../core/sanitize.js';

/**
 * Word matching for the EgressGuard (I11).
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
