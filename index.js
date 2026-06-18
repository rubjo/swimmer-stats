import fs from "fs";
import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import { loadIndex, rebuildIndex } from "./lib/fs-utils.js";
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

// Date range for scraping.
const FRA_DATO = process.env.FRA_DATO || "2000-01-01";
const TIL_DATO = process.env.TIL_DATO || "";

/* ─── Helpers ────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Format elapsed time since `start` (Date.now()) as "Xm Ys" or "Xs". */
function elapsed(start) {
  const secs = Math.round((Date.now() - start) / 1000);
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${secs}s`;
}

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

/* ─── Parallel processing ──────────────────────────────────────────── */

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
 * Reload a worker page (navigate back to BASE_URL, re-apply filters).
 * If the page is stuck, creates a fresh one.
 */
async function reloadWorkerPage(page, browser, baseUrl) {
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

/**
 * Run a single worker that processes a chunk of swimmers on its own page.
 * Each worker has its own retry logic and page lifecycle.
 * Returns { saved, workerId }.
 */
async function runWorker(browser, swimmers, workerId, sharedCtx) {
  if (swimmers.length === 0) return { saved: 0, workerId };

  let myPage;
  try {
    myPage = await browser.newPage();
    await myPage.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await myPage.setViewport({ width: 1400, height: 900 });
    await navigateAndFilter(myPage, sharedCtx.BASE_URL, {
      fraDato: FRA_DATO,
      tilDato: TIL_DATO,
    });
  } catch (err) {
    console.log(
      color(C.red, `[W${workerId}] Failed to create page: ${err.message}`),
    );
    return { saved: 0, workerId };
  }

  async function workerReload() {
    myPage = await reloadWorkerPage(myPage, browser, sharedCtx.BASE_URL);
  }

  let saved = 0;
  let localProcessed = 0;

  for (const sw of swimmers) {
    localProcessed++;

    // Index-based resume — skip if already fully indexed with all splits
    if (sharedCtx.alreadyIndexed.has(sw.id)) {
      console.log(
        `  ${color(C.yellow, "→")} ${localProcessed} — ${sw.text} (already indexed)`,
      );
      continue;
    }

    // Retry loop (3 attempts with page reload on timeout)
    let attempts = 0;
    let swimmerOk = false;
    while (attempts < 3 && !swimmerOk) {
      attempts++;
      try {
        // Position the combo box to this swimmer's index.
        // Timeout 120s — incremental scrolling through ~4500 items at
        // ~2.5 s per viewport needs ~75 s for mid-list swimmers.
        let found = await withTimeout(
          loadUntilIdx(myPage, sw.index).catch(() => false),
          120_000,
          `loadUntilIdx(${sw.index})`,
        );
        if (!found) {
          // Index-based lookup failed. Reload page (may have stuck CDP),
          // then try name-based lookup.
          await workerReload();

          const nameIdx = await findSwimmerIdx(myPage, sw.text);
          if (nameIdx !== null) {
            sw.index = nameIdx; // update index for future use
            if (attempts < 3) {
              continue; // retry loadUntilIdx with updated index
            }
            found = true; // last attempt — proceed with updated index
          } else if (attempts < 3) {
            console.log(
              color(
                C.yellow,
                `[W${workerId}] Swimmer ${sw.text} not found in combo (attempt ${attempts}/3), reloading...`,
              ),
            );
            continue;
          } else {
            console.log(
              color(
                C.red,
                `[W${workerId}] Swimmer ${sw.text} not found in combo (after 3 attempts)`,
              ),
            );
            swimmerOk = true;
            break;
          }
        }

        // Process the swimmer — grid parse, split extraction, save
        const result = await withTimeout(
          processSwimmer(myPage, sw, sw.index, {
            SWIMMERS_DIR: sharedCtx.SWIMMERS_DIR,
            processedInSession: localProcessed,
          }),
          7_200_000,
          sw.text,
        );

        if (result.saved) {
          saved++;
          sharedCtx.indexedSwimmers.add(sw.id);
          swimmerOk = true;
        } else if (result.needsReposition && attempts < 3) {
          // Grid never loaded — likely transient server overload.
          // Reload and retry rather than immediately skip.
          console.log(
            color(
              C.yellow,
              `  ⚠ ${sw.text}: grid never loaded, retrying (${attempts}/3)...`,
            ),
          );
          await workerReload();
          continue;
        } else {
          // Grid never loaded (exhausted retries) or no data — skip
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
              `[W${workerId}] ⚠ ${sw.text}: ${msg.slice(0, 80)} → reloading page...`,
            ),
          );
          try {
            await workerReload();
            if (attempts < 3)
              console.log(color(C.dim, `    retry ${attempts}/3...`));
          } catch {
            console.log(
              color(
                C.red,
                `[W${workerId}] ⚠ ${sw.text}: reload failed, skipping`,
              ),
            );
            break;
          }
        } else {
          console.log(
            color(C.red, `[W${workerId}] ⚠ ${sw.text}: ${msg.slice(0, 100)}`),
          );
          swimmerOk = true;
        }
      }
    }

    // Checkpoint every 10 saves: rebuild index + git commit + push
    if (saved > 0 && saved % 10 === 0) {
      rebuildIndex({
        swimmersDir: sharedCtx.SWIMMERS_DIR,
        dataDir: sharedCtx.DATA_DIR,
        indexFile: sharedCtx.INDEX_FILE,
        baseUrl: sharedCtx.BASE_URL,
        fraDato: sharedCtx.FRA_DATO,
        tilDato: sharedCtx.TIL_DATO,
        indexedSwimmers: sharedCtx.indexedSwimmers,
      });
      gitCheckpoint(`W${workerId} ${saved} swimmers`);
    }

    // Periodic page reload every 50 swimmers to prevent stale DevExpress
    // combo state from accumulating.
    if (localProcessed > 0 && localProcessed % 50 === 0) {
      console.log(
        color(
          C.dim,
          `[W${workerId}] Periodic page reload after ${localProcessed} swimmers...`,
        ),
      );
      await workerReload();
    }
  }

  try {
    await myPage.close();
  } catch {}
  return { saved, workerId };
}

/**
 * Run a parallel pass across 10 browser pages, each processing a separate
 * chunk of swimmers concurrently.
 *
 * Phase 1 — Discover all swimmer indices from the combo box (serial).
 * Phase 2 — Split into 10 round-robin chunks for even load distribution.
 * Phase 3 — Spawn 10 worker pages, each processing its chunk in parallel.
 * Phase 4 — Rebuild index, push to git.
 */
async function runPassParallel() {
  console.log("\n=== Full scrape (parallel, 10 workers) ===\n");

  // Load existing index for resume
  console.log("Loading index for resume…");
  const { swimmersMap } = loadIndex(INDEX_FILE);
  const alreadyIndexed = new Set();
  if (swimmersMap) {
    for (const [id, entry] of swimmersMap) {
      if (entry.splitsComplete) alreadyIndexed.add(id);
    }
  }
  console.log(
    color(C.dim, `  ${alreadyIndexed.size} swimmers already fully indexed`),
  );

  // Shared Set to track swimmers saved in THIS run (used for checkpoint rebuildIndex)
  const indexedSwimmers = new Set();

  console.log("Launching browser …");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 300_000,
  });

  // ── Phase 1: Discover all swimmers ──────────────────────────────
  console.log("Discovering swimmers (scanning combo box)...");
  const allSwimmers = await discoverAllSwimmers(browser, BASE_URL);
  console.log(color(C.green, `  Found ${allSwimmers.length} swimmers`));

  // ── Phase 2: Split into round-robin chunks ─────────────────────
  const NUM_WORKERS = 10;
  const chunks = Array.from({ length: NUM_WORKERS }, () => []);
  for (let i = 0; i < allSwimmers.length; i++) {
    chunks[i % NUM_WORKERS].push(allSwimmers[i]);
  }
  console.log(`  Chunks: ${chunks.map((c) => c.length).join(", ")}`);

  const sharedCtx = {
    BASE_URL,
    FRA_DATO,
    TIL_DATO,
    SWIMMERS_DIR,
    DATA_DIR,
    INDEX_FILE,
    alreadyIndexed,
    indexedSwimmers,
  };

  // ── Phase 3: Run workers in parallel ────────────────────────────
  const workerPromises = chunks.map((chunk, i) =>
    runWorker(browser, chunk, i, sharedCtx),
  );
  const results = await Promise.all(workerPromises);
  const totalSaved = results.reduce((sum, r) => sum + r.saved, 0);
  console.log(
    color(
      C.green,
      `\n  ✓ ${totalSaved} swimmers saved across ${NUM_WORKERS} workers`,
    ),
  );

  // ── Phase 4: Finalize ───────────────────────────────────────────
  console.log("    Rebuilding index…");
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
  gitCheckpoint(`parallel — ${totalSaved} swimmers`);

  console.log(
    color(
      C.green,
      `\n  ✓ Full scrape complete! ${allSwimmers.length} total swimmers, ${totalSaved} saved/updated`,
    ),
  );

  process.exit(0);
}

/* ─── Entry point ────────────────────────────────────────────────── */

async function main() {
  await runPassParallel();
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
