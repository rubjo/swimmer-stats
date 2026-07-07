import fs from "fs";
import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import { loadIndex, rebuildIndex, walkJsonFiles } from "./lib/fs-utils.js";
import {
  navigateAndFilter,
  loadUntilIdx,
  findSwimmerIdx,
  loadAllComboItems,
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

// Batch size: process at most this many swimmers per run, sorted by
// least-recently-checked first. This keeps each run well within the
// 6-hour GitHub Actions timeout while cycling through all swimmers
// over several runs.
const MAX_SWIMMERS_PER_RUN = parseInt(
  process.env.MAX_SWIMMERS_PER_RUN || "500",
  10,
);

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
  function toDDMMYYYY(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }
  const tilDatoDisplay = TIL_DATO || new Date().toISOString().slice(0, 10);
  console.log(`\n=== Incremental scrape — checking for new races ===`);
  console.log(
    `  Date range: ${toDDMMYYYY(FRA_DATO)} → ${toDDMMYYYY(tilDatoDisplay)}${TIL_DATO ? "" : " (today)"}`,
  );

  // Load ALL existing swimmer data from disk into a map keyed by swimmer ID.
  // This gives us the existing races for dedup (by PID) and merge.
  console.log("Loading existing swimmer data for dedup…");
  const existingDataMap = new Map();
  for (const fp of walkJsonFiles(SWIMMERS_DIR)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const id = String(data.swimmerId);
      const existing = existingDataMap.get(id);
      if (existing) {
        // Duplicate swimmer ID across files — keep the one with the
        // most races (indicates more complete data).
        const existingCount =
          existing.disciplines?.reduce(
            (s, d) => s + (d.races?.length || 0),
            0,
          ) || 0;
        const newCount =
          data.disciplines?.reduce((s, d) => s + (d.races?.length || 0), 0) ||
          0;
        if (newCount > existingCount) {
          console.warn(
            color(
              C.yellow,
              `  ⚠ Duplicate swimmer ID ${id}: using ${fp} (${newCount} races, newer)`,
            ),
          );
          existingDataMap.set(id, data);
        } else {
          console.warn(
            color(
              C.dim,
              `  ⚠ Duplicate swimmer ID ${id}: skipping ${fp} (${newCount} races ≤ existing ${existingCount})`,
            ),
          );
        }
      } else {
        existingDataMap.set(id, data);
      }
    } catch {
      /* skip corrupted */
    }
  }
  console.log(
    color(
      C.dim,
      `  ${existingDataMap.size} swimmers with existing data on disk`,
    ),
  );

  // Track ALL swimmers successfully checked in this run (for lastChecked)
  const processedIds = new Set();

  // Load the existing index to get lastChecked timestamps for batch rotation.
  console.log("Loading index for batch rotation…");
  const { swimmersMap } = loadIndex(INDEX_FILE);
  const lastCheckedMap = new Map();
  if (swimmersMap) {
    for (const [id, entry] of swimmersMap) {
      if (entry.lastChecked) lastCheckedMap.set(id, entry.lastChecked);
    }
  }
  console.log(
    color(
      C.dim,
      `  ${lastCheckedMap.size} swimmers have lastChecked timestamps`,
    ),
  );

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

  // Sort swimmers:
  // 1. Brand-new swimmers (no data file on disk) first — they need a full
  //    save and shouldn't wait behind existing swimmers.
  // 2. Existing swimmers by lastChecked ascending (most overdue first),
  //    so we cycle fairly through all swimmers over multiple runs.
  const sortedSwimmers = [...allSwimmers].sort((a, b) => {
    const aNew = existingDataMap.has(a.id) ? 1 : 0;
    const bNew = existingDataMap.has(b.id) ? 1 : 0;
    if (aNew !== bNew) return aNew - bNew; // no-data (brand-new) comes first
    const aChecked = lastCheckedMap.get(a.id) || "";
    const bChecked = lastCheckedMap.get(b.id) || "";
    return aChecked.localeCompare(bChecked);
  });
  // Take only the first batch to keep runtime within timeout limits.
  const batch = sortedSwimmers.slice(0, MAX_SWIMMERS_PER_RUN);
  const skipped = allSwimmers.length - batch.length;

  console.log(
    color(
      C.dim,
      `  Processing batch of ${batch.length} swimmers (${skipped} deferred to next run)`,
    ),
  );

  let saved = 0;
  let processed = 0;
  const total = batch.length;

  // Fatal timeout counter: when this reaches MAX_FATAL_TIMEOUTS we checkpoint & exit.
  let fatalTimeouts = 0;
  const MAX_FATAL_TIMEOUTS = 3;

  // Track page reloads — after a reload the combo data store is reset and
  // the discovery-to-processing index mapping may be invalid.
  let pageReloaded = false;

  for (const sw of batch) {
    processed++;

    // Retry loop (3 attempts with page reload on timeout/mismatch)
    let attempts = 0;
    let swimmerOk = false;
    let currentIndex = sw.index;

    // When true (page was reloaded, stale index is unreliable), the retry
    // loop will skip loadUntilIdx and attempt findSwimmerIdx directly.
    let useNameLookup = false;

    // If the previous swimmer's processing triggered a page reload, the
    // combo has been re-initialized and discovery indices may no longer
    // match. Use name-based lookup to re-establish the correct index.
    if (pageReloaded) {
      pageReloaded = false;
      useNameLookup = true;
      console.log(
        color(
          C.dim,
          `  ${sw.text} — discovering index (name lookup after reload)`,
        ),
      );
    }

    while (attempts < 3 && !swimmerOk) {
      attempts++;
      try {
        let found = false;

        if (useNameLookup) {
          // Name-based lookup: the combo was reloaded and stale indices
          // may select the wrong swimmer, so skip loadUntilIdx entirely.
          useNameLookup = false;
          const nameIdx = await withTimeout(
            findSwimmerIdx(page, sw.text),
            1_800_000,
            `findSwimmerIdx(${sw.text})`,
          );
          if (nameIdx !== null) {
            currentIndex = nameIdx;
            console.log(
              color(C.yellow, `  ${sw.text} — found by name, proceeding...`),
            );
            found = true;
          } else {
            // Name lookup failed. Reload, fully load combo, and retry.
            page = await reloadPage(page, browser, BASE_URL);
            await loadAllComboItems(page);
            useNameLookup = true;
            if (attempts < 3) {
              console.log(
                color(
                  C.yellow,
                  `  ${sw.text} not found in combo (attempt ${attempts}/3), reloading...`,
                ),
              );
            } else {
              console.log(
                color(
                  C.red,
                  `  ${sw.text} not found in combo (after 3 attempts)`,
                ),
              );
              swimmerOk = true;
            }
            continue;
          }
        } else {
          // Normal index-based lookup
          found = await withTimeout(
            loadUntilIdx(page, currentIndex).catch(() => false),
            1_800_000,
            `loadUntilIdx(${currentIndex})`,
          );

          if (!found) {
            // Index-based lookup failed. Reload, load all combo items,
            // then try name-based lookup.
            page = await reloadPage(page, browser, BASE_URL);
            pageReloaded = true;
            await loadAllComboItems(page);
            useNameLookup = true;
            continue;
          }
        }

        // Process the swimmer — grid parse, dedup, split extraction, merge, save
        const existingEntry = existingDataMap.get(sw.id) || null;
        const result = await withTimeout(
          processSwimmer(
            page,
            sw,
            currentIndex,
            {
              SWIMMERS_DIR,
              processedInSession: processed,
            },
            existingEntry,
          ),
          14_400_000,
          sw.text,
        );

        if (result.saved) {
          saved++;
          // successful progress resets the fatal-timeout counter
          fatalTimeouts = 0;
          swimmerOk = true;
        } else if (result.identityMismatch && attempts < 3) {
          // Wrong swimmer selected — reload page, look up by name, and retry
          console.log(
            color(
              C.yellow,
              `  ⚠ ${sw.text}: Identity mismatch — reloading and re-finding by name...`,
            ),
          );
          try {
            page = await reloadPage(page, browser, BASE_URL);
            pageReloaded = true;
            await loadAllComboItems(page);
            // On the next retry, use name-based lookup (skip stale index)
            useNameLookup = true;
            // Also try immediately — if successful, the next retry uses the
            // fresh index instead of wasting an attempt on stale loadUntilIdx.
            const nameIdx = await withTimeout(
              findSwimmerIdx(page, sw.text),
              1_800_000,
              `findSwimmerIdx(${sw.text}) after mismatch`,
            );
            if (nameIdx !== null) {
              currentIndex = nameIdx;
              console.log(
                color(
                  C.yellow,
                  `    Found by name, retrying (attempt ${attempts + 1}/3)...`,
                ),
              );
            }
          } catch (e) {
            console.log(color(C.red, `    Name lookup failed: ${e.message}`));
          }
          // Don't set swimmerOk — retry loop will attempt again
        } else if (result.identityMismatch) {
          // Out of retries — give up on this swimmer
          console.log(
            color(
              C.red,
              `  ✗ ${sw.text}: Identity mismatch after ${attempts} attempts, skipping`,
            ),
          );
          swimmerOk = true;
        } else {
          // No new races or grid never loaded — skip without retry.
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
                processedIds,
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
            pageReloaded = true;
            await loadAllComboItems(page);
            useNameLookup = true;
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
    // Record that this swimmer was successfully checked (even if no new races)
    // so lastChecked is persisted in the index during the next rebuild.
    if (swimmerOk) processedIds.add(sw.id);

    // Checkpoint every 10 saves: rebuild index + git commit + push
    if (saved > 0 && saved % 10 === 0) {
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
        processedIds,
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
    processedIds,
  });

  console.log("    Pushing to GitHub…");
  gitCheckpoint(`final — ${saved} swimmers`);

  const withChecked = processedIds.size;
  console.log(
    color(
      C.green,
      `\n  ✓ Incremental scrape complete! ${withChecked} swimmers checked, ${saved} with new races (${skipped} deferred)`,
    ),
  );

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
