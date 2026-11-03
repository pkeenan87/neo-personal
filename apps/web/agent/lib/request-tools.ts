import { z } from "zod";
import { MAX_GRANT_MINUTES } from "@/lib/child-request-types";
import { optionalInput } from "./tool-io";

/** `{ requestId, minutes?, scope? }` and nothing else: the tenant, member, grant and target all come from the stored request. */
export const decisionInput = z
  .object({
    requestId: z.string().trim().min(1).max(100),
    // 0 and blank count as absent (gateway-translated strict tool calls fill every property). Capped at 120 by the service.
    minutes: optionalInput(z.number().int().min(0).max(100_000)).transform((v) => (v ? v : undefined)),
    scope: optionalInput(z.enum(["once", "always"])),
  })
  .strict();

export type DecisionInput = z.infer<typeof decisionInput>;

/**
 * The approval prompt. eve builds it synchronously from the validated input (no session, no database), so it
 * cannot name the child or the site: it states exactly what the input will do, and the execution step reads
 * the stored request and reports the exact effect after it is stored. The owner approves the figures shown here.
 */
const shortRef = (input: Partial<DecisionInput> | undefined): string => (typeof input?.requestId === "string" && input.requestId ? `request ${input.requestId.slice(0, 8)}` : "this request");

export function approvePrompt(input: Partial<DecisionInput> | undefined): string {
  const id = shortRef(input);
  const minutes = input?.minutes === undefined ? "the minutes the child asked for (at most 120)" : `${Math.min(Math.max(Math.floor(input.minutes), 1), MAX_GRANT_MINUTES)} minutes`;
  const site = (input?.scope ?? "once") === "always" ? "allows the site always" : "allows the site for 1 hour";
  return `Approve ${id}? If it asks for more time, this gives ${minutes} today. If it asks to unblock a site, this ${site}. If it asks for an app, this allows the app. Neo checks the request again before changing anything.`;
}

export function denyPrompt(input: Partial<DecisionInput> | undefined): string {
  const id = shortRef(input);
  return `Say no to ${id}? Nothing is changed on the child's device.`;
}
