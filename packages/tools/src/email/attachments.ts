import extensions from "../data/dangerous-extensions.json" with { type: "json" };
import { VIRUSTOTAL_API } from "../checks/virustotal.js";
import type { CheckContext } from "../types.js";
import { cleanLine, escapeInvisible, hasBidiOverride, stripInvisible } from "../text.js";
import { discardBody, envKey, errorMessage, readJson, timeoutSignal } from "../util.js";
import type { AttachmentSkip, EmailAttachmentAnalysis, FileVirusTotalResult, MagicType, ParsedAttachment } from "./types.js";

const EXECUTABLE = new Set(extensions.executable);
const ACTIVE_MARKUP = new Set(extensions.active_markup);
const MACRO_DOCUMENT = new Set(extensions.macro_document);
const OLE_DOCUMENT = new Set(extensions.ole_document);
const ARCHIVE = new Set(extensions.archive);
const DECOY = new Set(extensions.decoy);

/** Magic types each extension may legitimately carry. Extensions not listed are not checked (except for executable content). */
const EXPECTED_MAGIC: Record<string, MagicType[]> = {
  pdf: ["pdf"],
  zip: ["zip"], zipx: ["zip"], docx: ["zip"], xlsx: ["zip"], pptx: ["zip"], docm: ["zip"], xlsm: ["zip"], pptm: ["zip"],
  odt: ["zip"], ods: ["zip"], odp: ["zip"], epub: ["zip"], jar: ["zip"], apk: ["zip"],
  doc: ["ole"], xls: ["ole"], ppt: ["ole"], msg: ["ole"], msi: ["ole"],
  exe: ["pe"], dll: ["pe"], scr: ["pe"], cpl: ["pe"], sys: ["pe"],
  html: ["html"], htm: ["html"], shtml: ["html"], xhtml: ["html"], svg: ["html"],
  lnk: ["lnk"], iso: ["iso"], img: ["iso", "unknown"],
  png: ["image"], jpg: ["image"], jpeg: ["image"], gif: ["image"], webp: ["image"],
  rar: ["archive"], "7z": ["archive"], gz: ["archive"], tgz: ["archive"],
  txt: ["unknown", "script"], csv: ["unknown"], eml: ["unknown", "html"],
};
/** Content types that are dangerous whatever the name says. */
const DANGEROUS_MAGIC = new Set<MagicType>(["pe", "lnk", "iso", "script", "html"]);
const MAX_LISTED = 50;
const MAX_VT_LOOKUPS = 5;

function extensionOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const m = /\.([a-z0-9-]{1,20})\s*$/i.exec(stripInvisible(name));
  return m?.[1]?.toLowerCase();
}

/** invoice.pdf.exe, "invoice.pdf      .exe", or an RTLO-disguised name. */
function isDoubleExtension(name: string | undefined): boolean {
  if (!name) return false;
  if (hasBidiOverride(name)) return true;
  const clean = stripInvisible(name).toLowerCase();
  const m = /\.([a-z0-9]{2,5})[\s._-]*\.([a-z0-9-]{1,20})\s*$/.exec(clean);
  if (!m) return false;
  const [, decoy, real] = m;
  return DECOY.has(decoy!) && (EXECUTABLE.has(real!) || ACTIVE_MARKUP.has(real!) || MACRO_DOCUMENT.has(real!));
}

export type TriagedAttachment = EmailAttachmentAnalysis & { heuristics: string[] };

/** Classify one attachment by name, declared type, and magic bytes (no content parsing). */
export function triageAttachment(a: ParsedAttachment): TriagedAttachment {
  const ext = extensionOf(a.filename);
  const magic = a.magic ?? "unknown";
  const flags: string[] = [];
  const heuristics: string[] = [];

  const byExt = !!ext && (EXECUTABLE.has(ext) || ACTIVE_MARKUP.has(ext) || MACRO_DOCUMENT.has(ext));
  const byMagic = DANGEROUS_MAGIC.has(magic) && !(magic === "html" && ext === "eml");
  const declaredHtml = /^(text\/html|application\/xhtml|image\/svg)/.test(a.mimeType) && a.disposition === "attachment";
  const dangerous_type = byExt || byMagic || declaredHtml || (!ext && a.mimeType === "application/x-msdownload");

  const expected = ext ? EXPECTED_MAGIC[ext] : undefined;
  const extension_mismatch =
    magic !== "unknown" && !!ext && (expected ? !expected.includes(magic) : ["pe", "lnk", "script", "iso"].includes(magic) && !EXECUTABLE.has(ext));
  const double_extension = isDoubleExtension(a.filename);

  if (ext && MACRO_DOCUMENT.has(ext)) flags.push("macro_enabled");
  if (magic === "ole" || (ext && OLE_DOCUMENT.has(ext))) {
    flags.push("ole_document");
    heuristics.push("ole_document");
  }
  if (magic === "zip" && ext && !["docx", "xlsx", "pptx", "docm", "xlsm", "pptm", "odt", "ods", "odp", "epub"].includes(ext)) {
    flags.push("archive_not_inspected");
  } else if (magic === "archive" || (ext && ARCHIVE.has(ext)) || (magic === "zip" && !ext)) {
    flags.push("archive_not_inspected");
  }
  if (flags.includes("archive_not_inspected")) heuristics.push("archive_not_inspected");
  if (a.filename && hasBidiOverride(a.filename)) flags.push("rtlo_in_name");
  if (a.disposition === "inline" || a.contentId) flags.push("inline");

  if (dangerous_type) heuristics.push("dangerous_attachment_type");
  if (extension_mismatch) heuristics.push("extension_mismatch");
  if (double_extension) heuristics.push("double_extension");

  const out: TriagedAttachment = {
    mime_type: cleanLine(a.mimeType, 100),
    size: a.size,
    magic,
    extension_mismatch,
    dangerous_type,
    double_extension,
    flags,
    sha256: a.sha256,
    heuristics,
  };
  if (a.filename) out.filename = escapeInvisible(a.filename).replace(/\s+/g, " ").slice(0, 255);
  if (ext) out.extension = ext;
  return out;
}

