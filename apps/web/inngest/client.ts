/**
 * Inngest client (inngest v4). Reads INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY
 * from the environment. v4 runs in cloud mode unless INNGEST_DEV is set
 * (e.g. INNGEST_DEV=1 with `npx inngest-cli dev` locally).
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "neo" });
