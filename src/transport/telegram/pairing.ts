const BOT_ID = /^\d{1,20}$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/**
 * Checks `owner:add --transport telegram` arguments: the agent address must be the bot
 * id, the optional username a bot username (a leading @ is dropped). Throws a usage error.
 */
export function checkTelegramCliArgs(agentAddress: string, botUsername?: string): { botUsername?: string } {
  if (!BOT_ID.test(agentAddress)) {
    throw new Error('For telegram, --agent-address is the bot id: the digits before ":" in the bot token');
  }
  if (botUsername === undefined) return {};
  const name = botUsername.replace(/^@/, '');
  if (!BOT_USERNAME.test(name)) throw new Error('--bot-username is not a Telegram bot username');
  return { botUsername: name };
}

/**
 * What the owner sends to pair: the exact "/start <code>" text, plus a t.me deep link
 * when the bot username is known (opening it and tapping Start sends the same command).
 */
export function telegramPairingInstructions(code: string, botUsername?: string): string[] {
  const lines = ['Open the bot in Telegram and send exactly:', `  /start ${code}`];
  if (botUsername !== undefined) lines.push('Or open this link and tap Start:', `  https://t.me/${botUsername}?start=${code}`);
  return lines;
}
