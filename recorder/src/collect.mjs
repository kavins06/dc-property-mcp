import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { chromium } from "playwright";

import {
  MANIFEST_KIND,
  MANIFEST_VERSION,
  PORTAL_ORIGIN,
  parseDetailText,
  parseSearchRow,
  sha256,
  stableJson,
  validateInstrument,
  validateManifest,
} from "./contract.mjs";
import {
  authorizationReference,
  compactDate,
  dateRange,
  isoDate,
  parseArguments,
  profileDirectory,
  sleep,
} from "./runtime.mjs";

const SECURED_DOCUMENT =
  /\b(DEED|TRUST|LIEN|MORTGAGE|FINANCING|RELEASE|SATISFACTION|ASSIGNMENT|SUBORDINATION)\b/i;
const PAGE_SIZE = 50;
const options = parseArguments(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(`${today}T00:00:00Z`);
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const defaultDate = yesterday.toISOString().slice(0, 10);
const from = isoDate(options.from ?? defaultDate, "--from");
const to = isoDate(options.to ?? from, "--to");
const maximumDays = Number(options["max-days"] ?? 31);
if (!Number.isSafeInteger(maximumDays) || maximumDays < 1 || maximumDays > 366) {
  throw new Error("--max-days must be an integer between 1 and 366.");
}
const dates = dateRange(from, to, maximumDays);
const delayMs = Number(options["delay-ms"] ?? 1500);
if (!Number.isSafeInteger(delayMs) || delayMs < 750 || delayMs > 60_000) {
  throw new Error("--delay-ms must be between 750 and 60000.");
}
const detailMode = options.details ?? "secured";
if (!["none", "secured", "all"].includes(detailMode)) {
  throw new Error("--details must be none, secured, or all.");
}
const outputRoot = resolve(
  options.output ?? resolve(import.meta.dirname, "..", "..", "data", "recorder"),
);
const authorizationRef = authorizationReference();
const profile = profileDirectory();
await mkdir(profile, { recursive: true });
await mkdir(outputRoot, { recursive: true });

function shouldFetchDetail(documentType) {
  return (
    detailMode === "all" ||
    (detailMode === "secured" && SECURED_DOCUMENT.test(documentType))
  );
}

function resultsUrl(date, offset = 0) {
  const params = new URLSearchParams({
    department: "RP",
    recordedDateRange: `${compactDate(date)},${compactDate(date)}`,
    searchType: "advancedSearch",
    sort: "asc",
    sortBy: "recordedDate",
  });
  if (offset > 0) params.set("offset", String(offset));
  return `${PORTAL_ORIGIN}/results?${params}`;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function existingArtifact(path) {
  try {
    const contents = await readFile(path, "utf8");
    const records = contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => validateInstrument(JSON.parse(line)));
    return {
      rows: records.length,
      sha256: sha256(contents),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readLegals(page) {
  const table = page
    .getByRole("tabpanel", { name: "Summary" })
    .getByRole("table");
  if ((await table.count()) === 0) return [];
  const rows = table.getByRole("row");
  const legals = [];
  for (let index = 1; index < (await rows.count()); index += 1) {
    const cells = await rows.nth(index).getByRole("cell").allTextContents();
    if (cells.length >= 2) {
      legals.push({
        square: cells[0].trim(),
        low_lot: cells[1].trim(),
        high_lot: (cells[2] ?? cells[1]).trim(),
      });
    }
  }
  return legals;
}

async function hydrateDetail(page, record) {
  try {
    await page.goto(record.source_url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page
      .getByRole("tabpanel", { name: "Summary" })
      .waitFor({ state: "visible", timeout: 30_000 });
    const text = await page
      .getByRole("tabpanel", { name: "Summary" })
      .innerText();
    const parsed = parseDetailText(text, record);
    const legals = await readLegals(page);
    return validateInstrument({
      ...parsed,
      legals: legals.length > 0 ? legals : parsed.legals,
    });
  } catch (error) {
    return validateInstrument({
      ...record,
      detail_status: "failed",
      detail_error_code:
        error?.name === "TimeoutError" ? "timeout" : "unexpected_page_shape",
    });
  }
}

let throttledStatus = null;
const context = await chromium.launchPersistentContext(profile, {
  headless: options.headless !== "false",
  acceptDownloads: false,
});
context.on("response", (response) => {
  if ([403, 429].includes(response.status())) {
    throttledStatus = response.status();
  }
});
await context.route("**/files/documents/**", (route) => route.abort());

const page = context.pages()[0] ?? (await context.newPage());
const detailPage = await context.newPage();
const pageArtifacts = [];
const seenDocumentIds = new Set();

try {
  await page.goto(PORTAL_ORIGIN, { waitUntil: "domcontentloaded" });
  if ((await page.getByRole("link", { name: "Sign Out" }).count()) === 0) {
    throw new Error(
      "Recorder session is not authenticated. Run `npm run login` first.",
    );
  }

  for (const date of dates) {
    let totalRows = null;
    let pageNumber = 1;
    do {
      const path = resolve(
        outputRoot,
        date,
        `page-${String(pageNumber).padStart(4, "0")}.jsonl`,
      );
      const existing = await existingArtifact(path);
      if (existing) {
        pageArtifacts.push({
          path: relative(outputRoot, path).replaceAll("\\", "/"),
          ...existing,
        });
        pageNumber += 1;
        if (existing.rows < PAGE_SIZE) break;
        continue;
      }

      throttledStatus = null;
      await page.goto(resultsUrl(date, (pageNumber - 1) * PAGE_SIZE), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (throttledStatus) {
        throw new Error(
          `Recorder returned HTTP ${throttledStatus}; collection stopped without retrying.`,
        );
      }
      if (
        (await page.getByText(/captcha|verify you are human/i).count()) > 0
      ) {
        throw new Error(
          "Recorder requested human verification; collection stopped for attended review.",
        );
      }
      const table = page.getByRole("table", {
        name: "Search results table for Real Property",
      });
      await Promise.race([
        table.waitFor({ state: "visible", timeout: 30_000 }),
        page
          .getByText(/no (matching )?(documents|results)|0 results/i)
          .first()
          .waitFor({ state: "visible", timeout: 30_000 }),
      ]);
      const bodyText = await page.getByRole("main").innerText();
      const totalMatch = bodyText.match(/\bof\s+([\d,]+)\b/i);
      if (totalRows === null && totalMatch) {
        totalRows = Number(totalMatch[1].replaceAll(",", ""));
      }
      const rows = table.getByRole("row");
      const records = [];
      const rowCount = (await table.count()) === 0 ? 0 : await rows.count();
      for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        const cells = await row.getByRole("cell").allTextContents();
        const checkbox = row.getByRole("checkbox");
        if ((await checkbox.count()) === 0) continue;
        const label = await checkbox.getAttribute("aria-label");
        let record = parseSearchRow(cells, label);
        if (seenDocumentIds.has(record.document_id)) {
          throw new Error(
            `Recorder pagination repeated document ${record.document_id}.`,
          );
        }
        seenDocumentIds.add(record.document_id);
        if (shouldFetchDetail(record.document_type)) {
          await sleep(delayMs);
          record = await hydrateDetail(detailPage, record);
        }
        records.push(record);
      }
      if (records.length === 0 && (totalRows ?? 0) > 0) {
        throw new Error(`Recorder page ${pageNumber} for ${date} was empty.`);
      }
      const contents =
        records.map((record) => stableJson(record)).join("\n") +
        (records.length > 0 ? "\n" : "");
      await atomicWrite(path, contents);
      pageArtifacts.push({
        path: relative(outputRoot, path).replaceAll("\\", "/"),
        rows: records.length,
        sha256: sha256(contents),
      });
      process.stdout.write(
        `${date} page ${pageNumber}: ${records.length} instruments\n`,
      );
      pageNumber += 1;
      await sleep(delayMs);
      if (records.length < PAGE_SIZE) break;
    } while (
      totalRows === null ||
      (pageNumber - 1) * PAGE_SIZE < totalRows
    );
  }

  const manifest = validateManifest({
    manifest_kind: MANIFEST_KIND,
    manifest_version: MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    source_origin: PORTAL_ORIGIN,
    date_from: from,
    date_to: to,
    authorization_ref: authorizationRef,
    collection_policy: {
      detail_mode: detailMode,
      delay_ms: delayMs,
      document_images_requested: false,
      paid_orders_placed: false,
    },
    row_count: pageArtifacts.reduce((sum, artifact) => sum + artifact.rows, 0),
    pages: pageArtifacts.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
  const manifestContents = `${stableJson(manifest)}\n`;
  const manifestPath = resolve(
    outputRoot,
    `manifest-${from}-${to}.json`,
  );
  try {
    await stat(manifestPath);
    throw new Error(`Manifest already exists: ${manifestPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(manifestPath, manifestContents);
  process.stdout.write(
    `Wrote ${manifest.row_count} normalized instruments and manifest ` +
      `${manifestPath} (sha256 ${sha256(manifestContents)}).\n`,
  );
} finally {
  await context.close();
}
