/**
 * Claude Code hook → Telegram bridge. Two routing modes, stored in state.json
 * (config.mode, editable from Telegram via /mode):
 *
 * claude (default):
 *   Plan approvals and questions show in Claude Code immediately. A detached
 *   watcher checks the session transcript; if still unanswered after
 *   config.escalate_after_seconds it escalates to Telegram — with a consent
 *   card (escalate_permission=ask), silently (auto), or not at all (never).
 *   Consent/auto flips mode to bot and mirrors the current question as an
 *   answerable card. The open terminal dialog itself can't be answered
 *   remotely; it auto-closes after the harness askUserQuestionTimeout, and
 *   Claude then picks the Telegram answer up via list_unprocessed.
 *
 * bot:
 *   PreToolUse on ExitPlanMode/AskUserQuestion holds the tool call, sends the
 *   card to Telegram, waits up to TG_HOOK_WAIT_SECONDS, feeds the answer back.
 *   No answer → card withdrawn, normal terminal dialog appears.
 *
 * Notification events always ping Telegram (fire-and-forget).
 *
 * Watcher mode: <entrypoint> hook --watch <payload.json> (spawned detached by
 * PreToolUse).
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  readState,
  withState,
  makeRequest,
  pushRequest,
  editAnswered,
  touch,
  pollLoop,
  sendRich,
  ensureSession,
  recordCardMessage,
  trackMsg,
  dest,
  threadRoot,
  setBusy,
  clearBusy,
  selfArgv,
  STATE_FILE,
  type Req,
  type CreateArgs,
  type State,
} from './server.ts';

const WAIT = Number(process.env.TG_HOOK_WAIT_SECONDS || 170);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Claude Code hook payload fields this bridge reads. */
interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { plan?: string; questions?: Question[]; [k: string]: unknown };
  tool_response?: unknown;
  error?: unknown;
  message?: string;
  transcript_path?: string;
  session_id?: string;
  cwd?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

// ---------------------------------------------------------------- shared
function out(decision: Record<string, unknown>): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision },
    })
  );
  process.exit(0);
}

async function create(type: 'question' | 'approval' | 'feedback', a: CreateArgs) {
  const { req } = withState((s) => structuredClone(makeRequest(s, type, a)));
  const sent = await pushRequest(req);
  recordCardMessage(req.id, sent.message_id, sent.chat_id);
  return req;
}

// Send a session-threaded rich message (context, errors, service notes) into
// the right place (project topic or DM) and advance the thread head.
export async function sendThreaded(
  session_id: string | undefined,
  markdown: string,
  extra: Record<string, unknown> = {}
) {
  const threadTo = await threadRoot(session_id);
  const s = readState();
  const d = dest(s, session_id);
  const msg = await sendRich(d.chat_id, markdown, {
    message_thread_id: d.message_thread_id,
    ...extra,
    reply_parameters: threadTo ? { message_id: threadTo, allow_sending_without_reply: true } : undefined,
  });
  if (session_id)
    withState((st) => {
      if (st.sessions[session_id]) st.sessions[session_id].last_card_msg_id = msg.message_id;
      trackMsg(st, msg.message_id, session_id);
    });
  return msg.message_id;
}

/**
 * Hand this session's queued Telegram messages over.
 *
 * `prompt` (UserPromptSubmit) empties the queue: additionalContext is part of
 * the prompt Claude is about to receive, so delivery is certain.
 *
 * `stop` cannot be certain — a blocking Stop only reaches Claude if the harness
 * runs the continuation, and a terminal prompt submitted in the same moment
 * cancels it. Deleting there lost the message outright (observed live). So Stop
 * stamps instead of deleting, and drops what an earlier Stop stamped: surviving
 * a whole continuation is the proof Claude saw it. Anything still stamped when
 * the next prompt arrives is exactly the cancelled case, and `prompt` re-delivers it.
 */
export function drainInbox(session_id: string | undefined, mode: 'prompt' | 'stop' = 'prompt') {
  return withState((s) => {
    if (mode === 'prompt') {
      const mine = s.inbox.filter((x) => x.session_id === session_id);
      s.inbox = s.inbox.filter((x) => x.session_id !== session_id);
      return mine;
    }
    s.inbox = s.inbox.filter((x) => x.session_id !== session_id || !x.delivered_at);
    const fresh = s.inbox.filter((x) => x.session_id === session_id);
    const now = new Date().toISOString();
    for (const x of fresh) x.delivered_at = now;
    return structuredClone(fresh);
  });
}

