/** Inngest endpoint: GET (introspection), POST (run steps), PUT (sync). Signed with INNGEST_SIGNING_KEY. */
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
