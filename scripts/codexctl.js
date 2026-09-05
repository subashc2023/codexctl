#!/usr/bin/env node
// codexctl — drive the Codex app-server (JSON-RPC control plane) from the command line.
// All commands print one JSON object on stdout (use --text to print only the agent's reply).
"use strict";
const fs = require("fs"); const path = require("path"); const os = require("os"); const crypto = require("crypto"); const { spawn, execSync } = require("child_process");
const { CodexClient, runTurn, itemSummary, probeWs, DEFAULT_WS } = require("./codexrpc");

const STATE_DIR = path.join(os.homedir(), ".codexctl");
const SERVER_FILE = path.join(STATE_DIR, "server.json");
const PLAIN_FILE = path.join(__dirname, "..", "assets", "plain.md");
const USAGE_FILE = path.join(STATE_DIR, "usage.jsonl");
const CATALOG_FILE = path.join(STATE_DIR, "openrouter-models.json");

const USAGE = `codexctl — Codex app-server control plane CLI (JSON out)

Agent commands (Codex as a coding agent in --cwd):
  run      "prompt"            start a thread and run one turn
  resume   THREAD "prompt"     continue an existing thread
  fork     THREAD "prompt"     fork a thread (optionally --model) and run one turn
  steer    THREAD "text"       inject text into the thread's active turn
  interrupt THREAD             stop the thread's active turn
  review   [--base BR|--commit SHA|--custom "instr"]   code review of --cwd (default: uncommitted changes)
  show     THREAD              thread metadata + items
  list     [--limit N] [--cwd DIR]   recent threads
  delete   THREAD...           delete threads (also archives)
  models | account | limits    inventory / auth / rate limits
  exec     -- cmd args...      run a command through the server sandbox (no model)
  serve    [--stop|--status]   start/stop the shared WebSocket app-server (needed for steer/interrupt across invocations)
  schema                       regenerate references/protocol.md

Plain model calls (any model, our own instructions instead of the Codex agent prompt, read-only, ephemeral):
  ask      [MODEL] "prompt"    one call; text on stdout, stats on stderr (default model: flash)
  compare  "prompt"            same prompt to --models (default group "prose"), labeled A/B/C...; saves a run
  map      "instruction"       split --file(s) into chunks, run the instruction on each in parallel, concatenate
  reveal   [RUN|latest]        which model produced which label of a --blind compare
  usage    [--days N]          spend summary from ~/.codexctl/usage.jsonl
  aliases                      model aliases, chains and groups

Options for run/resume/fork/review (ask/compare/map take the same model/effort/timeout options):
  --model M[,M2,...]  gpt-5.6-luna (default) | gpt-5.6-terra | gpt-5.6-sol | gpt-6-astra | alias (spark, flash, sonnet, deepseek, free, ...) | OpenRouter id
                      a comma list or a chain alias (free, cheap-chain) is a fallback chain: a turn that fails before producing anything moves to the next model
  --provider P        model provider id from ~/.codex/config.toml [model_providers.*]; implied (openrouter) by aliases and org/model ids
  --config k=v        codex -c override for this invocation (repeatable; forces a private server). e.g. --config model_providers.x.base_url=http://127.0.0.1:8787/v1
  --lean | --no-lean  drop app connectors, sub-agents, node_repl, browser/computer use from the prompt (~490 KB -> ~51 KB per request). Default on with --provider
  --instructions F    replace Codex's built-in system prompt with file F (model_instructions_file)
  --system TEXT       same, with inline text
  --plain             ask-style call inside run: assets/plain.md instructions, no skills/plugins/env context, read-only, ephemeral (~15 KB per request)
  --effort E          low (default) | medium | high | xhigh | max
  --cwd DIR           working directory (default: current)
  --sandbox S         workspace-write (default) | read-only | danger-full-access
  --approval P        on-request (default) | untrusted | never
  --decide D          accept (default) | acceptForSession | decline | cancel  — auto-answer to approval requests
  --schema FILE       JSON schema constraining the final message (outputSchema)
  --image PATH        attach a local image (repeatable)
  --ephemeral         do not persist the thread
  --timeout SEC       turn timeout (default 600)
  --journal FILE      append every protocol message as JSONL
  --detach            run in the background; print {pid, journal, threadFile} immediately
  --stream            print agent deltas to stderr as they arrive
  --text              print only the agent's final text
  --ws URL | --no-ws  shared server URL (default ${DEFAULT_WS}) / force private stdio server

Options for ask/compare/map:
  --file F            attach a file (repeatable). ask/compare: inlined before the prompt. map: the text to chunk
  --prompt-file F     read the prompt from a file (or pass "-" to read stdin)
  --models a,b,group  compare: models and/or groups (prose, cheap, free-all)   --n N  samples per model   --blind   --judge M
  --chunk N           map: chunk size in characters (default 200000)   --concurrency N (default 4)   --label  header per chunk
  --out F             write the main output to F as well as stdout
  --json              full result object instead of text
  --no-log            do not append to usage.jsonl
`;