/** `aborted` is a wait outcome, never a stored status — hence its own type. */
type WaitResult = Req | { status: 'aborted' } | null;

async function waitAnswer(id: string, deadline: number, abort?: () => boolean): Promise<WaitResult> {
  while (Date.now() < deadline) {
    const r = touch(id);
    if (!r || r.status !== 'pending') return r;
    if (abort?.()) return { status: 'aborted' };
    await sleep(1500);
  }
  return touch(id);
}

/**
 * A Phone turn has no terminal to fall back to, so its hooks must route to
 * Telegram whatever the stored mode says. Env-scoped for the life of that one
 * headless process — never written into state.config.mode. (The escalation
 * watcher does flip stored mode, deliberately, at its consent step; doing that
 * here would reroute every other session because one phone turn ran.)
 */
const FORCED_BOT = Boolean(process.env.CLAUDE_CODE_TELEGRAM_INTERFACE_FORCE_BOT);

const routingMode = (s: State) => (FORCED_BOT ? 'bot' : s.config.mode);

// While the bot holds a prompt, a manual /claude switch hands it back to Claude
// Code — except in a Phone turn, where there is no dialog to hand it to.
const switchedToClaude = () => !FORCED_BOT && readState().config.mode === 'claude';

function cancel(id: string, reason: string) {
  let snap: Req | null = null;
  withState((s) => {
    const r = s.requests[id];
    if (r && r.status === 'pending') {
      r.status = 'cancelled';
      r.cancel_reason = reason;
      snap = structuredClone(r);
    }
  });
  if (snap) editAnswered(snap).catch(() => {});
}

const consume = (id: string) =>
  withState((s) => {
    const r = s.requests[id];
    if (r) r.processed = true;
  });

// One AskUserQuestion question → card args. Options go through with their
// full descriptions — the card body shows them, buttons carry just numbers.
// i/total number the cards when Claude asks several questions at once.
function questionCardArgs(
  q: Question,
  project: string | undefined,
  expires_in_seconds: number,
  i = 0,
  total = 1
): CreateArgs {
  const options = (q.options || []).map((o) => ({ label: o.label, description: o.description }));
  return {
    title: q.question,
    header: [q.header, total > 1 ? `question ${i + 1} of ${total}` : null].filter(Boolean).join(' - '),
    details: q.multiSelect
      ? [
          'Multi-select: reply with comma-separated choices instead of tapping.',
          '',
          ...options.map((o, n) => `### ${n + 1}. ${o.label}${o.description ? `\n> ${o.description}` : ''}`),
        ].join('\n')
      : undefined,
    choices: q.multiSelect ? undefined : options,
    project,
    expires_in_seconds,
  };
}

// ---------------------------------------------------------------- errors
const clipTo = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '\n… ✂️ trimmed' : t);

/**
 * A tool failure a phone reader can act on: what Claude was trying to do (the
 * tool's own description and input) above what came back. The output alone is
 * unreadable away from the terminal — an exit code with no command is noise.
 */
