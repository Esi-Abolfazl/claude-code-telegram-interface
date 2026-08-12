---
description: Connect claude-code-telegram-interface to your own Telegram bot (token + admin id)
argument-hint: <bot-token> [your-telegram-user-id]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/run.sh --setup:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/run.sh" --setup $ARGUMENTS`

Relay the output above to the user, keeping the bot link and the exact `/start` line
they must send. Never echo the bot token back.

Then, unless it is already set, offer to add `"askUserQuestionTimeout": "5m"` to their
`~/.claude/settings.json`. Explain why in one line: an unanswered question dialog in
Claude Code closes after that timeout, which is what lets Claude pick up an answer that
arrived on Telegram instead. Only edit the file if they say yes, and leave every other
setting untouched.
