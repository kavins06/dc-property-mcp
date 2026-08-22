// Committed rollback rehearsals may use only a deliberately named disposable
// database. PostgreSQL limits database names to 63 bytes; keep the same bound
// in the tool guard so a name accepted here is accepted by the SQL guard.
export const DMV_ROLLBACK_DATABASE_PATTERN = /^dc_property_dmv_rollback_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isDmvRollbackDatabaseName(value) {
  const name = String(value ?? "").trim();
  return name.length <= 63 && DMV_ROLLBACK_DATABASE_PATTERN.test(name);
}
