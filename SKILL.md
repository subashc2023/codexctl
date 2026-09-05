---
name: codexctl
description: Drive OpenAI Codex (the local `codex app-server` JSON-RPC control plane) from Claude Code — delegate coding tasks to Codex models (gpt-5.6-luna/terra/sol, gpt-6-astra), run turns, resume/fork/steer/interrupt threads, get Codex code reviews, run sandboxed commands, list models/rate limits. Use when the user says Codex, codexctl, app-server, "ask Codex", "have Codex do/review", or wants a second-opinion agent.
argument-hint: [run|resume|review|list|show|serve] ...
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js *)
---

# codexctl

One CLI, JSON on stdout, exit 0 on a completed turn, 2 otherwise:

```
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js <command> [options] "prompt"
```

Run with no arguments for full usage. Working directory defaults to the current one; pass `--cwd`.

## Mental model

- **Thread** = persistent conversation with a model, cwd, sandbox, approval policy. **Turn** = one prompt→completion cycle producing **items** (agentMessage, commandExecution, fileChange, reasoning). Threads persist on disk under `~/.codex/sessions` and can be resumed, forked, reverted.
- The app server asks the client to approve commands (**server→client requests**). codexctl auto-answers with `--decide` (default `accept`). Safety comes from the **sandbox**, not from the approval answer: `workspace-write` (default, writes only inside cwd, no network), `read-only`, `danger-full-access`.
- Each invocation normally spawns a private app-server. Run `codexctl serve` once to get a shared WebSocket server; then invocations attach to it, and `steer`/`interrupt` can reach turns started by earlier invocations.

## Common invocations

```bash
# delegate a task (Luna, low effort, writes inside cwd, no prompts)
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js run --cwd . "Add unit tests for src/parser.ts and run them"

# stronger model / more effort, read-only investigation
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js run --model gpt-5.6-sol --effort high --sandbox read-only "Explain how auth works in this repo"

# continue a thread, fork it into another model, just the text
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js resume THREAD_ID "Now handle the edge case for empty input" --text
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js fork THREAD_ID --model gpt-5.6-terra "Second opinion: is the previous fix correct?"

# Codex code review of uncommitted changes (or --base main / --commit SHA / --custom "...")
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js review --cwd .

# structured answer
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js run --schema schema.json --text "Classify each file in src/ as core or util"

# long task in the background: returns {pid, journal, resultFile}; poll resultFile
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js serve
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js run --detach --model gpt-5.6-sol --effort medium "Port the build to pnpm workspaces"
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js steer THREAD_ID "Also update the CI workflow"
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js interrupt THREAD_ID

# inventory / housekeeping
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js models
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js limits
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js list --cwd . --limit 10
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js show THREAD_ID
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js delete THREAD_ID ...
node ${CLAUDE_SKILL_DIR}/scripts/codexctl.js exec --cwd . -- python -m pytest -q
```

## Choosing model and effort

| need | pick |
|---|---|
| quick edits, tests, scripts, throwaway probes | `gpt-5.6-luna --effort low` (default) |
| medium refactors, reviews | `gpt-5.6-terra --effort medium` |
| harder reasoning, second opinions | `gpt-5.6-sol --effort high` |
| the user's default heavy model | `gpt-6-astra` (efforts up to `ultra`; expensive) |

On short tasks effort mostly adds latency, not quality. Ask `models` for the live list.

## Rules of thumb

- Report Codex's result to the user as Codex's output, not yours; verify file changes it made before relying on them.
- Never start a second turn on a thread while one is running: it is silently merged into the active turn. Use `steer` for that.
- Compaction is lossy and emits no event; after long threads, restate the facts that matter.
- `--sandbox danger-full-access` and `--approval never` together give Codex unrestricted host access. Only with explicit user consent.
- Use `--ephemeral` for probes you do not want in the user's Codex history; otherwise clean up with `delete`.
- Turns are billed against the user's ChatGPT plan. Check `limits` before batch work.

## Supporting files (load on demand)

- [references/findings.md](references/findings.md) — verified behavior, gotchas, platform limits, timings (version-stamped).
- [references/protocol.md](references/protocol.md) — generated method/param reference for raw JSON-RPC work; regenerate with `codexctl schema` after `codex update`.
- [scripts/codexrpc.js](scripts/codexrpc.js) — the client library (`CodexClient`, `runTurn`) for custom orchestration beyond the CLI.
