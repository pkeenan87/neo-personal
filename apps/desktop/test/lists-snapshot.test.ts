import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectionLists } from "@neo/tools";
import { describe, expect, it } from "vitest";

const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), "..", "crates", "agent-service", "data", "lists-snapshot.json");

describe("the service's built-in lists", () => {
  it("match detectionLists(); run `pnpm --filter @neo/desktop lists` after changing the list data", () => {
    const committed = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(detectionLists())));
  });
});
