#!/usr/bin/env node
// codexctl — drive the Codex app-server (JSON-RPC control plane) from the command line.
// All commands print one JSON object on stdout (use --text to print only the agent's reply).
"use strict";
const fs = require("fs"); const path = require("path"); const os = require("os"); const { spawn, execSync } = require("child_process");
const { CodexClient, runTurn, itemSummary, probeWs, DEFAULT_WS } = require("./codexrpc");

const STATE_DIR = path.join(os.homedir(), ".codexctl");
const SERVER_FILE = path.join(STATE_DIR, "server.json");

const USAGE = `codexctl — Codex app-server control plane CLI (JSON out)

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

Options for run/resume/fork/review:
  --model M[,M2,...]  gpt-5.6-luna (default) | gpt-5.6-terra | gpt-5.6-sol | gpt-6-astra | ... (run: comma list = fallback chain; "free" = OpenRouter free chain)
  --provider P        model provider id from ~/.codex/config.toml [model_providers.*] (e.g. openrouter; then --model is an OpenRouter id)
  --config k=v        codex -c override for this invocation (repeatable; forces a private server). e.g. --config model_providers.x.base_url=http://127.0.0.1:8787/v1
  --lean | --no-lean  drop app connectors, sub-agents, node_repl, browser/computer use from the prompt (~490 KB -> ~51 KB per request). Default on with --provider
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
`;

// `--model free` = the OpenRouter :free models that completed a fix-and-verify agent task through Codex on 2026-09-05,
// fastest first. They need `[model_providers.openrouter]` in ~/.codex/config.toml (see SKILL.md).
const MODEL_CHAINS = {
  free: { provider: "openrouter", models: ["nvidia/nemotron-3.5-lightning:free", "minimax/minimax-m2.7:free", "inclusionai/ling-3.0-flash-sante:free", "nvidia/nemotron-3-super-120b-a12b:free", "dots-studio/dots-3-note-preview:free"] },
};

const LEAN_OVERRIDES = [
  "features.apps=false", "features.multi_agent=false", "features.browser_use=false", "features.computer_use=false",
  "tools.web_search=false", "mcp_servers.node_repl.enabled=false", "include_apps_instructions=false",
];

// ---- arg parsing ------------------------------------------------------------
function parseArgs(argv) {
  const o = { _: [], image: [], config: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const flags = ["ephemeral", "detach", "stream", "text", "no-ws", "stop", "status", "help", "verbose", "json", "lean", "no-lean"];
      if (flags.includes(k)) o[k] = true;
      else if (k === "image") o.image.push(argv[++i]);
      else if (k === "config") o.config.push(argv[++i]);
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const out = (obj) => { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); };
const fail = (msg, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(1); };
const abs = (p) => path.resolve(p || process.cwd());

function sandboxPolicy(s, cwd) {
  if (s === "read-only") return { type: "readOnly" };
  if (s === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [cwd] };
}

async function connect(o, name = "codexctl") {
  let journal = null;
  if (o.journal) { const fd = fs.openSync(o.journal, "a"); journal = (e) => fs.writeSync(fd, JSON.stringify(e) + "\n"); }
  // --config overrides only reach a private stdio server (a shared `serve` server was configured when it started).
  // --lean (default whenever --provider is set) drops the ChatGPT app connectors, sub-agents, node_repl, browser and
  // computer use: measured 2026-09-05, that cuts each request from ~490 KB / 137k tokens to ~51 KB / 14k tokens.
  const lean = o.lean || (o.provider && !o["no-lean"]);
  const extraArgs = [...(lean ? LEAN_OVERRIDES : []), ...o.config].flatMap((kv) => ["-c", kv]);
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

function finish(o, r, c) {
  if (c) c.close();
  if (o.text) { process.stdout.write((r.text || "") + "\n"); }
  else out({ ok: r.status === "completed", transport: c ? c.transport : undefined, ...r });
  process.exit(r.status === "completed" ? 0 : 2);
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
    const c = await connect(o);
    // --model a,b,c is a fallback chain: a thread whose turn fails before producing anything (429, provider error)
    // is retried on the next model in a fresh thread.
    const alias = MODEL_CHAINS[o.model];
    if (alias && !o.provider) o.provider = alias.provider;
    const chain = alias ? alias.models : String(o.model || "gpt-5.6-luna").split(",").map((s) => s.trim()).filter(Boolean);
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
    if (o["result-file"]) fs.writeFileSync(o["result-file"], JSON.stringify(r, null, 2));
    finish(o, r, c);
  },
  async resume(o) {
    const [threadId, prompt] = o._; if (!threadId || !prompt) fail("resume needs THREAD and prompt");
    const c = await connect(o);
    const rs = await c.request("thread/resume", { threadId, excludeTurns: true, ...(o.model ? { model: o.model } : {}), ...providerOf(o), ...(o.sandbox ? { sandbox: o.sandbox } : {}), ...(o.approval ? { approvalPolicy: o.approval } : {}) });
    const r = await runTurn(c, threadId, inputOf(o, prompt), { turnParams: turnParams(o), timeoutMs: (Number(o.timeout) || 600) * 1000, onDelta: o.stream ? (d) => process.stderr.write(d) : null });
    r.model = rs.thread?.model; r.cwd = rs.thread?.cwd;
    if (o["result-file"]) fs.writeFileSync(o["result-file"], JSON.stringify(r, null, 2));
    finish(o, r, c);
  },
  async fork(o) {
    const [threadId, prompt] = o._; if (!threadId || !prompt) fail("fork needs THREAD and prompt");
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
