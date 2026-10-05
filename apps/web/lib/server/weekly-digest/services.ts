import { getDb } from "../db";
import { createDbDigestServices, createMemoryDigestContentStore, resolveMemoryDigestRecipient, type DigestServices } from "./data";
import { createMemoryDigestRecipientStore, createMemoryWeeklyDigestStore } from "./store";

const g = globalThis as typeof globalThis & { __neoMemoryDigestServices?: DigestServices };
export function getDigestServices(): DigestServices {
  const db = getDb();
  if (db) return createDbDigestServices(db);
  g.__neoMemoryDigestServices ??= {
    store: createMemoryWeeklyDigestStore(),
    recipients: createMemoryDigestRecipientStore(),
    content: createMemoryDigestContentStore(),
    resolveRecipient: resolveMemoryDigestRecipient,
  };
  return g.__neoMemoryDigestServices;
}
