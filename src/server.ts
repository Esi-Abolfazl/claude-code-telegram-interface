/**
 * claude-code-telegram-interface — Claude ⇄ Telegram decision inbox.
 *
 * Mirrors agent questions / approvals / notifications to a Telegram bot as
 * push notifications with one-tap inline-button answers, so the human can
 * unblock long-running agent work from their phone.
 *
 * Contract (Remoko-style): external_id dedupe, versioned items, get_response
 * polling, mark_processed acknowledgment, report_execution outcomes.
 *
 * Config (see loadConfig): bot token + Admin id live in Plugin home
 * (~/.claude-code-telegram-interface/config.json), never inside the plugin directory —
 * that one is swapped on every plugin update. See docs/adr/0001.
 *
 * Entry points live in main.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import assert from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- types
export type Risk = 'low' | 'medium' | 'high' | 'critical';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type ReqType = 'question' | 'approval' | 'feedback' | 'notify';
export type ReqStatus = 'pending' | 'answered' | 'expired' | 'cancelled' | 'delivered';
export type Mode = 'bot' | 'claude';

export interface Choice {
  label: string;
  description?: string;
}

/**
 * What callers may pass as a choice. The object arm's `label` is optional only
 * because that is how the MCP SDK infers the zod schema; zod validates it as
 * required at runtime, so normChoices can safely default it.
 */
export type ChoiceInput = string | { label?: string; description?: string };

export interface Answer {
  choice?: string;
  choice_index?: number;
  text?: string;
  decision?: 'approve' | 'deny';
  always_allow?: boolean;
  responded_via?: 'tap' | 'text' | 'auto';
  rule?: string;
  at?: string;
  version?: number;
  by?: number;
}

export interface ExecutionResult {
  outcome?: 'success' | 'failure' | 'partial';
  files_changed?: number;
  tests_passed?: number;
  tests_failed?: number;
  commit_message?: string;
  duration_seconds?: number;
}

export interface Req {
  id: string;
  type: ReqType;
  version: number;
  status: ReqStatus;
  processed: boolean;
  created_at: string;
  expires_at?: string | null;
  external_id?: string;
  title?: string;
  header?: string;
  session_id?: string | null;
  details?: string;
  choices?: Choice[];
  allow_free_text?: boolean;
  project?: string;
  recommendation?: string;
  consequence?: string;
  prohibitions?: string;
  links?: string[];
  source_thread?: string;
  risk?: Risk;
  priority?: Priority;
  rule_key?: string;
  answer?: Answer;
  execution?: { status: string; summary?: string; result?: ExecutionResult; at: string };
  cancel_reason?: string;
  tg_message_id?: number | null;
  tg_chat_id?: number | null;
}

/** Arguments accepted by makeRequest / the MCP create tools. */
export interface CreateArgs {
  external_id?: string;
  title?: string;
  header?: string;
  session_id?: string | null;
  details?: string;
  choices?: ChoiceInput[];
  allow_free_text?: boolean;
  project?: string;
  recommendation?: string;
  consequence?: string;
  prohibitions?: string;
  links?: string[];
  source_thread?: string;
  risk?: Risk;
  priority?: Priority;
  rule_key?: string;
  expires_in_seconds?: number;
}

export interface Session {
  cwd: string | null;
  project: string | null;
  /** Human label for the session — what it was started to do. See sessionHead. */
  title?: string | null;
  started_at: string;
  last_card_msg_id: number | null;
  last_error_at: number;
  /** Busy (CONTEXT.md): mid-turn since this ms timestamp; null/absent = idle. */
  busy_since?: number | null;
  /** The Claude process owning the turn, so a crashed one stops counting as Busy. */
  busy_pid?: number | null;
  /** Latest transcript path seen for this session — what a Phone turn forks from. */
  transcript_path?: string | null;
  /** Turn mirror (CONTEXT.md): transcript lines already sent to Telegram. */
  mirrored_line?: number | null;
  /** General chat (CONTEXT.md): belongs to no project, always answered in General. */
  general?: boolean;
}

export interface BridgeConfig {
  mode: Mode;
  escalate_after_seconds: number;
  escalate_permission: 'ask' | 'auto' | 'never';
  /** Whether a plain Telegram message may start a Phone turn (CONTEXT.md). */
  phone_turns: 'on' | 'off';
}

export interface State {
  chat_id: number | null;
  /** The bound Admin's Telegram user id (see CONTEXT.md → Admin). */
  user_id: number | null;
  offset: number;
  rules: Record<string, { created_at: string; by: number }>;
  requests: Record<string, Req>;
  config: BridgeConfig;
  sessions: Record<string, Session>;
  /** `delivered_at`: handed to a blocking Stop, not yet proven seen — see drainInbox. */
  inbox: { session_id: string; text: string; at: string; delivered_at?: string }[];
  tg_msgs: Record<string, string>;
  group_chat_id: number | null;
  topics: Record<string, { topic_id: number; name: string }>;
  /** The General chat (CONTEXT.md) a plain message in General continues; /new clears it. */
  general_sid?: string | null;
}

/** Only the Telegram update fields this bridge actually reads. */
export interface TgMessage {
  message_id?: number;
  message_thread_id?: number;
  text?: string;
  from?: { id: number };
  chat: { id: number; type?: string; is_forum?: boolean };
  reply_to_message?: { message_id: number };
}

export interface TgCallback {
  id: string;
  from: { id: number };
  data?: string;
}

// ------------------------------------------------------------- build stamp
// Injected by `bun build --define` when compiling a release binary; absent in
// dev, where `typeof` on the undeclared identifier is safe.
declare const __BUILD_V__: number;
declare const __COMPILED__: boolean;

/** True in a compiled single-file binary — it ships no source files. */
export const COMPILED = typeof __COMPILED__ !== 'undefined' && __COMPILED__;

/**
 * Argv for re-spawning ourselves in another role (escalation watcher, Phone
 * turn runner). A compiled binary IS process.execPath and carries no source
 * files, so it takes the subcommand directly; in dev, node needs the script
 * path first.
 */
export const selfArgv = (...tail: string[]) =>
  COMPILED ? tail : [fileURLToPath(new URL('main.ts', import.meta.url)), ...tail];

/**
 * Poller-election rank: a process running newer code outranks a live older
 * one, so long-lived servers from old sessions yield to fresh code instead of
 * handling updates with stale logic.
 *
 * MUST stay an embedded build stamp, never a file mtime — a downloaded
 * binary's mtime is its download time, which would let stale code outrank
 * newer. Dev falls back to source mtime, which is accurate there. See
 * docs/adr/0001.
 */
export const BUILD_V: number =
  typeof __BUILD_V__ !== 'undefined'
    ? __BUILD_V__
    : (() => {
        try {
          return statSync(fileURLToPath(import.meta.url)).mtimeMs;
        } catch {
          return 0;
        }
      })();

// ---------------------------------------------------------------- config
export const SELFTEST = process.argv.includes('--selftest');

/**
 * Plugin home — the ONLY durable location. The installed plugin directory is
 * disposable (Claude Code swaps it on update), so nothing is ever written
 * next to the source. See docs/adr/0001.
 */
export const HOME_DIR = join(homedir(), '.claude-code-telegram-interface');

export const STATE_FILE =
  process.env.STATE_FILE ||
  (SELFTEST ? join(tmpdir(), `tg-assist-selftest-${process.pid}`, 'state.json') : join(HOME_DIR, 'state.json'));

// Selftest keeps config beside its throwaway state — it must never read or
// overwrite the real installation's token.
export const CONFIG_FILE =
  process.env.CLAUDE_CODE_TELEGRAM_INTERFACE_CONFIG ||
  (SELFTEST ? join(dirname(STATE_FILE), 'config.json') : join(HOME_DIR, 'config.json'));
const LOCK_DIR = STATE_FILE + '.lock';
const POLLER_FILE = STATE_FILE + '.poller';

export interface StoredConfig {
  bot_token?: string;
  admin_id?: number | null;
  /** One-time code that claims the Admin role via `/start <code>`. */
  pairing_code?: string | null;
}

export function readConfigFile(): StoredConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfigFile(patch: StoredConfig): StoredConfig {
  const merged = { ...readConfigFile(), ...patch };
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

// Dev legacy: a .env at the repo root still works for `CLAUDE_CODE_TELEGRAM_INTERFACE_DEV=1`
// runs. Real environment variables take precedence over it, and config.json
// is what an installed plugin uses.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {}

/**
 * Read live, never cached at import: `--setup` runs in a separate process, so
 * a server that started unconfigured must be able to pick the token up on its
 * next poll instead of forcing the human to restart Claude Code.
 */
export const currentToken = (): string => process.env.TELEGRAM_BOT_TOKEN || readConfigFile().bot_token || '';

/** A token exists, so Telegram calls can be attempted. */
export const isConfigured = () => Boolean(currentToken()) || SELFTEST;

/**
 * The declared Admin (CONTEXT.md → Admin): env overrides config.json, null
 * means nobody has claimed the bot yet. Read live rather than cached so
 * `--setup` in one process is visible to a server already running.
 */
export const declaredAdmin = (cfg: StoredConfig = readConfigFile()): number | null =>
  process.env.TELEGRAM_USER_ID ? Number(process.env.TELEGRAM_USER_ID) : (cfg.admin_id ?? null);

/**
 * A freshly installed plugin has no token yet. Never exit for that: the MCP
 * server still has to start, or Claude Code would report a crashing server on
 * every session. Tools answer with NOT_CONFIGURED instead.
 */
export const NOT_CONFIGURED =
  'claude-code-telegram-interface is not configured yet. Ask the human to run /claude-code-telegram-interface:setup <bot-token> ' +
  '(token from @BotFather), then press Start in their bot.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- state io
// Shared JSON state file. Multiple server processes (one per Claude session)
// coordinate through it: every mutation is lock → read → mutate → write, so
// no process ever works from a stale in-memory copy.
const DEFAULTS: State = {
  chat_id: null,
  user_id: null,
  offset: 0,
  rules: {},
  requests: {},
  // mode: where Claude's native prompts (plan approvals, questions) are answered.
  //   claude — they show in Claude Code; bot escalates only after escalate_after_seconds.
  //   bot    — they come to Telegram first, Claude Code is the fallback.
  // escalate_permission: ask (consent card first) | auto (just forward) | never.
  // phone_turns: on — plain text to an idle project wakes Claude headlessly.
  config: { mode: 'claude', escalate_after_seconds: 60, escalate_permission: 'ask', phone_turns: 'on' },
  sessions: {}, // session_id → {cwd, project, started_at, last_card_msg_id, last_error_at}
  inbox: [], // user replies routed to sessions: [{session_id, text, at}]
  tg_msgs: {}, // telegram message_id → session_id (thread chaining + reply routing)
  group_chat_id: null, // forum supergroup (topic = project); null → plain DM mode
  topics: {}, // project cwd → {topic_id, name}
  general_sid: null, // the General chat a plain General message continues
};
mkdirSync(dirname(STATE_FILE), { recursive: true });

export function readState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const st: State = { ...DEFAULTS, ...parsed, config: { ...DEFAULTS.config, ...(parsed.config || {}) } };
    if ((st.config.mode as string) === 'terminal') st.config.mode = 'claude'; // legacy name
    return st;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function acquireLock() {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { recursive: false });
      return;
    } catch {
      try {
        // Locks are held for ~1ms (sync read+write). Anything older is a dead process.
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > 5000) {
          rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > 10_000) throw new Error('state lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // sync 20ms sleep
    }
  }
}

export function withState<T>(fn: (s: State) => T): T {
  acquireLock();
  try {
    const s = readState();
    const ret = fn(s);
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2));
    renameSync(STATE_FILE + '.tmp', STATE_FILE);
    return ret;
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- telegram
/** Bot API call with an explicit token — setup validates a token before storing it. */
export async function tgWithToken(
  token: string,
  method: string,
  params: Record<string, any> = {}
): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

const realTg = (method: string, params: Record<string, any> = {}) =>
  tgWithToken(currentToken(), method, params);
export let telegram: (method: string, params?: Record<string, any>) => Promise<any> = realTg;

// Only one process may long-poll getUpdates (Telegram 409s concurrent polls).
// Cheapest election: a heartbeat file; stale or dead holder gets replaced.
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryBecomePoller() {
  try {
    const p = JSON.parse(readFileSync(POLLER_FILE, 'utf8'));
    const holderAlive = p.pid !== process.pid && Date.now() - p.t < 90_000 && alive(p.pid);
    if (holderAlive && (p.v ?? 0) >= BUILD_V) return false;
  } catch {}
  writeFileSync(POLLER_FILE, JSON.stringify({ pid: process.pid, t: Date.now(), v: BUILD_V }));
  try {
    return JSON.parse(readFileSync(POLLER_FILE, 'utf8')).pid === process.pid;
  } catch {
    return false;
  }
}