export function errorCard(input: Pick<HookInput, 'tool_name' | 'tool_input' | 'tool_response' | 'error'>) {
  const ti = input.tool_input || {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  // Bash and friends carry a human description + the command itself; anything
  // else falls back to its raw input, which is still better than nothing.
  const intent = [str(ti.description), str(ti.command) && '```\n' + clipTo(str(ti.command), 1000) + '\n```'];
  if (!intent.some(Boolean)) {
    const json = JSON.stringify(ti);
    if (json && json !== '{}') intent.push('```json\n' + clipTo(json, 1000) + '\n```');
  }
  const raw = String(
    typeof input.error === 'string'
      ? input.error
      : JSON.stringify(input.tool_response ?? input.error ?? 'unknown error')
  );
  return [
    `**Tool error:** \`${input.tool_name || '?'}\``,
    ...intent.filter(Boolean),
    '```\n' + clipTo(raw, 3000) + '\n```',
  ].join('\n\n');
}

// ---------------------------------------------------------------- transcript
// Claude Code transcripts are JSONL; tool_use / tool_result blocks live in
// message.content arrays. We only need "is this tool call answered yet".
function lastToolUseId(transcriptPath: string | undefined, toolName: string | undefined): string | null {
  try {
    const lines = readFileSync(transcriptPath!, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const c = JSON.parse(lines[i])?.message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) if (b.type === 'tool_use' && b.name === toolName) return b.id;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * A human name for the session, read off the transcript: Claude Code's own
 * summary line when the transcript has one, else the first real user prompt.
 * Set once per session — the name is what the session was started to do, so
 * it stays stable across the whole Telegram chain.
 */
export function sessionTitleFrom(transcriptPath: string | undefined): string | null {
  const line = firstRealLine;
  const clip = (t: string) => (t.length > 60 ? t.slice(0, 60).trimEnd() + '…' : t);
  try {
    let firstPrompt: string | undefined;
    for (const l of readFileSync(transcriptPath!, 'utf8').split('\n')) {
      if (!l) continue;
      let m: any;
      try {
        m = JSON.parse(l);
      } catch {
        continue;
      }
      const summary = line(m?.summary);
      if (summary) return clip(summary);
      if (!firstPrompt && m?.type === 'user') {
        const c = m.message?.content;
        firstPrompt = line(typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b.type === 'text')?.text : null);
      }
    }
    return firstPrompt ? clip(firstPrompt) : null;
  } catch {
    return null;
  }
}

/** Fills the session name once, from whatever the transcript already holds. */
function noteSessionTitle(session_id: string | undefined, transcriptPath: string | undefined) {
  if (!session_id || !transcriptPath || readState().sessions[session_id]?.title) return;
  const title = sessionTitleFrom(transcriptPath);
  if (title)
    withState((s) => {
      const sess = s.sessions[session_id];
      if (sess && !sess.title) sess.title = title;
    });
}

/** First line the human actually typed — skips system-reminder / command wrappers. */
const firstRealLine = (t: unknown) =>
  typeof t === 'string'
    ? t
        .split('\n')
        .map((x) => x.trim())
        .find((x) => x && !x.startsWith('<'))
    : undefined;

// tool_result lines are `type: user` too, and subagents write sidechain lines —
// neither is the human talking.
function humanMessage(m: any): boolean {
  if (m?.type !== 'user' || m.isSidechain) return false;
  const c = m.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b.type === 'tool_result') && c.some((b) => b.type === 'text');
}

const humanLine = (m: any) => {
  const c = m?.message?.content;
  return firstRealLine(typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b.type === 'text')?.text : null);
};

/**
 * The conversation text Telegram has not seen yet: everything from line `from`
 * (a session's `mirrored_line`) to the end of the transcript. `from` null — or
 * past the end, which a compacted transcript can cause — restarts at the
 * current turn, i.e. the last real human message.
 */
export function newTurnText(lines: string[], from: number | null | undefined) {
  const parse = (l: string) => {
    try {
      return l ? JSON.parse(l) : null;
    } catch {
      return null;
    }
  };
  let start = typeof from === 'number' && from >= 0 && from <= lines.length ? from : -1;
  if (start < 0) {
    start = 0;
    for (let i = lines.length - 1; i >= 0; i--)
      if (humanMessage(parse(lines[i]))) {
        start = i;
        break;
      }
  }
  let prompt: string | undefined;
  const texts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = parse(lines[i]);
    if (!m || m.isSidechain) continue;
    if (humanMessage(m)) {
      prompt = humanLine(m) ?? prompt; // last one wins — it started this turn
      continue;
    }
    const c = m.message?.content;
    if (m.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) if (b.type === 'text' && b.text?.trim()) texts.push(b.text.trim());
  }
  return { prompt: prompt ?? null, texts, nextLine: lines.length };
}

/**
 * Send the turn's new conversation text into the session's Telegram chain and
 * advance the session's `mirrored_line`.
 *
 * `mirrored_line` is the ONLY record of what Telegram has already seen, and it
 * moves only after a send succeeds. Every path that emits transcript text goes
 * through here — the pre-card context below and the Stop mirror share it, which
 * is what keeps a card's context from being repeated when the turn ends.
 */
export async function mirrorTurn(
  session_id: string | undefined,
  transcriptPath: string | undefined,
  { silent }: { silent: boolean }
) {
  if (!session_id || !transcriptPath) return;
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return;
  }
  const { prompt, texts, nextLine } = newTurnText(lines, readState().sessions[session_id]?.mirrored_line);
  if (texts.length) {
    const body = texts.join('\n\n');
    // One rich message, Claude's markdown verbatim (sendRichMessage caps at 32k).
    await sendThreaded(
      session_id,
      (prompt ? `👤 ${prompt}\n\n` : '') +
        '💬 *Claude:*\n\n' +
        (body.length > 30000
          ? "*✂️ earlier context trimmed — hit Telegram's size limit*\n\n" + body.slice(-30000)
          : body),
      { disable_notification: silent }
    );
  }
  withState((s) => {
    const sess = s.sessions[session_id];
    if (sess) sess.mirrored_line = nextLine;
  });
}