// Model aliases for --model. A string is one model, an array is a fallback chain, a group is a list of separate
// variants for compare. Every alias except the gpt-5.6/gpt-6 Codex models is an OpenRouter id (Responses API,
// all verified live 2026-09-05) and implies --provider openrouter. `free` = the :free models that completed a
// fix-and-verify agent task through Codex, fastest first. Free endpoints are rate-limited and may log prompts.
const ALIASES = {
  spark: "meta/muse-spark-1.3", "spark-cheap": "meta/muse-spark-1.3-contributor",
  flash: "google/gemini-3.8-flash", "flash-lite": "google/gemini-3.5-flash-lite",
  sonnet: "anthropic/claude-sonnet-5", haiku: "anthropic/claude-haiku-4-5", opus: "anthropic/claude-opus-5",
  gpt: "openai/gpt-5.5", mini: "openai/gpt-5.4-mini", nano: "openai/gpt-5.4-nano",
  deepseek: "deepseek/deepseek-v4-flash", "deepseek-pro": "deepseek/deepseek-v4-pro",
  qwen: "qwen/qwen3.7-flash", "qwen-max": "qwen/qwen3.8-max-0902", glm: "z-ai/glm-5.3-flash",
  mimo: "xiaomi/mimo-v2.5", minimax: "minimax/minimax-m3", kimi: "moonshotai/kimi-k3",
  "nemotron-free": "nvidia/nemotron-3.5-lightning:free", "minimax-free": "minimax/minimax-m2.7:free", "ling-free": "inclusionai/ling-3.0-flash-sante:free",
  "nemotron-super-free": "nvidia/nemotron-3-super-120b-a12b:free", "dots-free": "dots-studio/dots-3-note-preview:free",
  free: ["nemotron-free", "minimax-free", "ling-free", "nemotron-super-free", "dots-free"],
  "cheap-chain": ["deepseek", "qwen", "glm", "free"],
};
const GROUPS = { prose: ["spark", "flash", "sonnet"], cheap: ["deepseek", "qwen", "glm"], "free-all": ["nemotron-free", "minimax-free", "ling-free", "nemotron-super-free", "dots-free"] };
const DEFAULTS = { ask: "flash", compare: "prose", map: "deepseek", judge: "sonnet", chunk: 200000, concurrency: 4 };

const LEAN_OVERRIDES = [
  "features.apps=false", "features.multi_agent=false", "features.browser_use=false", "features.computer_use=false",
  "tools.web_search=false", "mcp_servers.node_repl.enabled=false", "include_apps_instructions=false",
];
// --plain: on top of lean, no skills catalog, plugins, collaboration-mode tools, image tool, permission text or
// environment context. With assets/plain.md as instructions a request is ~15 KB (measured 2026-09-05).
const PLAIN_OVERRIDES = [
  "features.skills=false", "skills.include_instructions=false", "features.plugins=false", "features.collaboration_modes=false",
  "tools.view_image=false", "include_permissions_instructions=false", "include_environment_context=false",
];

