export interface DemoArgs {
  fast: boolean;
  /** Set only with --live AND a key: a key in the environment alone never turns on the live model. */
  live: { apiKey: string } | null;
}

export const USAGE = 'Usage: npm run demo [-- --fast] [-- --live]';
export const LIVE_NEEDS_KEY = '--live needs ANTHROPIC_API_KEY in the environment. Without --live the demo uses the scripted model and needs no key.';

/** Parses the demo's flags. Returns an error text for anything it does not understand. */
export function parseDemoArgs(argv: readonly string[], env: Record<string, string | undefined>): DemoArgs | { error: string } {
  const unknown = argv.filter((a) => a !== '--fast' && a !== '--live');
  if (unknown.length > 0) return { error: `Unknown option: ${unknown.join(' ')}\n${USAGE}` };
  const fast = argv.includes('--fast');
  if (!argv.includes('--live')) return { fast, live: null };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { error: LIVE_NEEDS_KEY };
  return { fast, live: { apiKey } };
}
