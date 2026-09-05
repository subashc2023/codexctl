# Codex app-server protocol (generated)

Generated 2026-09-05 from `codex-cli 0.153.4` via `codex app-server generate-json-schema`. Regenerate with `node scripts/gen-protocol.js`.

Wire format: newline-delimited JSON-RPC 2.0. Handshake: `initialize` {clientInfo:{name,title,version}} then notification `initialized`. Params/results are camelCase.

## Client → server requests

| method | params |
|---|---|
| `account/login/cancel` | loginId:string |
| `account/login/start` | (object) |
| `account/logout` | (none) |
| `account/rateLimitResetCredit/consume` | creditId?:string\|null, idempotencyKey:string |
| `account/rateLimits/read` | (none) |
| `account/read` | refreshToken?:boolean |
| `account/sendAddCreditsNudgeEmail` | creditType:"credits"\|"usage_limit" |
| `account/usage/read` | (object) |
| `account/workspaceMessages/read` | (none) |
| `app/installed` | forceRefresh?:boolean, threadId?:string\|null |
| `app/list` | cursor?:string\|null, forceRefetch?:boolean, limit?:integer\|null, threadId?:string\|null |
| `app/read` | appIds:array<string>, includeTools?:boolean, threadId?:string\|null |
| `command/exec` | command:array<string>, cwd?:string\|null, disableOutputCap?:boolean, disableTimeout?:boolean, env?:object\|null, outputBytesCap?:integer\|null, processId?:string\|null, sandboxPolicy?:obj\|null, size?:object\|null, streamStdin?:boolean, streamStdoutStderr?:boolean, timeoutMs?:integer\|null, tty?:boolean |
| `command/exec/resize` | processId:string, size:any |
| `command/exec/terminate` | processId:string |
| `command/exec/write` | closeStdin?:boolean, deltaBase64?:string\|null, processId:string |
| `config/batchWrite` | edits:array<object>, expectedVersion?:string\|null, filePath?:string\|null, reloadUserConfig?:boolean |
| `config/mcpServer/reload` | (none) |
| `config/read` | cwd?:string\|null, includeLayers?:boolean |
| `config/value/write` | expectedVersion?:string\|null, filePath?:string\|null, keyPath:string, mergeStrategy:"replace"\|"upsert", value:any |
| `configRequirements/read` | (none) |
| `experimentalFeature/enablement/set` | enablement:object |
| `experimentalFeature/list` | cursor?:string\|null, limit?:integer\|null, threadId?:string\|null |
| `externalAgentConfig/detect` | cwds?:array\|null, includeHome?:boolean, maxSessionAgeDays?:integer\|null, maxSessions?:integer\|null, migrationSource?:string\|null, source?:string\|null |
| `externalAgentConfig/import` | migrationItems:array<object>, migrationSource?:string\|null, providerId?:string\|null, source?:string\|null |
| `externalAgentConfig/import/readHistories` | (none) |
| `externalAgentConfig/import/recordHistory` | itemTypeResults:array<object>, providerId:string |
| `feedback/upload` | classification:string, extraLogFiles?:array\|null, includeLogs?:boolean, reason?:string\|null, tags?:object\|null, threadId?:string\|null |
| `fs/copy` | destinationPath:any, recursive?:boolean, sourcePath:any |
| `fs/createDirectory` | path:any, recursive?:boolean\|null |
| `fs/getMetadata` | path:any |
| `fs/readDirectory` | path:any |
| `fs/readFile` | path:any |
| `fs/remove` | force?:boolean\|null, path:any, recursive?:boolean\|null |
| `fs/unwatch` | watchId:string |
| `fs/watch` | path:any, watchId:string |
| `fs/writeFile` | dataBase64:string, path:any |
| `fuzzyFileSearch` | cancellationToken?:string\|null, query:string, roots:array<string> |
| `hooks/list` | cwds?:array<string> |
| `initialize` | capabilities?:object\|null, clientInfo:object |
| `marketplace/add` | refName?:string\|null, source:string, sparsePaths?:array\|null |
| `marketplace/remove` | marketplaceName:string |
| `marketplace/upgrade` | marketplaceName?:string\|null |
| `mcpServer/oauth/login` | clientRegistration?:"auto"\|"cimd"\|"dcr"\|null, name:string, scopes?:array\|null, threadId?:string\|null, timeoutSecs?:integer\|null |
| `mcpServer/resource/read` | connectorId?:string\|null, originCallId?:string\|null, server:string, threadId?:string\|null, uri:string |
| `mcpServer/tool/call` | _meta?:any, arguments?:any, server:string, threadId:string, tool:string |
| `mcpServerStatus/list` | cursor?:string\|null, detail?:"full"\|"toolsAndAuthOnly"\|null, limit?:integer\|null, threadId?:string\|null |
| `model/list` | cursor?:string\|null, includeHidden?:boolean\|null, limit?:integer\|null |
| `modelProvider/capabilities/read` | (object) |
| `permissionProfile/list` | cursor?:string\|null, cwd?:string\|null, limit?:integer\|null |
| `plugin/install` | installAttemptId?:string\|null, marketplacePath?:string\|null, pluginName:string, remoteMarketplaceName?:string\|null |
| `plugin/installed` | cwds?:array\|null, installSuggestionPluginNames?:array\|null |
| `plugin/list` | cwds?:array\|null, forceRefetch?:boolean, marketplaceKinds?:array\|null |
| `plugin/read` | marketplacePath?:string\|null, pluginName:string, remoteMarketplaceName?:string\|null |
| `plugin/reconcile` | reason?:string\|null |
| `plugin/share/checkout` | remotePluginId:string |
| `plugin/share/delete` | remotePluginId:string |
| `plugin/share/list` | (object) |
| `plugin/share/save` | discoverability?:"LISTED"\|"UNLISTED"\|"PRIVATE"\|null, pluginPath:string, remotePluginId?:string\|null, shareTargets?:array\|null |
| `plugin/share/updateTargets` | discoverability:"UNLISTED"\|"PRIVATE"\|"LISTED", remotePluginId:string, shareTargets:array<object> |
| `plugin/skill/read` | remoteMarketplaceName:string, remotePluginId:string, skillName:string |
| `plugin/uninstall` | pluginId:string |
| `review/start` | delivery?:"inline"\|"detached"\|null, target:{type:uncommittedChanges\|baseBranch\|commit\|custom,...}, threadId:string |
| `skills/config/write` | enabled:boolean, name?:string\|null, path?:string\|null |
| `skills/extraRoots/set` | extraRoots:array<string> |
| `skills/list` | cwds?:array<string>, forceReload?:boolean |
| `thread/approveGuardianDeniedAction` | event:any, threadId:string |
| `thread/archive` | threadId:string |
| `thread/compact/start` | threadId:string |
| `thread/delete` | threadId:string |
| `thread/fork` | approvalPolicy?:obj\|null, approvalsReviewer?:"user"\|"auto_review"\|"guardian_subagent"\|null, baseInstructions?:string\|null, config?:object\|null, cwd?:string\|null, developerInstructions?:string\|null, ephemeral?:boolean, excludeTurns?:boolean, lastTurnId?:string\|null, model?:string\|null, modelProvider?:string\|null, sandbox?:"read-only"\|"workspace-write"\|"danger-full-access"\|null, serviceTier?:string\|null, threadId:string, threadSource?:string\|null |
| `thread/goal/clear` | threadId:string |
| `thread/goal/get` | threadId:string |
| `thread/goal/set` | objective?:string\|null, status?:"active"\|"paused"\|"blocked"\|"usageLimited"\|"budgetLimited"\|"complete"\|null, threadId:string, tokenBudget?:integer\|null |
| `thread/inject_items` | items:array<any>, threadId:string |
| `thread/items/list` | cursor?:string\|null, limit?:integer\|null, sortDirection?:"asc"\|"desc"\|null, threadId:string, turnId?:string\|null |
| `thread/list` | archived?:boolean\|null, cursor?:string\|null, cwd?:obj\|null, limit?:integer\|null, modelProviders?:array\|null, searchTerm?:string\|null, sectionId?:string\|null, sortDirection?:"asc"\|"desc"\|null, sortKey?:"created_at"\|"updated_at"\|"recency_at"\|"section_position"\|null, sourceKinds?:array\|null, useStateDbOnly?:boolean |
| `thread/loaded/list` | cursor?:string\|null, limit?:integer\|null |
| `thread/metadata/update` | gitInfo?:object\|null, threadId:string |
| `thread/name/set` | name:string, threadId:string |
| `thread/read` | includeTurns?:boolean, threadId:string |
| `thread/resume` | approvalPolicy?:obj\|null, approvalsReviewer?:"user"\|"auto_review"\|"guardian_subagent"\|null, baseInstructions?:string\|null, config?:object\|null, cwd?:string\|null, developerInstructions?:string\|null, excludeTurns?:boolean, model?:string\|null, modelProvider?:string\|null, personality?:"none"\|"friendly"\|"pragmatic"\|null, sandbox?:"read-only"\|"workspace-write"\|"danger-full-access"\|null, serviceTier?:string\|null, threadId:string |
| `thread/revert` | beforeTurnId:string, threadId:string |
| `thread/rollback` | numTurns:integer, threadId:string |
| `thread/section/move` | beforeThreadId?:string\|null, sectionId:string\|null, threadId:string |
| `thread/shellCommand` | command:string, threadId:string, timeoutMs?:integer\|null |
| `thread/start` | approvalPolicy?:obj\|null, approvalsReviewer?:"user"\|"auto_review"\|"guardian_subagent"\|null, baseInstructions?:string\|null, config?:object\|null, cwd?:string\|null, developerInstructions?:string\|null, ephemeral?:boolean\|null, model?:string\|null, modelProvider?:string\|null, personality?:"none"\|"friendly"\|"pragmatic"\|null, sandbox?:"read-only"\|"workspace-write"\|"danger-full-access"\|null, serviceName?:string\|null, serviceTier?:string\|null, sessionStartSource?:"startup"\|"clear"\|null, threadSource?:string\|null |
| `thread/turns/list` | cursor?:string\|null, itemsView?:obj\|null, limit?:integer\|null, sortDirection?:"asc"\|"desc"\|null, threadId:string |
| `thread/unarchive` | threadId:string |
| `thread/unsubscribe` | threadId:string |
| `threadSection/create` | appearance?:object\|null, name:string |
| `threadSection/delete` | sectionId:string |
| `threadSection/list` | cursor?:string\|null, limit?:integer\|null |
| `threadSection/update` | appearance?:object\|null, name:string, sectionId:string |
| `turn/interrupt` | threadId:string, turnId:string |
| `turn/start` | approvalPolicy?:obj\|null, approvalsReviewer?:"user"\|"auto_review"\|"guardian_subagent"\|null, clientUserMessageId?:string\|null, cwd?:string\|null, effort?:string\|null, input:array<{type:text\|image\|localImage\|audio\|localAudio\|skill\|mention,...}>, model?:string\|null, outputSchema?:any, personality?:"none"\|"friendly"\|"pragmatic"\|null, sandboxPolicy?:obj\|null, serviceTier?:string\|null, serviceTierForTurn?:string\|null, summary?:obj\|null, threadId:string, toolOutput?:object\|null, turnTrigger?:string\|null |
| `turn/steer` | clientUserMessageId?:string\|null, expectedTurnId:string, input:array<{type:text\|image\|localImage\|audio\|localAudio\|skill\|mention,...}>, threadId:string |
| `windowsSandbox/readiness` | (none) |
| `windowsSandbox/setupStart` | cwd?:string\|null, mode:"elevated"\|"unelevated" |

