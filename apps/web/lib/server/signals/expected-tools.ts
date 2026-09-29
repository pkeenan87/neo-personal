/**
 * PUT /api/household/devices/[id]/expected-tools (_specs/signals.md "Expected tools"): the
 * owner's allow-list of remote-access tools (and known peer ids) for one device, so helping
 * grandma over AnyDesk doesn't alert every session.
 */
import { findRemoteAccessTool } from "@neo/tools";
import type { ExpectedToolItem, SetExpectedToolsResponse } from "@/lib/signal-types";
import type { NeoSession } from "@/lib/session";
import { recordAudit } from "../audit";
import type { Outcome } from "../household";
import { listExpectedTools, setExpectedTools } from "./store";

export const MAX_EXPECTED_TOOLS = 10;
export const MAX_EXPECTED_TOOL_PEER_IDS = 10;
const PEER_ID_RE = /^[A-Za-z0-9 _.@-]{1,64}$/;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

const OWNER_ONLY = fail(403, "forbidden", "Only the household owner can do this.");
const DEVICE_NOT_FOUND = fail(404, "not_found", "That device is not in your household.");
const INVALID = fail(
  400,
  "invalid",
  'Expected { "tools": [{ "toolId": string, "peerIds": string[] }] }, at most 10 tools, at most 10 peer ids each (1-64 characters, letters/digits/space/_.@- only).',
);

interface ParsedTool {
  toolId: string;
  peerIds: string[];
}

/** Shape-and-bounds validation only (unknown-toolId is checked separately, for its own error code). */
function parseTools(raw: unknown): ParsedTool[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EXPECTED_TOOLS) return null;
  const out: ParsedTool[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { toolId, peerIds } = item as { toolId?: unknown; peerIds?: unknown };
    if (typeof toolId !== "string" || !toolId) return null;
    if (seen.has(toolId)) return null; // one entry per tool
    seen.add(toolId);
    if (!Array.isArray(peerIds) || peerIds.length > MAX_EXPECTED_TOOL_PEER_IDS) return null;
    const cleanPeerIds: string[] = [];
    for (const p of peerIds) {
      if (typeof p !== "string" || !PEER_ID_RE.test(p)) return null;
      cleanPeerIds.push(p);
    }
    out.push({ toolId, peerIds: cleanPeerIds });
  }
  return out;
}

function toItem(row: { toolId: string; peerIds: string[] }): ExpectedToolItem {
  return { toolId: row.toolId, name: findRemoteAccessTool(row.toolId)?.name ?? row.toolId, peerIds: row.peerIds };
}

export async function setDeviceExpectedTools(session: NeoSession, deviceId: string, body: Record<string, unknown> | null): Promise<Outcome<SetExpectedToolsResponse>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const tools = parseTools(body?.tools);
  if (!tools) return INVALID;
  for (const t of tools) {
    if (!findRemoteAccessTool(t.toolId)) return fail(400, "unknown_tool", `"${t.toolId}" is not a known remote-access tool.`);
  }
  const rows = await setExpectedTools({ tenantId: session.tenantId, deviceId, tools, createdBy: session.userId });
  if (!rows) return DEVICE_NOT_FOUND;
  await recordAudit(session.tenantId, session.userId, "device.expected_tools_changed", { deviceId, toolCount: rows.length });
  return { ok: true, value: { tools: rows.map(toItem) } };
}

/** For lib/server/devices.ts (GET /api/household), listing every device's expected tools without a PUT. */
export async function expectedToolsByDevice(tenantId: string): Promise<Map<string, ExpectedToolItem[]>> {
  const rows = await listExpectedTools(tenantId);
  const byDevice = new Map<string, ExpectedToolItem[]>();
  for (const r of rows) {
    const list = byDevice.get(r.deviceId) ?? [];
    list.push(toItem(r));
    byDevice.set(r.deviceId, list);
  }
  return byDevice;
}
