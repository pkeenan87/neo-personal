import { localDev } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import { incidentTurnContext } from "../lib/incident-context";
import { appSession } from "../lib/app-session";
import { recordSessionCreator } from "../lib/session-creator";

export default eveChannel({
  auth: [appSession, localDev()],
  async onMessage(ctx) {
    // `clientContext` is client-supplied: replace it with a server-checked incident pointer, or nothing.
    return { auth: defaultEveAuth(ctx), clientContext: await incidentTurnContext(ctx.eve.caller, ctx.eve.clientContext) };
  },
  events: {
    // eve keeps no per-session access list: remember who created each session so route auth can
    // keep every other household and user out of it (agent/lib/app-session.ts).
    "session.started": (_event, ctx) => recordSessionCreator(ctx.session.id, ctx.session.auth.initiator),
  },
});
