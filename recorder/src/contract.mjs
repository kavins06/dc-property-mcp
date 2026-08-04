import { createHash } from "node:crypto";

export const PORTAL_ORIGIN = "https://washington.dc.publicsearch.us";
export const MANIFEST_KIND = "dc-recorder-normalized-index";
export const MANIFEST_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENT_NUMBER = /^[A-Za-z0-9-]{1,40}$/;

export function normalizeText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "N/A" || text === "--" || text === "" ? null : text;
}

export function normalizeIdentifier(value) {
  return normalizeText(value)?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
}

export function parseCurrencyCents(value) {
  const text = normalizeText(value);
  if (text === null) return null;
  const match = text.match(/^\$?([\d,]+)(?:\.(\d{2}))?$/);
  if (!match) throw new Error(`Invalid currency value: ${text}`);
  return `${match[1].replaceAll(",", "")}${match[2] ?? "00"}`.replace(
    /^0+(?=\d)/,
    "",
  );
}

export function parseSearchRow(cells, checkboxLabel) {
  if (!Array.isArray(cells) || cells.length < 9) {
    throw new Error("Recorder result row has fewer than nine data cells.");
  }
  const match = String(checkboxLabel ?? "").match(/\bDocument\s+(\d+)\b/i);
  if (!match) throw new Error("Recorder result row has no internal document ID.");
  const [
    instrumentNumber,
    bookRollFrame,
    grantor,
    grantee,
    documentType,
    recordedDate,
    square,
    lot,
    relatedInstrumentNumber,
  ] = cells.slice(-9).map(normalizeText);
  if (!instrumentNumber || !documentType || !recordedDate) {
    throw new Error("Recorder result row is missing a required indexed field.");
  }
  const [bookType, rollBook, framePage] = (bookRollFrame ?? "")
    .split("/")
    .map(normalizeText);
  const record = {
    document_id: match[1],
    instrument_number: instrumentNumber,
    document_type: documentType,
    recorded_date: recordedDate,
    recorded_at_local: null,
    recorded_timezone: "America/New_York",
    book_type: bookType ?? null,
    roll_book: rollBook ?? null,
    frame_page: framePage ?? null,
    consideration_cents: null,
    page_count: null,
    parties: [
      ...(grantor ? [{ name: grantor, role: "GRANTOR" }] : []),
      ...(grantee ? [{ name: grantee, role: "GRANTEE" }] : []),
    ],
    legals:
      square && lot
        ? [{ square, low_lot: lot, high_lot: lot }]
        : [],
    related_instruments: relatedInstrumentNumber
      ? [{ instrument_number: relatedInstrumentNumber }]
      : [],
    detail_status: "index_only",
    source_url: `${PORTAL_ORIGIN}/doc/${match[1]}`,
  };
  return validateInstrument(record);
}

function valueAfter(lines, label) {
  const index = lines.indexOf(label);
  return index >= 0 ? normalizeText(lines[index + 1]) : null;
}

export function normalizeLocalDateTime(value) {
  const text = normalizeText(value);
  if (text === null) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }
  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (!match) throw new Error(`Invalid Recorder local timestamp: ${text}`);
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === "PM") hour += 12;
  return (
    `${match[3]}-${match[1].padStart(2, "0")}-` +
    `${match[2].padStart(2, "0")}T${String(hour).padStart(2, "0")}:` +
    `${match[5]}:00`
  );
}

export function parseDetailText(text, baseRecord) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const partiesStart = lines.indexOf("Parties");
  const relatedStart = lines.indexOf("Related Instrument Number");
  const parties = [];
  if (partiesStart >= 0 && relatedStart > partiesStart) {
    for (let index = partiesStart + 1; index + 1 < relatedStart; index += 2) {
      const name = normalizeText(lines[index]);
      const role = normalizeText(lines[index + 1])?.toUpperCase();
      if (name && ["GRANTOR", "GRANTEE", "OTHER"].includes(role)) {
        parties.push({ name, role });
      }
    }
  }
  const related = [];
  if (relatedStart >= 0) {
    const candidate = normalizeText(lines[relatedStart + 1]);
    if (
      candidate &&
      !/^no related instrument/i.test(candidate) &&
      DOCUMENT_NUMBER.test(candidate)
    ) {
      related.push({ instrument_number: candidate });
    }
  }
  const recordedAt = normalizeLocalDateTime(
    valueAfter(lines, "Recorded Date:"),
  );
  const pageCountText = valueAfter(lines, "Number of Pages:");
  return validateInstrument({
    ...baseRecord,
    document_type: normalizeText(lines[0]) ?? baseRecord.document_type,
    recorded_at_local: recordedAt,
    consideration_cents: parseCurrencyCents(
      valueAfter(lines, "Consideration:"),
    ),
    page_count: pageCountText === null ? null : Number(pageCountText),
    parties: parties.length > 0 ? parties : baseRecord.parties,
    related_instruments:
      related.length > 0 ? related : baseRecord.related_instruments,
    detail_status: "complete",
  });
}

