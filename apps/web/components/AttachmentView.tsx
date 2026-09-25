"use client";

import { FileText, Image as ImageIcon, Mail } from "lucide-react";
import { useState } from "react";
import { artifactUrl, type AttachmentRef } from "@/lib/attachments";

/** A file reference: icon, name, size; links to the download. */
export function AttachmentChip({ attachment }: { attachment: AttachmentRef }) {
  const Icon = attachment.kind === "image" ? ImageIcon : attachment.kind === "text" ? FileText : Mail;
  return (
    <a
      href={artifactUrl(attachment.id)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg hover:bg-surface-2"
      data-testid="attachment-chip"
      title={`Download ${attachment.filename}`}
    >
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="truncate">{attachment.filename}</span>
      <span className="shrink-0 text-muted">{attachment.size}</span>
    </a>
  );
}

/** An image thumbnail that opens the full image in a new tab; falls back to a chip (e.g. after expiry). */
export function AttachmentThumbnail({ attachment }: { attachment: AttachmentRef }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <AttachmentChip attachment={attachment} />;
  const href = artifactUrl(attachment.id, true);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block overflow-hidden rounded-xl border border-border bg-surface"
      data-testid="attachment-thumbnail"
      title={`Open ${attachment.filename}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, no-store API response; next/image cannot optimize it */}
      <img
        src={href}
        alt={`Screenshot: ${attachment.filename}`}
        loading="lazy"
        className="max-h-48 max-w-[14rem] object-contain"
        onError={() => setBroken(true)}
      />
    </a>
  );
}

/** Attachments of a user message: thumbnails for images, chips for files. */
export function AttachmentList({ attachments }: { attachments: AttachmentRef[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2" aria-label="Attachments">
      {attachments.map((a) =>
        a.kind === "image" ? <AttachmentThumbnail key={a.id} attachment={a} /> : <AttachmentChip key={a.id} attachment={a} />,
      )}
    </div>
  );
}