## Server → client requests (must be answered with a response carrying the same id)

| method | params |
|---|---|
| `account/chatgptAuthTokens/refresh` | (object) |
| `applyPatchApproval` | (object) |
| `attestation/generate` | (object) |
| `execCommandApproval` | (object) |
| `item/commandExecution/requestApproval` | (object) |
| `item/fileChange/requestApproval` | (object) |
| `item/permissions/requestApproval` | (object) |
| `item/tool/call` | (object) |
| `item/tool/requestUserInput` | (object) |
| `mcpServer/elicitation/request` | (object) |

Decisions: `item/*/requestApproval` → {decision: "accept"|"acceptForSession"|"decline"|"cancel"}; legacy `execCommandApproval`/`applyPatchApproval` → {decision: "approved"|"approved_for_session"|"denied"|"abort"}.

## Server → client notifications

`account/login/completed`, `account/rateLimits/updated`, `account/updated`, `app/list/updated`, `autoApprovalReview/strictReviewRequired`, `command/exec/outputDelta`, `configWarning`, `deprecationNotice`, `error`, `externalAgentConfig/import/completed`, `externalAgentConfig/import/progress`, `fs/changed`, `fuzzyFileSearch/sessionCompleted`, `fuzzyFileSearch/sessionUpdated`, `guardianWarning`, `hook/completed`, `hook/started`, `item/agentMessage/delta`, `item/autoApprovalReview/completed`, `item/autoApprovalReview/started`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/completed`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `item/plan/delta`, `item/reasoning/summaryPartAdded`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/started`, `mcpServer/event/stream/notification`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated`, `model/rerouted`, `model/safetyBuffering/updated`, `model/verification`, `modelProvider/authRecoveryCompleted`, `modelProvider/authRecoveryStarted`, `process/exited`, `process/outputDelta`, `project/changed`, `remoteControl/status/changed`, `serverRequest/resolved`, `skills/changed`, `thread/archived`, `thread/closed`, `thread/compacted`, `thread/deleted`, `thread/environment/connected`, `thread/environment/disconnected`, `thread/goal/cleared`, `thread/goal/updated`, `thread/name/updated`, `thread/project/updated`, `thread/queue/changed`, `thread/realtime/closed`, `thread/realtime/error`, `thread/realtime/item/completed`, `thread/realtime/item/started`, `thread/realtime/item/transcript/delta`, `thread/realtime/itemAdded`, `thread/realtime/outputAudio/delta`, `thread/realtime/sdp`, `thread/realtime/started`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/reverted`, `thread/settings/updated`, `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`, `thread/unarchived`, `turn/completed`, `turn/diff/updated`, `turn/moderationMetadata`, `turn/plan/updated`, `turn/started`, `warning`, `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`

