#!/usr/bin/env node
/**
 * A stand-in for the Neo server for the `desktop-windows` job (no secrets, no database).
 *
 *   node fake-neo-server.mjs --port 3007 --static-dir <dir> --static-port 8000 --log <file>
 *
 * - The API on --port answers from the recorded fixtures in crates/agent-core/tests/fixtures/http
 *   (the same ones the Rust tests use) and appends one `METHOD /path` line per request to --log,
 *   so the job can assert, for example, that an uninstall sent DELETE /api/devices/self and an
 *   upgrade did not.
 * - --static-dir is served read-only on --static-port: the update manifest and the MSI.
 */
import { createReadStream, existsSync, appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const port = Number(args.port ?? 3007);
const logFile = args.log ?? "requests.log";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "crates", "agent-core", "tests", "fixtures", "http");
writeFileSync(logFile, "");

function fixture(name) {
  const f = JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"));
  // A fresh device has nothing expected: every tool is unexpected in this run.
  if (f.body?.device) f.body.device.expectedTools = [];
  return f;
}

const routes = {
  "POST /api/devices/enroll/preview": () => fixture("enroll_preview"),
  "POST /api/devices/enroll": () => fixture("enroll"),
  "POST /api/devices/heartbeat": () => fixture("heartbeat"),
  "GET /api/signals/lists": () => fixture("lists"),
  "POST /api/devices/check-url": () => fixture("check_url"),
  "DELETE /api/devices/self": () => ({ status: 204, headers: {}, body: "" }),
  "POST /api/signals": (body) => ({
    status: 200,
    headers: {},
    body: { results: (JSON.parse(body || "{}").events ?? []).map((e) => ({ id: e.id, status: "accepted", severity: "high" })) },
  }),
};

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  const key = `${req.method} ${path}`;
  appendFileSync(logFile, `${key}\n`);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const route = routes[key];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no route ${key}`, code: "not_found" }));
    }
    const out = route(Buffer.concat(chunks).toString("utf8"));
    const body = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
    res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
    res.end(body);
  });
}).listen(port, "127.0.0.1", () => console.log(`fake Neo API on http://127.0.0.1:${port}, logging to ${logFile}`));

if (args["static-dir"]) {
  const root = normalize(args["static-dir"]);
  createServer((req, res) => {
    const file = normalize(join(root, decodeURIComponent((req.url ?? "/").split("?")[0])));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "application/octet-stream" });
    createReadStream(file).pipe(res);
  }).listen(Number(args["static-port"] ?? 8000), "127.0.0.1", () => console.log(`static files from ${root} on http://127.0.0.1:${args["static-port"] ?? 8000}`));
}
