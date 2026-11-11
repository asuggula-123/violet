import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** Non-comment, non-empty lines. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Just enough TOML for fly.toml: `[section]` / `[[section]]` headers and `key = value`
 * lines, keyed as "section.key" (top-level keys have no prefix). Values keep their quotes off.
 */
export function flyToml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = '';
  for (const line of lines(text)) {
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (kv) out.set(section ? `${section}.${kv[1]}` : kv[1]!, kv[2]!.trim().replace(/^"(.*)"$/, '$1'));
  }
  return out;
}
