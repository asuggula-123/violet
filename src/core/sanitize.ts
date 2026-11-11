/**
 * I13: makes untrusted text safe to show inside an owner message.
 * Strips control characters (Cc), every invisible formatting character (Cf: bidi
 * controls, zero-width characters, Unicode tag characters, interlinear annotation
 * marks, …) and line/paragraph separators, collapses whitespace and caps the length,
 * so it can never forge a second line or hide text.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}᠎⁠-⁯￹-￻\u{E0000}-\u{E007F}]/gu;

/** Double quotes a stranger could type to appear to close quote()'s quotation. */
const DOUBLE_QUOTES = /["“”„‟″‶❝❞〝-〟＂]/g;

export const DEFAULT_MAX_LENGTH = 300;

export function sanitize(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const clean = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= maxLength) return clean;
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join('').trimEnd()}…`;
}

/**
 * Sanitized and wrapped in curly quotes, for quoting third-party text to an owner.
 * Double quotes inside the text become straight single quotes, so the only curly
 * double quotes are the outer pair and the text cannot appear to end the quotation.
 */
export function quote(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  return `“${sanitize(text, maxLength).replace(DOUBLE_QUOTES, "'")}”`;
}
