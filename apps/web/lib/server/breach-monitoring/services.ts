import { inboundEnv } from "@/lib/env";
import { getDb } from "@/lib/server/db";
import { deliverBreachVerificationEmail } from "@/lib/server/breach-monitoring/email";
import { createBreachAddressService, createDbBreachAddressService } from "@/lib/server/breach-monitoring/address-service";
import { createMemoryBreachAddressStore } from "@/lib/server/breach-monitoring/store";
import { getMailer } from "@/lib/server/email/resend";
import type { Mailer } from "@/lib/server/email/resend";

export function getBreachAddressService(options: { requireMail?: boolean } = {}) {
  const db = getDb();
  const mailer: Mailer | null = options.requireMail ? getMailer() : null;
  const common = {
    baseUrl: inboundEnv().APP_URL,
    source: process.env,
    ...(options.requireMail ? { mailConfigured: mailer !== null } : {}),
    sendVerificationEmail: async (message: Parameters<typeof deliverBreachVerificationEmail>[1]) => deliverBreachVerificationEmail(mailer ?? getMailer(), message),
  };
  if (db) return createDbBreachAddressService({ db, ...common });
  return createBreachAddressService({
    ...common,
    store: createMemoryBreachAddressStore(),
    resolveVerifiedSignin: async () => undefined,
  });
}
