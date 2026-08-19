import { z } from "zod";

const schema = z.object({
  GOOGLE_VERTEX_PROJECT: z.string().min(1),
  GOOGLE_VERTEX_LOCATION: z.string().min(1),
  GCP_PROJECT_NUMBER: z.string().regex(/^\d+$/).optional(),
  GCP_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  GCP_WORKLOAD_IDENTITY_POOL_ID: z.string().min(1).optional(),
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1),
  MCP_SERVER_URL: z.url(),
});

export type ServerEnv = z.infer<typeof schema>;

export function getServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Missing or invalid server configuration: ${result.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  }

  if (
    source.VERCEL &&
    ![
      result.data.GCP_PROJECT_NUMBER,
      result.data.GCP_SERVICE_ACCOUNT_EMAIL,
      result.data.GCP_WORKLOAD_IDENTITY_POOL_ID,
      result.data.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID,
    ].every(Boolean)
  ) {
    throw new Error("Missing GCP Workload Identity Federation configuration.");
  }

  const url = new URL(result.data.MCP_SERVER_URL);
  const allowedHosts = new Set([
    "mcp.quoindata.com",
    "dc-property-mcp.quoindata.com",
  ]);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.pathname !== "/mcp" || (!allowedHosts.has(url.hostname) && !(local && source.NODE_ENV !== "production"))) {
    throw new Error("MCP_SERVER_URL must be an approved Quoin MCP endpoint.");
  }
  if (url.protocol !== "https:" && !local) {
    throw new Error("MCP_SERVER_URL must use HTTPS.");
  }

  return result.data;
}
