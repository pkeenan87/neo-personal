import { breachMonitoring, type BreachObservationRow } from "@neo/db";
import { getDb } from "@/lib/server/db";
import { getBreachAddressService } from "./services";
import { deriveAddressBreachStatus, deriveOverallBreachStatus, type BreachSurfaceStatus } from "./status";

export type BreachStatusObservation = {
  breachName: string;
  domain: string | null;
  breachDate: string | null;
  addedDate: string | null;
  dataClasses: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  retiredAt: string | null;
};
export type BreachStatusAddress = {
  id: string;
  email: string;
  source: "sign_in" | "extra";
  verificationStatus: "pending" | "verified";
  status: BreachSurfaceStatus;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  observations: BreachStatusObservation[];
};
export type BreachStatusSnapshot = {
  status: Exclude<BreachSurfaceStatus, "pending">;
  lastSuccessfulCheckAt: string | null;
  pendingCount: number;
  addresses: BreachStatusAddress[];
  attribution: { label: "Have I Been Pwned"; url: "https://haveibeenpwned.com"; license: "CC BY 4.0" };
};

function toObservation(row: BreachObservationRow): BreachStatusObservation {
  return {
    breachName: row.breachName,
    domain: row.domain ?? null,
    breachDate: row.breachDate?.toISOString().slice(0, 10) ?? null,
    addedDate: row.addedDate?.toISOString() ?? null,
    dataClasses: row.dataClasses,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

export async function getBreachStatusForUser(input: { tenantId: string; userId: string }, now = new Date()): Promise<BreachStatusSnapshot> {
  const addressService = getBreachAddressService();
  const addressRows = await addressService.listAddresses(input);
  const db = getDb();
  const addresses = await Promise.all(addressRows.map(async (address) => {
    const verificationStatus = address.verificationStatus;
    const rowStatus = deriveAddressBreachStatus({
      verificationStatus,
      checkStatus: address.checkStatus,
      lastSuccessfulCheckAt: address.lastSuccessfulCheckAt ? new Date(address.lastSuccessfulCheckAt) : undefined,
    }, now);
    const observations = db && verificationStatus === "verified"
      ? (await breachMonitoring.listObservations(db, { tenantId: input.tenantId, userId: input.userId, addressId: address.id })).map(toObservation)
      : [];
    return {
      id: address.id,
      email: address.email,
      source: address.source,
      verificationStatus,
      status: rowStatus,
      verifiedAt: address.verifiedAt,
      lastCheckedAt: address.lastCheckedAt,
      lastSuccessfulCheckAt: address.lastSuccessfulCheckAt,
      observations,
    } satisfies BreachStatusAddress;
  }));
  const statusInputs = addressRows.map((address) => ({
    verificationStatus: address.verificationStatus,
    checkStatus: address.checkStatus,
    lastSuccessfulCheckAt: address.lastSuccessfulCheckAt ? new Date(address.lastSuccessfulCheckAt) : undefined,
  }));
  const successes = addressRows.flatMap((address) => address.lastSuccessfulCheckAt ? [address.lastSuccessfulCheckAt] : []).sort();
  return {
    status: deriveOverallBreachStatus(statusInputs, now),
    lastSuccessfulCheckAt: successes.at(-1) ?? null,
    pendingCount: addresses.filter((address) => address.verificationStatus === "pending").length,
    addresses,
    attribution: { label: "Have I Been Pwned", url: "https://haveibeenpwned.com", license: "CC BY 4.0" },
  };
}
