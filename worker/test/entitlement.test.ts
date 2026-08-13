import { describe, expect, it, vi } from "vitest";
import { checkEntitlement, evaluateEntitlement } from "../src/entitlement";
import type { Env } from "../src/types";

describe("billing entitlement", () => {
  it("allows active and trialing accounts", () => {
    expect(evaluateEntitlement({ subscription_status: "trialing", trial_ends_at: 101 }, 100).allowed).toBe(true);
    expect(evaluateEntitlement({ subscription_status: "active", current_period_end: 101 }, 100).allowed).toBe(true);
  });

  it("fails closed after the recorded trial or billing period", () => {
    expect(evaluateEntitlement({ subscription_status: "trialing", trial_ends_at: 100 }, 100))
      .toEqual({ allowed: false, reason: "trial_expired" });
    expect(evaluateEntitlement({ subscription_status: "active", current_period_end: 100 }, 100))
      .toEqual({ allowed: false, reason: "period_expired" });
  });

  it("allows past-due access only inside the three-day grace window", () => {
    expect(evaluateEntitlement({ subscription_status: "past_due", grace_until: 101 }, 100).allowed).toBe(true);
    expect(evaluateEntitlement({ subscription_status: "past_due", grace_until: 100 }, 100).allowed).toBe(false);
  });

  it.each(["paused", "unpaid", "canceled", "incomplete"])("denies %s", (status) => {
    expect(evaluateEntitlement({ subscription_status: status }).allowed).toBe(false);
  });

  it("fails closed in on mode when D1 is unavailable", async () => {
    await expect(checkEntitlement("user_1", { BILLING_ENFORCEMENT: "on" } as Env))
      .resolves.toEqual({ allowed: false, reason: "database_unavailable", unavailable: true });
  });

  it("observes without blocking in shadow mode", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => ({ subscription_status: "paused" }) }) }),
    } as unknown as D1Database;
    await expect(checkEntitlement("user_1", {
      BILLING_ENFORCEMENT: "shadow", BILLING_DB: db,
    } as Env)).resolves.toEqual({ allowed: true, reason: "shadow_mode" });
  });
});
