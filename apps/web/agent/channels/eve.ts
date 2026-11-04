import { localDev } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import { incidentTurnContext } from "../lib/incident-context";
import { appSession } from "../lib/app-session";
import { recordSessionCreator } from "../lib/session-creator";
import { settleTurn, turnFactsFromView } from "../lib/turn-settled";

export default eveChannel({
  auth: [appSession, localDev()],
  // Text only for now: a file part would land in eve's sandbox, outside the artifact store and the old chat's
  // size and type limits (apps/web/lib/attachments.ts). Attachments are a follow-up (_specs/v2-m3-cutover.md 2b).
  uploadPolicy: "disabled",
  async onMessage(ctx) {
    // `clientContext` is client-supplied: replace it with a server-checked incident pointer, or nothing.
    return { auth: defaultEveAuth(ctx), clientContext: await incidentTurnContext(ctx.eve.caller, ctx.eve.clientContext) };
  },
  events: {
    // eve keeps no per-session access list: remember who created each session so route auth can
    // keep every other household and user out of it (agent/lib/app-session.ts).
    "session.started": (_event, ctx) => recordSessionCreator(ctx.session.id, ctx.session.auth.initiator),
    // The old chat's end-of-turn work (apps/web/lib/server/agent-run.ts): one usage row per turn and the
    // verdict the reply carries, both for the person who spoke this turn (never the session's creator).
    "turn.settled": (event, ctx) => settleTurn(ctx.session.auth.current, turnFactsFromView(ctx.view, event.data.turnId)),
  },
});
