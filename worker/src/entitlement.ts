import type { Env } from "./types";

export type EntitlementDecision = {
  allowed: boolean;
  reason: string;
  unavailable?: boolean;
};

export type BillingAccount = {
  subscription_status?: string | null;
  grace_until?: number | null;
  trial_ends_at?: number | null;
  current_period_end?: number | null;
};

export function evaluateEntitlement(
  account: BillingAccount | null,
  now = Math.floor(Date.now() / 1000),
): EntitlementDecision {
  if (!account) return { allowed: false, reason: "subscription_required" };
  if (account.subscription_status === "trialing") {
    return Number(account.trial_ends_at ?? 0) > now
      ? { allowed: true, reason: "trialing" }
      : { allowed: false, reason: "trial_expired" };
  }
  if (account.subscription_status === "active") {
    return Number(account.current_period_end ?? 0) > now
      ? { allowed: true, reason: "active" }
      : { allowed: false, reason: "period_expired" };
  }
  if (
    account.subscription_status === "past_due" &&
    Number(account.grace_until ?? 0) > now
  ) {
    return { allowed: true, reason: "grace_period" };
  }
  return {
    allowed: false,
    reason: account.subscription_status || "subscription_required",
  };
}

export async function checkEntitlement(
  workosUserId: string,
  env: Env,
): Promise<EntitlementDecision> {
  const mode = env.BILLING_ENFORCEMENT ?? "off";
  if (mode === "off") return { allowed: true, reason: "enforcement_off" };
  if (!env.BILLING_DB) {
    return mode === "shadow"
      ? { allowed: true, reason: "shadow_database_unavailable" }
      : { allowed: false, reason: "database_unavailable", unavailable: true };
  }
  try {
    const account = await env.BILLING_DB.prepare(
      `SELECT subscription_status, grace_until, trial_ends_at, current_period_end
         FROM billing_accounts WHERE workos_user_id = ?`,
    ).bind(workosUserId).first<BillingAccount>();
    const decision = evaluateEntitlement(account);
    if (mode === "shadow") {
      console.log({
        event: "billing_shadow_decision",
        allowed: decision.allowed,
        reason: decision.reason,
      });
      return { allowed: true, reason: "shadow_mode" };
    }
    return decision;
  } catch {
    return mode === "shadow"
      ? { allowed: true, reason: "shadow_database_unavailable" }
      : { allowed: false, reason: "database_unavailable", unavailable: true };
  }
}
