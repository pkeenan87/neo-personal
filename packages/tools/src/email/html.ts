import { decodeEntities } from "../text.js";

/**
 * A small linear-time HTML scanner for hostile email HTML. It never builds a
 * DOM, never evaluates anything, and never fetches anything: it only reads
 * tags, attributes, and text to extract links and a plain-text rendering.
 */

export type HtmlAnchor = { href: string; text: string };
export type HtmlFacts = {
  /** Visible text (tags stripped, entities decoded, script/style/hidden content dropped). */
  text: string;
  /** Text inside elements styled invisible (display:none, font-size:0, ...). */
  hidden_text: string;
  anchors: HtmlAnchor[];
  /** Non-image resource URLs: form actions, iframe/frame/embed/script src, object data, meta refresh. */
  resource_urls: string[];
  images: { src: string; pixel: boolean }[];
  forms: number;
  scripts: number;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "noembed", "noframes"]);
const BLOCK = new Set([
  "p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article", "header", "footer",
  "blockquote", "pre", "ul", "ol", "hr", "center", "dd", "dt", "address", "form",
]);
const HIDDEN_STYLE =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|(?:^|[;\s])(?:font-size|max-height|height|width|opacity|line-height)\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:!important\s*)?(?:;|$))/i;
const MAX_ANCHORS = 1000;
const MAX_IMAGES = 1000;
const MAX_STACK = 512;
const MAX_ATTR_CHARS = 8192;

type Attrs = Map<string, string>;

function parseAttrs(s: string): Attrs {
  const attrs: Attrs = new Map();
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of s.slice(0, MAX_ATTR_CHARS).matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim());
  }
  return attrs;
}

function isHidden(attrs: Attrs): boolean {
  if (attrs.has("hidden")) return true;
  const style = attrs.get("style");
  return !!style && HIDDEN_STYLE.test(style);
}

function isPixel(attrs: Attrs): boolean {
  const small = (v: string | undefined) => v !== undefined && /^\s*[01](?:px)?\s*$/i.test(v);
  const style = attrs.get("style") ?? "";
  const styleSmall = /(?:^|;)\s*width\s*:\s*[01]px/i.test(style) && /(?:^|;)\s*height\s*:\s*[01]px/i.test(style);
  return (small(attrs.get("width")) && small(attrs.get("height"))) || styleSmall || isHidden(attrs);
}

function collapse(s: string): string {
  return s
    .replace(/[ \t\f\r\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function analyzeHtml(html: string): HtmlFacts {
  const len = html.length;
  const lower = html.toLowerCase();
  const text: string[] = [];
  const hidden: string[] = [];
  const anchors: HtmlAnchor[] = [];
  const resources: string[] = [];
  const images: HtmlFacts["images"] = [];
  let forms = 0;
  let scripts = 0;
  const stack: { name: string; hidden: boolean }[] = [];
  let hiddenDepth = 0;
  let anchor: { href: string; parts: string[] } | null = null;

  const emit = (raw: string) => {
    if (!raw) return;
    const t = decodeEntities(raw);
    if (hiddenDepth > 0) hidden.push(t);
    else text.push(t);
    if (anchor && hiddenDepth === 0) anchor.parts.push(t);
  };
  const closeAnchor = () => {
    if (!anchor) return;
    if (anchors.length < MAX_ANCHORS) anchors.push({ href: anchor.href, text: collapse(anchor.parts.join(" ")).replace(/\s+/g, " ") });
    anchor = null;
  };
  const pop = (name: string) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.name !== name) continue;
      for (const e of stack.splice(k)) if (e.hidden) hiddenDepth--;
      return;
    }
  };

  let i = 0;
  while (i < len) {
    const lt = html.indexOf("<", i);
    const end = lt === -1 ? len : lt;
    if (end > i) emit(html.slice(i, end));
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const c = html.indexOf("-->", lt + 4);
      i = c === -1 ? len : c + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      const c = html.indexOf(">", lt);
      i = c === -1 ? len : c + 1;
      continue;
    }
    const closing = next === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nm = /^[a-zA-Z][a-zA-Z0-9:-]{0,31}/.exec(html.slice(nameStart, nameStart + 32));
    if (!nm) {
      emit("<");
      i = lt + 1;
      continue;
    }
    const name = nm[0].toLowerCase();
    let j = nameStart + nm[0].length;
    let quote: string | null = null;
    for (; j < len; j++) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const attrStr = html.slice(nameStart + nm[0].length, j);
    i = j + 1;

    if (closing) {
      if (name === "a") closeAnchor();
      pop(name);
      if (BLOCK.has(name)) emit("\n");
      continue;
    }

    const attrs = parseAttrs(attrStr);
    if (BLOCK.has(name)) emit("\n");
    if (name === "td" || name === "th") emit(" ");

    switch (name) {
      case "a":
        closeAnchor();
        if (attrs.has("href")) anchor = { href: attrs.get("href")!, parts: [] };
        break;
      case "area":
        if (attrs.has("href") && anchors.length < MAX_ANCHORS) anchors.push({ href: attrs.get("href")!, text: attrs.get("alt") ?? "" });
        break;
      case "img":
        if (attrs.get("src") && images.length < MAX_IMAGES) images.push({ src: attrs.get("src")!, pixel: isPixel(attrs) });
        if (anchor && attrs.get("alt")) anchor.parts.push(attrs.get("alt")!);
        break;
      case "form":
        forms++;
        if (attrs.get("action")) resources.push(attrs.get("action")!);
        break;
      case "iframe":
      case "frame":
      case "embed":
        if (attrs.get("src")) resources.push(attrs.get("src")!);
        break;
      case "object":
        if (attrs.get("data")) resources.push(attrs.get("data")!);
        break;
      case "meta": {
        const content = attrs.get("content") ?? "";
        if ((attrs.get("http-equiv") ?? "").toLowerCase() === "refresh") {
          const m = /url\s*=\s*['"]?([^'"\s;]+)/i.exec(content);
          if (m?.[1]) resources.push(m[1]);
        }
        break;
      }
      case "script":
        scripts++;
        if (attrs.get("src")) resources.push(attrs.get("src")!);
        break;
    }

    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) {
        i = len;
      } else {
        const gt = html.indexOf(">", close);
        i = gt === -1 ? len : gt + 1;
      }
      continue;
    }

    const selfClosing = /\/\s*$/.test(attrStr);
    if (!VOID.has(name) && !selfClosing && stack.length < MAX_STACK) {
      const h = isHidden(attrs);
      stack.push({ name, hidden: h });
      if (h) hiddenDepth++;
    }
  }
  closeAnchor();

  return {
    text: collapse(text.join("")),
    hidden_text: collapse(hidden.join(" ")),
    anchors,
    resource_urls: resources.slice(0, 200),
    images,
    forms,
    scripts,
  };
}
