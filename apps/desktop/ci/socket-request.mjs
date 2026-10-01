#!/usr/bin/env node
/**
 * Sends one request to the macOS daemon's socket and prints the one-line reply (the macOS
 * counterpart of pipe-request.ps1). A plain Node client rather than `nc -U`, whose end-of-input
 * handling differs between BSD netcat versions.
 *
 *   node socket-request.mjs '{"op":"status"}' [--path /var/run/neo-agent.sock] [--timeout 20]
 *
 * Exits 1 with a message on stderr when the socket cannot be reached or does not answer in time.
 */
import { createConnection } from "node:net";

const args = process.argv.slice(2);
const request = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!request || request.startsWith("--")) {
  console.error("usage: socket-request.mjs '<json request>' [--path <socket>] [--timeout <seconds>]");
  process.exit(2);
}
const path = opt("path", "/var/run/neo-agent.sock");
const timeoutMs = Number(opt("timeout", "20")) * 1000;

const socket = createConnection({ path });
let buffer = "";
const timer = setTimeout(() => {
  console.error(`no answer from ${path} within ${timeoutMs / 1000}s`);
  process.exit(1);
}, timeoutMs);

socket.on("connect", () => socket.write(`${request}\n`));
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const nl = buffer.indexOf("\n");
  if (nl >= 0) {
    clearTimeout(timer);
    process.stdout.write(`${buffer.slice(0, nl)}\n`);
    socket.end();
  }
});
socket.on("error", (e) => {
  console.error(`cannot reach ${path}: ${e.message}`);
  process.exit(1);
});
socket.on("close", () => {
  if (!buffer.includes("\n")) {
    console.error("the daemon closed the connection without answering");
    process.exit(1);
  }
});
