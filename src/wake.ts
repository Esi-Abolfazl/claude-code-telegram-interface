/**
 * Phone turn runner (CONTEXT.md → Phone turn).
 *
 * Spawned detached by the wake gate in server.ts when a plain Telegram message
 * arrives for an idle project. Runs `claude -p` there, forked from the origin
 * session so Claude keeps its context, and streams the reply back into the same
 * Telegram chain.
 *
 * Every exit path reports to the chain: the human is on their phone and cannot
 * check the machine to find out why nothing came back.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { clearBusy, pollLoop, withState, type WakePlan } from './server.ts';
import { sendThreaded } from './hook.ts';

interface WakePayload extends WakePlan {
  new_sid: string;
  text: string;
}

const BUDGET_USD = Number(process.env.TG_WAKE_BUDGET_USD || 5);
const MAX_SECONDS = Number(process.env.TG_WAKE_MAX_SECONDS || 1800);

/** Telegram rich messages hold 32k; cut with a visible marker, never silently. */
const clip = (s: string, n = 30000) =>
  s.length > n ? s.slice(0, n) + "\n\n*✂️ trimmed — hit Telegram's size limit*" : s;

const PHONE_NOTE = [
  'This turn was started from Telegram: the human is on their phone, away from the terminal.',
  'They see your reply as a Telegram message, so make it self-contained — no "see above",',
  'no pointing at terminal output, no asking them to check the machine.',
  'Anything interactive goes through the claude-code-telegram-interface MCP tools (ask_question,',
  'request_approval); a plain question in your reply text cannot be answered directly.',
].join(' ');

// A General chat has no repo behind it — the human opened a conversation, not a
// task in a project. Saying so stops Claude from treating the empty workspace
// directory as the thing it was asked about.
const GENERAL_NOTE = [
  PHONE_NOTE,
  'This is a general chat, not work on a project: there is no repository here and nothing',
  'in this directory to read. Answer the message on its own terms. If files are needed at',
  'all, this scratch directory is the only place to write them.',
].join(' ');

export type WakeEvent =
  | { kind: 'init'; metered: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: boolean; text: string; cost: number | null; seconds: number | null; denials: string[] }
  | null;

/**
 * One line of `--output-format stream-json`. Three kinds matter: init (is this
 * run API-key metered, or subscription auth where cost is a fiction?),
 * assistant text blocks (streamed to Telegram as Claude produces them), and
 * the final result. Everything else — hook_started/hook_response, rate
 * limits, tool blocks — is machinery the human does not need on their phone.
 */
export function parseWakeEvent(line: string): WakeEvent {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o?.type === 'system' && o.subtype === 'init')
    return { kind: 'init', metered: Boolean(o.apiKeySource) && o.apiKeySource !== 'none' };
  if (o?.type === 'assistant') {
    const text = (o.message?.content ?? [])
      .filter((b: any) => b?.type === 'text' && b.text?.trim())
      .map((b: any) => b.text.trim())
      .join('\n\n');
    return text ? { kind: 'text', text } : null;
  }
  if (o?.type === 'result')
    return {
      kind: 'result',
      ok: o.subtype === 'success' && !o.is_error,
      text: typeof o.result === 'string' ? o.result.trim() : '',
      cost: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
      seconds: typeof o.duration_ms === 'number' ? Math.round(o.duration_ms / 1000) : null,
      denials: (o.permission_denials ?? []).map((d: any) => d?.tool_name || d?.tool || '?'),
    };
  return null;
}

/**
 * What the human reads when no reply is coming. They are on their phone: the
 * message has to name the cause and the way out on its own, never "check the
 * terminal".
 */
export function failureLine(project: string, why: string, stderr = '') {
  const reason =
    why === 'ENOENT'
      ? 'the `claude` command is not on PATH for this process — start Claude Code from a shell where `claude` works, or install it globally'
      : why;
  return (
    `❌ *Could not finish that in ${project}* — ${reason}.` +
    (stderr.trim() ? `\n\n\`\`\`\n${stderr.trim().slice(-1200)}\n\`\`\`` : '') +
    '\n\n*Send it again to retry.*'
  );
}

/**
 * Trailer under the reply: duration, and anything the run was not allowed to
 * do. `total_cost_usd` is Claude Code's estimate at API list prices — real
 * money only on API-key auth; on claude.ai subscription auth nothing is
 * billed, so printing "$0.42" there would be fiction. Shown only when the
 * init event said the run is metered.
 */
