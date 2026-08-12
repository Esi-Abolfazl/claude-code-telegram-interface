#!/usr/bin/env node
/**
 * Single entry point for every role, so one compiled binary serves them all:
 *
 *   <entry>                    MCP stdio server (what .mcp.json launches)
 *   <entry> hook [--watch f]   Claude Code hook / detached escalation watcher
 *   <entry> --setup …          store bot token + Admin id in Plugin home
 *   <entry> --mode bot|claude  fast receiver switch for the slash commands
 *   <entry> --selftest         offline logic checks, no network
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomBytes } from 'node:crypto';
import {
  createServer,
  pollLoop,
  readState,
  selftest,
  telegram,
  tgWithToken,
  withState,
  writeConfigFile,
  CONFIG_FILE,
  isConfigured,
  STATE_FILE,
  type Mode,
} from './server.ts';

const argv = process.argv.slice(2);
const [sub] = argv;

/**
 * `--setup <token> [<admin-id>]`, or `--setup token=… admin=…`.
 * Without an Admin id we mint a one-time Pairing code instead: the user sends
 * `/start <code>` and whoever does becomes the Admin.
 */
async function setup(args: string[]) {
  let token = '';
  let admin: number | null = null;
  for (const raw of args) {
    const a = raw.trim();
    if (!a) continue;
    if (a.startsWith('token=')) token = a.slice(6);
    else if (a.startsWith('admin=')) admin = Number(a.slice(6));
    else if (/^\d+$/.test(a)) admin = Number(a);
    else if (!token) token = a;
  }
  if (!token) {
    console.error(
      'usage: --setup <bot-token> [<your-telegram-user-id>]\n' +
        'Get a token from @BotFather in Telegram (/newbot).'
    );
    process.exit(1);
  }
  if (admin !== null && !Number.isInteger(admin)) {
    console.error('The Telegram user id must be a number (get it from @userinfobot).');
    process.exit(1);
  }

  let me: { username?: string; first_name?: string };
  try {
    me = await tgWithToken(token, 'getMe');
  } catch (e: any) {
    console.error(`That token was rejected by Telegram: ${e.message}`);
    process.exit(1);
  }

  const pairing_code = admin === null ? randomBytes(3).toString('hex') : null;
  writeConfigFile({ bot_token: token, admin_id: admin, pairing_code });
  // A new token means a new bot: any previously bound chat belongs to the old
  // one. Both fields reset — the next /start re-establishes the Binding.
  withState((s) => {
    s.chat_id = null;
    s.user_id = null;
  });

  const link = me.username ? `https://t.me/${me.username}` : 'your bot in Telegram';
  console.log(
    [
      `✅ Saved to ${CONFIG_FILE} (owner-only permissions).`,
      `Bot: ${me.first_name || ''} ${me.username ? '@' + me.username : ''}`.trim(),
      '',
      admin === null
        ? `Now open ${link} and send:  /start ${pairing_code}\n` +
          `That one-time code makes you the admin — nobody else can use the bot.`
        : `Now open ${link} and press Start. Only Telegram user ${admin} is accepted.`,
      '',
      'No restart needed — a running session picks the token up within a few seconds.',
    ].join('\n')
  );
  process.exit(0);
}

async function switchMode(raw: string | undefined) {
  let m = raw === 'terminal' ? 'claude' : raw; // legacy alias
  if (m !== 'bot' && m !== 'claude') {
    console.error('usage: --mode bot|claude');
    process.exit(1);
  }
  withState((s) => (s.config.mode = m as Mode));
  const s = readState();
  if (s.chat_id && isConfigured())
    await telegram('sendMessage', {
      chat_id: s.chat_id,
      parse_mode: 'HTML',
      disable_notification: true,
      text:
        m === 'bot'
          ? '📱 <i>Bot mode on (switched from Claude Code).</i>'
          : '🖥 <i>Claude mode on (switched from Claude Code).</i>',
    }).catch(() => {});
  console.log(
    m === 'bot'
      ? 'Receiver: Telegram bot — questions & plan approvals go to the phone first.'
      : 'Receiver: Claude Code — questions show in Claude Code first.'
  );
  process.exit(0);
}

if (sub === 'hook') {
  const { runHook } = await import('./hook.ts');
  await runHook(argv.slice(1));
} else if (argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error('selftest FAILED:', e);
    process.exit(1);
  });
} else if (sub === '--setup') {
  await setup(argv.slice(1));
} else if (argv.includes('--mode')) {
  await switchMode(argv[argv.indexOf('--mode') + 1]);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  const s = readState();
  console.error(
    `claude-code-telegram-interface up · state: ${STATE_FILE} · ` +
      (!isConfigured()
        ? 'NOT configured — run /claude-code-telegram-interface:setup <bot-token>'
        : s.chat_id
          ? 'chat: bound'
          : 'chat: NOT bound — open your bot in Telegram and press Start')
  );
  pollLoop();
}
