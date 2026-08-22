import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GetBucketAclCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetObjectLockConfigurationCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import { archiveEncryption, s3ClientConfig } from "./archive-to-s3.mjs";
import {
  validateArchiveReceipt,
  sha256File,
} from "./lib/s3-archive.mjs";

export const HETZNER_ARCHIVE_TARGET = Object.freeze({
  bucket: "quoindata",
  endpoint: "https://fsn1.your-objectstorage.com",
  region: "fsn1",
});

const project = resolve(import.meta.dirname, "..");
const receiptRoot = resolve(project, "archive-receipts");
const reportRoot = resolve(project, "db", "reports", "generated");
const READ_TIMEOUT_MS = 45 * 1000;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the read-only archive verifier.`);
  return value;
}

export function assertExactTarget(environment = process.env) {
  const target = {
    bucket: required(environment, "HETZNER_S3_BUCKET"),
    endpoint: required(environment, "HETZNER_S3_ENDPOINT"),
    region: required(environment, "HETZNER_S3_REGION"),
  };
  for (const [name, expected] of Object.entries(HETZNER_ARCHIVE_TARGET)) {
    if (target[name] !== expected) {
      throw new Error(
        `Read-only archive verifier refuses non-canonical ${name}; ` +
          `expected ${expected}.`,
      );
    }
  }
  return target;
}

function canonical(value) {
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function safeError(error) {
  return {
    name: error?.name ?? "UnknownError",
    code: error?.Code ?? error?.code ?? null,
    http_status: error?.$metadata?.httpStatusCode ?? null,
  };
}

function sendRead(client, command) {
  return client.send(command, { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
}

async function readOptional(label, callback) {
  try {
    return { available: true, value: await callback() };
  } catch (error) {
    return { available: false, error: { label, ...safeError(error) } };
  }
}

function objectRecord(item) {
  if (typeof item?.Key !== "string" || !item.Key) {
    throw new Error("S3 returned an object without a key.");
  }
  if (!Number.isSafeInteger(item.Size) || item.Size < 0) {
    throw new Error(`S3 returned an invalid size for ${item.Key}.`);
  }
  const lastModified = item.LastModified?.toISOString?.();
  if (!lastModified) throw new Error(`S3 returned no LastModified for ${item.Key}.`);
  return {
    key: item.Key,
    size: item.Size,
    etag: String(item.ETag ?? "").replace(/^"|"$/g, ""),
    last_modified: lastModified,
  };
}

export async function listInventory(client, bucket) {
  const objects = [];
  let continuationToken;
  let page = 0;
  do {
    const response = await sendRead(client, new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    page += 1;
    process.stderr.write(`archive inventory page ${page}: ${objects.length + (response.Contents?.length ?? 0)} objects\n`);
    for (const item of response.Contents ?? []) objects.push(objectRecord(item));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  objects.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return {
    object_count: objects.length,
    total_bytes: objects.reduce((total, object) => total + object.size, 0),
    inventory_sha256: digest(objects),
    objects,
  };
}

export function compareInventories(first, second) {
  const before = new Map(first.objects.map((object) => [object.key, object]));
  const after = new Map(second.objects.map((object) => [object.key, object]));
  const additions = [];
  const deletions = [];
  const mutations = [];
  for (const object of first.objects) {
    const current = after.get(object.key);
    if (!current) {
      deletions.push(object.key);
    } else if (canonical(object) !== canonical(current)) {
      mutations.push({ key: object.key, before: object, after: current });
    }
  }
  for (const object of second.objects) if (!before.has(object.key)) additions.push(object.key);
  if (deletions.length || mutations.length) {
    throw new Error(
      `Object inventory changed between read-only passes: ` +
        `${deletions.length} deletions, ${mutations.length} mutations.`,
    );
  }
  return { additions, deletions, mutations };
}

function prefixTotals(objects) {
  const totals = new Map([["", { object_count: 0, total_bytes: 0 }]]);
  for (const object of objects) {
    const segments = object.key.split("/");
    const prefixes = [""];
    for (let index = 1; index < segments.length; index += 1) {
      prefixes.push(`${segments.slice(0, index).join("/")}/`);
    }
    for (const prefix of prefixes) {
      const current = totals.get(prefix) ?? { object_count: 0, total_bytes: 0 };
      current.object_count += 1;
      current.total_bytes += object.size;
      totals.set(prefix, current);
    }
  }
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function cleanLifecycle(rules = []) {
  return rules.map((rule) => ({
    id: rule.ID ?? null,
    status: rule.Status ?? null,
    prefix: rule.Filter?.Prefix ?? rule.Prefix ?? null,
    expiration_days: rule.Expiration?.Days ?? null,
    expiration_date: rule.Expiration?.Date?.toISOString?.() ?? null,
  }));
}

function cleanEncryption(result) {
  const rules = result.ServerSideEncryptionConfiguration?.Rules ?? [];
  return {
    enabled: rules.length > 0,
    rule_count: rules.length,
    algorithms: [...new Set(rules.map((rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).filter(Boolean))].sort(),
  };
}

async function bucketState(client, bucket) {
  const [location, versioning, objectLock, lifecycle, policy, acl, encryption] = await Promise.all([
    readOptional("location", () => sendRead(client, new GetBucketLocationCommand({ Bucket: bucket }))),
    readOptional("versioning", () => sendRead(client, new GetBucketVersioningCommand({ Bucket: bucket }))),
    readOptional("object_lock", () => sendRead(client, new GetObjectLockConfigurationCommand({ Bucket: bucket }))),
    readOptional("lifecycle", () => sendRead(client, new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))),
    readOptional("policy_status", () => sendRead(client, new GetBucketPolicyStatusCommand({ Bucket: bucket }))),
    readOptional("acl", () => sendRead(client, new GetBucketAclCommand({ Bucket: bucket }))),
    readOptional("encryption", () => sendRead(client, new GetBucketEncryptionCommand({ Bucket: bucket }))),
  ]);
  const grants = acl.available
    ? (acl.value.Grants ?? []).map((grant) => ({
        permission: grant.Permission ?? null,
        grantee_type: grant.Grantee?.Type ?? null,
        grantee_uri: grant.Grantee?.URI ?? null,
      }))
    : [];
  const publicAcl = grants.some((grant) =>
    ["READ", "WRITE", "READ_ACP", "WRITE_ACP", "FULL_CONTROL"].includes(grant.permission) &&
    ["http://acs.amazonaws.com/groups/global/AllUsers", "http://acs.amazonaws.com/groups/global/AuthenticatedUsers"].includes(grant.grantee_uri),
  );
  return {
    location: location.available ? (location.value.LocationConstraint ?? "us-east-1") : null,
    versioning: versioning.available ? {
      status: versioning.value.Status ?? "Disabled",
      mfa_delete: versioning.value.MFADelete ?? "Disabled",
    } : null,
    object_lock: objectLock.available ? {
      enabled: objectLock.value.ObjectLockEnabled === "Enabled",
      default_retention: objectLock.value.Rule?.DefaultRetention?.Mode ?? null,
    } : { enabled: false },
    lifecycle: lifecycle.available ? cleanLifecycle(lifecycle.value.Rules) : [],
    policy: policy.available ? { is_public: policy.value.PolicyStatus?.IsPublic === true } : { is_public: null },
    acl: { public: publicAcl, grants },
    default_encryption: encryption.available ? cleanEncryption(encryption.value) : { enabled: false, rule_count: 0, algorithms: [] },
    read_errors: [location, versioning, objectLock, lifecycle, policy, acl, encryption]
      .filter((result) => !result.available)
      .map((result) => result.error),
  };
}

async function streamHash(body) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function objectReadHeaders(receipt, encryption) {
  return receipt.receipt_version === 2 ? encryption.request : {};
}

async function verifyReceiptCoverage(client, target, encryption) {
  const names = (await readdir(receiptRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const receipts = [];
  const seenObjects = new Map();
  for (const name of names) {
    const path = resolve(receiptRoot, name);
    const bytes = await readFile(path);
    let receipt;
    try {
      receipt = validateArchiveReceipt(JSON.parse(bytes), { allowLegacyV1: true });
    } catch (error) {
      throw new Error(`Invalid local archive receipt ${name}: ${error.message}`);
    }
    if (receipt.provider !== "hetzner_object_storage" || receipt.bucket !== target.bucket || receipt.endpoint !== target.endpoint || receipt.region !== target.region) {
      throw new Error(`Archive receipt ${name} does not target the canonical private bucket.`);
    }
    if (receipt.receipt_version === 2 && receipt.encryption.key_sha256 !== encryption.receipt.key_sha256) {
      throw new Error(`Archive receipt ${name} uses an unexpected SSE-C key fingerprint.`);
    }
    const receiptSha256 = await sha256File(path);
    const objectEntries = receipt.files.flatMap((file) => file.parts.map((part) => ({
      key: part.object_key,
      bytes: part.bytes,
      sha256: part.sha256,
      kind: "part",
      receipt_version: receipt.receipt_version,
    })));
    objectEntries.push({
      key: receipt.receipt_object_key,
      bytes: bytes.length,
      sha256: receiptSha256,
      kind: "receipt",
      receipt_version: receipt.receipt_version,
    });
    for (const expected of objectEntries) {
      const prior = seenObjects.get(expected.key);
      if (prior && canonical(prior) !== canonical(expected)) throw new Error(`Conflicting receipt coverage for ${expected.key}.`);
      seenObjects.set(expected.key, expected);
    }
    receipts.push({
      file: name,
      archive_id: receipt.archive_id,
      receipt_version: receipt.receipt_version,
      encryption_key_sha256: receipt.encryption?.key_sha256 ?? null,
      file_count: receipt.files.length,
      part_count: receipt.files.reduce((total, file) => total + file.parts.length, 0),
      total_bytes: receipt.files.reduce((total, file) => total + file.bytes, 0),
      receipt_sha256: receiptSha256,
      receipt_object_key: receipt.receipt_object_key,
    });
  }
  let checkedObjects = 0;
  for (const expected of seenObjects.values()) {
    const head = await sendRead(client, new HeadObjectCommand({
      Bucket: target.bucket,
      Key: expected.key,
      ...objectReadHeaders(expected, encryption),
    }));
    const metadata = Object.fromEntries(Object.entries(head.Metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    if (head.ContentLength !== expected.bytes || metadata["dc-property-sha256"] !== expected.sha256) {
      throw new Error(`Remote receipt coverage mismatch for ${expected.key}.`);
    }
    checkedObjects += 1;
    if (checkedObjects % 25 === 0) process.stderr.write(`archive receipt coverage: ${checkedObjects}/${seenObjects.size} objects\n`);
  }
  const remoteReceipts = new Map();
  for (const receipt of receipts) {
    const request = receipt.receipt_version === 2 ? encryption.request : {};
    const response = await sendRead(client, new GetObjectCommand({ Bucket: target.bucket, Key: receipt.receipt_object_key, ...request }));
    if (!response.Body) throw new Error(`Remote receipt has no body: ${receipt.receipt_object_key}`);
    const observed = await streamHash(response.Body);
    if (observed.bytes !== (await readFile(resolve(receiptRoot, receipt.file))).length || observed.sha256 !== receipt.receipt_sha256) {
      throw new Error(`Remote receipt body differs from local receipt: ${receipt.file}`);
    }
    remoteReceipts.set(receipt.archive_id, true);
  }
  const encryptionFingerprints = [...new Set(receipts.map((receipt) => receipt.encryption_key_sha256).filter(Boolean))].sort();
  return {
    local_receipt_count: receipts.length,
    legacy_v1_count: receipts.filter((receipt) => receipt.receipt_version === 1).length,
    encrypted_v2_count: receipts.filter((receipt) => receipt.receipt_version === 2).length,
    covered_remote_object_count: seenObjects.size,
    covered_remote_receipt_count: remoteReceipts.size,
    encryption_key_sha256: encryptionFingerprints,
    receipts,
  };
}

export async function verifyHetznerArchive(environment = process.env) {
  const target = assertExactTarget(environment);
  const encryption = archiveEncryption(environment);
  const client = new S3Client(s3ClientConfig(environment));
  try {
    const first = await listInventory(client, target.bucket);
    const second = await listInventory(client, target.bucket);
    const comparison = compareInventories(first, second);
    const state = await bucketState(client, target.bucket);
    const coverage = await verifyReceiptCoverage(client, target, encryption);
    return {
      verifier: "verify-hetzner-archive",
      status: "passed",
      target,
      observed_at: new Date().toISOString(),
      inventory: {
        ...first,
        prefix_totals: prefixTotals(first.objects),
      },
      second_inventory: {
        object_count: second.object_count,
        total_bytes: second.total_bytes,
        inventory_sha256: second.inventory_sha256,
      },
      inventory_comparison: {
        additions_allowed: comparison.additions.length,
        additions: comparison.additions,
        existing_deletions: comparison.deletions.length,
        existing_mutations: comparison.mutations.length,
      },
      bucket_state: state,
      receipt_coverage: coverage,
      non_secret_encryption: {
        archive_sse_c_key_sha256: encryption.receipt.key_sha256,
        receipt_fingerprints: coverage.encryption_key_sha256,
      },
      remote_mutations: 0,
    };
  } finally {
    client.destroy();
  }
}

async function main() {
  const report = await verifyHetznerArchive();
  await mkdir(reportRoot, { recursive: true });
  const stamp = report.observed_at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const reportPath = resolve(reportRoot, `hetzner-archive-gate1-${stamp}.json`);
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    success: true,
    report_path: reportPath,
    report_sha256: createHash("sha256").update(bytes).digest("hex"),
    inventory_sha256: report.inventory.inventory_sha256,
    object_count: report.inventory.object_count,
    total_bytes: report.inventory.total_bytes,
    receipt_count: report.receipt_coverage.local_receipt_count,
    remote_mutations: 0,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