## UserInput

```json
{"oneOf":[{"properties":{"text":{"type":"string"},"text_elements":{"default":[],"description":"UI-defined spans within `text` used to render or persist special elements.","items":{"$ref":"#/definitions/TextElement"},"type":"array"},"type":{"enum":["text"],"title":"TextUserInputType","type":"string"}},"required":["text","type"],"title":"TextUserInput","type":"object"},{"properties":{"detail":{"anyOf":[{"$ref":"#/definitions/ImageDetail"},{"type":"null"}],"default":null},"type":{"enum":["image"],"title":"ImageUserInputType","type":"string"},"url":{"type":"string"}},"required":["type","url"],"title":"ImageUserInput","type":"object"},{"properties":{"detail":{"anyOf":[{"$ref":"#/definitions/ImageDetail"},{"type":"null"}],"default":null},"path":{"type":"string"},"type":{"enum":["localImage"],"title":"LocalImageUserInputType","type":"string"}},"required":["path","type"],"title":"LocalImageUserInput","type":"object"},{"properties":{"type":{"enum":["audio"],"title":"AudioUserInputType","type":"string"},"url":{"type":"string"}},"required":["type","url"],"title":"AudioUserInput","type":"object"},{"properties":{"path":{"type":"string"},"type":{"enum":["localAudio"],"title":"LocalAudioUserInputType","type":"string"}},"required":["path","type"],"title":"LocalAudioUserInput","type":"object"},{"properties":{"name":{"type":"string"},"path":{"type":"string"},"type":{"enum":["skill"],"title":"SkillUserInputType","type":"string"}},"required":["name","path","type"],"title":"SkillUserInput","type"
```

