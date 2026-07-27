import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

const requireShim = `
import * as __nodePath from "node:path";
import * as __nodeUtil from "node:util";
import * as __nodeUtilTypes from "node:util/types";
import * as __nodeCrypto from "node:crypto";
import * as __nodeFs from "node:fs";
import * as __nodeDns from "node:dns";
import * as __nodeEvents from "node:events";
import * as __nodeNet from "node:net";
import * as __nodeTls from "node:tls";
import * as __nodeStream from "node:stream";
import * as __nodeStringDecoder from "node:string_decoder";
const __nodeBuiltinModules = {
  path: __nodePath,
  util: __nodeUtil,
  "util/types": __nodeUtilTypes,
  crypto: __nodeCrypto,
  fs: __nodeFs,
  dns: __nodeDns,
  events: __nodeEvents,
  net: __nodeNet,
  tls: __nodeTls,
  stream: __nodeStream,
  string_decoder: __nodeStringDecoder,
};
const require = (id) => {
  const value = __nodeBuiltinModules[id];
  if (value) return value;
  throw new Error("Unsupported optional Node module: " + id);
};
`;

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  conditions: ["workerd", "worker", "import"],
  external: ["cloudflare:*"],
  banner: { js: requireShim },
  logLevel: "info",
});