function toolResultArrived(transcriptPath: string, toolUseId: string | null) {
  if (!toolUseId) return false;
  try {
    return readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .some((l) => {
        if (!l.includes(toolUseId) || !l.includes('tool_result')) return false;
        try {
          const c = JSON.parse(l)?.message?.content;
          return Array.isArray(c) && c.some((b: any) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- watcher
// Runs detached while the terminal dialog is open. Escalates to Telegram if
// the human doesn't answer in time.
export async function watch(payloadPath: string) {
  const p: HookInput = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const toolUseId = lastToolUseId(p.transcript_path, p.tool_name);
  const project = p.cwd ? basename(p.cwd) : undefined;
  withState((s) => ensureSession(s, p.session_id, p.cwd));
  noteSessionTitle(p.session_id, p.transcript_path);

  const answered = () => toolResultArrived(p.transcript_path!, toolUseId);

  pollLoop(); // we may be the only process able to receive Telegram taps/commands

  // Wait out the timer — re-reading config each tick so live changes apply:
  // a manual /bot switch pulls the open question over immediately.
  const startedAt = Date.now();
  let pulled = false;
  for (;;) {
    if (answered()) return cleanup();
    const c = readState().config;
    if (c.mode === 'bot') {
      pulled = true;
      break;
    }
    if (Date.now() - startedAt >= c.escalate_after_seconds * 1000) break;
    await sleep(10_000);
  }
  const cfg = readState().config;
  if (!pulled && (answered() || cfg.escalate_permission === 'never')) return cleanup();

  if (!pulled && cfg.escalate_permission === 'ask') {
    const consent = await create('question', {
      title: 'Claude is waiting on you in the terminal. Move questions to Telegram?',
      details: `${project ? project + ' — ' : ''}a ${
        p.tool_name === 'ExitPlanMode' ? 'plan approval' : 'question'
      } has been unanswered for ${Math.round(cfg.escalate_after_seconds / 60) || 1}+ min.`,
      choices: ['📱 Yes — ask me here', '🖥 No — I answer in Claude Code'],
      allow_free_text: false,
      project,
      session_id: p.session_id,
      expires_in_seconds: 1800,
    });
    const res = await waitAnswer(consent.id, Date.now() + 1800 * 1000);
    consume(consent.id);
    if (res?.status !== 'answered' || res.answer!.choice_index !== 0) {
      return cleanup(); // declined or expired — stay in claude mode
    }
  }

  if (!pulled) withState((s) => (s.config.mode = 'bot'));

  if (p.tool_name === 'ExitPlanMode') {
    await sendThreaded(
      p.session_id,
      `📱 **Bot mode on.** Future plan approvals and questions come here first.\n` +
        `The plan that is waiting now still needs a decision in Claude Code (open dialogs cannot be approved remotely). /claude to switch back.`
    ).catch(() => {});
    return cleanup();
  }

  // Mirror the currently open question(s) as answerable cards. Claude picks
  // the answers up via list_unprocessed after the terminal dialog auto-closes.
  // silent — the card right after it is what pings
  await mirrorTurn(p.session_id, p.transcript_path, { silent: true }).catch(() => {});
  const questions = p.tool_input?.questions || [];
  const reqs: Req[] = [];
  for (const q of questions)
    reqs.push(
      await create('question', {
        ...questionCardArgs(q, project, 1800, reqs.length, questions.length),
        session_id: p.session_id,
        external_id: toolUseId ? `esc-${toolUseId}-${reqs.length}` : undefined,
      })
    );
  if (!pulled && cfg.escalate_permission === 'auto')
    await sendThreaded(
      p.session_id,
      '🤖 *Forwarded automatically (escalation: auto). Bot mode is on now — /claude to switch back.*',
      { disable_notification: true }
    ).catch(() => {});

  const deadline = Date.now() + 1800 * 1000;
  for (const r of reqs) {
    const res = await waitAnswer(r.id, deadline, switchedToClaude);
    if (res?.status === 'aborted') {
      for (const x of reqs) cancel(x.id, 'resolved_elsewhere'); // /claude → back to the dialog
      break;
    }
    if (res?.status !== 'answered') break; // timeout — leave the rest; cards expire on their own
  }
  return cleanup();

  function cleanup(): never {
    try {
      rmSync(payloadPath, { force: true });
    } catch {}
    process.exit(0);
  }
}

// ---------------------------------------------------------------- bot-first
async function botFirstExitPlanMode(input: HookInput, project: string | undefined) {
  pollLoop();
  await mirrorTurn(input.session_id, input.transcript_path, { silent: true }).catch(() => {});
  const plan = String(input.tool_input?.plan || ''); // makeRequest clips with a visible marker
  const req = await create('approval', {
    title: 'Approve this plan?',
    details: plan,
    project,
    session_id: input.session_id,
    risk: 'medium',
    expires_in_seconds: WAIT + 30,
  });
  const res = await waitAnswer(req.id, Date.now() + WAIT * 1000, switchedToClaude);
  if (res?.status === 'answered') {
    consume(req.id);
    if (res.answer!.decision === 'approve')
      out({ permissionDecision: 'allow', permissionDecisionReason: 'Plan approved by the user via Telegram.' });
    out({
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Plan rejected by the user via Telegram. Revise the plan; if you need details, ask via the claude-code-telegram-interface ask_question tool — the user is away from the terminal.',
    });
  }
  cancel(req.id, 'resolved_elsewhere');
  out({
    permissionDecision: 'ask',
    permissionDecisionReason:
      res?.status === 'aborted'
        ? 'The user switched to Claude Code (/claude); asking in the terminal.'
        : 'No Telegram answer in time; asking in the terminal.',
  });
}

async function botFirstAskUserQuestion(input: HookInput, project: string | undefined) {
  const questions = input.tool_input?.questions || [];
  if (!questions.length) process.exit(0);
  pollLoop();
  await mirrorTurn(input.session_id, input.transcript_path, { silent: true }).catch(() => {});
  const deadline = Date.now() + WAIT * 1000;

  const reqs: Req[] = [];
  for (const q of questions)
    reqs.push(
      await create('question', {
        ...questionCardArgs(q, project, WAIT + 30, reqs.length, questions.length),
        session_id: input.session_id,
      })
    );

  const answers: Req[] = [];
  for (const r of reqs) {
    const res = await waitAnswer(r.id, deadline, switchedToClaude);
    if (res?.status !== 'answered') {
      for (const x of reqs) cancel(x.id, 'resolved_elsewhere');
      process.exit(0); // timeout or /claude switch → native terminal dialog
    }
    answers.push(res);
  }
  for (const r of reqs) consume(r.id);

  const lines = answers.map(
    (res, i) => `- ${JSON.stringify(questions[i].question)}: ${res.answer!.choice ?? res.answer!.text}`
  );
  out({
    permissionDecision: 'deny',
    permissionDecisionReason:
      `The user already answered via Telegram (not the terminal dialog):\n${lines.join('\n')}\n` +
      'Use these answers and continue. Do not ask these questions again.',
  });
}

// ---------------------------------------------------------------- entry
/** Runs one hook invocation. `argv` is everything after the `hook` subcommand. */
export async function runHook(argv: string[]) {
  if (argv[0] === '--watch') return watch(argv[1]);
  if (argv[0] === '--wake') {
    const { runWake } = await import('./wake.ts');
    return runWake(argv[1]);
  }

  const input: HookInput = JSON.parse(readFileSync(0, 'utf8'));
  const project = input.cwd ? basename(input.cwd) : undefined;
  const sid = input.session_id;
  const sid8 = sid ? `#${sid.slice(0, 8)}` : null;
  // Every hook carries the transcript — first one that can name the session does.
  withState((s) => ensureSession(s, sid, input.cwd));
  noteSessionTitle(sid, input.transcript_path);

  // Session bookkeeping events — work even before a chat is bound.
  if (input.hook_event_name === 'SessionStart') {
    withState((s) => ensureSession(s, sid, input.cwd));
    process.exit(0);
  }
  if (input.hook_event_name === 'SessionEnd') {
    withState((s) => clearBusy(s, sid));
    process.exit(0);
  }
  if (input.hook_event_name === 'Stop') {
    // Turn mirror: in bot mode the phone is the primary surface, so a finished
    // turn ships its own words there — notifying, this is the "come look" moment.
    // Not under FORCED_BOT: a Phone turn already streams its blocks live
    // (wake.ts), and mirroring here would send every one of them twice.
    const st = readState();
    if (st.chat_id && !FORCED_BOT && st.config.mode === 'bot')
      await mirrorTurn(sid, input.transcript_path, { silent: false }).catch(() => {});
    const msgs = drainInbox(sid, 'stop');
    // A blocking Stop keeps this Claude working, and no UserPromptSubmit follows —
    // so Busy has to be re-armed for the continuation. Clearing it here would let
    // the next Telegram message spawn a second Claude in the same project.
    withState((s) => (msgs.length ? setBusy(s, sid, process.ppid) : clearBusy(s, sid)));
    // Hook-injected text never shows in the visible chat history (a harness
    // ceiling: hooks cannot create user turns), so Claude is told to quote the
    // message — the quote in its reply is the durable, scrollable record.
    const mirrored = st.chat_id && !FORCED_BOT && st.config.mode === 'bot';
    if (msgs.length)
      console.log(
        JSON.stringify({
          decision: 'block',
          reason:
            'The user sent instructions from Telegram while you were working:\n' +
            msgs.map((x) => `- ${x.text}`).join('\n') +
            '\nStart your reply by quoting each message verbatim as "📨 From Telegram: …" — hook text is invisible in the chat history, your quote is its only durable record. Then act on them now. ' +
            (mirrored
              ? 'Your reply reaches Telegram by itself (turn mirror) — do not send a duplicate via notify_user unless you need a result card or links.'
              : 'When done, report the outcome back via claude-code-telegram-interface (notify_user or report_execution), then stop.'),
        })
      );
    process.exit(0);
  }
  if (input.hook_event_name === 'UserPromptSubmit') {
    withState((s) => {
      ensureSession(s, sid, input.cwd);
      // ppid IS the Claude process: every bin/run.sh branch execs, and a shell
      // given one simple command execs too, so nothing survives in between.
      setBusy(s, sid, process.ppid, input.transcript_path);
    });
    const msgs = drainInbox(sid);
    if (msgs.length)
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              'The user also sent these from Telegram (treat as user instructions):\n' +
              msgs.map((x) => `- ${x.text}`).join('\n') +
              '\nStart your reply by quoting each one verbatim as "📨 From Telegram: …" — this context is invisible in the chat history, your quote is its only durable record.',
          },
        })
      );
    process.exit(0);
  }

  const s0 = readState();
  if (!s0.chat_id) process.exit(0); // not bound → never block the normal flow

  if (input.hook_event_name === 'Notification') {
    withState((s) => ensureSession(s, sid, input.cwd));
    await sendThreaded(
      sid,
      `🔔 ${[project, sid8].filter(Boolean).join(' - ')}\n\n${
        input.message || 'Claude needs your attention in the terminal.'
      }`
    ).catch(() => {});
    process.exit(0);
  }

  if (input.hook_event_name === 'PostToolUseFailure') {
    const sess = s0.sessions[sid!];
    // only sessions the user already sees in the chat, max one error per minute
    if (!sess?.last_card_msg_id) process.exit(0);
    if (Date.now() - (sess.last_error_at || 0) < 60_000) process.exit(0);
    withState((s) => {
      if (s.sessions[sid!]) s.sessions[sid!].last_error_at = Date.now();
    });
    await sendThreaded(
      sid,
      `⚠️ ${[sess.project, sid8].filter(Boolean).join(' - ')}\n\n` + errorCard(input),
      { disable_notification: true }
    ).catch(() => {});
    process.exit(0);
  }

  if (input.hook_event_name !== 'PreToolUse' || !['ExitPlanMode', 'AskUserQuestion'].includes(input.tool_name!))
    process.exit(0);

  withState((s) => ensureSession(s, sid, input.cwd));

  if (routingMode(s0) === 'bot') {
    if (input.tool_name === 'ExitPlanMode') await botFirstExitPlanMode(input, project);
    else await botFirstAskUserQuestion(input, project);
    process.exit(0);
  }

  // claude mode: let the native dialog show right away; a detached watcher
  // escalates to Telegram if it stays unanswered.
  if (input.transcript_path && existsSync(input.transcript_path)) {
    const payloadPath = join(dirname(STATE_FILE), `esc-${Date.now()}-${process.pid}.json`);
    writeFileSync(payloadPath, JSON.stringify(input));
    spawn(process.execPath, selfArgv('hook', '--watch', payloadPath), {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
  process.exit(0); // no output → normal terminal flow
}
