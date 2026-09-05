// codexrpc.js — minimal JSON-RPC client for `codex app-server`.
// Transport: a shared WebSocket server (started with `codexctl serve`) when reachable,
// otherwise a private stdio-spawned app-server for this process. Node >= 22 (native WebSocket).
"use strict";
const { spawn } = require("child_process");
const EventEmitter = require("events");

const DEFAULT_WS = process.env.CODEXCTL_WS || "ws://127.0.0.1:47600";

class CodexClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.transport = null; // "ws" | "stdio"
    this.approvalHandler = opts.approvalHandler || ((m, p) => this.defaultApproval(m, p));
    this.journal = opts.journal || null; // function(obj) for JSONL logging
    this.buf = "";
  }

  // ---- connection -----------------------------------------------------------
  async connect() {
    const url = this.opts.ws === false ? null : (this.opts.ws || DEFAULT_WS);
    if (url && (await this.tryWs(url))) { this.transport = "ws"; return this; }
    if (this.opts.ws && this.opts.requireWs) throw new Error(`cannot reach app-server at ${url}`);
    this.spawnStdio();
    this.transport = "stdio";
    return this;
  }

  tryWs(url) {
    return new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(url); } catch { return resolve(false); }
      const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, this.opts.wsTimeoutMs || 1500);
      ws.onopen = () => { clearTimeout(t); this.ws = ws; ws.onmessage = (ev) => this.dispatchLine(String(ev.data)); ws.onclose = (e) => this.emit("exit", e.code, "ws-closed"); resolve(true); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
  }

  spawnStdio() {
    const args = ["app-server", "--listen", "stdio://", ...(this.opts.extraArgs || [])];
    this.child = spawn("codex", args, { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (line.trim()) this.dispatchLine(line); }
    });
    this.child.stderr.on("data", (d) => { this.stderrTail = ((this.stderrTail || "") + d).slice(-2000); if (this.opts.verbose) process.stderr.write("[app-server] " + d); });
    this.child.on("exit", (c, s) => {
      // A bad -c override makes the server exit at once; fail pending requests with its stderr instead of timing out.
      const why = `app-server exited (code ${c}${s ? `, ${s}` : ""}): ${(this.stderrTail || "").trim().replace(/\s+/g, " ").slice(-400) || "no stderr"}`;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.emit("exit", c, s);
    });
  }

  raw(obj) {
    const s = JSON.stringify(obj);
    if (this.opts.verbose) process.stderr.write(">> " + s.slice(0, 300) + "\n");
    if (this.ws) this.ws.send(s); else this.child.stdin.write(s + "\n");
  }

  close() {
    for (const p of this.pending.values()) p.reject(new Error("client closed"));
    this.pending.clear();
    if (this.ws) { try { this.ws.close(); } catch {} }
    if (this.child) { try { this.child.stdin.end(); } catch {} this.child.kill(); }
  }

  // ---- dispatch -------------------------------------------------------------
  dispatchLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { if (this.opts.verbose) process.stderr.write("<< raw " + line.slice(0, 200) + "\n"); return; }
    if (this.journal) this.journal({ ts: Date.now(), dir: "in", msg });
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "rpc error"), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) { // server -> client request (approvals, tool calls, user input)
      this.serverRequests.push(msg);
      this.emit("serverRequest", msg);
      Promise.resolve(this.approvalHandler(msg.method, msg.params, msg))
        .then((result) => this.raw({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((e) => this.raw({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }));
      return;
    }
    if (msg.method) { this.notifications.push(msg); this.emit("notification", msg); this.emit(msg.method, msg.params, msg); }
  }

  // decision: "accept" | "acceptForSession" | "decline" | "cancel"
  defaultApproval(method, params) {
    const d = this.opts.decision || "accept";
    const legacy = { accept: "approved", acceptForSession: "approved_for_session", decline: "denied", cancel: "abort" };
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": return { decision: d };
      case "execCommandApproval":
      case "applyPatchApproval": return { decision: legacy[d] || "approved" };
      case "item/tool/requestUserInput": return { answers: {} };
      default: return {};
    }
  }

  // ---- rpc ------------------------------------------------------------------
  request(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      if (this.journal) this.journal({ ts: Date.now(), dir: "out", msg: { id, method, params } });
      this.raw({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) { this.raw({ jsonrpc: "2.0", method, params }); }

  async init(name = "codexctl") {
    const r = await this.request("initialize", { clientInfo: { name, title: name, version: "0.2.0" } });
    this.notify("initialized");
    return r;
  }

  waitFor(method, pred = () => true, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(method, h); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const h = (params, msg) => { if (pred(params, msg)) { clearTimeout(t); this.off(method, h); resolve(params); } };
      this.on(method, h);
    });
  }
}

// Summarize a completed item for traces.
function itemSummary(it) {
  const s = { type: it.type, id: it.id };
  if (it.type === "agentMessage") s.text = it.text;
  if (it.type === "commandExecution") { s.command = it.command; s.exitCode = it.exitCode; s.status = it.status; s.output = (it.aggregatedOutput || "").slice(0, 2000); }
  if (it.type === "fileChange") { s.status = it.status; s.files = (it.changes || []).map((c) => c.path); }
  if (it.type === "reasoning") s.summary = (it.summary || []).join(" ");
  if (it.type === "mcpToolCall") { s.tool = it.tool || it.name; s.status = it.status; }
  return s;
}

// Run one turn on a thread; resolve when turn/completed arrives.
async function runTurn(client, threadId, input, opts = {}) {
  const t0 = Date.now();
  const items = [];
  let text = "";
  let usage = null;
  const errors = [];
  const approvals = [];
  const onItem = (p) => { if (p.threadId === threadId) items.push(itemSummary(p.item)); if (p.threadId === threadId && p.item.type === "agentMessage") text += p.item.text || ""; };
  const onDelta = (p) => { if (p.threadId === threadId && opts.onDelta) opts.onDelta(p.delta); };
  const onUsage = (p) => { if (p.threadId === threadId) usage = p.tokenUsage?.last || p.tokenUsage; };
  const onErr = (p) => { if (!p.threadId || p.threadId === threadId) errors.push(p); };
  const onReq = (m) => { if (m.params?.threadId === threadId) approvals.push({ method: m.method, kind: m.params.kind, command: m.params.command, reason: m.params.reason }); };
  client.on("item/completed", onItem); client.on("item/agentMessage/delta", onDelta); client.on("thread/tokenUsage/updated", onUsage); client.on("error", onErr); client.on("serverRequest", onReq);
  const done = client.waitFor("turn/completed", (p) => p.threadId === threadId, opts.timeoutMs || 600000);
  const params = { threadId, input: typeof input === "string" ? [{ type: "text", text: input }] : input, ...(opts.turnParams || {}) };
  const started = await client.request("turn/start", params);
  const turnId = started.turn?.id;
  if (opts.onStarted) opts.onStarted(turnId);
  let completed;
  try { completed = await done; } finally {
    client.off("item/completed", onItem); client.off("item/agentMessage/delta", onDelta); client.off("thread/tokenUsage/updated", onUsage); client.off("error", onErr); client.off("serverRequest", onReq);
  }
  return { threadId, turnId, status: completed.turn?.status, error: completed.turn?.error || (errors[0]?.error ?? null), text, items, usage, approvals, elapsedMs: Date.now() - t0 };
}

// Is a WS app-server reachable at url? Opens and immediately closes a socket.
function probeWs(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return resolve(false); }
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, timeoutMs);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
}

module.exports = { CodexClient, runTurn, itemSummary, probeWs, DEFAULT_WS };
