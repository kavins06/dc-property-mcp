import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED = {
  states: {
    header: ["USPS", "GEOID", "GEOIDFQ", "NAME", "ALAND", "AWATER", "ALAND_SQMI", "AWATER_SQMI", "INTPTLAT", "INTPTLONG"],
    rows: 52,
    zipSha256: "5c0bb56f4824af366538d73bffd229e790d301356624302eeca24d09cf27ba30",
  },
  counties: {
    header: ["USPS", "GEOID", "GEOIDFQ", "ANSICODE", "NAME", "ALAND", "AWATER", "ALAND_SQMI", "AWATER_SQMI", "INTPTLAT", "INTPTLONG"],
    rows: 3222,
    zipSha256: "4c90d0f805779923b5958ab13d0c1e9b99fe4932b786bfcf75dd739bb2dcb4ea",
  },
};

function requireArg(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return resolve(value);
}

export function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function countyKind(stateFips, name) {
  if (["24", "29", "32", "51"].includes(stateFips) && / city$/i.test(name)) {
    return "independent_city";
  }
  return / County$/i.test(name) ? "county" : "county_equivalent";
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function parsePipe(path, expected) {
  const lines = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const header = lines.shift().split("|");
  if (JSON.stringify(header) !== JSON.stringify(expected.header)) {
    throw new Error(`Unexpected ${basename(path)} header.`);
  }
  const rows = lines.map((line, rowIndex) => {
    const fields = line.split("|");
    if (fields.length !== header.length) {
      throw new Error(`${basename(path)} row ${rowIndex + 2} has ${fields.length} fields.`);
    }
    return Object.fromEntries(header.map((key, index) => [key, fields[index]]));
  });
  if (rows.length !== expected.rows) {
    throw new Error(`${basename(path)} has ${rows.length} rows; expected ${expected.rows}.`);
  }
  return rows;
}

function insertBatches(table, columns, rows, render, size = 400) {
  const statements = [];
  for (let index = 0; index < rows.length; index += size) {
    const batch = rows.slice(index, index + size);
    statements.push(
      `insert into ${table} (${columns.join(", ")})\nvalues\n${batch.map(render).join(",\n")};`,
    );
  }
  return statements.join("\n\n");
}

function buildSql(states, counties) {
  const fipsByUsps = new Map(states.map((row) => [row.USPS, row.GEOID]));
  if (fipsByUsps.size !== states.length || !fipsByUsps.has("DC") || !fipsByUsps.has("PR")) {
    throw new Error("State identity map is incomplete or duplicated.");
  }
  const countyIds = new Set(counties.map((row) => row.GEOID));
  if (countyIds.size !== counties.length || counties.some((row) => !fipsByUsps.has(row.USPS))) {
    throw new Error("County identity map is incomplete, duplicated, or has an unknown parent.");
  }

  const newStates = states.filter((row) => row.USPS !== "DC");
  const stateAreas = insertBatches(
    "geo.area",
    ["area_uid", "area_kind", "official_name", "country_code", "state_code"],
    newStates,
    (row) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}`)}, ${sqlText(row.USPS === "PR" ? "territory" : "state")}, ${sqlText(row.NAME)}, 'US', ${sqlText(row.USPS)})`,
  );
  const stateIdentifiers = insertBatches(
    "geo.area_identifier",
    ["area_uid", "identifier_authority", "identifier_namespace", "raw_identifier", "normalization_version"],
    newStates.flatMap((row) => [
      [row, "USPS", "STATE_ABBREVIATION", row.USPS, "upper-v1"],
      [row, "US_CENSUS", "STATE_FIPS", row.GEOID, "digits-v1"],
      [row, "US_CENSUS", "GEOIDFQ", row.GEOIDFQ, "raw-v1"],
    ]),
    ([row, authority, namespace, value, version]) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}`)}, ${sqlText(authority)}, ${sqlText(namespace)}, ${sqlText(value)}, ${sqlText(version)})`,
  );
  const stateRelations = insertBatches(
    "geo.area_relation",
    ["child_area_uid", "parent_area_uid", "relationship_kind"],
    newStates,
    (row) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}`)}, 'area_us', 'contained_by')`,
  );
  const countyAreas = insertBatches(
    "geo.area",
    ["area_uid", "area_kind", "official_name", "country_code", "state_code"],
    counties,
    (row) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}_county_${row.GEOID}`)}, ${sqlText(countyKind(fipsByUsps.get(row.USPS), row.NAME))}, ${sqlText(row.NAME)}, 'US', ${sqlText(row.USPS)})`,
  );
  const countyIdentifiers = insertBatches(
    "geo.area_identifier",
    ["area_uid", "identifier_authority", "identifier_namespace", "raw_identifier", "normalization_version"],
    counties.flatMap((row) => [
      [row, "COUNTY_FIPS", row.GEOID],
      [row, "GEOIDFQ", row.GEOIDFQ],
      [row, "ANSI_CODE", row.ANSICODE],
    ]),
    ([row, namespace, value]) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}_county_${row.GEOID}`)}, 'US_CENSUS', ${sqlText(namespace)}, ${sqlText(value)}, 'raw-v1')`,
  );
  const countyRelations = insertBatches(
    "geo.area_relation",
    ["child_area_uid", "parent_area_uid", "relationship_kind"],
    counties,
    (row) => `  (${sqlText(`area_us_${row.USPS.toLowerCase()}_county_${row.GEOID}`)}, ${sqlText(`area_us_${row.USPS.toLowerCase()}`)}, 'contained_by')`,
  );

  return `-- Generated from the official 2025 U.S. Census Gazetteer files.
-- States ZIP: https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_state_national.zip
-- SHA-256: ${EXPECTED.states.zipSha256}
-- Counties ZIP: https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip
-- SHA-256: ${EXPECTED.counties.zipSha256}
-- The Gazetteer covers the 50 states, D.C., and Puerto Rico; other island
-- areas remain explicit unavailable fallbacks until an official seed is added.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('quoin-national-production-migration', 0));
do $guard$
declare
  v_hash text := pg_catalog.current_setting('quoin.migration_sha256', true);
  v_target text := pg_catalog.current_setting('quoin.migration_target_class', true);
begin
  if pg_catalog.current_database() <> 'dc_property'
     or v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
     or v_target not in ('rehearsal', 'production')
     or pg_catalog.to_regclass('meta.production_migration') is null
     or not exists (select 1 from meta.production_migration where migration_key = 'national-foundation-v1')
     or exists (select 1 from meta.production_migration where migration_key = 'national-geography-2025') then
    raise exception 'national geography seed target or migration ledger is invalid' using errcode = '55000';
  end if;
end;
$guard$;
set local role dc_property_admin;

${stateAreas}

${stateIdentifiers}

insert into geo.area_identifier (area_uid, identifier_authority, identifier_namespace, raw_identifier, normalization_version)
values ('area_us_dc', 'US_CENSUS', 'GEOIDFQ', '0400000US11', 'raw-v1');

${stateRelations}

${countyAreas}

${countyIdentifiers}

${countyRelations}

reset role;
set local role api_owner;
create or replace function api_v1.list_national_jurisdictions(p_state_code text default null)
returns jsonb language sql stable security definer
set search_path = pg_catalog, geo, meta
as $function$
  with active_publication as (
    select p.publication_set_id, p.contract_version
    from meta.publication_set_pointer pp
    join meta.publication_set p using (publication_set_id)
    where pp.pointer_name = 'national-v1' and p.publication_status = 'active'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'area_uid', a.area_uid, 'name', a.official_name, 'area_kind', a.area_kind,
    'country_code', a.country_code, 'state_code', a.state_code,
    'availability', coalesce(m.availability_status, 'unavailable'),
    'reason', coalesce(m.availability_reason, 'No public property records are available for this jurisdiction yet.'),
    'contract_version', coalesce(p.contract_version, 'national-v1')
  ) order by a.state_code, a.official_name, a.area_uid), '[]'::jsonb)
  from geo.area a
  left join active_publication p on true
  left join meta.publication_set_member m
    on m.publication_set_id = p.publication_set_id and m.area_uid = a.area_uid
  where a.area_kind in ('state', 'district', 'territory')
    and (p_state_code is null or a.state_code = upper(btrim(p_state_code)));
$function$;

create or replace function api_v1.get_national_jurisdiction_availability(p_state_code text, p_area_uid text default null)
returns jsonb language sql stable security definer
set search_path = pg_catalog, geo, meta
as $function$
  with active_publication as (
    select p.publication_set_id, p.contract_version
    from meta.publication_set_pointer pp
    join meta.publication_set p using (publication_set_id)
    where pp.pointer_name = 'national-v1' and p.publication_status = 'active'
  )
  select coalesce((
    select jsonb_build_object(
      'area_uid', a.area_uid, 'name', a.official_name, 'area_kind', a.area_kind,
      'state_code', a.state_code,
      'availability', coalesce(m.availability_status, 'unavailable'),
      'reason', coalesce(m.availability_reason, 'No public property records are available for this jurisdiction yet.'),
      'contract_version', coalesce(p.contract_version, 'national-v1')
    )
    from geo.area a
    left join active_publication p on true
    left join meta.publication_set_member m
      on m.publication_set_id = p.publication_set_id and m.area_uid = a.area_uid
    where a.state_code = upper(btrim(p_state_code))
      and (p_area_uid is null or a.area_uid = p_area_uid)
    order by case when a.area_uid = 'area_us_' || lower(btrim(p_state_code)) then 0 else 1 end, a.area_uid
    limit 1
  ), jsonb_build_object(
    'area_uid', p_area_uid, 'state_code', upper(btrim(p_state_code)),
    'availability', 'unavailable',
    'reason', 'No public property records are available for this jurisdiction yet.',
    'contract_version', 'national-v1'
  ));
$function$;
reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;
insert into meta.production_migration (migration_key, migration_sha256, target_class)
values ('national-geography-2025', pg_catalog.current_setting('quoin.migration_sha256'), pg_catalog.current_setting('quoin.migration_target_class'));
reset role;
set local role dc_property_admin;
revoke usage on schema meta from data_owner;
reset role;
commit;
`;
}

export async function generate(args = process.argv.slice(2)) {
  const stateZip = requireArg(args, "--state-zip");
  const countyZip = requireArg(args, "--county-zip");
  const stateText = requireArg(args, "--state-text");
  const countyText = requireArg(args, "--county-text");
  const output = requireArg(args, "--output");
  const allowedOutput = resolve(import.meta.dirname, "../db/production-migrations");
  if (dirname(output) !== allowedOutput || !/^0002_[a-z0-9_]+\.sql$/.test(basename(output))) {
    throw new Error("Output must be a new 0002_*.sql file under db/production-migrations.");
  }
  if (await sha256(stateZip) !== EXPECTED.states.zipSha256 || await sha256(countyZip) !== EXPECTED.counties.zipSha256) {
    throw new Error("Census Gazetteer ZIP hash mismatch.");
  }
  const [states, counties] = await Promise.all([
    parsePipe(stateText, EXPECTED.states),
    parsePipe(countyText, EXPECTED.counties),
  ]);
  const partial = `${output}.partial`;
  await writeFile(partial, buildSql(states, counties), { encoding: "utf8", flag: "wx" });
  await rename(partial, output);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await generate());
}
