# claude-code-telegram-interface

A Claude Code plugin that connects Claude to your own Telegram bot. When Claude is running a long task and needs something from you — a question, an approval, a heads-up — it pings your bot. You answer with one tap (or a text reply) from anywhere; Claude picks the answer up and keeps going. No more waiting hours for you to come back to the desk.

Everything runs on your machine, under your own bot token. There is no server in the middle.

## Install (~2 minutes)

1. **Create your bot**: open [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name → copy the token.

2. **Add the plugin** in Claude Code:

```bash
/plugin marketplace add Esi-Abolfazl/claude-code-telegram-interface
```

```bash
/plugin install claude-code-telegram-interface@claude-code-telegram-interface
```

3. **Connect your bot** — paste the token from step 1:

```bash
/claude-code-telegram-interface:setup <your-bot-token>
```

4. Open the bot link it prints and send the `/start <code>` line it gives you. That one-time code makes you the admin; nobody else can drive your bot.

Restart Claude Code and try: *"ask me something on telegram and wait for my answer"*.

> Know your numeric Telegram id already (from [@userinfobot](https://t.me/userinfobot))? Pass it as a second argument — `/claude-code-telegram-interface:setup <token> <your-id>` — and just press **Start** in the bot instead of sending a code.
>
> Prefer not to type the token into a chat? Write `~/.claude-code-telegram-interface/config.json` yourself: `{"bot_token": "…", "admin_id": 123456}`, `chmod 600`.

No Node.js needed. If you have Node ≥ 23.6 the plugin just runs its own TypeScript sources; otherwise it downloads a self-contained binary for your platform (macOS and Linux, arm64 and x64), verifies its checksum, and caches it in `~/.claude-code-telegram-interface/bin/`.

## What you get on your phone

- 💬 **Claude's words first** — the explanation Claude wrote right before asking is sent as a native rich message (real headings, tables, code blocks, quotes), then the question cards
- ❓ **Questions** — up to 4 one-tap choice buttons, or reply with text; answered cards keep all options visible with ✅ marks (or your custom reply quoted)
- 🔶 **Approvals** — ✅ Approve / ❌ Deny buttons; low-risk recurring ones can offer "always allow"
- 📣 **Updates** — fire-and-forget progress notes with result cards (files changed, tests, commit)
- ⌛ Items can expire so a stale approval can't fire hours later
- `/pending` — list everything still waiting on you

## Group mode: topic per project (optional)

Bind a forum supergroup and the inbox reorganizes itself: **each project gets its own topic**, sessions chain inside it.

1. Create a group → enable **Topics** in group settings → add the bot as **admin** with "Manage topics"
2. Send `/bindgroup` in the group (from your account)

From then on: first message from a project auto-creates its topic; each session opens with a small `▶️ session #id` header and its cards reply-chain under it. Typing anything inside a topic (no reply needed) routes to that project's newest session. `/unbindgroup` reverts to DM delivery.

### General = a plain Claude chat

The group's **General** topic belongs to no project. Write there and you get an ordinary Claude conversation, answered in General:

- **Plain message** → continues the current chat.
- **Reply to any message of an older chat** → continues *that* chat.
- **`/new`** → starts a fresh one (alone, or with the first message: `/new explain rsync -a`).

Chats run headlessly in their own workspace (`~/.claude-code-telegram-interface/general`) under the same caps as any woken turn, so `/wake off` disables them. They have no repository behind them — for work on a project, write in that project's topic.

## Session threads

Every Claude session gets its own reply-chain in the chat:

- Cards show their origin on top: `project · #sessionid · header`
- Each new card/context/notification from a session **replies to the previous one** — tap the chain to review earlier cards and decisions
- **Tool errors** from a session land in its thread too (silent, max 1/min, only for sessions already in the chat), naming the failing command as well as its output
- In **bot** mode each finished turn is mirrored into the thread as well — see [the activity feed](#the-activity-feed-bot-mode-only)
- **Reply to any message of a thread** → your text is routed into that session: an open question gets answered directly; otherwise it is queued and delivered when the session finishes its current step, or with your next prompt there

## Chat with Claude from your phone

You are not limited to answering what Claude asks. Type anything into a project's thread and Claude picks it up:

- **Something is running there** → your message is queued and handed to that session the moment it finishes its current step (as above).
- **Nothing is running there** → Claude is **woken for you**: a headless turn starts in that project, continuing the session's context, and its answer streams back into the same thread — 💬 messages as it writes, then a final ✅ line with how long it took (and the cost, only if you use API-key billing — on a claude.ai plan a woken turn just draws on your plan's usage limits like any other turn).

Questions it needs to ask you mid-turn come back as normal cards, so a woken turn can still be steered from the phone.

| | |
|---|---|
| **Turn it off** | `/wake off` — plain text goes back to being queued only. `/wake on` re-enables. `/config` shows the current setting |
| **Permissions** | Woken turns run with `acceptEdits`: file edits in that project are applied, anything else stays behind your normal permission rules. Whatever gets denied is named in the final message |
| **Caps** | Stops at 30 minutes or at a "$5" reading on Claude Code's internal usage meter, whichever comes first (that meter is an estimate at API list prices — actual money only on API-key billing). Raise with `TG_WAKE_MAX_SECONDS` / `TG_WAKE_BUDGET_USD` if a task needs more room |
| **Requirement** | Some Claude Code session must be open somewhere on the machine (idle is fine) — that is what listens to Telegram. With every terminal closed, messages wait until you start one |

## Routing modes (claude ⇄ bot)

Native Claude Code prompts (plan approvals, `AskUserQuestion` dialogs) are bridged with two modes:

- **claude** (default): prompts show in Claude Code immediately. If one stays unanswered past the timer, the bot pings you — with a consent card, or automatically, per config. Accepting flips to bot mode and mirrors the open question as an answerable card. Open *plan* dialogs can't be finished remotely — only future ones route to the bot.
- **bot**: prompts go to Telegram first; the Claude Code dialog is the fallback if you don't answer within ~3 min (`TG_HOOK_WAIT_SECONDS`). Bot mode also turns the thread into an **activity feed** — see below.

### The activity feed (bot mode only)

In bot mode you are away from the terminal, so every session **reports each finished turn into its thread**: the prompt that started it (`👤 …`) and everything Claude wrote (`💬 …`), as one rich message that notifies you. It is the "come look" signal — Claude finished, here is what it did, reply to steer it.

- Nothing is ever sent twice: text already shown above a question card is not repeated when the turn ends.
- Woken turns (previous section) stream their blocks live instead, so they are not mirrored again.
- `/claude` switches the feed off with the routing — in claude mode you are at the keyboard and see it there.
- Tool errors keep their own silent card, now carrying **what Claude was doing** (the command and its description) above what came back — an exit code with no command is unreadable on a phone.

Telegram commands:

| Command | Effect |
|---|---|
| `/config` | Show current mode, timer, escalation policy, wake setting |
| `/bot` · `/claude` (or `/mode …`) | Switch routing side. Switching also moves the question waiting right now: `/bot` pulls an open Claude Code question to the phone; `/claude` withdraws a bot-held card so the terminal dialog appears |
| `/timer 4m` (or `90s`) | How long a Claude Code prompt waits before escalating (keep under 5m) |
| `/escalation ask` \| `auto` \| `never` | Consent card first, forward silently, or never escalate |
| `/wake on` \| `off` | Whether plain text may wake Claude in an idle project (see above) — also gates General chats |
| `/new` | In the General topic: start a fresh Claude chat |
| `/pending` | List everything waiting on you |

Same fast switch from Claude Code: `/claude-code-telegram-interface:bot` and `/claude-code-telegram-interface:claude`. Switching from either side notifies the other.

`/claude-code-telegram-interface:setup` also offers to set `askUserQuestionTimeout: "5m"` in your Claude settings — that timeout is what closes an idle question dialog so Claude can pick up the answer you gave on Telegram.

## Configuration

Durable files live in `~/.claude-code-telegram-interface/` (**never** inside the plugin directory, which Claude Code replaces on every update — see [ADR 0001](docs/adr/0001-plugin-dir-is-disposable.md)):

| File | Contents |
|---|---|
| `config.json` | `bot_token`, `admin_id`, one-time `pairing_code` (mode 600) |
| `state.json` | requests, answers, sessions, routing config |
| `bin/` | cached platform binary per plugin version |

Environment overrides, mostly for development: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `STATE_FILE`, `CLAUDE_CODE_TELEGRAM_INTERFACE_CONFIG`, `TG_HOOK_WAIT_SECONDS`, `TG_WAKE_BUDGET_USD`, `TG_WAKE_MAX_SECONDS`.

## Development

Needs Node.js ≥ 23.6 (it runs the TypeScript sources directly by stripping types) and pnpm.

```bash
pnpm install && pnpm test
```

```bash
pnpm typecheck
```

Install the plugin from a local path (`/plugin marketplace add /path/to/this/repo`) and `${CLAUDE_PLUGIN_ROOT}` resolves to your checkout, so edits are live after `/reload-plugins`. Set `CLAUDE_CODE_TELEGRAM_INTERFACE_DEV=1` only to force the sources when a release binary is already cached. A `.env` at the repo root still works for `TELEGRAM_BOT_TOKEN` in dev.

One entry point serves every role: `src/main.ts` (MCP server), `… hook` (Claude Code hooks and the detached escalation watcher), `… --setup`, `… --mode bot|claude`, `… --selftest`.

## Tools exposed to Claude

`how_to_use` · `ask_question` · `request_approval` · `request_feedback` · `notify_user` · `get_response` · `list_pending` · `list_unprocessed` · `update_request` · `cancel_request` · `mark_processed` · `report_execution`

Contract highlights (full text via the `how_to_use` tool):

- `external_id` on every create → duplicate creates return the existing item, no double-notify
- items are versioned → taps on outdated cards are rejected after `update_request`
- answers are never consumed by reads → act, `report_execution`, then `mark_processed`
- after a restart → `list_unprocessed` recovers answered-but-unhandled items

## Design notes

- **Long polling** (`getUpdates`) — no webhook, no public URL, runs fine on a laptop behind NAT.
- **One antenna, many sessions** — every Claude Code session spawns its own server process; they share one lock-protected state file and elect a single poller via a heartbeat file, since Telegram rejects concurrent `getUpdates`. A newer build outranks a live older one, and a dead holder is replaced within ~15s.
- **One authorization gate** — every inbound update passes `authorize()` and nothing else; strangers are dropped silently.
- **Self-check**: `pnpm test` runs offline logic tests (dedupe, versioning, expiry, the admin gate, pairing, free-text routing, group topics).
