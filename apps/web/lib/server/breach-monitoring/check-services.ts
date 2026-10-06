import { breachMonitoring } from "@neo/db";
import { getDb } from "@/lib/server/db";
import { alertBreachDetected } from "@/lib/server/alerts";
import { createBreachCheckService } from "./check-service";

export function getBreachCheckService() {
  const db = getDb();
  if (!db) return undefined;
  return createBreachCheckService({
    source: process.env,
    store: {
      getAddressForCheck: (target) => breachMonitoring.getAddressForCheck(db, target),
      updateCheck: (input) => breachMonitoring.updateCheck(db, input),
      upsertObservations: (input) => breachMonitoring.upsertObservations(db, input),
    },
    raiseAlert: alertBreachDetected,
  });
}

export function getBreachRecipientStore() {
  const db = getDb();
  if (!db) return undefined;
  return {
    listEligibleAddressIds: (input?: { cursor?: string; limit?: number }) => breachMonitoring.listEligibleAddressIds(db, input),
    getAddressForCheck: (target: { tenantId: string; userId: string; addressId: string }) => breachMonitoring.getAddressForCheck(db, target),
    updateCheck: (input: Parameters<typeof breachMonitoring.updateCheck>[1]) => breachMonitoring.updateCheck(db, input),
    purgeExpiredVerificationTokens: () => breachMonitoring.purgeExpiredVerificationTokens(db),
  };
}
