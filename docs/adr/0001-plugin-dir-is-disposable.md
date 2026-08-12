# 0001. The installed plugin directory is disposable; `~/.claude-code-telegram-interface/` owns all durable state

Status: accepted · Date: 2026-08-12

## Invariants

- **Never write config, tokens, caches, or state under the plugin's own
  directory.** The wrong code is the pattern this repo used before it became a
  plugin: a `.env` (or any state file) resolved relative to the source, e.g.
  `new URL('.env', import.meta.url)` or `dirname(fileURLToPath(import.meta.url))`.
  Claude Code installs a plugin to
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, copies a **new
  version directory** on every update, and sweeps the orphaned one after ~14
  days — anything written there is silently lost on upgrade. Enforced by the
  Plugin home constants: `src/server.ts:202` (`HOME_DIR`), `src/server.ts:204`
  (`STATE_FILE`), `src/server.ts:210` (`CONFIG_FILE`), and the binary cache path
  `bin/run.sh:47`. Reading the plugin directory is fine — `bin/run.sh` reads
  `.claude-plugin/plugin.json` for the version.
- **Poller-election rank must be an embedded build stamp, never a file mtime.**
  The wrong code is "simplifying" `BUILD_V` back to
  `statSync(fileURLToPath(import.meta.url)).mtimeMs`. A downloaded release
  binary's mtime is its *download* time, so a stale binary fetched today would
  outrank a newer one installed last week and win the election with old logic.
  Only the dev path (running from source, where mtime is accurate) may use it,
  and it already does as a fallback. Visible at `src/server.ts:183`
  (definition) and `src/server.ts:370` (the comparator).

## Where it lives

- `src/server.ts` — Plugin home constants (`HOME_DIR`, `STATE_FILE`,
  `CONFIG_FILE`) and the poller-election rank `BUILD_V`.
- `bin/run.sh` — caches downloaded binaries in Plugin home, never beside itself.
