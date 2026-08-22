export interface Env {
  HYPERDRIVE: Hyperdrive;
  WORKOS_AUTHKIT_DOMAIN: string;
  WORKOS_RESOURCE_URI: string;
  ALLOWED_ORIGINS: string;
  BILLING_DB?: D1Database;
  BILLING_ENFORCEMENT?: "off" | "shadow" | "on";
  ENTITLEMENT_HELP_URL?: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
  ENVIRONMENT?: string;
  /** Expected immutable national publication contract sent to PostgreSQL. */
  NATIONAL_CONTRACT_VERSION?: string;
  /** Publish the national MCP catalog only after its database contract passes Gate 6. */
  NATIONAL_SURFACE_ENABLED?: "false" | "true";
  /** SHA-256 of the operator-only token required by a staged candidate version. */
  CANDIDATE_ACCESS_SHA256?: string;
  GENERAL_RATE_LIMITER?: RateLimit;
  SEARCH_RATE_LIMITER?: RateLimit;
}

export interface AuthSubject {
  sub: string;
  scope: string[];
}
