export interface Env {
  HYPERDRIVE: Hyperdrive;
  WORKOS_AUTHKIT_DOMAIN: string;
  WORKOS_RESOURCE_URI: string;
  ALLOWED_ORIGINS: string;
  GENERAL_RATE_LIMITER?: RateLimit;
  SEARCH_RATE_LIMITER?: RateLimit;
}

export interface AuthSubject {
  sub: string;
  scope: string[];
}
