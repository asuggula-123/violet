/** Telegram's limit for one message, in UTF-16 code units. */
export const TELEGRAM_TEXT_LIMIT = 4096;

const SEPARATORS = ['\n\n', '\n', ' '];

/**
 * Splits text into chunks of at most `limit` UTF-16 units. Cuts at the last paragraph
 * break, else line break, else space in the second half of the window (the separator
 * itself is dropped); with none, cuts hard, never between the two halves of a
 * surrogate pair. Whitespace-only chunks are dropped.
 */
export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const [end, skip] = cutPoint(rest, limit);
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end + skip);
  }
  chunks.push(rest);
  const kept = chunks.filter((c) => c.trim() !== '');
  return kept.length > 0 ? kept : [text];
}

/** [end of this chunk, separator length to skip]. */
function cutPoint(text: string, limit: number): [number, number] {
  for (const sep of SEPARATORS) {
    const at = text.lastIndexOf(sep, limit);
    if (at >= limit / 2) return [at, sep.length];
  }
  const code = text.charCodeAt(limit - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return [splitsPair ? limit - 1 : limit, 0];
}
