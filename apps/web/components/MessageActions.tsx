"use client";

// Lifted from Neo web/components/MessageActions.
import { displayNameFor, type Route } from "@neo/core";
import { CopyButton } from "./CopyButton";

export interface MessageActionsProps {
  content: string;
  className?: string;
  /** How the turn was routed; renders the model chip when present. */
  route?: Route;
  /** Model id that actually served the response (`usage.model`), when it was reported. */
  servedModel?: string;
}

/** Chip text and tooltip for a routed turn (docs/contracts.md, Phase 2 "Chat events and UI"). */
export function modelChip(route: Route, servedModel?: string): { label: string; tooltip: string } {
  const label = `${displayNameFor(servedModel ?? route.model)} · ${route.tier} · ${route.preference}`;
  let tooltip = route.signals?.reason || `Routed by ${route.router}`;
  if (servedModel && servedModel !== route.model) tooltip += ` (served by ${displayNameFor(servedModel)})`;
  return { label, tooltip };
}

/** Action row under a completed assistant message. */
export function MessageActions({ content, className, route, servedModel }: MessageActionsProps) {
  const chip = route ? modelChip(route, servedModel) : null;
  return (
    <div className={`mt-1 flex items-center gap-1 ${className ?? ""}`}>
      <CopyButton text={content} label="Copy message to clipboard" />
      {chip && (
        <span
          className="ml-1 truncate text-xs text-muted"
          title={chip.tooltip}
          aria-label={`Answered by ${chip.label}. ${chip.tooltip}`}
          data-testid="model-chip"
        >
          {chip.label}
        </span>
      )}
    </div>
  );
}
