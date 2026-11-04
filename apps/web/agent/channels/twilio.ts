import { hashPii, logger } from "@neo/core";
import type { ResolvedChannelMember } from "@neo/db";
import { twilioChannel, type TwilioContext, type TwilioInboundResult, type TwilioTextMessage } from "eve/channels/twilio";
import type { HttpRouteDefinition, RouteDefinition } from "eve/channels";
import { twilioAuthToken, twilioEnabled } from "@/lib/env";
import { resolveSmsCaller } from "@/lib/server/member-channels";
import { takeRateSlot } from "@/lib/server/rate-limit";
import { mockTwilioFetch } from "@/lib/server/sms-sender";

/**
 * Neo over SMS (_specs/v2-m3-cutover.md section 5), behind `NEO_TWILIO_ENABLED` and mock-only: there is no
 * Twilio account and no A2P registration, so every outbound call goes to `mockTwilioFetch` (it logs a hashed
 * number and answers like the Messages API) and nothing reaches the network. SMS only; voice is a later step
 * (`onVoice` rejects every call and `onVoiceTranscription` ignores transcripts).
 *
 * - Flag off: every route answers 404 and no code below it runs.
 * - Webhook signature: eve checks `X-Twilio-Signature` on every request against `TWILIO_AUTH_TOKEN` (the fixed
 *   test token in MOCK_MODE off a deployed environment; no token means every webhook is rejected).
 * - Caller: `allowFrom: "*"` admits every number to `onText`, which is the caller check. A number maps to a
 *   member only through a verified `member_channels` row (`resolveSmsCaller`); the tenant comes from that
 *   lookup alone. Any other number gets one fixed reply and never reaches the model.
 */
export const NOT_CONNECTED_REPLY = "This number isn't connected to Neo.";
/** Canned replies per sending number: past this the text is dropped silently (no reply loop, no cost amplification). */
export const NOT_CONNECTED_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 } as const;

export interface TwilioDeps {
  resolveCaller(from: string): Promise<ResolvedChannelMember | null>;
  enabled(): boolean;
}

const defaultDeps: TwilioDeps = { resolveCaller: resolveSmsCaller, enabled: twilioEnabled };

/** The `onText` hook: verified number to a caller, anything else to the canned reply and `null` (no model). */
export function createOnText(deps: Pick<TwilioDeps, "resolveCaller">) {
  return async (ctx: TwilioContext, message: TwilioTextMessage): Promise<TwilioInboundResult> => {
    const caller = await deps.resolveCaller(message.from);
    if (!caller) {
      const numberHash = hashPii(message.from);
      if (takeRateSlot("twilio-not-connected", numberHash, NOT_CONNECTED_LIMIT.limit, NOT_CONNECTED_LIMIT.windowMs).ok) {
        try {
          await ctx.twilio.sendMessage(NOT_CONNECTED_REPLY);
        } catch (err) {
          logger.warn("Twilio canned reply failed", "twilio", { userIdHash: numberHash, errorMessage: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
        }
      }
      logger.info("Twilio text from an unconnected number ignored", "twilio", { userIdHash: numberHash });
      return null;
    }
    return {
      auth: {
        authenticator: "twilio-sms",
        // An account member is the same principal as on the web; a member without an account is the member.
        principalType: caller.userId ? "user" : "member",
        principalId: caller.userId ?? caller.memberId,
        attributes: { tenantId: caller.tenantId, memberId: caller.memberId, role: caller.role },
      },
    };
  };
}

/** Answers 404 for every route while the flag is off, without running eve's handler. */
function gateRoutes<T extends RouteDefinition<never>>(routes: readonly T[], enabled: () => boolean): T[] {
  return routes.map((route) => {
    if (route.transport === "websocket") return route;
    const http = route as HttpRouteDefinition<never>;
    const gated: HttpRouteDefinition<never> = {
      ...http,
      handler: (req, args) => (enabled() ? http.handler(req, args) : Promise.resolve(new Response("Not found", { status: 404 }))),
    };
    return gated as unknown as T;
  });
}

export function createTwilioChannel(deps: TwilioDeps = defaultDeps) {
  const channel = twilioChannel({
    allowFrom: "*",
    credentials: {
      accountSid: () => process.env.TWILIO_ACCOUNT_SID?.trim() || "AC00000000000000000000000000000000",
      authToken: () => {
        const token = twilioAuthToken();
        if (!token) throw new Error("TWILIO_AUTH_TOKEN is required.");
        return token;
      },
    },
    messaging: { from: process.env.TWILIO_FROM_NUMBER?.trim() || "+15005550006" },
    // Mock-only: replies, approval prompts and media downloads never leave the process.
    api: { fetch: mockTwilioFetch },
    onText: createOnText(deps),
    // Voice is a later step: calls are refused and transcripts ignored.
    onVoice: () => null,
    onVoiceTranscription: () => null,
  });
  return { ...channel, routes: gateRoutes(channel.routes, deps.enabled) };
}

export default createTwilioChannel();
