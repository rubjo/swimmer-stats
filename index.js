import { execSync } from "child_process";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCSV } from "./lib/csv.js";
import {
  flattenRaces,
  loadExistingSwimmers,
  writeSwimmerFile,
  rebuildIndex,
} from "./lib/fs-utils.js";
import {
  exportCSV,
  hasPotentialSplits,
  parseGridFromDOM,
  getSwimmerInfo,
  selectSwimmer,
  loadNextBatch,
  navigateAndFilter,
  extractSplits,
  pollFor,
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

const DELAY_SWIMMER = 3_000;
const DELAY_EXPORT = 2_000;
const DELAY_BETWEEN = 500;
const JITTER = 500;

/* ─── Helpers ────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Commit and push data/ to the repo so progress survives a crash. */
function gitCheckpoint(label) {
  try {
    execSync(`git add data/`, { stdio: "ignore", timeout: 30_000 });
    const out = execSync(
      `git diff --cached --quiet || git commit -m "checkpoint: ${label} [skip ci]"`,
      { stdio: "pipe", timeout: 30_000 },
    );
    if (out.includes("nothing to commit")) return;
    execSync(`git push`, { stdio: "ignore", timeout: 60_000 });
  } catch {}
}

/* ─── Main ───────────────────────────────────────────────────────── */
async function main() {
  if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

  /* ── Browser setup ────────────────────────────────────────────── */
  console.log("Launching browser …");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
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

  /* ── Load existing data ───────────────────────────────────────── */
  const existingSwimmers = loadExistingSwimmers(SWIMMERS_DIR);

  /* ── Main loop ────────────────────────────────────────────────── */
  let cbIdx = 1; // 0 = placeholder
  let loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
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
    console.log(`  ${processedInSession} — ${sw.text}`);

    try {
      await thisSwimmer(sw, selIdx);
    } catch (err) {
      console.log(`  ⚠ Error — ${sw.text}: ${err.message?.slice(0, 100)}`);
    }
    await sleep(DELAY_BETWEEN);
  }

  function elapsed(start) {
    const secs = Math.round((Date.now() - start) / 1000);
    if (secs >= 60) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    return `${secs}s`;
  }

  /** Compare CSV races against saved data and return indices where splits are missing. */
  function findMissingSplitIndices(csvRaces, savedRaces) {
    const indices = [];
    for (let i = 0; i < csvRaces.length; i++) {
      const cr = csvRaces[i];
      if (!hasPotentialSplits(cr.Distanse)) continue;
      const saved = savedRaces.find(
        (sr) =>
          sr.Distanse === cr.Distanse &&
          sr.Dato === cr.Dato &&
          sr.Tid === cr.Tid,
      );
      // Only retry if splits was never set (undefined).
      // Empty array = confirmed no splits available, skip.
      if (!saved || saved.splits === undefined) {
        indices.push(i);
      }
    }
    return indices;
  }

  async function thisSwimmer(sw, selIdx) {
    const swStart = Date.now();

    // Select swimmer (triggers grid load)
    await selectSwimmer(page, selIdx);
    // Poll for grid rows to appear — adapts to actual response time.
    const gridReady = await pollFor(
      page,
      () => {
        try {
          if (grdRanking.InCallback()) return false;
          const table = document.getElementById("grdRanking_DXMainTable");
          if (!table) return false;
          return (
            table.querySelector(".dxgvDataRow_PlasticBlue") !== null ||
            table.querySelector(".dxgvEmptyDataRow") !== null
          );
        } catch {
          return false;
        }
      },
      { interval: 200, timeout: 10_000 },
    );
    if (!gridReady) {
      console.log(`  ⚠ Grid never loaded — ${sw.text}`);
      return;
    }

    // Export and parse CSV; fall back to parsing the grid from DOM
    let csvText = await exportCSV(page, DL_DIR, DELAY_EXPORT + JITTER);
    let races;
    let fromGrid = false;

    if (csvText) {
      races = parseCSV(csvText);
    }

    if (!races || races.length === 0) {
      const gridRaces = await parseGridFromDOM(page);
      if (gridRaces && gridRaces.length > 0) {
        races = gridRaces;
        fromGrid = true;
        console.log(`  ⚡ Grid fallback — ${sw.text}`);
      } else if (!csvText) {
        console.log(`  ⚠ No CSV — ${sw.text}`);
        return;
      } else {
        console.log(`  ⚠ No data — ${sw.text}`);
        return;
      }
    }

    // How many races are eligible for split extraction
    const eligible = races.filter((r) => hasPotentialSplits(r.Distanse)).length;

    // Resume logic: compare with saved data to decide what to do
    const existing = existingSwimmers.get(sw.id);

    if (existing && existing.timestamp) {
      const savedRaces = flattenRaces(existing);

      if (savedRaces.length === races.length) {
        const missing = findMissingSplitIndices(races, savedRaces);

        if (missing.length === 0) {
          // All races current and all splits present — skip
          console.log(`  ✓ ${sw.text} (${elapsed(swStart)})`);
          existing.timestamp = new Date().toISOString();
          writeSwimmerFile(existing, SWIMMERS_DIR);
          return;
        }

        // Races match but some splits missing — extract only those
        console.log(
          `  ${sw.text} → extracting ${missing.length} missing splits from ${races.length} races`,
        );
        await extractSplits(page, races, {
          log: (msg) => console.log(`    ${msg}`),
          onlyRows: new Set(missing),
        });
        // Fall through to entry-building below (skip full extraction)
      } else {
        // Race count differs — full processing
        console.log(
          `  ${sw.text} → extracting ${eligible} splits from ${races.length} races`,
        );
        await extractSplits(page, races, {
          log: (msg) => console.log(`    ${msg}`),
        });
      }
    } else {
      // No existing data — full processing
      console.log(
        `  ${sw.text} → extracting ${eligible} splits from ${races.length} races`,
      );
      await extractSplits(page, races, {
        log: (msg) => console.log(`    ${msg}`),
      });
    }

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

    const splitsExtracted = races.filter((r) => r.splits?.length > 0).length;
    console.log(
      `  ${sw.text} → extracted ${splitsExtracted} splits (${elapsed(swStart)})`,
    );

    // Checkpoint: rebuild index and push data to repo every 25 swimmers
    if (processedInSession % 25 === 0) {
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
      });
      gitCheckpoint(`${processedInSession}/${loadedCount - 1} swimmers`);
    }
  }

  // Final index write and git push
  rebuildIndex({
    swimmersDir: SWIMMERS_DIR,
    dataDir: DATA_DIR,
    indexFile: INDEX_FILE,
    baseUrl: BASE_URL,
  });
  gitCheckpoint(`done — ${processedInSession} swimmers`);

  console.log(
    `✓ Done! ${processedInSession} swimmers checked, ${totalRaces} new/updated races`,
  );
  await browser.close();
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