export async function pollLoop() {
  for (;;) {
    // An unconfigured install idles here instead of exiting, so `--setup` in
    // another process starts working without restarting Claude Code.
    if (!isConfigured()) {
      await sleep(5000);
      continue;
    }
    if (!tryBecomePoller()) {
      await sleep(15_000);
      continue;
    }
    try {
      const updates = await telegram('getUpdates', {
        offset: readState().offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const u of updates) {
        await handleUpdate(u).catch((e) => console.error('update error:', e.message));
      }
      if (updates.length) withState((s) => (s.offset = updates.at(-1).update_id + 1));
    } catch (e: any) {
      console.error('poll:', e.message);
      await sleep(5000);
    }
  }
}

/**
 * THE authorization gate (CONTEXT.md → Admin). Every inbound update passes
 * through here and nowhere else, so messages and button taps can never drift
 * apart on who is allowed to drive the bot.
 *
 *   admin — the bound Admin; carry on
 *   bind  — an unbound bot being claimed by a legitimate /start
 *   drop  — anyone else, silently (never tell a stranger the bot exists)
 */
export function authorize(s: State, from_id: number | undefined, text: string): 'admin' | 'bind' | 'drop' {
  if (!from_id) return 'drop';
  // Bound-ness is chat_id, never user_id alone: --setup records the declared
  // Admin before any chat exists, and treating that as bound would make the
  // very /start that creates the Binding fall through to a handler that drops
  // it for not matching the (still null) chat.
  if (s.chat_id) return from_id === s.user_id ? 'admin' : 'drop';
  if (!text.startsWith('/start')) return 'drop';

  const cfg = readConfigFile();
  const admin = declaredAdmin(cfg);
  if (admin) return from_id === admin ? 'bind' : 'drop';
  if (cfg.pairing_code) return text.trim().split(/\s+/)[1] === cfg.pairing_code ? 'bind' : 'drop';
  return 'bind'; // no Admin declared and no code issued → trust on first use
}

/** Claims the bot for this sender: the Pairing code is single-use. */
function bindAdmin(m: TgMessage) {
  withState((s) => {
    s.chat_id = m.chat.id;
    s.user_id = m.from!.id;
  });
  writeConfigFile({ admin_id: m.from!.id, pairing_code: null });
  return telegram('sendMessage', {
    chat_id: m.chat.id,
    text: '🔗 Connected. Claude can now reach you here for questions, approvals and updates.\n/pending shows what is waiting on you.',
  });
}

export async function handleUpdate(u: { callback_query?: TgCallback; message?: TgMessage }) {
  const from = u.callback_query?.from ?? u.message?.from;
  const verdict = authorize(readState(), from?.id, u.message?.text || '');
  if (verdict === 'drop') {
    if (u.callback_query)
      await telegram('answerCallbackQuery', {
        callback_query_id: u.callback_query.id,
        text: 'Not authorized',
        show_alert: true,
      }).catch(() => {});
    return;
  }
  if (verdict === 'bind') return void (await bindAdmin(u.message!));
  if (u.callback_query) return handleCallback(u.callback_query);
  if (u.message) return handleMessage(u.message);
}

// ---------------------------------------------------------------- rendering
export const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Content-bearing messages go out as Telegram Rich Messages
// (sendRichMessage, Bot API): the `markdown` field renders Claude's own
// markdown dialect natively — headings, lists, tables, code fences, quotes —
// up to 32768 chars. Small service texts still use plain sendMessage + HTML.
export const sendRich = (chat_id: number | null, markdown: string, extra: Record<string, any> = {}) =>
  telegram('sendRichMessage', { chat_id, rich_message: { markdown }, ...extra });

const RISK_BADGE: Record<string, string> = {
  low: '🟢 low risk',
  medium: '🟡 medium risk',
  high: '🟠 high risk',
  critical: '🔴 CRITICAL risk',
};

function rel(ts: string) {
  const s = Math.round((Date.parse(ts) - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// ---------------------------------------------------------------- sessions
// Cards, notifications and errors from one Claude session form one Telegram
// reply-chain; replies to any message of the chain route back to the session.
export function ensureSession(s: State, id: string | null | undefined, cwd?: string | null) {
  if (!id) return null;
  const sess = (s.sessions[id] ??= {
    cwd: cwd || null,
    project: cwd ? cwd.split('/').filter(Boolean).pop()! : null,
    started_at: new Date().toISOString(),
    last_card_msg_id: null,
    last_error_at: 0,
  });
  if (cwd && !sess.cwd) {
    sess.cwd = cwd;
    sess.project = cwd.split('/').filter(Boolean).pop()!;
  }
  return sess;
}

/**
 * The two identity lines every message starts with: "project - #id" so the
 * human can find the session, then the session's own name so they know which
 * one it is without going back to the machine. Single source of truth — cards,
 * notifications, execution reports and thread headers all call this.
 */
export function sessionHead(project: string | null | undefined, session_id: string | null | undefined) {
  const top = [project, session_id ? `#${session_id.slice(0, 8)}` : null].filter(Boolean).join(' - ');
  const title = session_id ? readState().sessions[session_id]?.title : null;
  return [top || null, title ? `*${title}*` : null].filter(Boolean).join('\n');
}

/** Newest known session, optionally restricted to one project directory. */
export function newestSession(s: State, cwd?: string): string | null {
  let best: string | null = null;
  for (const [id, sess] of Object.entries(s.sessions))
    if ((!cwd || sess.cwd === cwd) && (!best || sess.started_at > s.sessions[best].started_at)) best = id;
  return best;
}

// MCP tool calls don't carry a session id; the server process is spawned with
// cwd = the session's project dir, so attribute to the newest session there.
const sessionIdForCwd = (s: State) => newestSession(s, process.cwd());

// -------------------------------------------------------------------- busy
// A session is Busy between UserPromptSubmit and Stop. Phone turns only spawn
// into projects that are not Busy, so a headless Claude never edits the same
// repo as a live one.

/** Backstop for a session SIGKILLed with no pid to check — see cwdBusy. */
const BUSY_MAX_MS = 6 * 3_600_000;

export function setBusy(
  s: State,
  id: string | null | undefined,
  pid?: number | null,
  transcript_path?: string | null
) {
  const sess = id ? s.sessions[id] : null;
  if (!sess) return;
  sess.busy_since = Date.now();
  sess.busy_pid = pid ?? null;
  if (transcript_path) sess.transcript_path = transcript_path;
}

export function clearBusy(s: State, id: string | null | undefined) {
  const sess = id ? s.sessions[id] : null;
  if (sess) sess.busy_since = null;
}

/**
 * Is any session in this project mid-turn? A live pid is the truth; a session
 * with no pid recorded falls back to a staleness window, so one crash can't
 * block Phone turns in that project forever.
 */
export function cwdBusy(s: State, cwd: string): boolean {
  return Object.values(s.sessions).some(
    (x) =>
      x.cwd === cwd &&
      x.busy_since &&
      (x.busy_pid ? alive(x.busy_pid) : Date.now() - x.busy_since < BUSY_MAX_MS)
  );
}

// -------------------------------------------------------------- phone turns
// A plain Telegram message for an idle project starts a Phone turn: a detached
// runner wakes `claude -p` there and streams the reply back into the same
// Telegram chain. Wakes happen ONLY through deliver()'s gate below — that is
// already the single choke point every inbound text passes through, so keep
// this the only caller instead of spawning from anywhere else.

/**
 * Where General chats run. A Phone turn runs with `acceptEdits`, so its cwd
 * must be a directory we own and nothing else lives in — never $HOME, which
 * would put every file the human has behind an unattended turn.
 */
export const GENERAL_DIR = join(HOME_DIR, 'general');

export interface WakePlan {
  cwd: string;
  project: string | null;
  origin_sid: string;
  /** Existence probe for a forkable transcript; the fork itself resumes by id. */
  transcript_path: string | null;
  /** General chat: no project, answers go back to General. */
  general?: boolean;
  /** Name for a brand-new chat (a General chat has no origin to inherit from). */
  title?: string | null;
}

/**
 * The plan for a General chat: continue `sid`'s chat when one is given (the
 * runner forks its transcript), otherwise a fresh one. Unlike a project wake
 * there is no origin session to read a cwd from — General IS the workspace.
 */
export function generalPlan(s: State, sid: string | null, firstLine: string): WakePlan {
  const sess = sid ? s.sessions[sid] : null;
  return {
    cwd: GENERAL_DIR,
    project: null,
    origin_sid: sess?.general ? sid! : '',
    transcript_path: sess?.general ? sess.transcript_path ?? null : null,
    general: true,
    title: sess?.title ?? (firstLine.length > 60 ? firstLine.slice(0, 60).trimEnd() + '…' : firstLine),
  };
}

/** Whether this text may start a Phone turn, and with what. */
export function shouldWake(s: State, sid: string | null | undefined): WakePlan | null {
  if (s.config.phone_turns !== 'on' || !sid) return null;
  const sess = s.sessions[sid];
  if (!sess?.cwd || cwdBusy(s, sess.cwd)) return null;
  return {
    cwd: sess.cwd,
    project: sess.project,
    origin_sid: sid,
    transcript_path: sess.transcript_path ?? null,
  };
}

/**
 * Registers the Phone turn's own session before Claude starts: it inherits the
 * origin's chain head and name so every message lands in the same Telegram
 * thread, and starts Busy so a second message during Claude's slow boot queues
 * instead of spawning a second turn.
 */
export function seedWakeSession(
  s: State,
  p: WakePlan,
  new_sid: string,
  pid: number | null,
  userMsgId: number | null = null
) {
  const origin = s.sessions[p.origin_sid];
  s.sessions[new_sid] = {
    cwd: p.cwd,
    project: p.project,
    title: origin?.title ?? p.title ?? null,
    started_at: new Date().toISOString(),
    // The waking message itself, when known — the streamed reply chains to it.
    last_card_msg_id: userMsgId ?? origin?.last_card_msg_id ?? null,
    last_error_at: 0,
    busy_since: Date.now(),
    busy_pid: pid,
    ...(p.general ? { general: true } : {}),
  };
  if (p.general) s.general_sid = new_sid; // the chat plain General messages continue
}

/**
 * Spawns the detached runner. Returns the project label when a turn started, so
 * the caller can say so; `say` is also how a failed spawn reports itself —
 * "⚡️ Waking Claude" followed by silence is the one outcome the human cannot
 * diagnose from their phone.
 */
function maybeWake(
  sid: string | null,
  text: string,
  say: (t: string) => unknown,
  userMsgId: number | null = null
): string | null {
  const plan = shouldWake(readState(), sid);
  return plan ? spawnWake(plan, text, say, userMsgId) : null;
}

/** The spawn half, shared by project wakes and General chats. */
export function spawnWake(
  plan: WakePlan,
  text: string,
  say: (t: string) => unknown,
  userMsgId: number | null = null
): string | null {
  if (SELFTEST) return null; // selftest is offline: no real Claude, no spawn
  const payloadPath = join(dirname(STATE_FILE), `wake-${Date.now()}-${process.pid}.json`);
  const new_sid = randomUUID();
  const failed = (why: string) => {
    console.error('wake spawn:', why);
    withState((s) => clearBusy(s, new_sid));
    rmSync(payloadPath, { force: true });
    say(`❌ Could not start Claude in <b>${esc(basename(plan.cwd))}</b>: ${esc(why)}. Send it again to retry.`);
  };
  try {
    mkdirSync(plan.cwd, { recursive: true }); // the General workspace on first use
    writeFileSync(payloadPath, JSON.stringify({ ...plan, new_sid, text }));
    const child = spawn(process.execPath, selfArgv('hook', '--wake', payloadPath), {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
    });
    // spawn reports a bad cwd / missing runtime asynchronously, long after this
    // function has returned — the listener is the only place that can catch it.
    child.on('error', (e: any) => failed(e.message));
    child.unref();
    withState((s) => seedWakeSession(s, plan, new_sid, child.pid ?? null, userMsgId));
    return plan.project || basename(plan.cwd);
  } catch (e: any) {
    failed(e.message);
    return null;
  }
}

export function trackMsg(s: State, message_id: number | null, session_id: string | null | undefined) {
  if (!message_id || !session_id) return;
  s.tg_msgs[message_id] = session_id;
  const keys = Object.keys(s.tg_msgs);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete s.tg_msgs[k];
}

// Store the sent card's telegram id + chat and advance the session's thread head.
export function recordCardMessage(request_id: string, message_id: number, chat_id: number | null) {
  withState((s) => {
    const r = s.requests[request_id];
    if (r) {
      r.tg_message_id = message_id;
      if (chat_id) r.tg_chat_id = chat_id;
    }
    if (r?.session_id) {
      const sess = s.sessions[r.session_id];
      if (sess) sess.last_card_msg_id = message_id;
      trackMsg(s, message_id, r.session_id);
    }
  });
}

// Where a session's messages go: its project topic in the forum group when
// one is bound, else the DM chat.
export function dest(s: State, session_id: string | null | undefined) {
  const sess = session_id ? s.sessions[session_id] : null;
  // A General chat carries no project, so it never gets a project topic: its
  // messages go back to General (no thread id), which is where they were typed.
  if (sess?.general) return { chat_id: s.group_chat_id ?? s.chat_id, message_thread_id: undefined };
  if (s.group_chat_id && sess?.cwd && s.topics[sess.cwd])
    return { chat_id: s.group_chat_id, message_thread_id: s.topics[sess.cwd].topic_id as number | undefined };
  return { chat_id: s.chat_id, message_thread_id: undefined };
}

async function ensureTopicFor(session_id: string | null | undefined) {
  const s = readState();
  const sess = session_id ? s.sessions[session_id] : null;
  // A General chat lives in General; giving its workspace a topic would put a
  // "general" project next to the real ones.
  if (!s.group_chat_id || sess?.general || !sess?.cwd || s.topics[sess.cwd]) return;
  try {
    const t = await telegram('createForumTopic', {
      chat_id: s.group_chat_id,
      name: sess.project || sess.cwd,
    });
    withState((st) => {
      // ponytail: two processes racing here can create an orphan topic; user deletes it
      if (!st.topics[sess.cwd!]) st.topics[sess.cwd!] = { topic_id: t.message_thread_id, name: t.name };
    });
  } catch (e: any) {
    console.error('createForumTopic:', e.message);
  }
}

// In group mode each session chain starts with a small header message —
// sessions stay visually separated inside the project topic. Returns the
// message id the next card should reply to (null → no chain root yet).
export async function threadRoot(session_id: string | null | undefined): Promise<number | null> {
  if (!session_id) return null;
  let s = readState();
  const sess = s.sessions[session_id];
  if (!sess) return null;
  if (sess.last_card_msg_id || !s.group_chat_id) return sess.last_card_msg_id;
  await ensureTopicFor(session_id);
  s = readState();
  const d = dest(s, session_id);
  if (!d.chat_id) return null;
  try {
    const msg = await telegram('sendRichMessage', {
      ...d,
      rich_message: {
        markdown: [
          sess.general
            ? `💬 **New chat** — *#${session_id.slice(0, 8)}*`
            : `▶️ **${sess.project || ''}** — session *#${session_id.slice(0, 8)}*`,
          sess.title || null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      disable_notification: true,
    });
    withState((st) => {
      const x = st.sessions[session_id];
      if (x && !x.last_card_msg_id) x.last_card_msg_id = msg.message_id;
      trackMsg(st, msg.message_id, session_id);
    });
    return msg.message_id;
  } catch {
    return null;
  }
}

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

// Self-contained principle: never truncate silently. Rich messages hold 32k;
// when a field genuinely exceeds its budget, cut WITH a visible marker.
const clip = (s: string | undefined, n: number) =>
  s && s.length > n ? s.slice(0, n) + "\n\n*✂️ trimmed — hit Telegram's size limit*" : s;

// Choices accept plain strings or {label, description}; stored normalized so
// the card can show the full description of every option.
export const normChoices = (choices?: ChoiceInput[]): Choice[] | undefined =>
  choices
    ?.map((c) => (typeof c === 'string' ? { label: c } : { label: c.label ?? '', description: c.description }))
    .slice(0, NUM.length);

// Card body in rich markdown. Dynamic fields (details, recommendation, plan…)
// are Claude's own markdown and pass through verbatim. Options are listed in
// the body with their descriptions — buttons below carry only the numbers —
// so the phone shows everything the terminal dialog would.
export function renderRequest(req: Req) {
  const L: string[] = [];
  const head = sessionHead(req.project, req.session_id);
  if (head) L.push(head);
  if (req.header) L.push(req.header);
  L.push(`## ${req.title}`);
  if (req.details) L.push(req.details);
  if (req.recommendation) L.push(`💡 **Recommendation:** ${req.recommendation}`);
  if (req.consequence) L.push(`➡️ **If approved:** ${req.consequence}`);
  if (req.prohibitions) L.push(`🚫 **Still not allowed:** ${req.prohibitions}`);
  if (req.choices?.length) {
    // Each option: heading line (number + label), description as an indented
    // quote block under it — visually separate, readable on a phone.
    const sel = req.status === 'answered' ? req.answer?.choice_index : undefined;
    L.push('---');
    // Options are accordions: label on the summary line, description folded.
    // The selected one re-renders expanded with a ✅.
    const fold = (head: string, body: string | undefined, open: boolean) =>
      body
        ? `<details${open ? ' open' : ''}><summary>${head}</summary>\n\n${body}\n</details>`
        : `**${head}**`; // same visual weight as accordion summaries
    const rows = req.choices.map((c, i) =>
      fold(`${NUM[i]} ${i === sel ? '✅ ' : ''}${c.label}`, c.description, i === sel)
    );
    // Free text is an option like in the Claude Code dialog. After answering
    // it only stays on the card when it WAS the chosen answer.
    if (acceptsFreeText(req)) {
      if (req.status === 'pending') rows.push(fold('✏️ Other', 'Reply to this message with your own answer.', false));
      else if (req.answer?.text) rows.push(fold('✏️ ✅ Other', req.answer.text, true));
    }
    L.push(rows.join('\n'));
  }
  if (req.links?.length) L.push(req.links.join('\n'));
  const meta: string[] = [];
  if (req.risk) meta.push(RISK_BADGE[req.risk] || req.risk);
  if (req.status === 'pending' && req.expires_at) meta.push(`expires in ${rel(req.expires_at)}`);
  if (req.version > 1) meta.push(`updated - v${req.version}`); // v1 is noise
  if (meta.length) {
    L.push('---');
    L.push(`*${meta.join(' - ')}*`);
  }
  return L.join('\n\n');
}

// Full question + answer of referenced requests, embedded in follow-up
// messages — Telegram's reply preview shows one truncated line, so the
// message itself must carry the information. >2 decisions fold into an
// accordion to stay compact.
export function renderDecisions(reqs: Req[]) {
  const rows = reqs
    .filter((r) => r && (r.answer || r.status !== 'pending'))
    .map((r) => {
      const a = r.answer;
      const ans =
        a?.choice ??
        a?.text ??
        (a?.decision === 'approve' ? 'Approved' : a?.decision === 'deny' ? 'Denied' : r.status);
      return `> ❓ ${r.title}\n> ✅ ${ans}`;
    });
  if (!rows.length) return null;
  return rows.length > 2
    ? `<details><summary>↩️ Decisions (${rows.length})</summary>\n\n${rows.join('\n\n')}\n</details>`
    : rows.join('\n\n');
}

export function resultBlock(r: ExecutionResult | undefined) {
  if (!r) return null;
  const rows: string[] = [];
  if (r.outcome) rows.push(`outcome: ${r.outcome}`);
  if (r.files_changed != null) rows.push(`files changed: ${r.files_changed}`);
  if (r.tests_passed != null || r.tests_failed != null)
    rows.push(`tests: ${r.tests_passed ?? 0} passed / ${r.tests_failed ?? 0} failed`);
  if (r.commit_message) rows.push(`commit: ${r.commit_message}`);
  if (r.duration_seconds != null) rows.push(`took ${r.duration_seconds}s`);
  return rows.length ? '```\n' + rows.join('\n') + '\n```' : null;
}

const acceptsFreeText = (r: Req) =>
  r.type === 'feedback' || (r.type === 'question' && r.allow_free_text !== false);

export function keyboardFor(req: Req, rules: State['rules']) {
  if (req.status !== 'pending') return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  if (req.type === 'approval') {
    rows.push([
      { text: '✅ Approve', callback_data: `a:${req.id}:${req.version}:approve` },
      { text: '❌ Deny', callback_data: `a:${req.id}:${req.version}:deny` },
    ]);
    if (req.risk === 'low' && req.rule_key && !rules[ruleId(req)])
      rows.push([{ text: '♾ Approve + always allow this', callback_data: `a:${req.id}:${req.version}:always` }]);
  } else if (req.choices?.length) {
    // labels + descriptions live in the card body; buttons are just numbers
    rows.push(req.choices.map((_, i) => ({ text: NUM[i], callback_data: `a:${req.id}:${req.version}:${i}` })));
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

const FREE_TEXT_HINT = '\n\n✍️ *Reply to this message to answer in free text.*';

const ruleId = (req: Req) => `${req.project || ''}::${req.rule_key}`;

// ---------------------------------------------------------------- domain
function newId(s: State) {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!s.requests[id]) return id;
  }
}

// Creates inside an open withState. Dedupe by external_id across all statuses:
// a re-create after restart must return the answered item, not re-notify.
export function makeRequest(s: State, type: ReqType, a: CreateArgs): { req: Req; dup: boolean } {
  if (a.external_id) {
    const dup = Object.values(s.requests).find((r) => r.external_id === a.external_id);
    if (dup) return { req: dup, dup: true };
  }
  const req: Req = {
    id: newId(s),
    type,
    version: 1,
    status: 'pending',
    processed: false,
    created_at: new Date().toISOString(),
    expires_at: a.expires_in_seconds ? new Date(Date.now() + a.expires_in_seconds * 1000).toISOString() : null,
    external_id: a.external_id,
    title: a.title,
    header: a.header,
    session_id: a.session_id,
    details: clip(a.details, 20000),
    choices: normChoices(a.choices),
    allow_free_text: a.allow_free_text,
    project: a.project,
    recommendation: a.recommendation,
    consequence: a.consequence,
    prohibitions: a.prohibitions,
    links: a.links,
    source_thread: a.source_thread,
    risk: a.risk,
    priority: a.priority,
    rule_key: a.rule_key,
  };
  s.requests[req.id] = req;
  return { req, dup: false };
}

export function expireIfDue(req: Req) {
  if (req.status === 'pending' && req.expires_at && Date.now() > Date.parse(req.expires_at)) {
    req.status = 'expired';
    return true;
  }
  return false;
}

// Reload from disk, expire if due, return a snapshot (or null).
export function touch(id: string): Req | null {
  let snap: Req | null = null;
  let flipped = false;
  withState((s) => {
    const r = s.requests[id];
    if (!r) return;
    flipped = expireIfDue(r);
    snap = structuredClone(r);
  });
  if (flipped) editAnswered(snap).catch(() => {});
  return snap;
}

export function publicView(req: Req, duplicate?: boolean) {
  return {
    request_id: req.id,
    external_id: req.external_id ?? null,
    type: req.type,
    title: req.title,
    status: req.status,
    version: req.version,
    processed: req.processed,
    answer: req.answer ?? null,
    execution: req.execution ?? null,
    created_at: req.created_at,
    expires_at: req.expires_at,
    ...(duplicate !== undefined ? { duplicate } : {}),
  };
}

// -------------------------------------------------- telegram side effects
// Sends the card into the right place (project topic or DM) chained onto the
// session's previous message. Returns {message_id, chat_id}.
export async function pushRequest(req: Req) {
  const threadTo = await threadRoot(req.session_id);
  const s = readState();
  const d = dest(s, req.session_id);
  // cards with choices show free text as the "Other" option row instead
  const hint = req.status === 'pending' && acceptsFreeText(req) && !req.choices?.length;
  const msg = await sendRich(d.chat_id, renderRequest(req) + (hint ? FREE_TEXT_HINT : ''), {
    message_thread_id: d.message_thread_id,
    disable_notification: req.priority === 'low',
    reply_markup: keyboardFor(req, s.rules),
    reply_parameters: threadTo ? { message_id: threadTo, allow_sending_without_reply: true } : undefined,
  });
  return { message_id: msg.message_id as number, chat_id: d.chat_id };
}

// Post-answer summary under the card. Choice marks live in the options list
// renderRequest draws (✅/○ per option); here only what's not shown there:
// approval decisions, free-text replies, expiry/withdrawal headlines.
export function answerBlock(req: Req) {
  const a = req.answer;
  const mark = (txt: string, sel: boolean) => (sel ? `✅ **${txt}**` : txt);
  if (req.status === 'expired') return '**⌛️ Expired**';
  if (req.status === 'cancelled') return `**🚫 Withdrawn${req.cancel_reason ? ` (${req.cancel_reason})` : ''}**`;
  if (!a) return '';
  if (a.decision)
    return (
      [mark('Approve', a.decision === 'approve'), mark('Deny', a.decision === 'deny')].join('\n') +
      (a.always_allow ? '\n*♾ always-allow rule saved*' : '') +
      (a.responded_via === 'auto' ? '\n*🤖 auto-approved*' : '')
    );
  // free-text replies on cards WITH choices are shown in the "Other" row
  if (a.text) return req.choices?.length ? '' : `✍️ *reply:* **${a.text}**`;
  return ''; // tapped choice — already marked in the options list
}

export async function editAnswered(req: Req | null) {
  const chat_id = req?.tg_chat_id ?? readState().chat_id;
  if (!req?.tg_message_id || !chat_id) return;
  const extra = answerBlock(req);
  await telegram('editMessageText', {
    chat_id,
    message_id: req.tg_message_id,
    rich_message: { markdown: renderRequest(req) + (extra ? `\n\n${extra}` : '') },
  }).catch((e) => console.error('edit failed:', e.message));
}

// -------------------------------------------------- incoming from telegram
export async function handleCallback(cq: TgCallback) {
  const ack = (text?: string, alert = false) =>
    telegram('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {});
  const [tag, id, ver, sel] = (cq.data || '').split(':');
  if (tag !== 'a') return ack('Unknown action');

  let out: { msg: string; alert?: boolean; edit?: Req } | null = null;
  withState((s) => {
    const req = s.requests[id];
    if (!req) return (out = { msg: 'Unknown item' });
    if (expireIfDue(req))
      return (out = { msg: 'This item has expired', alert: true, edit: structuredClone(req) });
    if (req.status !== 'pending') return (out = { msg: `Already ${req.status}` });
    if (Number(ver) !== req.version)
      return (out = {
        msg: 'Outdated card — this item was updated. Check the newer message.',
        alert: true,
      });

    let answer: Answer;
    if (sel === 'approve' || sel === 'deny') answer = { decision: sel };
    else if (sel === 'always') {
      s.rules[ruleId(req)] = { created_at: new Date().toISOString(), by: cq.from.id };
      answer = { decision: 'approve', always_allow: true };
    } else {
      const i = Number(sel);
      if (!req.choices?.[i]) return (out = { msg: 'Invalid choice' });
      answer = { choice: req.choices[i].label, choice_index: i };
    }
    req.status = 'answered';
    req.answer = {
      ...answer,
      responded_via: 'tap',
      at: new Date().toISOString(),
      version: req.version,
      by: cq.from.id,
    };
    out = { msg: 'Recorded ✅', edit: structuredClone(req) };
  });

  await ack(out!.msg, out!.alert);
  if (out!.edit) await editAnswered(out!.edit);
}

/** Callers must have passed the `authorize` gate in handleUpdate first. */
export async function handleMessage(m: TgMessage) {
  // In a group Telegram appends the bot's username to a tapped command
  // (/pending@my_bot). Strip it once here — every command below compares with
  // ===, so without this they all fall through to the "Commands: …" catch-all.
  const text = (m.text || '').trim().replace(/^(\/[A-Za-z_]+)@[A-Za-z0-9_]+/, '$1');
  // Textless updates are Telegram service messages (a pin, a join, a photo with
  // no caption). Nothing here works without text, and letting them fall through
  // to deliver() queued an EMPTY instruction for the session — Claude then read
  // "the user also sent: -" and had to guess. Drop them silently.
  if (!text) return;
  const s0 = readState();

  const fromGroup = s0.group_chat_id && m.chat.id === s0.group_chat_id;
  const isForumGroup = ['group', 'supergroup'].includes(m.chat.type || '');
  const say = (t: string, extra: Record<string, any> = {}) =>
    telegram('sendMessage', {
      chat_id: m.chat.id,
      message_thread_id: m.message_thread_id,
      text: t,
      parse_mode: 'HTML',
      ...extra,
    });

  // Bind/unbind a forum group: topic = project, sessions chain inside it.
  if (text === '/bindgroup') {
    if (!isForumGroup) return void say('Run /bindgroup inside the forum group you want to use.');
    if (!m.chat.is_forum)
      return void say(
        'This group has no Topics. Enable Topics in the group settings first, then /bindgroup again.'
      );
    withState((s) => {
      s.group_chat_id = m.chat.id;
      s.topics = {};
    });
    return void say(
      '🔗 Group bound. Each project gets its own topic here; sessions thread inside it. /unbindgroup reverts to DM.'
    );
  }
  if (text === '/unbindgroup') {
    withState((s) => {
      s.group_chat_id = null;
      s.topics = {};
    });
    return void say('Unbound — back to DM delivery.');
  }
  if (m.chat.id !== s0.chat_id && !fromGroup) return; // strangers' chats: ignore

  if (text.startsWith('/start')) return void say('Already connected ✅');
  if (text === '/pending') {
    const pend = sweepAll().filter((r) => r.status === 'pending');
    return void say(
      pend.length
        ? '<b>Waiting on you:</b>\n' + pend.map((r) => `• ${esc(r.title)} <i>(${r.type})</i>`).join('\n')
        : 'Nothing pending 🎉'
    );
  }
  if (text === '/config') {
    const c = s0.config;
    return void say(
      `<b>Bridge config</b>\n` +
        `mode: <b>${c.mode}</b> — ${c.mode === 'bot' ? 'questions come here first' : 'questions show in Claude Code first'}\n` +
        `timer: <b>${c.escalate_after_seconds}s</b> — unanswered Claude Code questions escalate here after this\n` +
        `escalation: <b>${c.escalate_permission}</b> — ask (consent card) | auto (just forward) | never\n` +
        `wake: <b>${c.phone_turns}</b> — plain text here starts a Claude turn in that project\n\n` +
        `Change: /bot · /claude · /timer 4m · /escalation ask|auto|never · /wake on|off\n` +
        `Keep the timer under 5m — that is when an idle Claude Code dialog auto-closes.`
    );
  }
  const setConfig = (patch: Partial<BridgeConfig>, msg: string) => {
    withState((s) => Object.assign(s.config, patch));
    return void say(msg);
  };
  if (text === '/bot' || text === '/claude' || text === '/terminal' || text.startsWith('/mode')) {
    let m = text === '/bot' ? 'bot' : text === '/claude' || text === '/terminal' ? 'claude' : text.split(/\s+/)[1];
    if (m === 'terminal') m = 'claude'; // legacy alias
    if (m !== 'bot' && m !== 'claude') return void say('Usage: /bot | /claude (or /mode bot|claude)');
    return setConfig(
      { mode: m },
      m === 'bot'
        ? '📱 Bot mode — plan approvals and questions come here first now. /claude to switch back.'
        : '🖥 Claude mode — questions show in Claude Code first; they escalate here after the timer.'
    );
  }
  if (text.startsWith('/timer')) {
    const m = /^\/timer\s+(\d+)\s*(m|s)?$/.exec(text);
    if (!m) return void say('Usage: /timer 90s or /timer 4m');
    const secs = Number(m[1]) * (m[2] === 'm' ? 60 : 1);
    return setConfig({ escalate_after_seconds: secs }, `⏱ Escalation timer set to ${secs}s.`);
  }
  if (text.startsWith('/wake')) {
    const v = text.split(/\s+/)[1];
    if (v !== 'on' && v !== 'off') return void say('Usage: /wake on | off');
    return setConfig(
      { phone_turns: v },
      v === 'on'
        ? '⚡️ Wake on — plain text here starts a Claude turn in that project (when nothing is running there).'
        : '💤 Wake off — plain text is queued for the session instead of starting a turn.'
    );
  }
  if (text.startsWith('/escalation')) {
    const v = text.split(/\s+/)[1];
    if (!['ask', 'auto', 'never'].includes(v)) return void say('Usage: /escalation ask | auto | never');
    return setConfig(
      { escalate_permission: v as BridgeConfig['escalate_permission'] },
      v === 'auto'
        ? '🤖 Unanswered terminal questions will be forwarded here automatically.'
        : v === 'ask'
          ? '🙋 You will get a consent card before questions are moved here.'
          : '🔕 No escalation — terminal questions stay in the terminal.'
    );
  }
  /**
   * General: a Claude chat that belongs to no project. Plain text continues the
   * current chat, a reply continues the chat that message came from, /new starts
   * a fresh one. It runs on the Phone-turn runner in the General workspace, so
   * the answer streams back here — never into a project topic, which is the
   * whole point (a General message used to be delivered to whatever session
   * started last on the machine).
   */
  const general = (sid: string | null) => {
    const first = text.replace(/^\/new\s*/, '').trim();
    if (!first) {
      withState((s) => (s.general_sid = null));
      return void say('🆕 New chat. Send your first message here.');
    }
    if (s0.config.phone_turns !== 'off' && cwdBusy(s0, GENERAL_DIR)) {
      const busy = sid ?? s0.general_sid;
      if (busy) {
        withState((s) => s.inbox.push({ session_id: busy, text: first, at: new Date().toISOString() }));
        return void say('📨 This chat is mid-answer — your message goes in as soon as it finishes.', {
          reply_to_message_id: m.message_id,
        });
      }
    }
    if (s0.config.phone_turns === 'off')
      return void say('General chats run headlessly, which /wake off disables. Send /wake on to use them.');
    // No "starting…" / "continuing…" ack: the answer itself is the reply, and a
    // fresh chat says so at the top of it. One question, one message back.
    spawnWake(generalPlan(s0, sid, first), first, say, m.message_id ?? null);
  };

  // Everything in General is a General chat: replying continues the chat that
  // message belongs to, anything else continues the current one. Nothing here
  // may fall through to session routing — that fall-through is the bug.
  if (fromGroup && !m.message_thread_id) {
    if (text.startsWith('/new')) return general(null);
    const isGeneral = (id: string | null | undefined) => (id && s0.sessions[id]?.general ? id : null);
    const replied = m.reply_to_message ? s0.tg_msgs[m.reply_to_message.message_id] : null;
    return general(isGeneral(replied) ?? isGeneral(s0.general_sid));
  }

  if (text.startsWith('/'))
    return void say(
      'Commands: /pending /config /bot /claude /wake /new /timer /escalation /bindgroup /unbindgroup'
    );

  // Anything the bot can't turn into an answer still has to go somewhere: the
  // human typed it for Claude, so it either starts a Phone turn (idle project)
  // or lands in a session inbox. Only a chat with no known session at all can
  // dead-end.
  const deliver = (sid: string | null) => {
    if (!sid)
      return void say(
        'No Claude session has spoken here yet, so there is nowhere to deliver that. Start Claude Code in a project and try again.'
      );
    const woken = maybeWake(sid, text, say, m.message_id ?? null);
    if (woken)
      return void say(`⚡️ Waking Claude in <b>${esc(woken)}</b> — the reply comes back here.`, {
        reply_to_message_id: m.message_id,
      });
    withState((s) => {
      s.inbox.push({ session_id: sid, text, at: new Date().toISOString() });
      // The user's own message becomes the thread head: Claude's eventual
      // reply must chain to WHAT IT ANSWERS, not to Claude's previous message.
      const sess = s.sessions[sid];
      if (sess && m.message_id) sess.last_card_msg_id = m.message_id;
      trackMsg(s, m.message_id ?? null, sid);
    });
    return void say(
      `📨 Delivered to <b>#${sid.slice(0, 8)}</b> — Claude reads it when it finishes its current step, or with your next prompt there.`,
      { reply_to_message_id: m.message_id }
    );
  };

  // Free-text answer: prefer explicit reply-to; else unambiguous single open item.
  let targetId: string | null = null;
  if (m.reply_to_message) {
    const replyMid = m.reply_to_message.message_id;
    const req = Object.values(s0.requests).find((r) => r.tg_message_id === replyMid);
    if (req && req.status === 'pending' && !acceptsFreeText(req))
      return void say('That one needs a button tap, not text.');
    if (req && req.status === 'pending') {
      targetId = req.id;
    } else {
      // Not an open question — route the reply into the originating session.
      // Untracked message (a service notice, or one sent before tracking):
      // fall back to the newest session rather than refusing the text.
      return deliver(req?.session_id ?? s0.tg_msgs[replyMid] ?? newestSession(s0));
    }
  } else if (fromGroup && m.message_thread_id) {
    // Plain text inside a project topic → newest session of that project. A
    // topic we don't know (General has no thread id and never lands here) is
    // still the Admin talking to the bridge: fall back rather than ignore.
    const entry = Object.entries(s0.topics).find(([, t]) => t.topic_id === m.message_thread_id);
    if (!entry) return deliver(newestSession(s0));
    const best = newestSession(s0, entry[0]);
    if (!best)
      return void say(
        `No Claude session has run in <b>${esc(basename(entry[0]))}</b> yet. Start Claude Code there, or write in another topic.`
      );
    return deliver(best);
  } else {
    const open = sweepAll().filter((r) => r.status === 'pending' && acceptsFreeText(r));
    if (open.length === 1) targetId = open[0].id;
    else if (open.length > 1)
      return void say('Several items are open — reply directly to the message you are answering.');
    // Nothing to answer: treat it as an instruction for the newest session,
    // matching what typing inside a project topic already does.
    else return deliver(newestSession(s0));
  }

  let out: { msg: string; edit?: Req } | null = null;
  withState((s) => {
    const req = s.requests[targetId!];
    if (expireIfDue(req)) return (out = { msg: '⌛️ Too late — that item expired.', edit: structuredClone(req) });
    if (req.status !== 'pending') return (out = { msg: `Already ${req.status}.` });
    req.status = 'answered';
    req.answer = {
      text,
      responded_via: 'text',
      at: new Date().toISOString(),
      version: req.version,
      by: m.from!.id,
    };
    out = { msg: 'Recorded ✅', edit: structuredClone(req) };
  });
  await say(out!.msg, { reply_to_message_id: m.message_id }).catch(() => say(out!.msg));
  if (out!.edit) await editAnswered(out!.edit);
}

// Expire everything due, return snapshots of all requests.
export function sweepAll(): Req[] {
  const flipped: Req[] = [];
  let snaps: Req[] = [];
  withState((s) => {
    for (const r of Object.values(s.requests)) if (expireIfDue(r)) flipped.push(structuredClone(r));
    snaps = Object.values(structuredClone(s.requests));
  });
  for (const r of flipped) editAnswered(r).catch(() => {});
  return snaps.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------- MCP tools
const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const NOT_BOUND =
  'No Telegram chat is bound yet. Ask the human to open the bot in Telegram and send /start, then retry.';

// Create flow shared by question/approval/feedback:
// reserve record → send telegram message → store message id.
async function createAndPush(type: ReqType, a: CreateArgs, decorate?: (req: Req, s: State) => void) {
  if (!isConfigured()) return err(NOT_CONFIGURED);
  const s0 = readState();
  if (!s0.chat_id) return err(NOT_BOUND);
  const { req, dup } = withState((s) => {
    const r = makeRequest(s, type, a);
    if (!r.dup) {
      r.req.session_id ??= sessionIdForCwd(s); // MCP calls: newest session in this cwd
      r.req.project ??= basename(process.cwd());
    }
    if (!r.dup && decorate) decorate(r.req, s);
    return { req: structuredClone(r.req), dup: r.dup };
  });
  if (dup) return json(publicView(req, true));
  if (req.status === 'pending') {
    try {
      const sent = await pushRequest(req);
      recordCardMessage(req.id, sent.message_id, sent.chat_id);
    } catch (e: any) {
      withState((s) => delete s.requests[req.id]);
      return err(`Telegram send failed: ${e.message}`);
    }
  }
  return json(publicView(req, false));
}

const choiceSchema = z
  .array(
    z.union([
      z.string().max(60),
      z.object({
        label: z.string().max(60).describe('Short label, shown bold and on the number button row.'),
        description: z
          .string()
          .max(1500)
          .optional()
          .describe('Full explanation of the option, shown in the card body (accordion).'),
      }),
    ])
  )
  .max(4)
  .describe('Up to 4 one-tap choices, each optionally with a description shown on the card.');

const metaFields = {
  external_id: z.string().describe('Your stable ID for this item. Duplicate creates return the existing item.'),
  details: z.string().optional().describe('Longer context shown under the title.'),
  project: z.string().optional().describe('Groups items, e.g. repo name.'),
  links: z.array(z.string()).optional().describe('URLs back to authoritative context (PR, doc).'),
  source_thread: z.string().optional().describe('Identifier of the originating conversation.'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('low = silent notification.'),
  expires_in_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('After this the item can no longer be answered.'),
};

export function registerTools(server: McpServer) {
  server.registerTool(
    'how_to_use',
    { description: 'Usage guide and contract for this Telegram decision inbox.' },
    async () => text(HOW_TO_USE)
  );

  server.registerTool(
    'ask_question',
    {
      description:
        'Ask the human a question on Telegram, with up to 4 one-tap choices and/or free-text reply. Returns request_id; poll get_response.',
      inputSchema: {
        ...metaFields,
        question: z.string().describe('The question, short and concrete.'),
        header: z
          .string()
          .max(24)
          .optional()
          .describe('Short topic chip shown above the question, e.g. "Auth method".'),
        choices: choiceSchema.optional(),
        allow_free_text: z.boolean().optional().describe('Default true.'),
        recommendation: z.string().optional().describe('Your recommended choice, plain language.'),
      },
    },
    async (a) => createAndPush('question', { ...a, title: a.question })
  );

  server.registerTool(
    'request_approval',
    {
      description:
        'Ask the human for a yes/no decision on Telegram (Approve / Deny buttons). Use BEFORE irreversible or consequential actions. Returns request_id; poll get_response.',
      inputSchema: {
        ...metaFields,
        title: z.string().describe('What needs approval, short and concrete.'),
        recommendation: z.string().optional().describe('Your recommended action.'),
        consequence: z.string().optional().describe('What practically happens if approved.'),
        prohibitions: z.string().optional().describe('What remains NOT allowed even after approval.'),
        risk: z
          .enum(['low', 'medium', 'high', 'critical'])
          .describe('Declare honestly. Only low-risk items are eligible for always-allow rules.'),
        rule_key: z
          .string()
          .optional()
          .describe(
            'risk=low only: stable key for this class of approval (e.g. deploy-staging). Enables "always allow"; future low-risk approvals with the same project+rule_key auto-approve.'
          ),
      },
    },
    async (a) => {
      if (a.rule_key && a.risk !== 'low')
        return err(
          'rule_key is only allowed with risk=low. Consequential approvals must stay individual decisions.'
        );
      return createAndPush('approval', a, (req, s) => {
        if (req.risk === 'low' && req.rule_key && s.rules[ruleId(req)]) {
          req.status = 'answered';
          req.answer = {
            decision: 'approve',
            responded_via: 'auto',
            rule: ruleId(req),
            at: new Date().toISOString(),
            version: req.version,
          };
          // FYI trail, silent — audited but doesn't wake anyone.
          sendRich(s.chat_id, renderRequest(req) + '\n\n**✅ Auto-approved 🤖** *(always-allow rule)*', {
            disable_notification: true,
          }).catch(() => {});
        }
      });
    }
  );

  server.registerTool(
    'request_feedback',
    {
      description: 'Ask the human for open-ended feedback on something you produced. Free-text reply.',
      inputSchema: {
        ...metaFields,
        title: z.string().describe('What you want feedback on.'),
      },
    },
    async (a) => createAndPush('feedback', a)
  );

  server.registerTool(
    'notify_user',
    {
      description:
        'Fire-and-forget update to the human on Telegram. No answer expected. Attach result when reporting finished work.',
      inputSchema: {
        external_id: metaFields.external_id.optional(),
        title: z.string().describe('Headline of the update.'),
        message: z.string().optional().describe('Body text.'),
        project: metaFields.project,
        links: metaFields.links,
        priority: metaFields.priority,
        result: z
          .object({
            outcome: z.enum(['success', 'failure', 'partial']),
            files_changed: z.number().int().optional(),
            tests_passed: z.number().int().optional(),
            tests_failed: z.number().int().optional(),
            commit_message: z.string().optional(),
            duration_seconds: z.number().optional(),
          })
          .optional()
          .describe('Structured outcome rendered as a result card.'),
      },
    },
    async (a) => {
      if (!isConfigured()) return err(NOT_CONFIGURED);
      const s0 = readState();
      if (!s0.chat_id) return err(NOT_BOUND);
      if (a.external_id) {
        const dup = Object.values(s0.requests).find((r) => r.external_id === a.external_id);
        if (dup) return json(publicView(dup, true));
      }
      const sid = sessionIdForCwd(s0);
      const project = a.project ?? basename(process.cwd());
      const body = [
        `📣 ${sessionHead(project, sid)}`,
        `## ${a.title}`,
        a.message ? clip(a.message, 20000) : null,
        resultBlock(a.result),
        a.links?.length ? a.links.join('\n') : null,
      ]
        .filter(Boolean)
        .join('\n\n');
      let mid: number | null = null;
      let sentChat: number | null = null;
      try {
        const threadTo = await threadRoot(sid);
        const s1 = readState();
        const d = dest(s1, sid);
        sentChat = d.chat_id;
        mid = (
          await sendRich(d.chat_id, body, {
            message_thread_id: d.message_thread_id,
            disable_notification: a.priority === 'low',
            reply_parameters: threadTo ? { message_id: threadTo, allow_sending_without_reply: true } : undefined,
          })
        ).message_id;
      } catch (e: any) {
        return err(`Telegram send failed: ${e.message}`);
      }
      const req = withState((s) => {
        const r: Req = {
          id: newId(s),
          type: 'notify',
          version: 1,
          status: 'delivered',
          processed: true,
          external_id: a.external_id,
          title: a.title,
          project,
          session_id: sid,
          tg_message_id: mid,
          tg_chat_id: sentChat,
          created_at: new Date().toISOString(),
        };
        s.requests[r.id] = r;
        if (sid && s.sessions[sid]) s.sessions[sid].last_card_msg_id = mid;
        trackMsg(s, mid, sid);
        return r;
      });
      return json(publicView(req, false));
    }
  );

  server.registerTool(
    'get_response',
    {
      description:
        'Poll a request for the human answer. wait_seconds long-polls up to 60s. Responses are never consumed by reads.',
      inputSchema: {
        request_id: z.string(),
        wait_seconds: z.number().min(0).max(60).optional().describe('Long-poll duration, default 0.'),
      },
    },
    async ({ request_id, wait_seconds = 0 }) => {
      const deadline = Date.now() + Math.min(wait_seconds, 60) * 1000;
      for (;;) {
        const req = touch(request_id);
        if (!req) return err(`Unknown request_id: ${request_id}`);
        if (req.status !== 'pending' || Date.now() >= deadline) return json(publicView(req));
        await sleep(1000);
      }
    }
  );

  server.registerTool('list_pending', { description: 'Everything still waiting on the human.' }, async () =>
    json(
      sweepAll()
        .filter((r) => r.status === 'pending')
        .map((r) => publicView(r))
    )
  );

  server.registerTool(
    'list_unprocessed',
    {
      description:
        'Answered/expired/cancelled items you have not yet marked processed. Call after a restart to recover.',
    },
    async () =>
      json(
        sweepAll()
          .filter((r) => r.status !== 'pending' && r.type !== 'notify' && !r.processed)
          .map((r) => publicView(r))
      )
  );

  server.registerTool(
    'update_request',
    {
      description:
        'Revise a pending item. Bumps version: taps on the outdated card are rejected, so update instead of re-creating.',
      inputSchema: {
        request_id: z.string(),
        title: z.string().optional(),
        details: z.string().optional(),
        choices: choiceSchema.optional(),
        recommendation: z.string().optional(),
        consequence: z.string().optional(),
        prohibitions: z.string().optional(),
        risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        links: z.array(z.string()).optional(),
        expires_in_seconds: z.number().int().positive().optional(),
      },
    },
    async (a) => {
      const out = withState((s) => {
        const req = s.requests[a.request_id];
        if (!req) return { error: `Unknown request_id: ${a.request_id}` };
        expireIfDue(req);
        if (req.status !== 'pending')
          return { error: `Cannot update: status is ${req.status}. Create a new request.` };
        for (const k of [
          'title',
          'details',
          'recommendation',
          'consequence',
          'prohibitions',
          'risk',
          'priority',
          'links',
        ] as const)
          if (a[k] !== undefined) (req as any)[k] = a[k];
        if (a.choices !== undefined) req.choices = normChoices(a.choices);
        if (a.expires_in_seconds !== undefined)
          req.expires_at = new Date(Date.now() + a.expires_in_seconds * 1000).toISOString();
        req.version++;
        return {
          req: structuredClone(req),
          rules: structuredClone(s.rules),
          chat_id: req.tg_chat_id ?? s.chat_id,
        };
      });
      if (out.error) return err(out.error);
      const { req, rules, chat_id } = out as { req: Req; rules: State['rules']; chat_id: number | null };
      const body =
        renderRequest(req) +
        '\n\n✏️ *updated*' +
        (acceptsFreeText(req) && !req.choices?.length ? FREE_TEXT_HINT : '');
      await telegram('editMessageText', {
        chat_id,
        message_id: req.tg_message_id,
        rich_message: { markdown: body },
        reply_markup: keyboardFor(req, rules),
      }).catch(async () => {
        // Original message gone or too old — push a fresh card instead.
        const sent = await pushRequest(req).catch(() => null);
        if (sent) recordCardMessage(req.id, sent.message_id, sent.chat_id);
      });
      return json(publicView(req));
    }
  );

  server.registerTool(
    'cancel_request',
    {
      description: 'Withdraw a pending item that no longer needs a decision.',
      inputSchema: {
        request_id: z.string(),
        reason: z.enum(['cancelled', 'resolved_elsewhere']),
      },
    },
    async ({ request_id, reason }) => {
      const out = withState((s) => {
        const req = s.requests[request_id];
        if (!req) return { error: `Unknown request_id: ${request_id}` };
        if (req.status !== 'pending') return { req: structuredClone(req) }; // idempotent-ish: nothing to cancel
        req.status = 'cancelled';
        req.cancel_reason = reason;
        return { req: structuredClone(req), edit: true };
      });
      if (out.error) return err(out.error);
      if (out.edit) await editAnswered(out.req!);
      return json(publicView(out.req!));
    }
  );

  server.registerTool(
    'mark_processed',
    {
      description: 'Idempotent acknowledgment that you consumed the answer and acted on it.',
      inputSchema: { request_id: z.string() },
    },
    async ({ request_id }) => {
      const req = withState((s) => {
        const r = s.requests[request_id];
        if (r) r.processed = true;
        return r ? structuredClone(r) : null;
      });
      return req ? json(publicView(req)) : err(`Unknown request_id: ${request_id}`);
    }
  );

  server.registerTool(
    'report_execution',
    {
      description:
        'Post the execution outcome of a decision back to the human (accepted / rejected / completed / failed). Call after acting on an answer.',
      inputSchema: {
        request_id: z.string().optional(),
        request_ids: z
          .array(z.string())
          .optional()
          .describe('All decisions this execution acted on — each is quoted in full on the card.'),
        external_id: z.string().optional(),
        status: z.enum(['accepted', 'rejected', 'completed', 'failed']),
        summary: z.string().optional().describe('One or two sentences: what you did.'),
        result: z
          .object({
            outcome: z.enum(['success', 'failure', 'partial']),
            files_changed: z.number().int().optional(),
            tests_passed: z.number().int().optional(),
            tests_failed: z.number().int().optional(),
            commit_message: z.string().optional(),
            duration_seconds: z.number().optional(),
          })
          .optional(),
      },
    },
    async (a) => {
      if (!isConfigured()) return err(NOT_CONFIGURED);
      const s0 = readState();
      if (!s0.chat_id) return err(NOT_BOUND);
      const targets = [a.request_id, ...(a.request_ids ?? [])].filter(Boolean) as string[];
      const reqs = [...new Set(targets)].map((id) => s0.requests[id]).filter(Boolean);
      if (a.external_id) {
        const byExt = Object.values(s0.requests).find((r) => r.external_id === a.external_id);
        if (byExt && !reqs.includes(byExt)) reqs.unshift(byExt);
      }
      const req = reqs[0] ?? null;
      const icon = { accepted: '👍', rejected: '🙅', completed: '✅', failed: '❌' }[a.status];
      const sid = req?.session_id ?? sessionIdForCwd(s0);
      const body = [
        `${icon} ${sessionHead(basename(process.cwd()), sid)}`,
        `## Execution: ${a.status}${req && reqs.length === 1 ? ` — ${req.title}` : ''}`,
        renderDecisions(reqs),
        a.summary ? clip(a.summary, 20000) : null,
        resultBlock(a.result),
      ]
        .filter(Boolean)
        .join('\n\n');
      // reply to the original card when known, else to the session thread
      let mid: number | null = null;
      try {
        await threadRoot(sid);
        const s1 = readState();
        const d = dest(s1, sid);
        const chat_id = req?.tg_chat_id ?? d.chat_id;
        const threadTo = req?.tg_message_id ?? (sid ? s1.sessions[sid]?.last_card_msg_id : null);
        mid = (
          await sendRich(chat_id, body, {
            message_thread_id: chat_id === s1.group_chat_id ? d.message_thread_id : undefined,
            reply_parameters: threadTo ? { message_id: threadTo, allow_sending_without_reply: true } : undefined,
            disable_notification: a.status !== 'failed',
          })
        ).message_id;
      } catch (e: any) {
        return err(`Telegram send failed: ${e.message}`);
      }
      withState((s) => {
        if (req && s.requests[req.id])
          s.requests[req.id].execution = {
            status: a.status,
            summary: a.summary,
            result: a.result,
            at: new Date().toISOString(),
          };
        if (sid && s.sessions[sid]) s.sessions[sid].last_card_msg_id = mid;
        trackMsg(s, mid, sid);
      });
      return json({ ok: true, request_id: req?.id ?? null });
    }
  );
}

export const HOW_TO_USE = `# claude-code-telegram-interface MCP — remote decision inbox via Telegram

Mirrors your questions, approvals and updates to the human's Telegram bot and returns their one-tap or free-text answers. Telegram is never the source of truth: revalidate answers against current repository/task state before executing, then post the outcome back with report_execution.

## Contract
- Pass external_id (your stable ID) on every create — duplicate creates return the existing item instead of double-notifying.
- Items are versioned. update_request bumps the version; taps on outdated cards are rejected, so update instead of re-creating.
- Responses are never consumed by reads. After acting on an answer: report_execution, then mark_processed (idempotent). After a restart: list_unprocessed.
- cancel_request when a decision is no longer needed; set expires_in_seconds so stale approvals can't fire later.
- report_execution: pass request_ids with EVERY decision you acted on — the card quotes each question and chosen answer in full, so the human never depends on Telegram's truncated reply preview.
- risk is honest: high = irreversible or production-facing. Never downgrade risk for a faster answer. rule_key (risk=low only) lets the human tap "always allow" — future identical low-risk approvals auto-approve.

## When to ping
- BEFORE deploys, migrations, data deletion, spending money, force-pushes: request_approval.
- Fork you can't resolve from context: ask_question with 2-4 concrete choices + your recommendation.
- Milestone finished: notify_user with result (files_changed, tests, commit_message).
- Do NOT ping for things you can decide yourself. Batch small questions. While waiting, keep working on independent tasks; poll get_response (wait_seconds up to 60), never re-send.

## Human side
The human binds the chat by sending /start to the bot. They answer via inline buttons or by replying to the question message with text. /pending shows their open items.`;

// ---------------------------------------------------------------- selftest
export async function selftest() {
  let msgN = 100;
  let topicN = 700;
  const sent: { method: string; params: any }[] = [];
  telegram = async (method, params: any = {}) => {
    sent.push({ method, params });
    if (method === 'sendMessage' || method === 'sendRichMessage') return { message_id: msgN++ };
    if (method === 'createForumTopic') return { message_thread_id: topicN++, name: params.name };
    return {};
  };
  // Selftest fixtures are deliberately partial — these helpers keep Req honest
  // for real code while letting a test build only the fields it exercises.
  const asReq = (o: Partial<Req>) => o as Req;
  delete process.env.TELEGRAM_USER_ID; // the gate tests must not inherit a real override

  // ---- fresh install: config + the Admin gate ----
  const unbound = readState();
  assert.equal(authorize(unbound, 5, 'hello'), 'drop'); // only /start can claim a bot
  assert.equal(authorize(unbound, undefined, '/start'), 'drop');
  assert.equal(authorize(unbound, 5, '/start'), 'bind'); // nothing declared → trust on first use

  writeConfigFile({ admin_id: 42, pairing_code: null });
  assert.equal(authorize(unbound, 42, '/start'), 'bind');
  assert.equal(authorize(unbound, 43, '/start'), 'drop');

  // The state `--setup <token> <admin-id>` leaves: an Admin is declared but no
  // chat exists yet. Regression: keying bound-ness off user_id made this
  // return 'admin', so the very /start that binds was dropped downstream.
  writeConfigFile({ admin_id: 2031365585, pairing_code: null });
  const declaredNotBound = { ...readState(), chat_id: null, user_id: 2031365585 };
  assert.equal(authorize(declaredNotBound, 2031365585, '/start'), 'bind');
  assert.equal(authorize(declaredNotBound, 5, '/start'), 'drop');

  writeConfigFile({ admin_id: null, pairing_code: 'c0ffee' });
  assert.equal(authorize(unbound, 7, '/start c0ffee'), 'bind');
  assert.equal(authorize(unbound, 7, '/start nope'), 'drop');
  assert.equal(authorize(unbound, 7, '/start'), 'drop'); // a code was issued: it is required

  // binding consumes the Pairing code and records the Admin durably
  await handleUpdate({ message: { chat: { id: 1 }, from: { id: 7 }, message_id: 1, text: '/start c0ffee' } });
  assert.equal(readState().user_id, 7);
  assert.equal(readState().chat_id, 1);
  assert.equal(readConfigFile().pairing_code, null); // single use
  assert.equal(readConfigFile().admin_id, 7);
  assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600); // token file stays owner-only
  assert.equal(authorize(readState(), 7, 'hi'), 'admin');
  assert.equal(authorize(readState(), 8, '/start c0ffee'), 'drop'); // bound: a spent code opens nothing

  // env beats config.json for the declared Admin
  process.env.TELEGRAM_USER_ID = '99';
  assert.equal(declaredAdmin(), 99);
  delete process.env.TELEGRAM_USER_ID;
  assert.equal(declaredAdmin(), 7);

  withState((s) => {
    s.chat_id = 1;
    s.user_id = 1;
  });

  // dedupe by external_id
  const r1 = withState((s) =>
    structuredClone(makeRequest(s, 'question', { external_id: 'x1', title: 'pick', choices: ['a', 'b'] }))
  );
  const r2 = withState((s) => structuredClone(makeRequest(s, 'question', { external_id: 'x1', title: 'pick' })));
  assert.equal(r2.dup, true);
  assert.equal(r2.req.id, r1.req.id);

  // stale version rejected, current version accepted
  await handleCallback({ id: 'cb1', from: { id: 1 }, data: `a:${r1.req.id}:99:0` });
  assert.equal(touch(r1.req.id)!.status, 'pending');
  await handleCallback({ id: 'cb2', from: { id: 1 }, data: `a:${r1.req.id}:1:1` });
  const answered = touch(r1.req.id)!;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer!.choice, 'b');

  // the Admin gate drops a stranger's tap; the Admin's tap goes through.
  // Both go via handleUpdate — that is where the single gate lives.
  const r3 = withState((s) =>
    structuredClone(makeRequest(s, 'approval', { external_id: 'x2', title: 'deploy?', risk: 'high' }))
  );
  await handleUpdate({ callback_query: { id: 'cb3', from: { id: 666 }, data: `a:${r3.req.id}:1:approve` } });
  assert.equal(touch(r3.req.id)!.status, 'pending');
  await handleUpdate({ callback_query: { id: 'cb4', from: { id: 1 }, data: `a:${r3.req.id}:1:approve` } });
  assert.equal(touch(r3.req.id)!.answer!.decision, 'approve');

  // …and a stranger's message never reaches the handlers
  const before = readState().inbox.length;
  await handleUpdate({
    message: { chat: { id: 1 }, from: { id: 666 }, message_id: 52, text: '/timer 9s' },
  });
  assert.equal(readState().config.escalate_after_seconds, 60); // untouched default
  assert.equal(readState().inbox.length, before);

  // expiry
  const r4 = withState((s) => {
    const r = makeRequest(s, 'question', { external_id: 'x3', title: 'late' });
    r.req.expires_at = new Date(Date.now() - 1000).toISOString();
    return structuredClone(r);
  });
  assert.equal(touch(r4.req.id)!.status, 'expired');

  // free text routes to the single open free-text item
  const r5 = withState((s) =>
    structuredClone(makeRequest(s, 'feedback', { external_id: 'x4', title: 'thoughts?' }))
  );
  withState((s) => (s.requests[r5.req.id].tg_message_id = 50));
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 51, text: 'looks good' });
  const fed = touch(r5.req.id)!;
  assert.equal(fed.status, 'answered');
  assert.equal(fed.answer!.text, 'looks good');

  // answered card: options stay in the body with ✅/○ marks + descriptions
  const rr = renderRequest(
    asReq({
      type: 'question',
      status: 'answered',
      title: 'T',
      version: 1,
      choices: normChoices(['Alpha', { label: 'Beta', description: 'why beta' }]),
      answer: { choice: 'Beta', choice_index: 1 },
    })
  );
  assert.ok(rr.includes('**1️⃣ Alpha**')); // no description → bold row, same size as accordions
  assert.ok(rr.includes('<details open><summary>2️⃣ ✅ Beta</summary>\n\nwhy beta\n</details>'));
  assert.ok(!rr.includes('Other')); // chosen by button → Other row disappears
  assert.ok(!rr.includes('v1')); // version marker only from v2 up
  const rrPending = renderRequest(
    asReq({ type: 'question', status: 'pending', title: 'T', version: 1, choices: normChoices(['Alpha']) })
  );
  assert.ok(rrPending.includes('<details><summary>✏️ Other</summary>\n\nReply to this message'));
  const rrText = renderRequest(
    asReq({
      type: 'question',
      status: 'answered',
      title: 'T',
      version: 1,
      choices: normChoices(['Alpha']),
      answer: { text: 'my own words' },
    })
  );
  assert.ok(rrText.includes('**1️⃣ Alpha**'));
  assert.ok(rrText.includes('<details open><summary>✏️ ✅ Other</summary>\n\nmy own words\n</details>'));
  assert.equal(
    answerBlock(asReq({ status: 'answered', choices: normChoices(['A']), answer: { text: 'x' } })),
    '' // shown in the Other row, not duplicated below
  );
  // pending card: bold numbered options, number-only buttons
  const kb = keyboardFor(
    asReq({ id: 'x', version: 1, status: 'pending', type: 'question', choices: normChoices(['a', 'b']) }),
    {}
  );
  assert.deepEqual(
    kb!.inline_keyboard[0].map((b) => b.text),
    ['1️⃣', '2️⃣']
  );
  assert.equal(
    answerBlock(asReq({ status: 'answered', answer: { text: 'custom words' } })),
    '✍️ *reply:* **custom words**'
  );
  assert.equal(answerBlock(asReq({ status: 'answered', answer: { decision: 'deny' } })), 'Approve\n✅ **Deny**');
  // cards go out as rich messages carrying markdown verbatim
  await pushRequest(
    asReq({ id: 'zz', type: 'question', status: 'pending', version: 1, title: 'T', details: '**md** stays' })
  );
  const rich = sent.filter((c) => c.method === 'sendRichMessage');
  assert.ok(rich.length >= 1);
  assert.ok(rich.every((c) => typeof c.params.rich_message.markdown === 'string'));
  assert.ok(rich.at(-1)!.params.rich_message.markdown.includes('**md** stays'));

  // session threading: second card replies to the first, msgs are tracked
  withState((s) => ensureSession(s, 'sess-test-1', '/tmp/projX'));
  const t1 = withState((s) =>
    structuredClone(makeRequest(s, 'question', { title: 'first card', session_id: 'sess-test-1' }))
  );
  const sent1 = await pushRequest(t1.req);
  const mid1 = sent1.message_id;
  recordCardMessage(t1.req.id, mid1, sent1.chat_id);
  assert.equal(readState().sessions['sess-test-1'].last_card_msg_id, mid1);
  const t2 = withState((s) =>
    structuredClone(makeRequest(s, 'question', { title: 'second card', session_id: 'sess-test-1' }))
  );
  await pushRequest(t2.req);
  const threaded = sent.filter((c) => c.method === 'sendRichMessage').at(-1)!;
  assert.equal(threaded.params.reply_parameters?.message_id, mid1);
  assert.ok(threaded.params.rich_message.markdown.includes('#sess-tes'));

  // session name rides under the id line on every card
  assert.equal(sessionHead('projX', 'sess-test-1'), 'projX - #sess-tes');
  withState((s) => (s.sessions['sess-test-1'].title = 'E2E check'));
  assert.equal(sessionHead('projX', 'sess-test-1'), 'projX - #sess-tes\n*E2E check*');
  assert.ok(
    renderRequest(
      asReq({ type: 'question', status: 'pending', title: 'T', project: 'projX', session_id: 'sess-test-1' })
    ).startsWith('projX - #sess-tes\n*E2E check*\n\n')
  );

  // group mode: project topic created once, session header roots the chain
  withState((s) => (s.group_chat_id = -100999));
  withState((s) => ensureSession(s, 'sess-grp-1', '/tmp/projY'));
  const g1 = withState((s) =>
    structuredClone(
      makeRequest(s, 'question', { title: 'grp card', session_id: 'sess-grp-1', project: 'projY' })
    )
  );
  const gsent = await pushRequest(g1.req);
  recordCardMessage(g1.req.id, gsent.message_id, gsent.chat_id);
  assert.equal(gsent.chat_id, -100999);
  const topic = readState().topics['/tmp/projY'];
  assert.ok(topic?.topic_id >= 700);
  const gCard = sent.filter((c) => c.method === 'sendRichMessage').at(-1)!;
  const gHeader = sent.filter((c) => c.method === 'sendRichMessage').at(-2)!;
  assert.equal(gCard.params.message_thread_id, topic.topic_id);
  assert.ok(gHeader.params.rich_message.markdown.includes('session *#sess-grp'));
  assert.equal(gCard.params.reply_parameters?.message_id, readState().requests[g1.req.id].tg_message_id! - 1); // chained onto the session header
  // plain text inside the topic routes to the newest session of that project
  await handleMessage({
    chat: { id: -100999, type: 'supergroup' },
    from: { id: 1 },
    message_id: 800,
    message_thread_id: topic.topic_id,
    text: 'group topic instruction',
  });
  const gInbox = readState().inbox;
  assert.equal(gInbox.at(-1)?.session_id, 'sess-grp-1');
  assert.equal(gInbox.at(-1)?.text, 'group topic instruction');
  withState((s) => {
    s.inbox = [];
    s.group_chat_id = null;
    s.topics = {};
  });

  // reply to a non-pending card routes into the session inbox
  withState((s) => {
    s.requests[t1.req.id].status = 'answered';
    s.requests[t1.req.id].answer = { text: 'done', version: 1 };
  });
  await handleMessage({
    chat: { id: 1 },
    from: { id: 1 },
    message_id: 700,
    reply_to_message: { message_id: mid1 },
    text: 'also update the readme please',
  });
  const inbox = readState().inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].session_id, 'sess-test-1');
  assert.equal(inbox[0].text, 'also update the readme please');
  // the human's own message becomes the chain head: Claude's reply must chain
  // onto what it answers, not onto Claude's previous message
  assert.equal(readState().sessions['sess-test-1'].last_card_msg_id, 700);
  withState((s) => (s.inbox = []));

  // A reply to an UNTRACKED message (service notice, or one sent before this
  // chat tracked ids) must still reach a session — it used to be refused with
  // "not something I can accept an answer for", stranding the text.
  await handleMessage({
    chat: { id: 1 },
    from: { id: 1 },
    message_id: 701,
    reply_to_message: { message_id: 99999 },
    text: 'reply to an untracked message',
  });
  assert.equal(readState().inbox.at(-1)?.text, 'reply to an untracked message');
  assert.ok(readState().inbox.at(-1)?.session_id); // newest session, whichever it is

  // Several questions open → a bare text is ambiguous and must NOT be guessed
  // at; the human is told to reply to the one they mean.
  assert.ok(sweepAll().filter((r) => r.status === 'pending' && acceptsFreeText(r)).length > 1);
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 702, text: 'ambiguous' });
  assert.ok(sent.at(-1)!.params.text.startsWith('Several items are open'));
  assert.equal(readState().inbox.at(-1)?.text, 'reply to an untracked message'); // nothing queued

  // With nothing open, plain text is an instruction, not an error — same as
  // typing inside a project topic.
  withState((s) => {
    for (const r of Object.values(s.requests)) if (r.status === 'pending') r.status = 'cancelled';
  });
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 703, text: 'what is 2+2?' });
  assert.equal(readState().inbox.at(-1)?.text, 'what is 2+2?');
  withState((s) => (s.inbox = []));

  // decisions embed: ≤2 visible quotes, >2 fold into an accordion
  const d1 = renderDecisions([asReq({ title: 'Cap?', status: 'answered', answer: { choice: '300/min' } })]);
  assert.equal(d1, '> ❓ Cap?\n> ✅ 300/min');
  const d3 = renderDecisions([
    asReq({ title: 'A?', status: 'answered', answer: { choice: 'x' } }),
    asReq({ title: 'B?', status: 'answered', answer: { text: 'custom' } }),
    asReq({ title: 'C?', status: 'answered', answer: { decision: 'approve' } }),
  ]);
  assert.ok(d3!.startsWith('<details><summary>↩️ Decisions (3)</summary>'));
  assert.ok(d3!.includes('> ❓ B?\n> ✅ custom'));
  assert.ok(d3!.includes('> ✅ Approved'));
  assert.equal(renderDecisions([asReq({ title: 'P', status: 'pending' })]), null);

  // ---- Phone turns: the wake gate, the seeded session, the stream parser ----
  const { parseWakeEvent, resultLine, failureLine, replyMessage } = await import('./wake.ts');

  // One answer = one message: banner, text and trailer travel together. Three
  // messages for one reply is what the chat used to send.
  const oneMsg = replyMessage(true, 'the answer', '*✅ done · 7s*');
  assert.ok(oneMsg.startsWith('🆕 *New chat*\n\n💬 the answer'));
  assert.ok(oneMsg.endsWith('*✅ done · 7s*'));
  assert.ok(!replyMessage(false, 'the answer', '*✅ done*').includes('New chat')); // banner is first-reply only
  assert.equal(replyMessage(false, 'mid-turn block'), '💬 mid-turn block'); // no trailer yet
  assert.equal(replyMessage(false, null, '*✅ done*'), '*✅ done*'); // trailer alone stays alone

  withState((s) => ensureSession(s, 'sess-busy-1', '/tmp/projBusy'));
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), false); // idle: never touched
  withState((s) => setBusy(s, 'sess-busy-1', process.pid)); // our own pid is alive
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), true);
  withState((s) => setBusy(s, 'sess-busy-1', 999_999)); // dead pid → not Busy
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), false);
  withState((s) => {
    // no pid recorded → the staleness window decides
    const x = s.sessions['sess-busy-1'];
    x.busy_pid = null;
    x.busy_since = Date.now();
  });
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), true);
  withState((s) => (s.sessions['sess-busy-1'].busy_since = Date.now() - 7 * 3_600_000));
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), false); // 7h old: stale, not Busy
  withState((s) => clearBusy(s, 'sess-busy-1'));
  assert.equal(cwdBusy(readState(), '/tmp/projBusy'), false);

  assert.equal(shouldWake(readState(), null), null); // no session
  assert.equal(shouldWake(readState(), 'sess-test-1')?.cwd, '/tmp/projX'); // idle → wake
  withState((s) => setBusy(s, 'sess-test-1', process.pid));
  assert.equal(shouldWake(readState(), 'sess-test-1'), null); // Busy project
  withState((s) => clearBusy(s, 'sess-test-1'));
  withState((s) => (s.config.phone_turns = 'off'));
  assert.equal(shouldWake(readState(), 'sess-test-1'), null); // /wake off
  withState((s) => (s.config.phone_turns = 'on'));
  const wplan = shouldWake(readState(), 'sess-test-1')!;
  assert.equal(wplan.origin_sid, 'sess-test-1');
  assert.equal(wplan.transcript_path, null); // none recorded for this fixture

  // The Phone turn's session inherits the chain so its messages thread with the
  // origin's, and starts Busy so a second message can't spawn a second turn.
  // whatever the origin's head is right now — a card, or the human's own
  // message once they wrote into the thread (deliver() moves it)
  const originHead = readState().sessions['sess-test-1'].last_card_msg_id;
  withState((s) => seedWakeSession(s, wplan, 'sess-wake-1', 999_998));
  const seeded = readState().sessions['sess-wake-1'];
  assert.equal(seeded.cwd, '/tmp/projX');
  assert.equal(seeded.title, 'E2E check'); // inherited name
  assert.ok(originHead);
  assert.equal(seeded.last_card_msg_id, originHead); // inherited thread head
  assert.equal(seeded.busy_pid, 999_998);
  assert.ok(seeded.busy_since);
  assert.equal(cwdBusy(readState(), '/tmp/projX'), false); // above any real pid: dead
  withState((s) => (s.sessions['sess-wake-1'].busy_pid = process.pid));
  assert.equal(shouldWake(readState(), 'sess-test-1'), null); // the turn itself blocks re-entry
  withState((s) => delete s.sessions['sess-wake-1']);

  assert.equal(parseWakeEvent('not json'), null);
  // init reveals whether the run bills real money (API key) or draws on a
  // claude.ai subscription ('none') — the trailer's $ hinges on it
  assert.deepEqual(parseWakeEvent(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' })), {
    kind: 'init',
    metered: false,
  });
  assert.deepEqual(
    parseWakeEvent(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' })),
    { kind: 'init', metered: true }
  );
  assert.equal(parseWakeEvent(JSON.stringify({ type: 'system', subtype: 'hook_started' })), null);
  assert.deepEqual(
    parseWakeEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' hi ' }] } })),
    { kind: 'text', text: 'hi' }
  );
  // tool_use-only blocks are machinery, not something to forward to a phone
  assert.equal(
    parseWakeEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } })),
    null
  );
  const wres = parseWakeEvent(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.1234,
      duration_ms: 6700,
      permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }],
    })
  ) as any;
  assert.equal(wres.ok, true);
  assert.equal(wres.seconds, 7);
  // $ appears only on metered (API-key) runs — on subscription auth the number
  // is Claude Code's internal estimate, not a charge, so showing it would lie
  assert.equal(resultLine(wres, true), '*✅ done · 7s · $0.12*\n*🚫 not allowed without you: Bash*');
  assert.equal(resultLine(wres), '*✅ done · 7s*\n*🚫 not allowed without you: Bash*');
  const wfail = parseWakeEvent(JSON.stringify({ type: 'result', subtype: 'error_max_budget', is_error: true })) as any;
  assert.equal(wfail.ok, false);
  assert.equal(resultLine(wfail), '*❌ stopped*');

  // Every failure mode says what happened and what to do — nothing sends the
  // human back to the machine to find out why their message went nowhere.
  for (const [why, must] of [
    ['ENOENT', 'not on PATH'],
    ['hit the 1800s limit', 'hit the 1800s limit'],
    ['claude exited with code 1', 'exited with code 1'],
  ] as const) {
    const line = failureLine('projX', why);
    assert.ok(line.includes(must), `failureLine(${why})`);
    assert.ok(line.includes('projX') && line.includes('Send it again to retry'), `failureLine(${why}) tail`);
  }
  assert.ok(failureLine('projX', 'boom', ' stack trace ').includes('```\nstack trace\n```'));

  // ---- Turn mirror: the walk, the pointer, the error card ----
  const { newTurnText, mirrorTurn, errorCard } = await import('./hook.ts');
  const L = (o: unknown) => JSON.stringify(o);
  const txt = (text: string, extra: Record<string, unknown> = {}) =>
    L({ type: 'assistant', ...extra, message: { content: [{ type: 'text', text }] } });
  const tl = [
    L({ type: 'user', message: { content: 'old turn, already mirrored' } }),
    txt('Older answer.'),
    L({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>\nfix the parser' } }),
    L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    txt(' Looking at it. '),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    txt('subagent chatter', { isSidechain: true }),
    txt('Fixed it.'),
  ];
  const walk = newTurnText(tl, null);
  // no pointer → the current turn only: the prompt the human typed (wrappers
  // skipped), Claude's text blocks in order, no sidechain, no earlier turn
  assert.equal(walk.prompt, 'fix the parser');
  assert.deepEqual(walk.texts, ['Looking at it.', 'Fixed it.']);
  assert.equal(walk.nextLine, tl.length);
  assert.deepEqual(newTurnText(tl, 99), walk); // pointer past the end (compaction) → same reset
  const mid = newTurnText(tl, 6); // resumed after the card that already showed the first half
  assert.equal(mid.prompt, null); // the prompt went out with that card
  assert.deepEqual(mid.texts, ['Fixed it.']);
  assert.deepEqual(newTurnText(tl, walk.nextLine).texts, []); // nothing is ever sent twice
  // a user message that is only a wrapper still bounds the turn, with no prompt line
  const wrapped = [...tl, L({ type: 'user', message: { content: '<command-name>/x</command-name>' } }), txt('After.')];
  assert.deepEqual(newTurnText(wrapped, null), { prompt: null, texts: ['After.'], nextLine: wrapped.length });

  // Round trip: one message per turn, and the pointer only moves that far.
  const tPath = join(tmpdir(), `ta-mirror-${process.pid}.jsonl`);
  writeFileSync(tPath, tl.join('\n'));
  withState((s) => ensureSession(s, 'sess-mirror-1', '/tmp/projM'));
  const preMirror = sent.length;
  await mirrorTurn('sess-mirror-1', tPath, { silent: false });
  const mirrored = sent.slice(preMirror).filter((c) => c.method === 'sendRichMessage');
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0].params.rich_message.markdown.startsWith('👤 fix the parser'));
  assert.ok(mirrored[0].params.rich_message.markdown.includes('Looking at it.\n\nFixed it.'));
  assert.equal(readState().sessions['sess-mirror-1'].mirrored_line, tl.length);
  const after1 = sent.length;
  await mirrorTurn('sess-mirror-1', tPath, { silent: true }); // same file again
  assert.equal(sent.slice(after1).filter((c) => c.method === 'sendRichMessage').length, 0);
  rmSync(tPath, { force: true });

  // An error card names what Claude was DOING, not just what came back — the
  // output alone is unreadable on a phone.
  const bashCard = errorCard({
    tool_name: 'Bash',
    tool_input: { description: 'Check which auth the headless runs used', command: 'claude auth status' },
    tool_response: 'Exit code 1',
  });
  assert.ok(bashCard.includes('Check which auth the headless runs used'));
  assert.ok(bashCard.includes('```\nclaude auth status\n```'));
  assert.ok(bashCard.indexOf('Check which auth') < bashCard.indexOf('Exit code 1')); // intent first
  const readCard = errorCard({ tool_name: 'Read', tool_input: { file_path: '/nope' }, error: 'ENOENT' });
  assert.ok(readCard.includes('```json\n{"file_path":"/nope"}\n```') && readCard.includes('ENOENT'));
  assert.ok(errorCard({ tool_name: 'X' }).includes('unknown error')); // no input, still a card
  assert.ok(errorCard({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(2000) } }).includes('✂️ trimmed'));

  // ---- General: a Claude chat that belongs to no project ----
  // The reported bug: a message in General was delivered to whatever session
  // started last on the machine and answered inside that project's topic.
  const gGroup = { chat: { id: -100999, type: 'supergroup' as const }, from: { id: 1 } };
  withState((s) => {
    s.group_chat_id = -100999;
    s.topics['/tmp/projY'] = { topic_id: 777, name: 'projY' };
    s.sessions['sess-gen-1'] = {
      cwd: GENERAL_DIR,
      project: null,
      general: true,
      title: 'first chat',
      started_at: '2026-08-12T00:00:00Z',
      last_card_msg_id: 500,
      last_error_at: 0,
    };
    s.general_sid = 'sess-gen-1';
  });
  // a General chat answers in General (no thread id), never in a project topic
  assert.deepEqual(dest(readState(), 'sess-gen-1'), { chat_id: -100999, message_thread_id: undefined });
  assert.equal(dest(readState(), 'sess-grp-1').message_thread_id !== undefined, true); // projects still get theirs

  // plain text in General continues the current chat — SELFTEST blocks the spawn,
  // so what is asserted is the routing decision, not a real Claude
  const genPlan = generalPlan(readState(), readState().general_sid!, 'carry on');
  assert.equal(genPlan.cwd, GENERAL_DIR);
  assert.equal(genPlan.general, true);
  assert.equal(genPlan.origin_sid, 'sess-gen-1'); // resumes that chat
  assert.equal(genPlan.title, 'first chat'); // keeps the chat's name
  const freshPlan = generalPlan(readState(), null, 'a brand new question about typescript');
  assert.equal(freshPlan.origin_sid, ''); // nothing to resume → new chat
  assert.equal(freshPlan.transcript_path, null);
  assert.equal(freshPlan.title, 'a brand new question about typescript');

  // a tapped command in a group arrives as /new@thebot — same command
  await handleMessage({ ...gGroup, message_id: 909, text: '/pending@some_bot' });
  assert.ok(!sent.at(-1)!.params.text.startsWith('Commands:'));

  // /new forgets the current chat instead of continuing it
  await handleMessage({ ...gGroup, message_id: 910, text: '/new' });
  assert.equal(readState().general_sid, null);
  const preGeneral = readState().inbox.length;
  // a General message must never be queued into a project session
  await handleMessage({ ...gGroup, message_id: 911, text: 'hello claude' });
  assert.equal(readState().inbox.length, preGeneral);
  withState((s) => (s.general_sid = 'sess-gen-1'));

  // busy General workspace → queued to that chat, not spawned twice
  withState((s) => setBusy(s, 'sess-gen-1', process.pid));
  await handleMessage({ ...gGroup, message_id: 912, text: 'one more thing' });
  assert.equal(readState().inbox.at(-1)?.session_id, 'sess-gen-1');
  assert.equal(readState().inbox.at(-1)?.text, 'one more thing');
  withState((s) => {
    clearBusy(s, 'sess-gen-1');
    s.inbox = [];
  });

  // /wake off disables the runner General chats need — say so, never go silent
  withState((s) => (s.config.phone_turns = 'off'));
  await handleMessage({ ...gGroup, message_id: 913, text: 'anyone there?' });
  assert.ok(sent.at(-1)!.params.text.includes('/wake on'));
  assert.equal(readState().inbox.length, 0);
  withState((s) => {
    s.config.phone_turns = 'on';
    s.group_chat_id = null;
    s.topics = {};
    delete s.sessions['sess-gen-1'];
    s.general_sid = null;
  });

  // A Stop hand-over is never destructive: a cancelled continuation (terminal
  // prompt submitted in the same moment) must not swallow the message.
  const { drainInbox } = await import('./hook.ts');
  withState((s) => s.inbox.push({ session_id: 'sess-inbox-1', text: 'from the phone', at: 'now' }));
  const stop1 = drainInbox('sess-inbox-1', 'stop');
  assert.deepEqual(stop1.map((x) => x.text), ['from the phone']);
  assert.ok(readState().inbox.find((x) => x.session_id === 'sess-inbox-1')?.delivered_at); // kept, stamped
  assert.deepEqual(drainInbox('sess-inbox-1', 'stop'), []); // continuation ran → cleared, no loop
  assert.equal(readState().inbox.filter((x) => x.session_id === 'sess-inbox-1').length, 0);
  // the cancelled case: stamped by Stop, still queued when the next prompt lands
  withState((s) => s.inbox.push({ session_id: 'sess-inbox-1', text: 'lost one', at: 'now' }));
  drainInbox('sess-inbox-1', 'stop');
  assert.deepEqual(drainInbox('sess-inbox-1', 'prompt').map((x) => x.text), ['lost one']);
  assert.equal(readState().inbox.filter((x) => x.session_id === 'sess-inbox-1').length, 0);

  // A delivered phone message becomes the thread head, so Claude's reply
  // chains to it — not to Claude's own previous message.
  const mirrorMid = Number(Object.entries(readState().tg_msgs).find(([, v]) => v === 'sess-mirror-1')![0]);
  await handleMessage({
    chat: { id: 1 },
    from: { id: 1 },
    message_id: 91,
    reply_to_message: { message_id: mirrorMid },
    text: 'thread head test',
  });
  assert.ok(readState().inbox.some((x) => x.session_id === 'sess-mirror-1' && x.text === 'thread head test'));
  assert.equal(readState().sessions['sess-mirror-1'].last_card_msg_id, 91);
  withState((s) => (s.inbox = s.inbox.filter((x) => x.session_id !== 'sess-mirror-1')));
  // and a woken turn chains to the waking message
  withState((s) => seedWakeSession(s, wplan, 'sess-wake-2', null, 92));
  assert.equal(readState().sessions['sess-wake-2'].last_card_msg_id, 92);
  withState((s) => delete s.sessions['sess-wake-2']);

  // A pinned-message / join service update carries no text: it must queue
  // nothing and answer nothing (it used to deliver an empty instruction).
  const preService = sent.length;
  const inboxBefore = readState().inbox.length;
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 90 });
  assert.equal(sent.length, preService);
  assert.equal(readState().inbox.length, inboxBefore);

  // config commands
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 67, text: '/wake off' });
  assert.equal(readState().config.phone_turns, 'off');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 68, text: '/wake nonsense' });
  assert.equal(readState().config.phone_turns, 'off'); // unchanged
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 69, text: '/wake on' });
  assert.equal(readState().config.phone_turns, 'on');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 60, text: '/timer 4m' });
  assert.equal(readState().config.escalate_after_seconds, 240);
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 61, text: '/escalation auto' });
  assert.equal(readState().config.escalate_permission, 'auto');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 62, text: '/bot' });
  assert.equal(readState().config.mode, 'bot');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 63, text: '/claude' });
  assert.equal(readState().config.mode, 'claude');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 65, text: '/mode bot' });
  assert.equal(readState().config.mode, 'bot');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 66, text: '/terminal' }); // legacy alias
  assert.equal(readState().config.mode, 'claude');
  await handleMessage({ chat: { id: 1 }, from: { id: 1 }, message_id: 64, text: '/timer nonsense' });
  assert.equal(readState().config.escalate_after_seconds, 240); // unchanged

  // unprocessed sweep + mark_processed idempotence
  const unproc = sweepAll().filter((r) => r.status !== 'pending' && !r.processed);
  assert.ok(unproc.length >= 3);
  withState((s) => (s.requests[r5.req.id].processed = true));
  withState((s) => (s.requests[r5.req.id].processed = true));

  rmSync(dirname(STATE_FILE), { recursive: true, force: true });
  console.error(`selftest OK (${sent.length} telegram calls stubbed)`);
}

/**
 * Rules Claude must follow for the bridge to work, shipped with the server so
 * every install carries them — they used to live in the operator's own
 * CLAUDE.md, which a plugin install cannot provide.
 */
export const SERVER_INSTRUCTIONS = `This server bridges you to the human's Telegram bot.

- If an AskUserQuestion or plan dialog auto-continues without the human answering, call
  list_unprocessed immediately: they may have answered the same question on Telegram.
  Use that answer and call mark_processed.
- If nothing is there and the question still matters, re-ask it with ask_question and poll
  get_response — the human prefers Telegram when away from the terminal.
- Read how_to_use before your first create call for the full contract.`;

/** Boots the MCP stdio server. Entry-point wiring lives in main.ts. */
export function createServer() {
  const server = new McpServer(
    { name: 'claude-code-telegram-interface', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}
