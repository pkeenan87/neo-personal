import type { AddressRow } from "@neo/db";

export const BREACH_STATUS_STALE_AFTER_MS = 8 * 24 * 60 * 60_000;
export type BreachSurfaceStatus = "pending" | "clean" | "breached" | "stale" | "never-checked" | "failed";
type StatusInput = Pick<AddressRow, "checkStatus" | "lastSuccessfulCheckAt"> & { verificationStatus: "pending" | "verified" };

export function deriveAddressBreachStatus(input: StatusInput, now = new Date()): BreachSurfaceStatus {
  if (input.verificationStatus === "pending") return "pending";
  if (input.checkStatus === "failed") return "failed";
  const lastSuccess = input.lastSuccessfulCheckAt;
  if (!lastSuccess) return "never-checked";
  if (now.getTime() - lastSuccess.getTime() > BREACH_STATUS_STALE_AFTER_MS) return "stale";
  if (input.checkStatus === "breached") return "breached";
  return "clean";
}

export function deriveOverallBreachStatus(addresses: StatusInput[], now = new Date()): Exclude<BreachSurfaceStatus, "pending"> {
  if (addresses.length === 0) return "never-checked";
  const statuses = addresses.map((address) => deriveAddressBreachStatus(address, now));
  if (statuses.includes("breached")) return "breached";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("stale")) return "stale";
  if (statuses.some((status) => status === "pending" || status === "never-checked")) return "never-checked";
  return "clean";
}
