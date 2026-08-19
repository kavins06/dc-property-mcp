import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const globalRoot = process.platform === "win32"
  ? join(process.env.APPDATA || "", "npm", "node_modules")
  : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const storeUrl = pathToFileURL(join(globalRoot, "workos", "dist", "lib", "config-store.js"));
const { getActiveEnvironment } = await import(storeUrl.href);
const workos = getActiveEnvironment();

if (!workos?.apiKey || !workos.clientId) {
  throw new Error("No active WorkOS CLI environment. Run `workos env add` first.");
}
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is required.");
}

const port = process.env.PORT || "3001";
const env = {
  ...process.env,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  MCP_SERVER_URL: process.env.MCP_SERVER_URL || "https://mcp.quoindata.com/mcp",
  WORKOS_API_KEY: workos.apiKey,
  WORKOS_CLIENT_ID: workos.clientId,
  WORKOS_COOKIE_PASSWORD: createHash("sha256")
    .update("quoin-local-cookie-v1\0")
    .update(workos.apiKey)
    .digest("base64url"),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI:
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || `http://localhost:${port}/auth/callback`,
};

const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "-p", port],
  { cwd: process.cwd(), env, stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 0));
