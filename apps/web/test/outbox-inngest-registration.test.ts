import { describe, expect, it } from "vitest";
import { functions } from "@/inngest/functions";
import { alertCreated } from "@/inngest/functions/alert-created";
import { outboxSweep } from "@/inngest/functions/outbox-sweep";

describe("outbox Inngest registration", () => {
  it("serves the alert drain (id unchanged) and the 5-minute sweep", () => {
    expect(functions).toContain(alertCreated);
    expect(functions).toContain(outboxSweep);
    expect(alertCreated.id()).toContain("alert-created");
    expect(outboxSweep.id()).toContain("outbox-sweep");
  });
});
