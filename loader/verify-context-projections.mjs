import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { parse as parseCsv } from "csv-parse";

import { normalizeCamaYear } from "./sql-projection.mjs";

export async function verifyContextProjectionCompatibility(path) {
  const counts = {
    rows: 0,
    cama_rows: 0,
    valid_year_built: 0,
    nulled_year_built: 0,
    valid_year_renovated: 0,
    nulled_year_renovated: 0,
  };
  const rows = createReadStream(path)
    .pipe(createGunzip())
    .pipe(parseCsv({
      bom: true,
      columns: true,
      skip_empty_lines: true,
    }));
  for await (const row of rows) {
    counts.rows += 1;
    if (row.record_type !== "cama_building_profile") continue;
    counts.cama_rows += 1;
    let facts;
    try {
      facts = JSON.parse(row.facts_json);
    } catch (error) {
      throw new Error(
        `Context row ${counts.rows} contains invalid facts_json: ${error.message}`,
      );
    }
    for (const [field, validKey, nulledKey] of [
      ["AYB", "valid_year_built", "nulled_year_built"],
      ["YR_RMDL", "valid_year_renovated", "nulled_year_renovated"],
    ]) {
      const raw = facts[field];
      if (raw === null || raw === undefined || raw === "") continue;
      const projected = normalizeCamaYear(raw);
      if (projected === null) {
        counts[nulledKey] += 1;
      } else {
        if (projected < 1600 || projected > 2200) {
          throw new Error(
            `Unsafe projected ${field} value ${projected} at row ${counts.rows}.`,
          );
        }
        counts[validKey] += 1;
      }
    }
  }
  if (counts.rows < 1 || counts.cama_rows < 1) {
    throw new Error("Context artifact contains no CAMA rows.");
  }
  return counts;
}
