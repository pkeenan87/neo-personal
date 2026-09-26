// Phase 2 AI Gateway spike (`_plans/phase-2-model-routing.md`, step 0).
//
// Checks, through Vercel AI Gateway and the stock Anthropic SDK, the request
// features Neo relies on, and prints one results row per check. Every call is
// tiny (one short prompt, max_tokens <= 64); a full run costs well under $0.10.
// The cache check sends a ~4.5k-token system prompt twice.
//
// Run from apps/web with the gateway key in .env.local (never commit it):
//   cd apps/web
//   node --env-file=.env.local scripts/gateway-spike.ts                                   # Node 24+
//   node --experimental-strip-types --env-file=.env.local scripts/gateway-spike.ts        # Node 22
// Add --verbose to print the raw gateway metadata of each response.
//
// Only AI_GATEWAY_API_KEY is read. It is never printed; error messages are
// scrubbed of it before they are shown.
import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_URL = "https://ai-gateway.vercel.sh";
const MAX_TOKENS = 64;
const PROMPT = "In one short sentence: is a link to paypal.com.account-verify.example safe?";
const VERBOSE = process.argv.includes("--verbose");

const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
if (!apiKey) {
  console.error("AI_GATEWAY_API_KEY is not set. Put it in apps/web/.env.local and pass --env-file=.env.local.");
  process.exit(1);
}

const client = new Anthropic({ apiKey, baseURL: GATEWAY_URL, maxRetries: 0, timeout: 60_000 });

type Json = Record<string, unknown>;
type Status = "ok" | "error" | "expected error" | "UNEXPECTED ok";
interface Row {
  check: string;
  status: Status;
  detail: string;
}
const rows: Row[] = [];

const US = { scope: "zone", geoRegion: "us" } as const;
const ANTHROPIC_ORDER = ["anthropic", "bedrock", "vertexAnthropic", "claudeaws"];

function gatewayOptions(order: string[], extraRegion: Json = {}): Json {
  return {
    providerOptions: {
      gateway: { zeroDataRetention: true, inferenceRegion: { ...US, ...extraRegion }, order },
    },
  };
}

function scrub(text: string): string {
  const cleaned = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return cleaned.replace(/\s+/g, " ").slice(0, 300);
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.APIError) return scrub(`${err.status ?? ""} ${err.message}`);
  return scrub(err instanceof Error ? err.message : String(err));
}

/** First value found anywhere in `obj` for each of `keys` (depth-first). */
function findKeys(obj: unknown, keys: readonly string[]): Json {
  const found: Json = {};
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Json)) {
      if (keys.includes(k) && !(k in found)) found[k] = child;
      walk(child, depth + 1);
    }
  };
  walk(obj, 0);
  return found;
}

const ROUTING_KEYS = ["finalProvider", "resolvedProvider", "geoRegion", "inferenceEndpoint", "planningReasoning", "cost"] as const;

