import { loadDotEnv, parseConfig } from '../config.js';
import { parseDemoArgs } from '../demo/args.js';
import { runDemo } from '../demo/story.js';
import { AnthropicLlm } from '../llm/anthropic.js';

/** `npm run demo [-- --fast] [-- --live]`: the 60-second story, in this process, no files left behind. */
async function main(): Promise<void> {
  loadDotEnv();
  const args = parseDemoArgs(process.argv.slice(2), process.env);
  if ('error' in args) {
    console.error(args.error);
    process.exit(2);
  }
  let live: AnthropicLlm | undefined;
  if (args.live) {
    const { VIOLET_MODEL, VIOLET_ENVOY_MODEL, VIOLET_MODEL_FALLBACK } = process.env;
    const config = parseConfig({ VIOLET_MODEL, VIOLET_ENVOY_MODEL, VIOLET_MODEL_FALLBACK });
    live = new AnthropicLlm({
      apiKey: args.live.apiKey,
      models: { brain: config.VIOLET_MODEL, envoy: config.VIOLET_ENVOY_MODEL },
      fallback: config.VIOLET_MODEL_FALLBACK === 'on',
    });
  }
  const result = await runDemo({ fast: args.fast, ...(live ? { live } : {}) });
  process.exit(result.leaks.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
