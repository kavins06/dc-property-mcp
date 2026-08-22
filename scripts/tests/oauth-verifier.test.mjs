import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(import.meta.dirname, "../verify-authenticated-mcp.mjs"),
  "utf8",
);

test("OAuth verifier callback and network calls are locally and temporally bounded", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:\$\{callbackPort\}\/callback/);
  assert.match(source, /request\.socket\.remoteAddress !== "127\.0\.0\.1"/);
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /host: "127\.0\.0\.1"/);
  assert.match(source, /AbortSignal\.timeout\(requestTimeoutSeconds \* 1000\)/);
  assert.doesNotMatch(source, /host: "::"/);
});
