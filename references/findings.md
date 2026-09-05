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

## Third-party models via OpenRouter (probed 2026-09-05, codex-cli 0.153.4)

- `wire_api = "chat"` is gone in this version; a provider must speak the Responses API. OpenRouter's `/api/v1/responses` works, including function calls and streaming, so `[model_providers.openrouter]` with `base_url = "https://openrouter.ai/api/v1"`, `env_key = "OPENROUTER_API_KEY"`, `wire_api = "responses"` is enough. Pass `modelProvider: "openrouter"` on `thread/start` (`codexctl --provider openrouter`).
- Unknown model ids get "fallback metadata" (warning event, 258k context assumed). Third-party models get `exec_command`/`write_stdin` only, no `apply_patch`; every model edited files through PowerShell one-liners and that was fine.
- **Prompt size is the real cost.** With the user's connected ChatGPT apps, each request carried ~490 KB: 424 KB of tool schemas (GitHub 78 KB, Notion 73 KB, Figma 65 KB, Drive 63 KB, Gmail 45 KB, Sites 35 KB, ...), 17 KB base instructions, 28 KB skills list, 5 KB "recommended plugins". That is ~137k input tokens per request and ~10 s upload latency. `-c features.apps=false features.multi_agent=false features.browser_use=false features.computer_use=false tools.web_search=false mcp_servers.node_repl.enabled=false include_apps_instructions=false` brings it to ~51 KB / ~14k tokens and ~3 s per request; the same task went from 67 s to 33 s. `codexctl --lean` applies exactly this set (default with `--provider`).
- App-server has no `--profile`; overrides go in as `-c key=value` on the spawned process, so they only reach a private stdio server, never a shared `serve` one.
- Fix-and-verify task (find bug in `mathlib.py`, fix, run python to verify), full prompt, effort low, 3 concurrent:

  | model | result | wall | shell calls |
  |---|---|---|---|
  | nvidia/nemotron-3.5-lightning:free | fixed + verified | 67 s (33 s lean) | 4 |
  | minimax/minimax-m2.7:free | fixed + verified | 45 s | 3 |
  | inclusionai/ling-3.0-flash-sante:free | fixed + verified | 78 s | 6 |
  | nvidia/nemotron-3-super-120b-a12b:free | fixed + verified | 94 s | 5 |
  | dots-studio/dots-3-note-preview:free | fixed + verified | 110 s | 8 |
  | nvidia/nemotron-3-ultra-550b-a55b:free | fixed + verified | 158 s | 5 |
  | cohere/north-mini-code:free | fixed + verified | 190 s | 17 (fought PowerShell quoting) |
  | minimax/minimax-m3:free | no fix | timeout / ended turn after "Patching now" | 0-3 |
  | z-ai/glm-5.2:free, google/gemma-4-31b-it:free | 429 | "temporarily rate-limited upstream" on the Responses path all day | 0 |
  | poolside/laguna-s-2.1:free | 429 | tiny direct call works, agent-sized request does not | 0-1 |

- 429s come back in 1-2 s ("exceeded retry limit"); Codex does not switch models. `codexctl run --model a,b,c` starts a fresh thread on the next model when a turn fails before producing any item; `--model free` is the chain of the models above that passed, fastest first.
- Cost: every free call reported `cost: 0` in OpenRouter usage. Free endpoints may log prompts; keep private repos on paid or OpenAI models.