## SandboxPolicy

```json
{"oneOf":[{"properties":{"type":{"enum":["dangerFullAccess"],"title":"DangerFullAccessSandboxPolicyType","type":"string"}},"required":["type"],"title":"DangerFullAccessSandboxPolicy","type":"object"},{"properties":{"networkAccess":{"default":false,"type":"boolean"},"type":{"enum":["readOnly"],"title":"ReadOnlySandboxPolicyType","type":"string"}},"required":["type"],"title":"ReadOnlySandboxPolicy","type":"object"},{"properties":{"networkAccess":{"allOf":[{"$ref":"#/definitions/NetworkAccess"}],"default":"restricted"},"type":{"enum":["externalSandbox"],"title":"ExternalSandboxSandboxPolicyType","type":"string"}},"required":["type"],"title":"ExternalSandboxSandboxPolicy","type":"object"},{"properties":{"excludeSlashTmp":{"default":false,"type":"boolean"},"excludeTmpdirEnvVar":{"default":false,"type":"boolean"},"networkAccess":{"default":false,"type":"boolean"},"type":{"enum":["workspaceWrite"],"title":"WorkspaceWriteSandboxPolicyType","type":"string"},"writableRoots":{"default":[],"items":{"$ref":"#/definitions/AbsolutePathBuf"},"type":"array"}},"required":["type"],"title":"WorkspaceWriteSandboxPolicy","type":"object"}]}
```

## AskForApproval

```json
{"oneOf":[{"enum":["untrusted","on-request","never"],"type":"string"},{"additionalProperties":false,"properties":{"granular":{"properties":{"mcp_elicitations":{"type":"boolean"},"request_permissions":{"default":false,"type":"boolean"},"rules":{"type":"boolean"},"sandbox_approval":{"type":"boolean"},"skill_approval":{"default":false,"type":"boolean"}},"required":["mcp_elicitations","rules","sandbox_approval"],"type":"object"}},"required":["granular"],"title":"GranularAskForApproval","type":"object"}]}
```

## ThreadGoalStatus

```json
{"enum":["active","paused","blocked","usageLimited","budgetLimited","complete"],"type":"string"}
```