function vtPermalink(sha256: string): string {
  return `https://www.virustotal.com/gui/file/${sha256}`;
}

type VtFileAttributes = {
  last_analysis_stats?: { malicious?: number; suspicious?: number; harmless?: number; undetected?: number };
  last_analysis_results?: Record<string, { category?: string; result?: string; engine_name?: string }>;
  type_description?: string;
  last_analysis_date?: number;
};

export function parseVirusTotalFile(sha256: string, body: unknown): FileVirusTotalResult {
  const attrs = ((body as { data?: { attributes?: VtFileAttributes } } | null)?.data?.attributes ?? {}) as VtFileAttributes;
  const stats = attrs.last_analysis_stats ?? {};
  const top_engines = Object.entries(attrs.last_analysis_results ?? {})
    .filter(([, r]) => r.category === "malicious" || r.category === "suspicious")
    .sort(([a, ra], [b, rb]) => (ra.category === rb.category ? a.localeCompare(b) : ra.category === "malicious" ? -1 : 1))
    .slice(0, 8)
    .map(([name, r]) => `${r.engine_name ?? name}${r.result ? ` (${r.result})` : ""}`);
  const out: FileVirusTotalResult = {
    status: "found",
    malicious: stats.malicious ?? 0,
    suspicious: stats.suspicious ?? 0,
    harmless: stats.harmless ?? 0,
    undetected: stats.undetected ?? 0,
    top_engines,
    permalink: vtPermalink(sha256),
  };
  if (attrs.type_description) out.type_description = attrs.type_description.slice(0, 100);
  if (typeof attrs.last_analysis_date === "number") out.last_analysis_date = new Date(attrs.last_analysis_date * 1000).toISOString();
  return out;
}

/** VirusTotal v3 file report by SHA-256 (`GET /files/{hash}`). Lookup only: files are never uploaded. */
export async function checkVirusTotalFile(sha256: string, ctx: CheckContext): Promise<FileVirusTotalResult | AttachmentSkip> {
  if (ctx.deps.mock) return { skipped: "mock" };
  const key = envKey(ctx.deps.env, "VIRUSTOTAL_API_KEY");
  if (!key) return { skipped: "no_api_key" };
  const res = await ctx.deps.fetch(`${VIRUSTOTAL_API}/files/${sha256}`, {
    headers: { "x-apikey": key, accept: "application/json" },
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (res.ok) return parseVirusTotalFile(sha256, await readJson(res));
  discardBody(res);
  if (res.status === 404) return { status: "not_found" };
  throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
}

function lookupPriority(a: TriagedAttachment): number {
  if (a.dangerous_type || a.extension_mismatch || a.double_extension) return 0;
  if (a.flags.includes("archive_not_inspected") || a.flags.includes("ole_document") || a.flags.includes("macro_enabled")) return 1;
  if (a.magic === "pdf" || a.magic === "zip") return 2;
  return 3;
}

/**
 * Triage every attachment (at most 50 listed) and look up to 5 of the
 * riskiest on VirusTotal by hash. Inline images are not looked up.
 */
export async function analyzeAttachments(
  list: ParsedAttachment[],
  ctx: CheckContext,
  errors: string[],
): Promise<{ attachments: EmailAttachmentAnalysis[]; heuristics: string[] }> {
  const triaged = list.slice(0, MAX_LISTED).map(triageAttachment);
  const heuristics = new Set<string>(triaged.flatMap((t) => t.heuristics));
  const candidates = triaged
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !(t.magic === "image" && t.flags.includes("inline")) && t.mime_type !== "message/rfc822")
    .sort((a, b) => lookupPriority(a.t) - lookupPriority(b.t) || a.idx - b.idx);
  const chosen = new Set(candidates.slice(0, MAX_VT_LOOKUPS).map((c) => c.idx));

  await Promise.all(
    triaged.map(async (t, idx) => {
      if (!chosen.has(idx)) {
        t.virustotal = { skipped: candidates.some((c) => c.idx === idx) ? "limit" : "not_applicable" };
        return;
      }
      try {
        t.virustotal = await checkVirusTotalFile(t.sha256, ctx);
      } catch (e) {
        errors.push(`virustotal_file: ${errorMessage(e)}`);
        t.virustotal = { skipped: "error" };
      }
      const vt = t.virustotal;
      if (vt && "status" in vt && vt.status === "found" && vt.malicious + vt.suspicious > 0) heuristics.add("attachment_vt_flagged");
    }),
  );
  const attachments = triaged.map((t): EmailAttachmentAnalysis => {
    const { heuristics: perAttachment, ...rest } = t;
    void perAttachment;
    return rest;
  });
  return { attachments, heuristics: [...heuristics] };
}
