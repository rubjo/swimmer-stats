import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import {
  flattenRaces,
  loadExistingSwimmers,
  writeSwimmerFile,
  rebuildIndex,
} from "./lib/fs-utils.js";
import {
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

const DELAY_BETWEEN = 500;
const DEFAULT_MODE = (process.env.MODE || "auto").trim();

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
    execSync(`git pull --rebase`, { stdio: "ignore", timeout: 30_000 });
    execSync(`git push`, { stdio: "ignore", timeout: 60_000 });
  } catch {}
}

/* ─── Run one pass (collect or splits) ──────────────────────────── */
async function runPass(mode) {
  console.log(`\n=== ${mode} pass ===\n`);

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

  console.log("Navigating …");
  await navigateAndFilter(page, BASE_URL);

  /* ── Load existing data ───────────────────────────────────────── */
  const existingSwimmers = loadExistingSwimmers(SWIMMERS_DIR);

  /* ── Main loop ────────────────────────────────────────────────── */
  let cbIdx = 1; // 0 = placeholder
  let loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
  let processedInSession = 0;
  let totalRaces = 0;
  let expansionsSinceReload = 0;

  console.log(`Mode: ${mode}`);

  /** Navigate back to BASE_URL, re-apply filters, reset loadedCount. */
  async function reloadPage() {
    console.log(`    Reloading page to clear state...`);
    await navigateAndFilter(page, BASE_URL);
    loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
    expansionsSinceReload = 0;
  }

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

    // Parse the grid table directly from the DOM.
    // The array indices are the grid's visible indices, which is what
    // GVShowDetailRow expects. CSV export would include filtered-out
    // rows (D/F) and cause index mismatches.
    const races = await parseGridFromDOM(page);
    if (!races || races.length === 0) {
      console.log(`  ⚠ No data — ${sw.text}`);
      return;
    }

    // ── Collect mode: skip split extraction, save immediately ──
    if (mode !== "splits") {
      // Drop unwanted CSV columns
      for (const r of races) {
        delete r.Nr;
        delete r.Poeng;
        delete r.Poengtype;
        delete r.D;
        if (r.RK == null) delete r.RK;
        if (r.RA == null) delete r.RA;
      }

      // Build entry with no split data (splits field omitted → undefined)
      const info = await getSwimmerInfo(page);
      const swimmerName = info.name || sw.text;

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
      console.log(`  ✓ ${sw.text} (${elapsed(swStart)})`);

      if (processedInSession % 25 === 0) {
        rebuildIndex({
          swimmersDir: SWIMMERS_DIR,
          dataDir: DATA_DIR,
          indexFile: INDEX_FILE,
          baseUrl: BASE_URL,
        });
        gitCheckpoint(`${processedInSession}/${loadedCount - 1} swimmers`);
      }
      return;
    }

    // ── Splits mode: extract splits with resume logic ──
    const eligible = races.filter((r) => hasPotentialSplits(r.Distanse)).length;
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
      } else {
        console.log(
          `  ${sw.text} → extracting ${eligible} splits from ${races.length} races`,
        );
        await extractSplits(page, races, {
          log: (msg) => console.log(`    ${msg}`),
        });
      }
    } else {
      console.log(
        `  ${sw.text} → extracting ${eligible} splits from ${races.length} races`,
      );
      await extractSplits(page, races, {
        log: (msg) => console.log(`    ${msg}`),
      });
    }

    // Check if page is still alive after all the expansion work
    try {
      await page.evaluate(() => true);
    } catch {
      console.log(
        `    ⚠ Page unresponsive after split extraction, reloading...`,
      );
      await reloadPage();
    }

    // Reload page periodically to prevent state buildup (every 200 expansions)
    const expandedCount = races.filter(
      (r) => r.splits !== undefined && hasPotentialSplits(r.Distanse),
    ).length;
    expansionsSinceReload += expandedCount;
    if (expansionsSinceReload >= 200) {
      await reloadPage();
    }

    // Drop unwanted CSV columns
    for (const r of races) {
      delete r.Nr;
      delete r.Poeng;
      delete r.Poengtype;
      delete r.D;
      if (r.RK == null) delete r.RK;
      if (r.RA == null) delete r.RA;
    }

    const info = await getSwimmerInfo(page);
    const swimmerName = info.name || sw.text;

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
  gitCheckpoint(`${mode} done — ${processedInSession} swimmers`);

  console.log(
    `✓ ${mode} pass complete! ${processedInSession} swimmers checked, ${totalRaces} new/updated races`,
  );
  await browser.close();
}

/* ─── Entry point ────────────────────────────────────────────────── */
async function main() {
  if (DEFAULT_MODE === "auto") {
    await runPass("collect");
    await runPass("splits");
  } else {
    await runPass(DEFAULT_MODE);
  }
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
