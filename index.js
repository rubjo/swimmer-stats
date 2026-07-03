import fs from "fs";
import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import { rebuildIndex, walkJsonFiles } from "./lib/fs-utils.js";
import {
  navigateAndFilter,
  loadUntilIdx,
  findSwimmerIdx,
} from "./lib/browser.js";
import { processSwimmer } from "./lib/swimmer.js";

/* ─── Config ─────────────────────────────────────────────────────── */
const BASE_URL = "https://www.medley.no/svommer.aspx";
const DATA_DIR = "data";
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

// Date range for incremental scraping.
// Default to 2026-06-19 (the day after the initial full scrape ended).
// Override via env var to narrow the window for subsequent runs.
const FRA_DATO = process.env.FRA_DATO || "2026-06-19";
const TIL_DATO = process.env.TIL_DATO || "";

/* ─── Helpers ────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Race a promise against a timeout. If the timeout fires first, the
 * promise is abandoned (caller should reload the page to clean up CDP).
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`⏱ ${label} timed out after ${ms}ms`);
    }),
  ]);
}

/** Commit and push data/ to the repo so progress survives a crash. */
function gitCheckpoint(label) {
  try {
    execSync(`git add data/`, { stdio: "ignore", timeout: 30_000 });
    const out = execSync(
      `git diff --cached --quiet || git commit -m "checkpoint: ${label} [skip ci]"`,
      { stdio: "pipe", timeout: 30_000 },
    );
    if (out.includes("nothing to commit")) return;
    try {
      execSync(`git push origin HEAD:main`, {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      execSync(`git pull --rebase origin main`, {
        stdio: "ignore",
        timeout: 30_000,
      });
      execSync(`git push origin HEAD:main`, {
        stdio: "ignore",
        timeout: 60_000,
      });
    }
  } catch {}
}

/* ─── ANSI color helpers ─────────────────────────────────────────── */
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};
const color = (code, s) => `${code}${s}${C.reset}`;

/* ─── Swimmer discovery ───────────────────────────────────────────── */

/**
 * Discover all swimmers in the combo box by loading ALL items into the
 * DevExpress client data store, then reading them via GetItem().
 *
 * Returns an array of { id, text, index } for every swimmer.
 */
async function discoverAllSwimmers(browser, baseUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1400, height: 900 });
  await navigateAndFilter(page, baseUrl, {
    fraDato: FRA_DATO,
    tilDato: TIL_DATO,
  });

  page.setDefaultTimeout(300_000);

  const rawData = await page.evaluate(async () => {
    const startMs = Date.now();
    const MAX_DISCOVERY_MS = 250_000;

    try {
      cmbUtover.HideDropDown();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    try {
      cmbUtover.ShowDropDown();
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
    } catch {}
    await new Promise((r) => setTimeout(r, 600));

    const d = cmbUtover.GetListBoxScrollDivElement();
    if (!d) return { error: "no scroll div" };

    async function waitForGrowth(prevCount) {
      for (let p = 0; p < 20; p++) {
        await new Promise((r) => setTimeout(r, 500));
        if (Date.now() - startMs > MAX_DISCOVERY_MS) return false;
        if (cmbUtover.GetItemCount() > prevCount) return true;
      }
      return false;
    }

    // Phase A: Load suffix (cursor → end)
    for (let i = 0; i < 80; i++) {
      if (Date.now() - startMs > MAX_DISCOVERY_MS) break;
      const prevCount = cmbUtover.GetItemCount();
      const prevScroll = d.scrollTop;
      d.scrollTop = d.scrollHeight;
      if (d.scrollTop <= prevScroll) {
        if (!(await waitForGrowth(prevCount))) break;
        continue;
      }
      if (!(await waitForGrowth(prevCount))) break;
    }

    // Phase B: Reload prefix by closing & reopening
    if (Date.now() - startMs < MAX_DISCOVERY_MS) {
      try {
        cmbUtover.HideDropDown();
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      try {
        cmbUtover.ShowDropDown();
        if (d) d.scrollTop = 0;
      } catch {}
      await new Promise((r) => setTimeout(r, 1_000));

      d.scrollTop = d.scrollHeight;
      await new Promise((r) => setTimeout(r, 1_500));

      try {
        cmbUtover.HideDropDown();
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      try {
        cmbUtover.ShowDropDown();
        if (d) d.scrollTop = 0;
      } catch {}
      await new Promise((r) => setTimeout(r, 1_000));
    }

    // Phase C: Read all items
    const all = [];
    for (let i = 0; ; i++) {
      try {
        const item = cmbUtover.GetItem(i);
        if (!item) {
          if (all.length === 0) continue;
          break;
        }
        if (String(item.value) === "0") continue;
        all.push({
          id: String(item.value),
          text: item.text.trim(),
          index: i,
        });
      } catch {
        break;
      }
    }
    return { swimmers: all };
  });

  if (rawData.error) {
    console.log(color(C.red, `  Discovery error: ${rawData.error}`));
    await page.close();
    return [];
  }

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await page.close();

  const swimmers = rawData.swimmers;
  console.log(color(C.dim, `  Found ${swimmers.length} swimmers`));
  return swimmers;
}

/**
 * Reload the page (navigate back to BASE_URL, re-apply filters).
 * If the page is stuck, creates a fresh one.
 */
async function reloadPage(page, browser, baseUrl) {
  try {
    await navigateAndFilter(page, baseUrl, {
      fraDato: FRA_DATO,
      tilDato: TIL_DATO,
    });
    return page;
  } catch {
    try {
      await page.close();
    } catch {}
    const newPage = await browser.newPage();
    await newPage.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await newPage.setViewport({ width: 1400, height: 900 });
    await navigateAndFilter(newPage, baseUrl, {
      fraDato: FRA_DATO,
      tilDato: TIL_DATO,
    });
    return newPage;
  }
}

/* ─── Main sequential scrape loop ──────────────────────────────────── */

async function main() {
  console.log("\n=== Incremental scrape — checking for new races ===\n");

  // Load ALL existing swimmer data from disk into a map keyed by swimmer ID.
  // This gives us the existing races for dedup (by PID) and merge.
  console.log("Loading existing swimmer data for dedup…");
  const existingDataMap = new Map();
  for (const fp of walkJsonFiles(SWIMMERS_DIR)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      existingDataMap.set(String(data.swimmerId), data);
    } catch {
      /* skip corrupted */
    }
  }
  console.log(
    color(C.dim, `  ${existingDataMap.size} swimmers with existing data on disk`),
  );

  // Track swimmers saved in THIS run (used for checkpoint rebuildIndex)
  const indexedSwimmers = new Set();

  console.log("Launching browser …");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 300_000,
  });

  // ── Discover all swimmers ───────────────────────────────────────
  console.log("Discovering swimmers (scanning combo box)...");
  const allSwimmers = await discoverAllSwimmers(browser, BASE_URL);
  console.log(color(C.green, `  Found ${allSwimmers.length} swimmers`));

  // ── Create main processing page ──────────────────────────────────
  let page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1400, height: 900 });
  await navigateAndFilter(page, BASE_URL, {
    fraDato: FRA_DATO,
    tilDato: TIL_DATO,
  });

  // Process ALL swimmers sequentially. For each one, load their existing
  // data from disk (if any) for dedup. Swimmers with no new races are
  // skipped by processSwimmer without writing.
  console.log(
    color(C.dim, `  Processing all ${allSwimmers.length} swimmers`),
  );

  let saved = 0;
  let processed = 0;
  const total = allSwimmers.length;

  // Fatal timeout counter: when this reaches MAX_FATAL_TIMEOUTS we checkpoint & exit.
  let fatalTimeouts = 0;
  const MAX_FATAL_TIMEOUTS = 3;

  for (const sw of allSwimmers) {
    processed++;

    // Retry loop (3 attempts with page reload on timeout)
    let attempts = 0;
    let swimmerOk = false;
    while (attempts < 3 && !swimmerOk) {
      attempts++;
      try {
        // Position the combo box to this swimmer's index.
        // ~4650 items, ~2.5s per viewport scroll, needs up to 600 scrolls
        // for late-alphabet swimmers. 30 min timeout gives headroom even
        // when the server is slow.
        let found = await withTimeout(
          loadUntilIdx(page, sw.index).catch(() => false),
          1_800_000,
          `loadUntilIdx(${sw.index})`,
        );
        if (!found) {
          // Index-based lookup failed. Reload page (may have stuck CDP),
          // then try name-based lookup.
          page = await reloadPage(page, browser, BASE_URL);

          const nameIdx = await withTimeout(
            findSwimmerIdx(page, sw.text),
            1_800_000,
            `findSwimmerIdx(${sw.text})`,
          );
          if (nameIdx !== null) {
            sw.index = nameIdx; // update index for future use
            console.log(
              color(
                C.yellow,
                `  ${sw.text} — found by name after reload, proceeding...`,
              ),
            );
            // Found by name — proceed directly to processSwimmer
            // (don't retry loadUntilIdx, which would just reload the page)
            found = true;
          } else if (attempts < 3) {
            console.log(
              color(
                C.yellow,
                `  ${sw.text} not found in combo (attempt ${attempts}/3), reloading...`,
              ),
            );
            continue;
          } else {
            console.log(
              color(
                C.red,
                `  ${sw.text} not found in combo (after 3 attempts)`,
              ),
            );
            swimmerOk = true;
            break;
          }
        }

        // Process the swimmer — grid parse, dedup, split extraction, merge, save
        const existingEntry = existingDataMap.get(sw.id) || null;
        const result = await withTimeout(
          processSwimmer(page, sw, sw.index, {
            SWIMMERS_DIR,
            processedInSession: processed,
          }, existingEntry),
          14_400_000,
          sw.text,
        );

        if (result.saved) {
          saved++;
          indexedSwimmers.add(sw.id);
          // successful progress resets the fatal-timeout counter
          fatalTimeouts = 0;
          swimmerOk = true;
        } else {
          // Grid never loaded — skip without retry.
          swimmerOk = true;
          break;
        }
      } catch (err) {
        const msg = err.message || String(err);
        const isTimeout =
          msg.includes("timed out") ||
          msg.includes("Runtime.callFunctionOn timed out") ||
          msg.includes("Protocol error");
        if (isTimeout) {
          console.log(
            color(
              C.red,
              `  ⚠ ${sw.text}: ${msg.slice(0, 80)} → reloading page...`,
            ),
          );
          // increment fatal timeout counter for each timeout-ish error state
          fatalTimeouts++;
          console.log(
            color(
              C.dim,
              `    fatal timeouts: ${fatalTimeouts}/${MAX_FATAL_TIMEOUTS}`,
            ),
          );
          // If we've hit the threshold, persist progress and exit so a scheduled run can resume.
          if (fatalTimeouts >= MAX_FATAL_TIMEOUTS) {
            console.log(
              color(
                C.red,
                `  ✗ Reached ${MAX_FATAL_TIMEOUTS} fatal timeouts — checkpointing and exiting`,
              ),
            );
            try {
              // Rebuild index and push what's been saved so far.
              rebuildIndex({
                swimmersDir: SWIMMERS_DIR,
                dataDir: DATA_DIR,
                indexFile: INDEX_FILE,
                baseUrl: BASE_URL,
                fraDato: FRA_DATO,
                tilDato: TIL_DATO,
                indexedSwimmers,
              });
            } catch (e) {}
            try {
              gitCheckpoint(`partial — fatal timeouts (${fatalTimeouts})`);
            } catch (e) {}
            // Exit cleanly so next scheduled run can pick up.
            process.exit(0);
          }

          try {
            page = await reloadPage(page, browser, BASE_URL);
            if (attempts < 3)
              console.log(color(C.dim, `    retry ${attempts}/3...`));
          } catch {
            console.log(
              color(C.red, `  ⚠ ${sw.text}: reload failed, skipping`),
            );
            break;
          }
        } else {
          console.log(color(C.red, `  ⚠ ${sw.text}: ${msg.slice(0, 100)}`));
          swimmerOk = true;
        }
      }
    }

    // Checkpoint every 10 saves: rebuild index + git commit + push
    if (saved > 0 && saved % 10 === 0) {
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
        fraDato: FRA_DATO,
        tilDato: TIL_DATO,
        indexedSwimmers,
      });
      gitCheckpoint(`${saved} swimmers`);
      console.log(color(C.dim, `  Checkpoint: ${saved} swimmers saved`));
    }

    // Log progress every 50 swimmers
    if (processed % 50 === 0) {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(color(C.dim, `  Progress: ${processed}/${total} (${pct}%)`));
    }
  }

  // ── Finalize ────────────────────────────────────────────────────
  try {
    await page.close();
  } catch {}

  console.log("\n    Rebuilding index…");
  rebuildIndex({
    swimmersDir: SWIMMERS_DIR,
    dataDir: DATA_DIR,
    indexFile: INDEX_FILE,
    baseUrl: BASE_URL,
    fraDato: FRA_DATO,
    tilDato: TIL_DATO,
    indexedSwimmers,
  });

  console.log("    Pushing to GitHub…");
  gitCheckpoint(`final — ${saved} swimmers`);

  const withNewRaces = indexedSwimmers.size;
  console.log(
    color(
      C.green,
      `\n  ✓ Incremental scrape complete! ${total} swimmers checked, ${withNewRaces} with new races`,
    ),
  );

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