export function validateInstrument(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Recorder instrument must be an object.");
  }
  if (!/^\d{1,20}$/.test(String(record.document_id))) {
    throw new Error("Recorder instrument has an invalid document_id.");
  }
  if (!DOCUMENT_NUMBER.test(String(record.instrument_number))) {
    throw new Error("Recorder instrument has an invalid instrument_number.");
  }
  if (!normalizeText(record.document_type)) {
    throw new Error("Recorder instrument has no document_type.");
  }
  const normalizedDate = normalizeDate(record.recorded_date);
  if (!DATE.test(normalizedDate)) {
    throw new Error("Recorder instrument has an invalid recorded_date.");
  }
  if (
    record.page_count !== null &&
    (!Number.isSafeInteger(record.page_count) || record.page_count < 1)
  ) {
    throw new Error("Recorder instrument has an invalid page_count.");
  }
  if (
    record.recorded_at_local !== null &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(
      record.recorded_at_local,
    )
  ) {
    throw new Error("Recorder instrument has an invalid local timestamp.");
  }
  if (
    !["index_only", "complete", "failed"].includes(record.detail_status)
  ) {
    throw new Error("Recorder instrument has an invalid detail_status.");
  }
  if (
    record.source_url !== `${PORTAL_ORIGIN}/doc/${record.document_id}`
  ) {
    throw new Error("Recorder instrument source URL is not canonical.");
  }
  for (const party of record.parties ?? []) {
    if (
      !normalizeText(party.name) ||
      !["GRANTOR", "GRANTEE", "OTHER"].includes(
        String(party.role).toUpperCase(),
      )
    ) {
      throw new Error("Recorder instrument has an invalid party.");
    }
  }
  for (const legal of record.legals ?? []) {
    if (!normalizeText(legal.square) || !normalizeText(legal.low_lot)) {
      throw new Error("Recorder instrument has an invalid legal description.");
    }
  }
  return {
    ...record,
    recorded_date: normalizedDate,
    parties: record.parties ?? [],
    legals: record.legals ?? [],
    related_instruments: record.related_instruments ?? [],
  };
}

export function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (DATE.test(text)) return text;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return text;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateManifest(manifest) {
  if (
    manifest?.manifest_kind !== MANIFEST_KIND ||
    manifest?.manifest_version !== MANIFEST_VERSION
  ) {
    throw new Error("Unsupported Recorder manifest.");
  }
  if (
    !DATE.test(manifest.date_from) ||
    !DATE.test(manifest.date_to) ||
    manifest.date_from > manifest.date_to
  ) {
    throw new Error("Recorder manifest date range is invalid.");
  }
  if (
    typeof manifest.authorization_ref !== "string" ||
    !manifest.authorization_ref.trim() ||
    manifest.authorization_ref.length > 200
  ) {
    throw new Error("Recorder manifest authorization_ref is invalid.");
  }
  if (
    manifest.source_origin !== PORTAL_ORIGIN ||
    !manifest.collection_policy ||
    typeof manifest.collection_policy !== "object" ||
    !["none", "secured", "all"].includes(
      manifest.collection_policy.detail_mode,
    ) ||
    !Number.isSafeInteger(manifest.collection_policy.delay_ms) ||
    manifest.collection_policy.delay_ms < 750 ||
    manifest.collection_policy.document_images_requested !== false ||
    manifest.collection_policy.paid_orders_placed !== false
  ) {
    throw new Error("Recorder manifest collection policy is invalid.");
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length < 1) {
    throw new Error("Recorder manifest has no page artifacts.");
  }
  const paths = new Set();
  let rows = 0;
  for (const page of manifest.pages) {
    if (
      typeof page.path !== "string" ||
      !/^\d{4}-\d{2}-\d{2}\/page-\d{4}\.jsonl$/.test(page.path) ||
      paths.has(page.path) ||
      !Number.isSafeInteger(page.rows) ||
      page.rows < 0 ||
      !SHA256.test(page.sha256)
    ) {
      throw new Error("Recorder manifest has an invalid page artifact.");
    }
    paths.add(page.path);
    rows += page.rows;
  }
  if (manifest.row_count !== rows) {
    throw new Error("Recorder manifest row count does not match pages.");
  }
  return manifest;
}
