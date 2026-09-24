"use client";

// Lifted from Neo web/components/MarkdownRenderer (CSS module → Tailwind).
// Raw HTML is never rendered: react-markdown ignores it by default and
// rehype-sanitize strips anything unsafe that slips through GFM.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children.props as { children?: ReactNode }).children);
  }
  return "";
}

const components: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-border-strong pl-3 text-muted">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border" tabIndex={0} aria-label="Scrollable table">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th scope="col" className="border-b border-border bg-surface-2 px-3 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  pre: ({ children }) => (
    <div className="group relative my-3">
      <div className="absolute top-1.5 right-1.5 opacity-80 group-hover:opacity-100">
        <CopyButton text={extractText(children)} variant="text" />
      </div>
      <pre
        className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 pr-20 font-mono text-[13px] leading-relaxed"
        tabIndex={0}
        aria-label="Scrollable code block"
      >
        {children}
      </pre>
    </div>
  ),
  code: ({ className, children, ...rest }) =>
    className ? (
      <code className={`font-mono ${className}`} {...rest}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9em] break-words" {...rest}>
        {children}
      </code>
    ),
};

export function MarkdownRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={`text-[15px] break-words ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {content.replace(/\r\n?/g, "\n")}
      </ReactMarkdown>
    </div>
  );
}