// ---- arg parsing ------------------------------------------------------------
const FLAGS = ["ephemeral", "detach", "stream", "text", "no-ws", "stop", "status", "help", "verbose", "json", "lean", "no-lean", "plain", "blind", "label", "no-log"];
function parseArgs(argv) {
  const o = { _: [], image: [], config: [], file: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (FLAGS.includes(k)) o[k] = true;
      else if (k === "image" || k === "config" || k === "file") o[k].push(argv[++i]);
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const out = (obj) => { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); };
const fail = (msg, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(1); };
const note = (s) => process.stderr.write(`[codexctl] ${s}\n`);
const abs = (p) => path.resolve(p || process.cwd());
const fwd = (p) => abs(p).replace(/\\/g, "/"); // -c values are TOML; forward slashes avoid escaping

function sandboxPolicy(s, cwd) {
  if (s === "read-only") return { type: "readOnly" };
  if (s === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [cwd] };
}

// ---- model resolution ---------------------------------------------------------
// "a,b" | alias | group -> ordered list of model ids (chains flattened). Codex-native ids (no "/") stay as they are.
function expand(ref, seen = new Set()) {
  if (seen.has(ref)) return []; seen.add(ref);
  const v = ALIASES[ref];
  if (Array.isArray(v)) return v.flatMap((x) => expand(x, seen));
  return [v || ref];
}
function resolveModel(o, fallback = "gpt-5.6-luna") {
  const spec = String(o.model || fallback);
  const refs = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const chain = refs.flatMap((r) => expand(r));
  const provider = o.provider || (refs.some((r) => ALIASES[r]) || chain.some((m) => m.includes("/")) ? "openrouter" : undefined);
  return { chain, provider, alias: refs.length === 1 && ALIASES[refs[0]] ? refs[0] : undefined };
}
function resolveVariants(spec) {
  return String(spec).split(",").map((s) => s.trim()).filter(Boolean).flatMap((r) => GROUPS[r] || [r]);
}

// ---- connection ---------------------------------------------------------------
function instructionsFile(o) {
  if (o.instructions) return fwd(o.instructions);
  if (o.system !== undefined) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = path.join(STATE_DIR, `instructions-${crypto.createHash("sha1").update(o.system).digest("hex").slice(0, 12)}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, o.system);
    return fwd(f);
  }
  if (o.plain) return fwd(PLAIN_FILE);
  return null;
}

async function connect(o, name = "codexctl") {
  let journal = null;
  if (o.journal) { const fd = fs.openSync(o.journal, "a"); journal = (e) => fs.writeSync(fd, JSON.stringify(e) + "\n"); }
  // --config overrides only reach a private stdio server (a shared `serve` server was configured when it started).
  // --lean (default whenever --provider is set) drops the ChatGPT app connectors, sub-agents, node_repl, browser and
  // computer use: measured 2026-09-05, that cuts each request from ~490 KB / 137k tokens to ~51 KB / 14k tokens.
  const lean = o.lean || o.plain || (o.provider && !o["no-lean"]);
  const instr = instructionsFile(o);
  const extraArgs = [...(lean ? LEAN_OVERRIDES : []), ...(o.plain ? PLAIN_OVERRIDES : []), ...(instr ? [`model_instructions_file=${instr}`] : []), ...o.config].flatMap((kv) => ["-c", kv]);
  const c = new CodexClient({ ws: o["no-ws"] || extraArgs.length ? false : o.ws, decision: o.decide || "accept", journal, verbose: !!o.verbose, extraArgs });
  await c.connect();
  await c.init(name);
  return c;
}

function turnParams(o) {
  const tp = { effort: o.effort || "low" };
  if (o.model) tp.model = o.model;
  if (o.schema) tp.outputSchema = JSON.parse(fs.readFileSync(o.schema, "utf8"));
  return tp;
}

function inputOf(o, prompt) {
  const input = [{ type: "text", text: prompt }];
  for (const p of o.image) input.push({ type: "localImage", path: abs(p) });
  return input;
}

function threadStartParams(o, cwd) {
  return { model: o.model || "gpt-5.6-luna", cwd, sandbox: o.sandbox || "workspace-write", approvalPolicy: o.approval || "on-request", ephemeral: !!o.ephemeral, threadSource: "exec", personality: "pragmatic", ...providerOf(o) };
}

// --provider names a [model_providers.<id>] entry from ~/.codex/config.toml (e.g. openrouter).
function providerOf(o) {
  return o.provider ? { modelProvider: o.provider } : {};
}

// Run one prompt over a model chain: a thread whose turn fails before producing anything (429, provider error)
// is retried on the next model in a fresh thread. Returns the runTurn result plus model/cwd/requested/attempts.
async function runChain(c, o, chain, cwd, prompt) {
  const attempts = [];
  let th, r;
  for (let i = 0; i < chain.length; i++) {
    const oi = { ...o, model: chain[i] };
    th = await c.request("thread/start", threadStartParams(oi, cwd));
    if (o["result-file"]) fs.writeFileSync(o["result-file"] + ".thread", th.thread.id);
    r = await runTurn(c, th.thread.id, inputOf(o, prompt), { turnParams: turnParams(oi), timeoutMs: (Number(o.timeout) || 600) * 1000, onDelta: o.stream ? (d) => process.stderr.write(d) : null });
    const produced = r.items.some((it) => it.type !== "userMessage" && it.type !== "reasoning");
    if (r.status === "completed" || produced || i === chain.length - 1) break;
    const why = String(r.error?.message || JSON.stringify(r.error) || r.status).replace(/\s+/g, " ").slice(0, 160);
    attempts.push({ model: chain[i], threadId: th.thread.id, error: why });
    process.stderr.write(`${chain[i]} failed (${why}), falling back to ${chain[i + 1]}\n`);
  }
  r.model = th.thread.model; r.cwd = cwd;
  if (attempts.length) { r.requested = chain[0]; r.attempts = attempts; }
  return r;
}

function finish(o, r, c) {
  if (c) c.close();
  if (o.text) { process.stdout.write((r.text || "") + "\n"); }
  else out({ ok: r.status === "completed", transport: c ? c.transport : undefined, ...r });
  process.exit(r.status === "completed" ? 0 : 2);
}

// ---- plain calls (ask / compare / map) -------------------------------------------
function readPrompt(o, positional) {
  if (o["prompt-file"]) return fs.readFileSync(o["prompt-file"], "utf8");
  if (positional === "-") return fs.readFileSync(0, "utf8");
  return positional;
}
function attachFiles(files) { return files.map((f) => `<file path="${f}">\n${fs.readFileSync(f, "utf8")}\n</file>`).join("\n\n"); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// One plain call: own instructions, lean+plain prompt, read-only sandbox, ephemeral thread, private server.
async function askOnce(o, modelSpec, prompt, cmd) {
  const { chain, provider, alias } = resolveModel({ ...o, model: modelSpec }, DEFAULTS.ask);
  const oa = { ...o, provider, plain: true, sandbox: o.sandbox || "read-only", approval: o.approval || "never", ephemeral: true, stream: false };
  const c = await connect(oa);
  let r;
  try { r = await runChain(c, oa, chain, abs(o.cwd), prompt); } finally { c.close(); }
  r.alias = alias; r.cost = await priceOf(r.model, r.usage, provider);
  if (r.status !== "completed" && !r.text) r.error = r.error || { message: r.status };
  if (!o["no-log"]) logUsage({ ts: new Date().toISOString(), cmd, model: r.model, requested: r.requested, in: r.usage?.inputTokens || 0, out: r.usage?.outputTokens || 0, cost: r.cost, elapsedMs: r.elapsedMs });
  return r;
}
async function catalog() {
  try { const st = fs.statSync(CATALOG_FILE); if (Date.now() - st.mtimeMs < 86400e3) return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")); } catch {}
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    const map = {}; for (const m of j.data || []) map[m.id] = { in: Number(m.pricing?.prompt || 0), out: Number(m.pricing?.completion || 0), ctx: m.context_length };
    fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(CATALOG_FILE, JSON.stringify(map));
    return map;
  } catch { return {}; }
}
async function priceOf(model, usage, provider) {
  if (provider !== "openrouter" || !usage) return null;
  const p = (await catalog())[model]; if (!p) return null;
  return (usage.inputTokens || 0) * p.in + (usage.outputTokens || 0) * p.out;
}
function logUsage(rec) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + "\n"); } catch {} }
const fmtCost = (c) => c == null ? "n/a" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`;
const statLine = (r) => `${r.alias ? `${r.alias} (${r.model})` : r.model}${r.requested ? ` (fallback from ${r.requested})` : ""}  ${r.usage?.inputTokens || 0} in / ${r.usage?.outputTokens || 0} out  ${fmtCost(r.cost)}  ${(r.elapsedMs / 1000).toFixed(1)}s${r.status !== "completed" ? `  status=${r.status}` : ""}`;

function splitChunks(text, size) {
  const chunks = []; let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > i + size * 0.5) end = nl + 1; }
    chunks.push(text.slice(i, end)); i = end;
  }
  return chunks;
}

