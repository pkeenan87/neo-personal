import { alertCreated } from "./alert-created";
import { artifactsExpire } from "./artifacts-expire";
import { devicesOffline } from "./devices-offline";
import { emailReceived } from "./email-received";
import { signalEscalate } from "./signal-escalate";

/** Every function served at /api/inngest. */
export const functions = [emailReceived, artifactsExpire, alertCreated, devicesOffline, signalEscalate];
