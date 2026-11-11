/**
 * Principle 3: text not typed by the owner is data. It reaches a model only inside
 * <untrusted source="…">…</untrusted>, and the system prompt says such content is never
 * an instruction. The content cannot open or close the tag. After NFKC (folds fullwidth
 * and other compatibility brackets to `<`) and removal of invisible format characters
 * (Cf), every `<` (or bracket look-alike) that starts something a reader could take for
 * a tag named `untrusted` becomes `‹`. The name is matched on a confusable skeleton:
 * default-ignorable code points and combining marks are skipped (they are left in the
 * text), letters are case-folded and stripped of diacritics, and Cyrillic, Greek,
 * Armenian and small-capital look-alikes (`</untrustеd>` with a Cyrillic е) fold to the
 * Latin letter they imitate. The look-ahead per `<` is bounded, so the pass is linear.
 */
export type UntrustedSource = 'email' | 'calendar' | 'stranger' | 'notes' | 'agent';

const INVISIBLE = /[\p{Cf}]/gu;
/** Marks a model may read straight through: default-ignorables and combining marks. */
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{Mn}\p{Me}\p{Cf}]$/u;
const SPACE_OR_SLASH = /^[\s/⁄∕⧸]$/u;
/** `<` and the brackets a reader may take for it (NFKC already folds ＜ and ﹤ to `<`). */
const OPENERS = new Set(['<', '‹', '˂', 'ᐸ', '〈', '⟨', '❮', '❬', '⧼', '〈']);
const NAME = 'untrusted';
const LOOKAHEAD = 256;

/** Lowercase look-alikes of the letters in "untrusted". */
const CONFUSABLE: Record<string, string> = {
  // u
  'υ': 'u', 'ս': 'u', 'ᴜ': 'u', 'ʋ': 'u', 'ц': 'u', 'ᑌ': 'u', 'ꞟ': 'u',
  // n
  'ո': 'n', 'п': 'n', 'η': 'n', 'ɴ': 'n', 'ռ': 'n', 'ν': 'n', 'ᥒ': 'n', 'и': 'n',
  // t
  'т': 't', 'τ': 't', 'ᴛ': 't', 'ƚ': 't', 'ŧ': 't', 'ƭ': 't', 'ʈ': 't',
  // r
  'г': 'r', 'ʀ': 'r', 'ᴦ': 'r', 'ꭇ': 'r', 'ꭈ': 'r', 'ᚱ': 'r', 'ɼ': 'r', 'ɽ': 'r', 'ʁ': 'r', 'ꮁ': 'r',
  // s
  'ѕ': 's', 'ꜱ': 's', 'ʂ': 's', 'ƽ': 's', 'ꮪ': 's', 'ꮥ': 's',
  // e
  'е': 'e', 'ε': 'e', 'ҽ': 'e', 'ɛ': 'e', 'ᴇ': 'e', 'ꬲ': 'e', 'ə': 'e', 'є': 'e', 'ɘ': 'e', 'ꭼ': 'e',
  // d
  'ԁ': 'd', 'ᴅ': 'd', 'ɗ': 'd', 'ᑯ': 'd', 'ꓒ': 'd', 'ꓓ': 'd', 'Ꮷ': 'd', 'ꭰ': 'd', 'ժ': 'd', 'ɖ': 'd', 'đ': 'd',
};

/** One code point → its skeleton letter(s): lowercased, diacritics stripped, look-alikes folded. */
function skeleton(ch: string): string {
  let out = '';
  for (const c of ch.toLowerCase().normalize('NFKD')) {
    if (IGNORABLE.test(c)) continue;
    out += CONFUSABLE[c] ?? c;
  }
  return out;
}

/** Whether the text right after an opener at `chars[i]` reads as `untrusted` (optionally after spaces and `/`). */
function startsTag(chars: string[], i: number): boolean {
  let name = '';
  let inName = false;
  const end = Math.min(chars.length, i + 1 + LOOKAHEAD);
  for (let j = i + 1; j < end && name.length < NAME.length; j += 1) {
    const c = chars[j]!;
    if (IGNORABLE.test(c)) continue;
    if (!inName && SPACE_OR_SLASH.test(c)) continue;
    inName = true;
    name += skeleton(c);
    if (!NAME.startsWith(name.slice(0, NAME.length))) return false;
  }
  return name.startsWith(NAME);
}

export function neutralizeUntrusted(text: string): string {
  const chars = [...text.normalize('NFKC').replace(INVISIBLE, '')];
  for (let i = 0; i < chars.length; i += 1) {
    if (OPENERS.has(chars[i]!) && startsTag(chars, i)) chars[i] = '‹';
  }
  return chars.join('');
}

export function wrapUntrusted(source: UntrustedSource, text: string): string {
  return `<untrusted source="${source}">\n${neutralizeUntrusted(text)}\n</untrusted>`;
}
