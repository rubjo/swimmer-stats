import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCSV } from "./lib/csv.js";
import {
  loadExistingSwimmers,
  writeSwimmerFile,
  rebuildIndex,
} from "./lib/fs-utils.js";
import {
  exportCSV,
  getSwimmerInfo,
  selectSwimmer,
  loadNextBatch,
  navigateAndFilter,
  extractSplits,
} from "./lib/browser.js";

/* ─── Config ─────────────────────────────────────────────────────── */
const BASE_URL = "https://www.medley.no/svommer.aspx";
const DATA_DIR = "data";
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const DL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "_dl",
);

const DELAY_SWIMMER = 1_500;
const DELAY_EXPORT = 1_500;
const DELAY_BETWEEN = 200;
const JITTER = 300;

/* ─── Helpers ────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Main ───────────────────────────────────────────────────────── */
async function main() {
  if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

  /* ── Browser setup ────────────────────────────────────────────── */
  console.log("Launching browser …");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1400, height: 900 });

  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DL_DIR,
    eventsEnabled: true,
  });

  console.log("Navigating …");
  await navigateAndFilter(page, BASE_URL);

  /* ── Pre-scan: discover total swimmer count ──────────────────── */
  console.log("Discovering swimmers …");
  while (true) {
    const prev = await page.evaluate(() => cmbUtover.GetItemCount());
    const next = await loadNextBatch(page);
    if (next <= prev) break;
  }
  const totalSwimmers =
    (await page.evaluate(() => cmbUtover.GetItemCount())) - 1;
  console.log("Found " + totalSwimmers + " licensed swimmers\n");

  /* ── Load existing data ───────────────────────────────────────── */
  const existingSwimmers = loadExistingSwimmers(SWIMMERS_DIR);

  /* ── Main loop ────────────────────────────────────────────────── */
  let cbIdx = 1; // 0 = placeholder
  let loadedCount = totalSwimmers + 1; // +1 for placeholder
  let processedInSession = 0;
  let totalRaces = 0;

  while (true) {
    // Safety net: load next batch if needed (shouldn't trigger after pre-scan)
    if (cbIdx >= loadedCount) {
      const newCount = await loadNextBatch(page);
      if (newCount <= loadedCount) break;
      loadedCount = newCount;
    }

    // Read swimmer info from combo box
    const sw = await page.evaluate((idx) => {
      const item = cmbUtover.GetItem(idx);
      if (!item || !item.value || item.value === "0") return null;
      return { id: String(item.value), text: item.text.trim() };
    }, cbIdx);

    if (!sw) {
      cbIdx++;
      continue;
    }

    const selIdx = cbIdx;
    cbIdx++;
    processedInSession++;
    console.log(`  ${processedInSession}/${loadedCount - 1} — ${sw.text}`);

    // Select swimmer (triggers grid load)
    await selectSwimmer(page, selIdx);
    await sleep(DELAY_SWIMMER + Math.random() * JITTER);

    // Export and parse CSV
    const csvText = await exportCSV(page, DL_DIR, DELAY_EXPORT + JITTER);
    if (!csvText) {
      console.log(`  ⚠ No CSV — ${sw.text}`);
      await sleep(DELAY_BETWEEN);
      continue;
    }

    const races = parseCSV(csvText);
    if (races.length === 0) {
      console.log(`  ⚠ No data — ${sw.text}`);
      await sleep(DELAY_BETWEEN);
      continue;
    }

    // Skip if scraped within the last 24 hours, but still bump the timestamp
    const existing = existingSwimmers.get(sw.id);
    if (existing && existing.timestamp) {
      const age = Date.now() - new Date(existing.timestamp).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        console.log(`  ✓ ${sw.text}`);
        existing.timestamp = new Date().toISOString();
        writeSwimmerFile(existing, SWIMMERS_DIR);
        await sleep(DELAY_BETWEEN);
        continue;
      }
    }

    // Expand every row to extract detail fields and split times
    console.log(`  ${sw.text} → expanding details (${races.length} races)`);
    await extractSplits(page, races, { log: () => {} });

    // Drop unwanted CSV columns, and null-valued ranking fields
    for (const r of races) {
      delete r.Nr;
      delete r.Poeng;
      delete r.Poengtype;
      delete r.D;
      if (r.RK == null) delete r.RK;
      if (r.RA == null) delete r.RA;
    }

    // Build the swimmer entry
    const info = await getSwimmerInfo(page);
    const swimmerName = info.name || sw.text;

    // Group by discipline
    const discMap = new Map();
    for (const r of races) {
      const dist = r.Distanse || "Ukjent";
      if (!discMap.has(dist)) discMap.set(dist, []);
      discMap.get(dist).push(r);
    }
    const disciplines = [];
    for (const [distanse, dRaces] of discMap) {
      for (const r of dRaces) delete r.Distanse;
      disciplines.push({ distanse, races: dRaces });
    }

    const entry = {
      swimmerId: sw.id,
      name: swimmerName,
      club: info.club,
      birthYear: info.birthYear,
      timestamp: new Date().toISOString(),
      disciplines,
    };

    writeSwimmerFile(entry, SWIMMERS_DIR);
    totalRaces += races.length;

    const splitsCount = races.filter((r) => r.splits).length;
    console.log(
      `  ${sw.text} → ${races.length} races${splitsCount ? `, ${splitsCount} with splits` : ""}`,
    );

    // Rebuild index as checkpoint
    if (processedInSession % 25 === 0) {
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
      });
    }

    await sleep(DELAY_BETWEEN);
  }

  // Final index write
  rebuildIndex({
    swimmersDir: SWIMMERS_DIR,
    dataDir: DATA_DIR,
    indexFile: INDEX_FILE,
    baseUrl: BASE_URL,
  });

  console.log(
    `✓ Done! ${processedInSession} swimmers checked, ${totalRaces} new/updated races`,
  );
  await browser.close();
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