// ---- detach ----------------------------------------------------------------
function detach(o, argv) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const journal = o.journal || path.join(STATE_DIR, `run-${stamp}.jsonl`);
  const resultFile = journal.replace(/\.jsonl$/, "") + ".result.json";
  const args = argv.filter((a) => a !== "--detach");
  if (!o.journal) args.push("--journal", journal);
  args.push("--result-file", resultFile);
  const outFd = fs.openSync(journal.replace(/\.jsonl$/, "") + ".log", "a");
  const child = spawn(process.execPath, [__filename, ...args], { detached: true, stdio: ["ignore", outFd, outFd], windowsHide: true });
  child.unref();
  out({ ok: true, detached: true, pid: child.pid, journal, resultFile, hint: "threadId appears in the journal's thread/start result; poll resultFile for the final result" });
  process.exit(0);
}

// ---- commands ---------------------------------------------------------------
const commands = {
  async run(o) {
    const prompt = o._[0]; if (!prompt) fail("run needs a prompt");
    const cwd = abs(o.cwd);
    const { chain, provider } = resolveModel(o);
    o.provider = provider; // before connect(), so --lean applies to alias/OpenRouter runs
    const c = await connect(o);
    const r = await runChain(c, o, chain, cwd, prompt);
    if (o["result-file"]) fs.writeFileSync(o["result-file"], JSON.stringify(r, null, 2));
    finish(o, r, c);
  },
  async resume(o) {
    const [threadId, prompt] = o._; if (!threadId || !prompt) fail("resume needs THREAD and prompt");
    if (o.model) { const m = resolveModel(o); o.model = m.chain[0]; o.provider = m.provider; }
    const c = await connect(o);
    const rs = await c.request("thread/resume", { threadId, excludeTurns: true, ...(o.model ? { model: o.model } : {}), ...providerOf(o), ...(o.sandbox ? { sandbox: o.sandbox } : {}), ...(o.approval ? { approvalPolicy: o.approval } : {}) });
    const r = await runTurn(c, threadId, inputOf(o, prompt), { turnParams: turnParams(o), timeoutMs: (Number(o.timeout) || 600) * 1000, onDelta: o.stream ? (d) => process.stderr.write(d) : null });
    r.model = rs.thread?.model; r.cwd = rs.thread?.cwd;
    if (o["result-file"]) fs.writeFileSync(o["result-file"], JSON.stringify(r, null, 2));
    finish(o, r, c);
  },
  async fork(o) {
    const [threadId, prompt] = o._; if (!threadId || !prompt) fail("fork needs THREAD and prompt");
    if (o.model) { const m = resolveModel(o); o.model = m.chain[0]; o.provider = m.provider; }
    const c = await connect(o);
    const fk = await c.request("thread/fork", { threadId, excludeTurns: true, threadSource: "exec", ...(o.model ? { model: o.model } : {}), ...providerOf(o), ...(o.cwd ? { cwd: abs(o.cwd) } : {}), ...(o.sandbox ? { sandbox: o.sandbox } : {}) });
    const r = await runTurn(c, fk.thread.id, inputOf(o, prompt), { turnParams: turnParams(o), timeoutMs: (Number(o.timeout) || 600) * 1000 });
    r.forkedFrom = threadId; r.model = fk.thread.model;
    finish(o, r, c);
  },
  async steer(o) {
    const [threadId, text] = o._; if (!threadId || !text) fail("steer needs THREAD and text");
    const c = await connect(o);
    if (c.transport !== "ws") { c.close(); fail("steer needs the shared server (run `codexctl serve` first); a private stdio server cannot see turns started elsewhere"); }
    await c.request("thread/resume", { threadId, excludeTurns: true }).catch(() => {});
    const turnId = o.turn || (await activeTurn(c, threadId));
    if (!turnId) { c.close(); fail("no active turn found on thread"); }
    const r = await c.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] }).catch((e) => ({ error: e.message }));
    c.close(); out({ ok: !r.error, threadId, turnId, ...r });
  },
  async interrupt(o) {
    const [threadId] = o._; if (!threadId) fail("interrupt needs THREAD");
    const c = await connect(o);
    if (c.transport !== "ws") { c.close(); fail("interrupt needs the shared server (run `codexctl serve` first)"); }
    await c.request("thread/resume", { threadId, excludeTurns: true }).catch(() => {});
    const turnId = o.turn || (await activeTurn(c, threadId));
    if (!turnId) { c.close(); fail("no active turn found on thread"); }
    const r = await c.request("turn/interrupt", { threadId, turnId }).catch((e) => ({ error: e.message }));
    c.close(); out({ ok: !r.error, threadId, turnId, ...r });
  },
  async review(o) {
    const cwd = abs(o.cwd);
    if (o.model) { const m = resolveModel(o); o.model = m.chain[0]; o.provider = m.provider; }
    const c = await connect(o);
    const th = await c.request("thread/start", { ...threadStartParams(o, cwd), model: o.model || "gpt-5.6-terra", sandbox: "read-only", approvalPolicy: "never" });
    const threadId = th.thread.id;
    const target = o.base ? { type: "baseBranch", branch: o.base } : o.commit ? { type: "commit", sha: o.commit } : o.custom ? { type: "custom", instructions: o.custom } : { type: "uncommittedChanges" };
    const done = c.waitFor("turn/completed", (p) => p.threadId === threadId, (Number(o.timeout) || 900) * 1000);
    const t0 = Date.now();
    await c.request("review/start", { threadId, target, delivery: "inline" });
    const completed = await done;
    const items = await c.request("thread/items/list", { threadId, limit: 100 });
    const exit = (items.data || []).map((i) => i.item || i).find((i) => i.type === "exitedReviewMode");
    const msg = (items.data || []).map((i) => i.item || i).filter((i) => i.type === "agentMessage").pop();
    const r = { threadId, status: completed.turn?.status, text: exit?.review || exit?.text || msg?.text || "", target, elapsedMs: Date.now() - t0 };
    finish(o, r, c);
  },
  async show(o) {
    const [threadId] = o._; if (!threadId) fail("show needs THREAD");
    const c = await connect(o);
    const th = await c.request("thread/read", { threadId, includeTurns: false }).catch((e) => ({ error: e.message }));
    await c.request("thread/resume", { threadId, excludeTurns: true }).catch(() => {});
    const items = await c.request("thread/items/list", { threadId, limit: Number(o.limit) || 100 }).catch((e) => ({ error: e.message }));
    const turns = await c.request("thread/turns/list", { threadId }).catch(() => ({}));
    c.close();
    const t = th.thread || {};
    out({ ok: !th.error, thread: { id: t.id, model: t.model, cwd: t.cwd, status: t.status, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, preview: t.preview }, turns: (turns.data || []).map((x) => ({ id: x.id, status: x.status })), items: (items.data || []).map((i) => itemSummary(i.item || i)) });
  },
  async list(o) {
    const c = await connect(o);
    const lst = await c.request("thread/list", { limit: Number(o.limit) || 20 });
    c.close();
    let data = lst.data || [];
    if (o.cwd) { const want = abs(o.cwd).toLowerCase(); data = data.filter((t) => (t.cwd || "").toLowerCase().startsWith(want)); }
    out({ ok: true, threads: data.map((t) => ({ id: t.id, model: t.model, cwd: t.cwd, status: t.status?.type, updatedAt: t.updatedAt, preview: (t.preview || "").slice(0, 80) })), nextCursor: lst.nextCursor });
  },
  async delete(o) {
    if (!o._.length) fail("delete needs THREAD ids");
    const c = await connect(o);
    const results = {};
    for (const id of o._) { await c.request("thread/archive", { threadId: id }).catch(() => {}); results[id] = await c.request("thread/delete", { threadId: id }).then(() => "deleted").catch((e) => e.message); }
    c.close(); out({ ok: true, results });
  },
  async models(o) {
    const c = await connect(o);
    const m = await c.request("model/list", {});
    c.close();
    out({ ok: true, models: (m.data || []).map((x) => ({ id: x.id, displayName: x.displayName, default: x.isDefault, efforts: (x.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), defaultEffort: x.defaultReasoningEffort })) });
  },
  async account(o) { const c = await connect(o); const a = await c.request("account/read", {}); c.close(); out({ ok: true, ...a }); },
  async limits(o) { const c = await connect(o); const a = await c.request("account/rateLimits/read", {}); c.close(); out({ ok: true, ...a }); },
  async exec(o) {
    if (!o._.length) fail("exec needs -- cmd args");
    const cwd = abs(o.cwd);
    const c = await connect(o);
    const r = await c.request("command/exec", { command: o._, cwd, timeoutMs: (Number(o.timeout) || 120) * 1000, sandboxPolicy: sandboxPolicy(o.sandbox || "workspace-write", cwd) }).catch((e) => ({ error: e.message }));
    c.close(); out({ ok: !r.error, ...r });
  },
  async serve(o) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const url = o.ws || DEFAULT_WS;
    const existing = fs.existsSync(SERVER_FILE) ? JSON.parse(fs.readFileSync(SERVER_FILE, "utf8")) : null;
    const alive = await probeWs(url);
    if (o.status) { out({ ok: true, url, alive, ...(existing || {}) }); process.exit(0); }
    if (o.stop) {
      if (existing?.pid) { try { process.platform === "win32" ? execSync(`taskkill /PID ${existing.pid} /T /F`, { stdio: "ignore" }) : process.kill(-existing.pid); } catch {} }
      try { fs.unlinkSync(SERVER_FILE); } catch {}
      out({ ok: true, stopped: true, wasAlive: alive, stillAlive: await probeWs(url) }); process.exit(0);
    }
    if (alive) { out({ ok: true, url, alreadyRunning: true, ...(existing || {}) }); process.exit(0); }
    const logFd = fs.openSync(path.join(STATE_DIR, "server.log"), "a");
    const child = spawn("codex", ["app-server", "--listen", url], { shell: true, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
    child.unref();
    const info = { pid: child.pid, url, startedAt: new Date().toISOString(), log: path.join(STATE_DIR, "server.log") };
    fs.writeFileSync(SERVER_FILE, JSON.stringify(info, null, 2));
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 300)); if (await probeWs(url, 500)) { out({ ok: true, started: true, ...info }); process.exit(0); } }
    out({ ok: false, error: "server did not become reachable", ...info }); process.exit(1);
  },
  async schema() { execSync(`node "${path.join(__dirname, "gen-protocol.js")}"`, { stdio: "inherit" }); },

  // ---- plain calls ----
  async ask(o) {
    let modelRef = o.model, prompt;
    if (o._.length >= 2) { modelRef = modelRef || o._[0]; prompt = readPrompt(o, o._[1]); } else prompt = readPrompt(o, o._[0]);
    if (!prompt && !o.file.length) fail("ask needs a prompt");
    const full = o.file.length ? `${attachFiles(o.file)}\n\n${prompt || ""}`.trim() : prompt;
    const r = await askOnce(o, modelRef || DEFAULTS.ask, full, "ask");
    note(statLine(r));
    if (o.out) fs.writeFileSync(o.out, r.text);
    if (o.json) out({ ok: r.status === "completed", ...r }); else process.stdout.write(r.text + (r.text.endsWith("\n") ? "" : "\n"));
    process.exitCode = r.status === "completed" ? 0 : 2; // no process.exit(): it races the closing child handle on Windows (libuv assert)
  },
  async compare(o) {
    const prompt = readPrompt(o, o._[0]); if (!prompt) fail("compare needs a prompt");
    const full = o.file.length ? `${attachFiles(o.file)}\n\n${prompt}`.trim() : prompt;
    const models = resolveVariants(o.models || DEFAULTS.compare);
    const n = Number(o.n || 1);
    const jobs = []; for (const m of models) for (let i = 0; i < n; i++) jobs.push({ spec: m, sample: i + 1 });
    if (jobs.length > LABELS.length) fail(`too many variants (${jobs.length})`);
    note(`running ${jobs.length} variant(s): ${models.join(", ")}${n > 1 ? ` x${n}` : ""}`);
    const results = await Promise.all(jobs.map(async (j) => {
      try { const r = await askOnce(o, j.spec, full, "compare"); return r.text ? { ...j, result: r } : { ...j, error: String(r.error?.message || r.error || r.status) }; }
      catch (e) { return { ...j, error: String(e.message || e) }; }
    }));
    const order = results.map((_, i) => i);
    if (o.blind) for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
    const variants = order.map((idx, li) => ({ label: LABELS[li], ...results[idx] }));
    const runId = `${stamp()}-compare`;
    const dir = path.join(STATE_DIR, "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const key = variants.map((v) => `${v.label} = ${v.result ? (v.result.alias ? `${v.result.alias} (${v.result.model})` : v.result.model) : v.spec}${n > 1 ? ` #${v.sample}` : ""}${v.result ? `${v.result.requested ? `, answered after fallback from ${v.result.requested}` : ""}, ${(v.result.elapsedMs / 1000).toFixed(1)}s, ${v.result.usage?.outputTokens || 0} out, ${fmtCost(v.result.cost)}` : `, ERROR: ${v.error.replace(/\s+/g, " ")}`}`);
    const failed = variants.filter((v) => v.error).length;
    if (failed) { note(`${failed} of ${variants.length} variant(s) failed`); process.exitCode = 1; if (failed === variants.length) fail("every variant failed", { key }); }
    let md = `# compare ${runId}\n\n`;
    if (o.system) md += `**system:** ${o.system.length > 300 ? o.system.slice(0, 300) + "…" : o.system}\n\n`;
    md += `**prompt:** ${prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt}\n\n`;
    for (const v of variants) md += `## ${v.label}\n\n${v.result ? v.result.text.trim() : `_error: ${v.error}_`}\n\n`;
    let judge = null;
    if (o.judge) {
      const jm = o.judge === "default" ? DEFAULTS.judge : o.judge;
      const jprompt = `You are judging ${variants.length} candidate responses to the same brief. Rank them best to worst and explain briefly what separates them (voice, specificity, rhythm, clichés, accuracy, fit to the brief). Be concrete; quote phrases. End with one line: RANKING: <labels best to worst>.\n\n<brief>\n${o.system ? `SYSTEM: ${o.system}\n\n` : ""}${prompt}\n</brief>\n\n` + variants.map((v) => `<candidate label="${v.label}">\n${v.result ? v.result.text.trim() : "(error)"}\n</candidate>`).join("\n\n");
      try { judge = await askOnce({ ...o, system: undefined, instructions: undefined }, jm, jprompt, "judge"); note(statLine(judge)); md += `## judge (${judge.model})\n\n${judge.text.trim()}\n\n`; }
      catch (e) { md += `## judge\n\n_error: ${e.message}_\n\n`; }
    }
    md += o.blind ? `---\n_blind run; \`codexctl reveal ${runId}\` shows the key_\n` : `---\n${key.map((k) => `- ${k}`).join("\n")}\n`;
    const total = variants.reduce((s, v) => s + (v.result?.cost || 0), 0);
    fs.writeFileSync(path.join(dir, "variants.md"), md);
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ runId, prompt, system: o.system || null, blind: !!o.blind, key, totalCost: total, variants: variants.map((v) => ({ label: v.label, model: v.result?.model, requested: v.spec, alias: v.result?.alias, sample: v.sample, text: v.result?.text, usage: v.result?.usage, cost: v.result?.cost, elapsedMs: v.result?.elapsedMs, attempts: v.result?.attempts, error: v.error })), judge: judge && { model: judge.model, text: judge.text, usage: judge.usage, cost: judge.cost } }, null, 2));
    fs.writeFileSync(path.join(STATE_DIR, "runs", "latest"), runId);
    note(`saved ${dir}  total ${fmtCost(total)}`);
    if (o.out) fs.writeFileSync(o.out, md);
    process.stdout.write(o.json ? fs.readFileSync(path.join(dir, "run.json")) : md);
  },
  reveal(o) {
    let id = o._[0] || "latest";
    if (id === "latest") id = fs.readFileSync(path.join(STATE_DIR, "runs", "latest"), "utf8").trim();
    const run = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "runs", id, "run.json"), "utf8"));
    process.stdout.write(run.key.map((k) => `${k}\n`).join("") + `total ${fmtCost(run.totalCost)}\n`);
  },
  async map(o) {
    const instruction = readPrompt(o, o._[0]); if (!instruction) fail("map needs an instruction");
    if (!o.file.length) fail("map needs at least one --file");
    const spec = o.model || DEFAULTS.map;
    const size = Number(o.chunk || DEFAULTS.chunk), conc = Number(o.concurrency || DEFAULTS.concurrency);
    const chunks = [];
    for (const f of o.file) for (const [i, c] of splitChunks(fs.readFileSync(f, "utf8"), size).entries()) chunks.push({ file: f, index: i, text: c });
    note(`${chunks.length} chunk(s) of <=${size} chars from ${o.file.length} file(s) -> ${spec}, concurrency ${conc}`);
    const outs = new Array(chunks.length);
    let next = 0, cost = 0, inTok = 0, outTok = 0, failed = 0, model = spec;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++; const c = chunks[i];
        const prompt = `<chunk file="${c.file}" part="${c.index + 1}">\n${c.text}\n</chunk>\n\n${instruction}`;
        try {
          const r = await askOnce(o, spec, prompt, "map");
          if (!r.text) throw new Error(String(r.error?.message || r.error || r.status));
          outs[i] = r.text.trim(); cost += r.cost || 0; inTok += r.usage?.inputTokens || 0; outTok += r.usage?.outputTokens || 0; model = r.model;
          note(`chunk ${i + 1}/${chunks.length} done  ${statLine(r)}`);
        } catch (e) { failed++; const m = String(e.message).replace(/\s+/g, " "); outs[i] = `<!-- chunk ${i + 1} failed: ${m} -->`; note(`chunk ${i + 1} FAILED: ${m}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));
    const text = chunks.map((c, i) => (o.label ? `### ${path.basename(c.file)} part ${c.index + 1}\n\n` : "") + outs[i]).join("\n\n") + "\n";
    note(`map total: ${inTok} in / ${outTok} out  ${fmtCost(cost)}${failed ? `  ${failed} of ${chunks.length} chunk(s) FAILED` : ""}`);
    if (o.out) fs.writeFileSync(o.out, text);
    process.stdout.write(o.json ? JSON.stringify({ model, chunks: chunks.length, failed, usage: { in: inTok, out: outTok }, cost, outputs: outs }, null, 2) + "\n" : text);
    process.exitCode = failed ? 1 : 0;
  },
  usage(o) {
    if (!fs.existsSync(USAGE_FILE)) return process.stdout.write("no usage recorded\n");
    const days = Number(o.days || 30), since = Date.now() - days * 86400e3;
    const by = {}; const total = { calls: 0, in: 0, out: 0, cost: 0, unknown: 0 };
    for (const line of fs.readFileSync(USAGE_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (Date.parse(r.ts) < since) continue;
      const b = (by[r.model] ||= { calls: 0, in: 0, out: 0, cost: 0, unknown: 0 });
      for (const x of [b, total]) { x.calls++; x.in += r.in || 0; x.out += r.out || 0; if (r.cost == null) x.unknown++; else x.cost += r.cost; }
    }
    process.stdout.write(`last ${days} days\n${"model".padEnd(48)} calls      in       out      cost\n`);
    for (const [id, b] of Object.entries(by).sort((a, b) => b[1].cost - a[1].cost)) process.stdout.write(`${String(id).padEnd(48)} ${String(b.calls).padStart(5)} ${String(b.in).padStart(8)} ${String(b.out).padStart(8)}  ${fmtCost(b.cost)}${b.unknown ? ` (+${b.unknown} unpriced)` : ""}\n`);
    process.stdout.write(`${"total".padEnd(48)} ${String(total.calls).padStart(5)} ${String(total.in).padStart(8)} ${String(total.out).padStart(8)}  ${fmtCost(total.cost)}${total.unknown ? ` (+${total.unknown} unpriced)` : ""}\n`);
  },
  aliases() {
    for (const [a, m] of Object.entries(ALIASES)) process.stdout.write(`${a.padEnd(20)} ${Array.isArray(m) ? `chain: ${m.join(" -> ")}` : m}\n`);
    for (const [g, ms] of Object.entries(GROUPS)) process.stdout.write(`${("group:" + g).padEnd(20)} ${ms.join(", ")}\n`);
    process.stdout.write(`defaults: ${JSON.stringify(DEFAULTS)}\n`);
  },
};

async function activeTurn(c, threadId) {
  const turns = await c.request("thread/turns/list", { threadId }).catch(() => ({ data: [] }));
  const active = (turns.data || []).filter((t) => t.status === "inProgress").pop();
  return active?.id || null;
}

(async () => {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  const cmd = o._.shift();
  if (!cmd || o.help || !commands[cmd]) { process.stdout.write(USAGE); process.exit(cmd && !commands[cmd] ? 1 : 0); }
  if (o.detach) return detach(o, argv);
  try { await commands[cmd](o); }
  catch (e) { fail(e.message, { rpc: e.rpc, stack: o.verbose ? e.stack : undefined }); }
})();