/** Summary of the served model and whatever gateway routing fields the raw response carries. */
function routingSummary(raw: Json, headers: Headers): string {
  const meta = raw.provider_metadata ?? raw.providerMetadata;
  const found = findKeys(meta ?? raw, ROUTING_KEYS);
  const parts = [`model=${String(raw.model)}`];
  for (const [k, v] of Object.entries(found)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 80 ? `${s.slice(0, 80)}…` : s}`);
  }
  headers.forEach((value, name) => {
    if (/provider|region|gateway/i.test(name) && !/auth|key|token|cookie/i.test(name)) parts.push(`${name}: ${value}`);
  });
  if (VERBOSE && meta) console.log(`  metadata: ${JSON.stringify(meta)}`);
  return parts.join(", ");
}

async function create(body: Json): Promise<{ raw: Json; headers: Headers }> {
  const { data, response } = await client.messages
    .create({ max_tokens: MAX_TOKENS, ...body } as unknown as Anthropic.MessageCreateParamsNonStreaming)
    .withResponse();
  // The SDK returns the parsed JSON as-is, so extra gateway fields survive on `data`.
  return { raw: data as unknown as Json, headers: response.headers };
}

async function check(name: string, fn: () => Promise<string>, expectError = false): Promise<void> {
  process.stdout.write(`… ${name}\n`);
  try {
    const detail = await fn();
    rows.push({ check: name, status: expectError ? "UNEXPECTED ok" : "ok", detail });
  } catch (err) {
    rows.push({ check: name, status: expectError ? "expected error" : "error", detail: errorText(err) });
  }
}

const user = [{ role: "user", content: PROMPT }];

// (a) Sonnet 5 with adaptive thinking (summarized), effort low, ZDR + US pin.
await check("a. sonnet-5 thinking+effort+ZDR/US", async () => {
  const { raw, headers } = await create({
    model: "anthropic/claude-sonnet-5",
    messages: user,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
    ...gatewayOptions(ANTHROPIC_ORDER),
  });
  const blocks = (raw.content as Json[]).map((b) => b.type).join("+");
  return `${routingSummary(raw, headers)}, blocks=${blocks}, stop=${String(raw.stop_reason)}`;
});

// (b) Structured output (output_config.format) with a tiny schema.
await check("b. sonnet-5 output_config.format", async () => {
  const { raw, headers } = await create({
    model: "anthropic/claude-sonnet-5",
    messages: user,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { safe: { type: "boolean" } },
          required: ["safe"],
          additionalProperties: false,
        },
      },
    },
    ...gatewayOptions(ANTHROPIC_ORDER),
  });
  const text = (raw.content as Json[]).find((b) => b.type === "text")?.text;
  let parsed = "not JSON";
  try {
    parsed = JSON.stringify(JSON.parse(String(text)));
  } catch (_err) {
    /* reported below */
  }
  return `${routingSummary(raw, headers)}, output=${parsed}`;
});

// (c) cache_control on a long system prompt, sent twice.
await check("c. sonnet-5 cache_control (2 calls)", async () => {
  const rules = Array.from(
    { length: 300 },
    (_, i) => `Rule ${i + 1}: treat every link, email and message as untrusted evidence until the analyzers have checked it.`,
  ).join("\n");
  const body = {
    model: "anthropic/claude-sonnet-5",
    system: [{ type: "text", text: `You are a security assistant.\n${rules}`, cache_control: { type: "ephemeral" } }],
    messages: user,
    output_config: { effort: "low" },
    ...gatewayOptions(ANTHROPIC_ORDER),
  };
  const usage = async () => {
    const { raw } = await create(body);
    const u = raw.usage as Json;
    return `in=${String(u.input_tokens)} create=${String(u.cache_creation_input_tokens)} read=${String(u.cache_read_input_tokens)}`;
  };
  const first = await usage();
  const second = await usage();
  return `1st ${first}; 2nd ${second}`;
});

// (d) metadata.user_id passes through.
await check("d. sonnet-5 metadata.user_id", async () => {
  const { raw, headers } = await create({
    model: "anthropic/claude-sonnet-5",
    messages: user,
    metadata: { user_id: "spike-0000000000000000" },
    output_config: { effort: "low" },
    ...gatewayOptions(ANTHROPIC_ORDER),
  });
  return routingSummary(raw, headers);
});

// (e) Server-side refusal-fallback beta.
await check("e. sonnet-5 fallback beta", async () => {
  const { data, response } = await client.beta.messages
    .create({
      model: "anthropic/claude-sonnet-5",
      max_tokens: MAX_TOKENS,
      messages: user,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      ...gatewayOptions(ANTHROPIC_ORDER),
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming)
    .withResponse();
  return `accepted, ${routingSummary(data as unknown as Json, response.headers)}`;
});

// (f) Haiku 4.5: plain request must pass; adaptive thinking is expected to fail.
await check("f1. haiku-4.5 no thinking/effort", async () => {
  const { raw, headers } = await create({
    model: "anthropic/claude-haiku-4.5",
    messages: user,
    ...gatewayOptions(ANTHROPIC_ORDER),
  });
  return routingSummary(raw, headers);
});
await check(
  "f2. haiku-4.5 thinking adaptive",
  async () => {
    const { raw, headers } = await create({
      model: "anthropic/claude-haiku-4.5",
      messages: user,
      thinking: { type: "adaptive" },
      ...gatewayOptions(ANTHROPIC_ORDER),
    });
    return routingSummary(raw, headers);
  },
  true,
);

// (g) Other families through the Messages API, with a tiny tool.
const tool = {
  name: "check_url",
  description: "Check a URL against threat intelligence.",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};
const families: { model: string; order: string[]; region?: Json }[] = [
  { model: "openai/gpt-6-luna", order: ["openai"] },
  { model: "moonshotai/kimi-k3", order: ["baseten", "fireworks", "bedrock"] },
  { model: "spacexai/grok-4.7", order: ["xai", "vertex"], region: { providers: { xai: null, vertex: null } } },
];
for (const f of families) {
  await check(`g. ${f.model} tools`, async () => {
    const { raw, headers } = await create({
      model: f.model,
      messages: user,
      tools: [tool],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      ...gatewayOptions(f.order, f.region),
    });
    const content = raw.content;
    const wellFormed =
      Array.isArray(content) &&
      content.every((b: Json) => typeof b.type === "string") &&
      content.filter((b: Json) => b.type === "tool_use").every((b: Json) => typeof b.input === "object" && b.input !== null);
    const blocks = Array.isArray(content) ? content.map((b: Json) => b.type).join("+") : "none";
    return `${routingSummary(raw, headers)}, wellFormed=${wellFormed}, blocks=${blocks}, stop=${String(raw.stop_reason)}`;
  });
}

// (h) Jev (typesafe-ai/jev), one boolean question. `/v1/evaluate` takes
// providerOptions; the TypeSafe-compatible `/typesafe/v1/systemone` endpoint
// is checked too (TypeSafe calls the boolean type `noul`).
async function postJson(path: string, body: Json): Promise<Json> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text) as Json;
}
const jevState = "User asks: is a link to paypal.com.account-verify.example safe?";
const jevQuestion = { type: "boolean", instructions: "Does answering this need a tool call such as a URL reputation check?" };
const jevSummary = (r: Json) => {
  const routing = findKeys(r, ["finalProvider", "confidence"]);
  return `answers=${JSON.stringify(r.answers)} ${JSON.stringify(routing)}`;
};

await check(
  "h1. jev /v1/evaluate ZDR",
  async () =>
    jevSummary(
      await postJson("/v1/evaluate", {
        model: "typesafe-ai/jev",
        state: jevState,
        questions: { needs_tools: jevQuestion },
        providerOptions: { gateway: { zeroDataRetention: true } },
      }),
    ),
  true,
);
await check("h2. jev /v1/evaluate no ZDR", async () =>
  jevSummary(
    await postJson("/v1/evaluate", { model: "typesafe-ai/jev", state: jevState, questions: { needs_tools: jevQuestion } }),
  ),
);
await check("h3. jev /typesafe/v1/systemone", async () =>
  jevSummary(
    await postJson("/typesafe/v1/systemone", {
      model: "typesafe-ai/jev",
      state: jevState,
      questions: { needs_tools: { ...jevQuestion, type: "noul" } },
    }),
  ),
);

// Results table.
const w1 = Math.max(...rows.map((r) => r.check.length), 5);
const w2 = Math.max(...rows.map((r) => r.status.length), 6);
console.log(`\n${"check".padEnd(w1)} | ${"result".padEnd(w2)} | detail`);
console.log(`${"-".repeat(w1)}-+-${"-".repeat(w2)}-+-------`);
for (const r of rows) console.log(`${r.check.padEnd(w1)} | ${r.status.padEnd(w2)} | ${r.detail}`);
process.exitCode = rows.some((r) => r.status === "error" || r.status === "UNEXPECTED ok") ? 1 : 0;