export function resultLine(r: Extract<WakeEvent, { kind: 'result' }>, metered = false) {
  const bits = [r.ok ? '✅ done' : '❌ stopped'];
  if (r.seconds != null) bits.push(`${r.seconds}s`);
  if (metered && r.cost != null) bits.push(`$${r.cost.toFixed(2)}`);
  const denied = [...new Set(r.denials)];
  return (
    `*${bits.join(' · ')}*` +
    (denied.length ? `\n*🚫 not allowed without you: ${denied.join(', ')}*` : '')
  );
}

/**
 * One outgoing message: the "new chat" banner (first reply of a fresh General
 * chat only), the text, and the trailer — together, not as separate messages.
 * The chat used to get three messages for one answer.
 */
export function replyMessage(newChat: boolean, text: string | null, trailer = '') {
  const head = newChat ? '🆕 *New chat*\n\n' : '';
  return [head + (text ? '💬 ' + clip(text) : ''), trailer].filter((x) => x.trim()).join('\n\n');
}

export async function runWake(payloadPath: string) {
  const p: WakePayload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const sid = p.new_sid;
  const say = (md: string, extra: Record<string, unknown> = {}) =>
    sendThreaded(sid, md, extra).catch(() => 0);

  pollLoop(); // this may be the only live process able to receive taps meanwhile

  // Fork the origin session so Claude keeps its context. Without a transcript on
  // disk there is nothing to resume — run fresh rather than fail.
  const resumable = p.transcript_path && existsSync(p.transcript_path);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    sid,
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(BUDGET_USD),
    '--append-system-prompt',
    p.general ? GENERAL_NOTE : PHONE_NOTE,
    ...(resumable ? ['--resume', p.origin_sid, '--fork-session'] : []),
  ];

  const child = spawn('claude', args, {
    cwd: p.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Headless runs have no terminal to fall back to: hooks must route questions
    // to Telegram regardless of the stored mode. Env-scoped on purpose — never
    // written into state.config.mode.
    env: { ...process.env, CLAUDE_CODE_TELEGRAM_INTERFACE_FORCE_BOT: '1' },
  });

  let killed = '';
  const timer = setTimeout(() => {
    killed = `hit the ${MAX_SECONDS}s limit`;
    child.kill('SIGTERM');
  }, MAX_SECONDS * 1000);

  child.on('error', (e: any) => {
    killed = killed || (e.code === 'ENOENT' ? 'ENOENT' : e.message);
  });
  child.stdin.on('error', () => {}); // a claude that never started has no stdin
  child.stdin.end(p.text);

  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-2000)));

  /**
   * One answer should read as ONE message. Blocks are therefore held, not sent
   * on arrival: a block goes out only when the NEXT one arrives (so a long turn
   * still shows progress), and the last block leaves together with the trailer.
   * A short Q&A is then a single notifying message instead of the three the
   * chat used to get (ack, text, "✅ done").
   */
  let held: string | null = null;
  let firstOut = true;
  let metered = false;
  let result: Extract<WakeEvent, { kind: 'result' }> | null = null;
  let buf = '';

  const send = async (trailer = '') => {
    if (!held && !trailer) return;
    const newChat = firstOut && !!p.general && !p.origin_sid;
    await say(replyMessage(newChat, held, trailer), {
      disable_notification: !trailer, // only the message carrying the trailer pings
    });
    firstOut = false;
    held = null;
  };

  const pump = async (chunk: string, flush = false) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = flush ? '' : lines.pop()!;
    for (const line of lines) {
      const ev = parseWakeEvent(line.trim());
      if (!ev) continue;
      if (ev.kind === 'init') metered = ev.metered;
      else if (ev.kind === 'text') {
        await send(); // flush the previous block, keep this one back
        held = ev.text;
      } else result = ev;
    }
  };

  // Sequential drain: Telegram sends must stay in order, and out-of-order
  // messages would scramble the reply chain.
  let queue: Promise<void> = Promise.resolve();
  child.stdout.on('data', (b) => (queue = queue.then(() => pump(String(b)))));

  const code: number = await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  await queue;
  await pump('', true);

  if (result) {
    // The result text normally repeats the block already held; only a turn that
    // streamed nothing has anything new to say here.
    if (!held && result.text) held = result.text;
    await send(resultLine(result, metered));
  } else {
    await say(failureLine(p.general ? 'this chat' : basename(p.cwd), killed || `claude exited with code ${code}`, stderr));
  }

  withState((s) => clearBusy(s, sid));
  rmSync(payloadPath, { force: true });
  process.exit(0);
}
