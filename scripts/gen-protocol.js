// gen-protocol.js — regenerate references/protocol.md from the installed Codex CLI's schema.
// Usage: node gen-protocol.js [--out ../references/protocol.md]
"use strict";
const fs = require("fs"); const path = require("path"); const os = require("os"); const { execSync } = require("child_process");

const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, "..", "references", "protocol.md");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-"));
const version = execSync("codex --version", { encoding: "utf8" }).trim();
execSync(`codex app-server generate-json-schema --out "${tmp}"`, { stdio: "ignore" });

const load = (f) => JSON.parse(fs.readFileSync(path.join(tmp, f), "utf8"));
const client = load("ClientRequest.json");
const defs = client.definitions || client.$defs || {};
const resolve = (o) => (o && o.$ref ? defs[o.$ref.split("/").pop()] : o);

function typeOf(v) {
  v = resolve(v) || {};
  if (v.enum) return v.enum.map((e) => JSON.stringify(e)).join("|");
  if (v.oneOf || v.anyOf) {
    const alts = (v.oneOf || v.anyOf).map(resolve).filter(Boolean);
    const enums = alts.filter((a) => a.enum).flatMap((a) => a.enum);
    const tags = alts.map((a) => a.properties?.type?.enum?.[0]).filter(Boolean);
    if (enums.length && !tags.length) return enums.map((e) => JSON.stringify(e)).join("|") + (alts.some((a) => a.type === "null") ? "|null" : "");
    if (tags.length) return "{type:" + tags.join("|") + ",...}";
    return alts.map((a) => a.type || "obj").join("|");
  }
  if (Array.isArray(v.type)) return v.type.join("|");
  if (v.type === "array") return "array<" + typeOf(v.items) + ">";
  return v.type || "any";
}

function paramsLine(p) {
  p = resolve(p);
  if (!p || !p.properties) return p && p.type === "null" ? "(none)" : "(object)";
  const req = new Set(p.required || []);
  return Object.entries(p.properties).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}:${typeOf(v)}`).join(", ");
}

function methodsOf(schema) {
  const out = [];
  for (const variant of schema.oneOf || []) {
    const m = variant.properties?.method; if (!m) continue;
    const name = m.enum ? m.enum[0] : m.const;
    out.push({ name, params: variant.properties.params, desc: variant.description || "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const lines = [];
lines.push(`# Codex app-server protocol (generated)`, ``, `Generated ${new Date().toISOString().slice(0, 10)} from \`${version}\` via \`codex app-server generate-json-schema\`. Regenerate with \`node scripts/gen-protocol.js\`.`, ``);
lines.push(`Wire format: newline-delimited JSON-RPC 2.0. Handshake: \`initialize\` {clientInfo:{name,title,version}} then notification \`initialized\`. Params/results are camelCase.`, ``);
lines.push(`## Client → server requests`, ``, `| method | params |`, `|---|---|`);
for (const m of methodsOf(client)) lines.push(`| \`${m.name}\` | ${paramsLine(m.params).replace(/\|/g, "\\|")} |`);
const server = load("ServerRequest.json");
lines.push(``, `## Server → client requests (must be answered with a response carrying the same id)`, ``, `| method | params |`, `|---|---|`);
for (const m of methodsOf(server)) lines.push(`| \`${m.name}\` | ${paramsLine(m.params).replace(/\|/g, "\\|")} |`);
lines.push(``, `Decisions: \`item/*/requestApproval\` → {decision: "accept"|"acceptForSession"|"decline"|"cancel"}; legacy \`execCommandApproval\`/\`applyPatchApproval\` → {decision: "approved"|"approved_for_session"|"denied"|"abort"}.`);
const notif = load("ServerNotification.json");
lines.push(``, `## Server → client notifications`, ``);
lines.push(methodsOf(notif).map((m) => `\`${m.name}\``).join(", "));
for (const name of ["UserInput", "SandboxPolicy", "AskForApproval", "ThreadGoalStatus"]) {
  if (defs[name]) lines.push(``, `## ${name}`, ``, "```json", JSON.stringify(defs[name], null, 0).slice(0, 1500), "```");
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join("\n") + "\n");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} (${lines.length} lines, ${version})`);
