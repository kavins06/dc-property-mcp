export interface Env {
  HYPERDRIVE: Hyperdrive;
  WORKOS_AUTHKIT_DOMAIN: string;
  WORKOS_RESOURCE_URI: string;
  WORKOS_CHAT_CLIENT_ID?: string;
  ALLOWED_ORIGINS: string;
  BILLING_DB?: D1Database;
  BILLING_ENFORCEMENT?: "off" | "shadow" | "on";
  ENTITLEMENT_HELP_URL?: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
  ENVIRONMENT?: string;
  GENERAL_RATE_LIMITER?: RateLimit;
  SEARCH_RATE_LIMITER?: RateLimit;
}

export interface AuthSubject {
  sub: string;
  scope: string[];
}
