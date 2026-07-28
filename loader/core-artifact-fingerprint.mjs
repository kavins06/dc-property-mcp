import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse as parseCsv } from "csv-parse";
import { stringify as stringifyCsv } from "csv-stringify";
import { to as copyTo } from "pg-copy-streams";

export const ACCOUNT_MAPPING_COLUMNS = Object.freeze([
  "account_id",
  "source_id",
  "source_row_number",
  "ssl_normalized",
  "address_normalized",
  "unit_number",
  "is_deleted",
]);

function nullable(value) {
  return value === "" || value === undefined ? null : value;
}

export function canonicalAccountMappingRow(row) {
  const deleted = String(row.is_deleted).toLowerCase();
  if (!["true", "false", "t", "f"].includes(deleted)) {
    throw new Error(
      `Unexpected is_deleted value for account ${row.account_id}.`,
    );
  }
  return {
    account_id: row.account_id,
    source_id: row.source_id,
    source_row_number: row.source_row_number,
    ssl_normalized: row.ssl_normalized,
    address_normalized: nullable(row.address_normalized),
    unit_number: nullable(row.unit_number),
    is_deleted: ["true", "t"].includes(deleted) ? "t" : "f",
  };
}

export async function localAccountMappingFingerprint(artifactPath) {
  const hash = createHash("sha256");
  let rows = 0;
  let previousAccountId = 0;
  const canonicalize = async function* (source) {
    for await (const row of source) {
      const accountId = Number(row.account_id);
      if (
        !Number.isSafeInteger(accountId) ||
        accountId <= previousAccountId
      ) {
        throw new Error(
          "The property-account artifact must be uniquely ordered by " +
            "strictly increasing account_id.",
        );
      }
      previousAccountId = accountId;
      rows += 1;
      yield canonicalAccountMappingRow(row);
    }
  };
  const sink = async (source) => {
    for await (const chunk of source) hash.update(chunk);
  };
  await pipeline(
    createReadStream(artifactPath),
    createGunzip(),
    parseCsv({
      bom: true,
      columns: true,
      skip_empty_lines: true,
    }),
    canonicalize,
    stringifyCsv({
      columns: ACCOUNT_MAPPING_COLUMNS,
      header: false,
      record_delimiter: "\n",
    }),
    sink,
  );
  return { rows, sha256: hash.digest("hex") };
}

export async function databaseAccountMappingFingerprint(client) {
  const hash = createHash("sha256");
  const stream = client.query(
    copyTo(`
      copy (
        select
          account_id,
          source_id,
          source_row_number,
          ssl_normalized,
          address_normalized,
          unit_number,
          is_deleted
        from core.property_account_current
        order by account_id
      ) to stdout with (format csv, header false, null '')
    `),
  );
  for await (const chunk of stream) hash.update(chunk);
  const count = await client.query(
    "select count(*)::bigint rows from core.property_account_current",
  );
  return {
    rows: Number(count.rows[0].rows),
    sha256: hash.digest("hex"),
  };
}
