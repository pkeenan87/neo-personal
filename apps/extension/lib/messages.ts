/**
 * Messages content scripts, the popup, the options page and the warning page send to the
 * background. Every response is whatever the corresponding `lib/sync.ts` function returns;
 * callers narrow by the request `type` they sent.
 */
import { browser } from "wxt/browser";
import type { LookalikeIndicator, TechSupportIndicator } from "@neo/verdict";

export type BackgroundRequest =
  | { type: "tech-support-hit"; domain: string; pageUrl: string; indicators: TechSupportIndicator[]; phone?: string }
  | { type: "lookalike-hit"; domain: string; pageUrl: string; brand: string; indicators: LookalikeIndicator[] }
  | { type: "warning-bypassed"; relatesTo: string; domain: string; originalUrl: string }
  | { type: "get-state" }
  | { type: "preview-code"; code: string }
  | { type: "enroll-with-code"; code: string; deviceName?: string }
  | { type: "start-sign-in"; deviceName?: string }
  | { type: "poll-sign-in" }
  | { type: "cancel-sign-in" }
  | { type: "stop-protecting" }
  | { type: "set-server-url"; url: string }
  | { type: "request-host-permission" }
  | { type: "check-url"; url: string };

export function sendToBackground<T = unknown>(message: BackgroundRequest): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}
