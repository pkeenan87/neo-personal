import {
  File as FileIcon,
  Globe,
  KeyRound,
  Mail,
  MessageSquare,
  MessagesSquare,
  Package,
  PlugZap,
  ShieldAlert,
  Link as LinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { SubjectType } from "@neo/verdict";

/**
 * What was checked, in words a household member reads, not API vocabulary
 * (_specs/signals.md adds `software`, `remote_session`, `permission`).
 */
export const SUBJECT_LABEL: Record<SubjectType, string> = {
  email: "Email",
  sms: "Text message",
  url: "Link",
  page: "Web page",
  signin_alert: "Sign-in alert",
  file: "File",
  conversation: "Conversation",
  software: "Program",
  remote_session: "Remote session",
  permission: "Permission",
};

export const SUBJECT_ICON: Record<SubjectType, LucideIcon> = {
  email: Mail,
  sms: MessageSquare,
  url: LinkIcon,
  page: Globe,
  signin_alert: KeyRound,
  file: FileIcon,
  conversation: MessagesSquare,
  software: Package,
  remote_session: PlugZap,
  permission: ShieldAlert,
};

/** Small icon + label, for a compact "what kind of thing was this" badge. */
export function SubjectBadge({ type, className }: { type: SubjectType; className?: string }) {
  const Icon = SUBJECT_ICON[type];
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {SUBJECT_LABEL[type]}
    </span>
  );
}
