import { artifactsExpire } from "./artifacts-expire";
import { emailReceived } from "./email-received";

/** Every function served at /api/inngest. */
export const functions = [emailReceived, artifactsExpire];
