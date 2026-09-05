# Verified app-server behavior

Tested 2026-09-05 on Windows 11 with `codex-cli 0.153.4`, ChatGPT Pro login, models gpt-5.6-luna / terra / sol. Re-verify anything marked version-sensitive after `codex update`.

## Transports and platform limits

- `codex app-server --listen stdio://` and `--listen ws://127.0.0.1:PORT` both work. The WS server binds localhost only and serves `/healthz` and `/readyz` (200, empty body).
- Each stdio invocation spawns its own app-server process. Live turns exist only in that process's memory, so interrupt/steer from another invocation requires the shared WS server (`codexctl serve`).
- Unix-only on this version: `codex app-server daemon ...` lifecycle, `codex agents` without `--remote`, `codex remote-control`. Remote control status reports `disabled`.
- `command/exec` with `streamStdoutStderr`/`tty` is rejected under the Windows sandbox ("streaming command/exec is not supported with windows sandbox"). Non-streaming exec works.
- `server/diagnostics` needs an `experimentalApi` capability at initialize; not exposed by codexctl.
- Sandboxed PowerShell runs in ConstrainedLanguage mode, so a user's `Microsoft.PowerShell_profile.ps1` can error inside commands the model runs. Expect noise like "Cannot dot-source this command because it was defined in a different language mode".

## Threads, turns, and history

- `thread/start` never validates the model id. A bogus model surfaces as a 400 at the first `turn/start` (`turn.status = "failed"`, error message from the API).
- `thread/start` also accepts a nonexistent `cwd`.
- Effort is set per turn (`turn/start.effort`). A thread reports `reasoningEffort: "ultra"` from config until the first turn overrides it. Luna does not list `ultra` but accepted it and completed normally.
- `turn/start` on a thread with an active turn is **silently merged into the running turn**: it returns a new turn id with status `inProgress`, no `thread/queue/changed` fires, and no second `turn/completed` ever arrives. Wait for completion before starting the next turn, or use `turn/steer` deliberately.
- `turn/steer` requires the active turn id (`expectedTurnId`); it returns `{turnId}` and the model folds the text into the same turn. Wrong or stale id → `-32600 no active turn to steer`.
- `turn/interrupt` completes the turn with `status: "interrupted"`, `error: null`; the thread stays usable and remembers the interrupted context.
- `thread/fork` (optionally with a different model) preserves memory of the source thread. `thread/resume` from a brand-new connection preserves memory and returns full metadata.
- `thread/revert {beforeTurnId}` drops that turn and everything after; the model then forgets those turns. It does not touch files.
- `thread/compact/start` returned `{}`, emitted **no** `thread/compacted` notification within 120 s, and afterwards Luna lost a fact ("codeword") it had recalled correctly in the previous turn. Treat compaction as lossy; restate critical facts after it.
- `thread/inject_items` with a Responses-API `message` item (`role: user`, `content: [{type: "input_text", text}]`) is visible to the model on the next turn.
- `thread/shellCommand` returns `{}`; the command output shows up as a hidden turn that the model comments on at the start of the next turn. Prefer `command/exec` for plain command execution.
- Ephemeral threads (`ephemeral: true`) work normally and are absent from `thread/list`.
- `thread/delete` refuses a thread that has been forked ("forked history still references it"); delete the forks first. `thread/archive` on an already-archived thread is fine.
- `thread/goal/set` needs `objective` on first call; status values are `active|paused|blocked|usageLimited|budgetLimited|complete`.
- `thread/list` paginates via `nextCursor`; `thread/loaded/list` returns ids loaded in the current server process.
- `review/start` supports only `delivery: "inline"` ("paginated threads do not support detached review"). The result is an `exitedReviewMode` item whose `review` text carries the findings, plus a matching `agentMessage`. A small diff took ~113 s on Terra.
- `outputSchema` on `turn/start` yields a final `agentMessage` that is exactly the JSON object.

## Approvals and sandboxing

- Approvals arrive as server→client requests `item/commandExecution/requestApproval` (and `item/fileChange/requestApproval`, `item/permissions/requestApproval`). Response `{decision}`: `accept`, `acceptForSession`, `decline` (agent continues, item `status: "declined"`), `cancel` (turn ends `interrupted`).
- With `sandbox: read-only` + `approvalPolicy: untrusted`, every command asked. Accepting a write command under read-only still ran it inside the sandbox on this build and the write failed with the PowerShell profile error above; switch the turn to `sandboxPolicy: {type: "workspaceWrite", writableRoots: [cwd]}` to actually write.
- `workspace-write` + `approvalPolicy: never`: writes inside cwd succeed with no prompts; a `fileChange` patch outside cwd is rejected ("writing is blocked by read-only sandbox"); outbound network from python fails with `WinError 10061`.
- `approvalsReviewer: "auto_review"` still routed the approval request to the client on this build; no `item/autoApprovalReview/*` events fired.
- Per-turn overrides `approvalPolicy` and `sandboxPolicy` on `turn/start` apply to that turn and later turns of the thread.

## Multi-client (shared WS server)

- A second client sees the thread in `thread/loaded/list` and can `thread/read` it, but receives only `thread/status/changed` for it until it calls `thread/resume {threadId, excludeTurns: true}`; after that it can `turn/interrupt` and `turn/start`, and both clients get `turn/completed`.
- A thread survives its creating client disconnecting; the remaining client can keep running turns.

## Model/effort grid (same tool-using CSV task, 9 threads concurrently, ~26 s wall clock)

| model | effort | elapsed s | total tokens | correct |
|---|---|---|---|---|
| gpt-5.6-luna | low / medium / high | 17.8 / 20.2 / 22.6 | ~17.8k | yes |
| gpt-5.6-terra | low / medium / high | 18.8 / 22.6 / 23.4 | ~19.4k | yes |
| gpt-5.6-sol | low / medium / high | 18.8 / 21.3 / 25.4 | ~19.4k | yes |

Token totals are dominated by the ~17k-token system prompt; cached input tokens appear from the second request onward. Reasoning tokens were near zero at every effort for these short tasks. Higher effort mainly added latency here. Three models in parallel on one connection finished a primes.py task in 36 s wall clock. Weekly rate limit went from 9% before ~45 turns.

## Useful facts

- `account/rateLimits/read` → `primary.usedPercent`, `windowDurationMins` (10080 = weekly), `resetsAt`. `account/read` → plan type and email.
- `model/list` → ids with `supportedReasoningEfforts`. Known ids: gpt-6-astra (default, ultra effort), gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4-mini, gpt-5.3-codex-spark, gpt-reserve, codex-auto-review.
- `~/.codex/config.toml` sets the default model and `approvals_reviewer`; thread rollouts live under `~/.codex/sessions/YYYY/MM/DD/`.
