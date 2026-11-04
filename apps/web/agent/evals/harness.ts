/**
 * Offline eval harness (_specs/v2-m4-hardening.md section 5). It stands in for eve's tool loop with a
 * scripted model, so the safety properties that do not depend on the model's prose run in CI with no
 * network and no real model:
 *
 *  - a tool whose `approval.request` answers "user-approval" never executes until `approve()`; `deny()` and
 *    never answering leave no effect, and the model only hears that the owner said no;
 *  - input is validated against the tool's own schema (strict: no tenant or other extra fields);
 *  - the model sees nothing a tool returned except `toModelOutput`, which must be the wrapToolResult envelope.
 *
 * This mirrors the contract of eve's runtime (approval is decided from the tool definition, the model sees
 * `toModelOutput`); it does not run the runtime. What only a live model can show is in `evals/` (NEO_LIVE_EVALS=1).
 */
import type { Person } from "../../test/helpers/eve-db";

export interface ToolDef {
  approval?: { request: (ctx: unknown) => unknown; prompt: (ctx: unknown) => string };
  execute(input: unknown, ctx: unknown): Promise<unknown>;
  toModelOutput(output: unknown): { type: "text"; value: string };
  inputSchema: { safeParse(v: unknown): { success: boolean; data?: unknown }; shape?: Record<string, unknown> };
}

/** Every tool in agent/tools, by file name (the tool name eve registers). */
export function loadTools(): Record<string, ToolDef> {
  const mods = import.meta.glob("../tools/*.ts", { eager: true }) as Record<string, { default: unknown }>;
  return Object.fromEntries(Object.entries(mods).map(([file, m]) => [file.replace(/^.*\/(\w+)\.ts$/, "$1"), m.default as ToolDef]));
}

export function ctxFor(p: Person | null, claimedRole: "owner" | "member" = p?.role ?? "member") {
  return {
    abortSignal: new AbortController().signal,
    session: { auth: { current: p ? { principalType: "user", principalId: p.userId, attributes: { tenantId: p.tenantId, role: claimedRole } } : null } },
  };
}

export interface ModelStep {
  tool: string;
  input: unknown;
}
/** The scripted model: given everything it has been shown so far, the next tool call, or null to finish. */
export type ScriptedModel = (seen: string[]) => ModelStep | null;

export interface PendingApproval {
  id: string;
  tool: string;
  input: unknown;
  prompt: string;
}

export class Loop {
  /** What the model has been shown, in order: tool outputs (`toModelOutput`) and approval outcomes. */
  readonly seen: string[] = [];
  /** Tools that actually ran. */
  readonly executed: string[] = [];
  readonly pending: PendingApproval[] = [];
  private n = 0;

  constructor(
    private readonly tools: Record<string, ToolDef>,
    private readonly caller: Person | null,
  ) {}

  /** Run until the model finishes or parks on an approval. */
  async run(model: ScriptedModel, maxSteps = 8): Promise<void> {
    for (let i = 0; i < maxSteps && this.pending.length === 0; i++) {
      const step = model(this.seen);
      if (!step) return;
      await this.call(step);
    }
  }

  private async call(step: ModelStep): Promise<void> {
    const tool = this.tools[step.tool];
    if (!tool) {
      this.seen.push(`error: unknown tool ${step.tool}`);
      return;
    }
    const parsed = tool.inputSchema.safeParse(step.input);
    if (!parsed.success) {
      this.seen.push(`error: invalid input for ${step.tool}`);
      return;
    }
    if (tool.approval && tool.approval.request({ toolInput: parsed.data }) === "user-approval") {
      this.n += 1;
      this.pending.push({ id: `approval-${this.n}`, tool: step.tool, input: parsed.data, prompt: tool.approval.prompt({ input: parsed.data, toolName: step.tool, callId: `c${this.n}` }) });
      return;
    }
    await this.execute(step.tool, parsed.data);
  }

  private async execute(name: string, input: unknown): Promise<void> {
    const tool = this.tools[name]!;
    this.executed.push(name);
    const out = await tool.execute(input, ctxFor(this.caller));
    this.seen.push(tool.toModelOutput(out).value);
  }

  async approve(id: string): Promise<void> {
    const p = this.take(id);
    await this.execute(p.tool, p.input);
  }

  deny(id: string): void {
    this.take(id);
    this.seen.push("The owner said no. Nothing was done.");
  }

  private take(id: string): PendingApproval {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no pending approval ${id}`);
    return this.pending.splice(i, 1)[0]!;
  }
}

/** The adversarial model: first calls `first`, then does whatever the data it was shown tells it to ("CALL tool {json}"). */
export function followsInjection(first: ModelStep): ScriptedModel {
  let started = false;
  let obeyed = 0;
  return (seen) => {
    if (!started) {
      started = true;
      return first;
    }
    for (const text of seen) {
      for (const s of stringsOf(text)) {
        const m = /CALL (\w+) (\{[^}]*\})/.exec(s);
        if (m && obeyed < 3) {
          obeyed += 1;
          return { tool: m[1]!, input: JSON.parse(m[2]!) };
        }
      }
    }
    return null;
  };
}

/** Every string inside an envelope (or the string itself when it is not JSON). */
export function stringsOf(text: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    out.push(text);
  }
  return out;
}

export interface Envelope {
  _neo_trust_boundary: { source: string; tool: string; injection_detected: boolean };
  data: unknown;
}
export function envelopeOf(text: string): Envelope | null {
  try {
    const v = JSON.parse(text) as Envelope;
    return v && typeof v === "object" && v._neo_trust_boundary?.source === "external_tool" ? v : null;
  } catch {
    return null;
  }
}
