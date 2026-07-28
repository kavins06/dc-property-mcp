export const ACTIVE_LOADS = Object.freeze([
  Object.freeze({
    table: "core.property_account_current",
    fileName: "property_account_current.csv.gz",
    expectedRows: 221_263,
    phase: "initial",
  }),
  Object.freeze({
    table: "history.tax_series",
    fileName: "tax_series.csv.gz",
    expectedRows: 221_263,
    phase: "initial",
  }),
  Object.freeze({
    table: "history.sale_series",
    fileName: "sale_series.csv.gz",
    expectedRows: 215_408,
    phase: "sale",
  }),
]);

export const EXPECTED_LINKED_SALE_ROWS = 421_436;
// Preserve capacity for the other databases sharing the 200 GB Hetzner
// volume. These replace the former Supabase plan ceiling and remain well above
// the measured v0.4 production database size.
export const DATABASE_SIZE_WARNING_BYTES = 25_000_000_000;
export const DATABASE_SIZE_HARD_LIMIT_BYTES = 40_000_000_000;

export function databaseSizeLevel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError("Database size must be a finite non-negative number.");
  }
  if (bytes >= DATABASE_SIZE_HARD_LIMIT_BYTES) return "hard_limit";
  if (bytes >= DATABASE_SIZE_WARNING_BYTES) return "warning";
  return "ok";
}
