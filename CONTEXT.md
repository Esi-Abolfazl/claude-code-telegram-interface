# claude-code-telegram-interface

Decision inbox bridging Claude Code and the user's personal Telegram bot: questions,
approvals, and notifications answered from the phone.

## Language

**Admin**:
The single Telegram user authorized to bind and talk to the bot. Every inbound update is
dropped unless it comes from the Admin.
_Avoid_: owner, user id lock, LOCK_USER

**Binding**:
The stored association between the bot and the Admin's chat, completed by the Admin's
first `/start`.
_Avoid_: registration, pairing (that word is reserved for Pairing code)

**Pairing code**:
One-time code printed by setup and sent via `/start <code>` to claim the Admin role when
the user doesn't know their numeric Telegram id.

**Card**:
One Telegram message representing a question/approval/notification, with inline buttons
and versioned edits.
_Avoid_: message, prompt

**Poller**:
The single elected server process allowed to run `getUpdates`; all other live processes
stay passive. Election via heartbeat file.
_Avoid_: listener, receiver

**Mode**:
Where Claude's native prompts are answered first: `claude` (terminal first, escalate to
phone) or `bot` (phone first, terminal fallback).
_Avoid_: terminal (legacy alias for `claude`)

**Escalation**:
Moving an unanswered native prompt from Claude Code to Telegram after the timer, per the
consent policy (ask / auto / never).

**Session chain**:
The reply-chain of Telegram messages belonging to one Claude Code session; new cards
reply to the chain's last message.
_Avoid_: thread (Telegram "topics" are a different thing)

**Topic**:
A Telegram forum-supergroup topic mapped 1:1 to a project directory in group mode.

**Phone turn**:
A headless `claude -p` turn spawned ("woken") in a project's cwd when the Admin's plain
Telegram message reaches an idle project; its reply streams back into the session chain.
_Avoid_: wake turn, headless turn, remote turn

**General chat**:
A Claude conversation that belongs to no project, held in the group's General topic and
answered there. Runs as a Phone turn in the General workspace
(`~/.claude-code-telegram-interface/general`). A plain message continues the current one, a reply
continues the chat that message came from, `/new` starts a fresh one.
_Avoid_: default session, global chat

**Turn mirror**:
The copy of a finished turn's conversation text (the human's prompt plus Claude's own
words) sent into the Session chain in `bot` Mode. `Session.mirrored_line` — the count of
transcript lines already sent — is the single record of what Telegram has seen; a Phone
turn streams instead and is never mirrored.
_Avoid_: feed, echo, relay

**Busy**:
A project whose newest activity is a session mid-turn (between UserPromptSubmit and Stop,
Claude process still alive). Phone turns spawn only for projects that are not Busy.
_Avoid_: running, active, working

**Plugin home**:
`~/.claude-code-telegram-interface/` — the durable directory owning config, state, and cached
binaries. The installed plugin directory is disposable; Plugin home is not.
