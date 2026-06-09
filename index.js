import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import {
  flattenRaces,
  loadExistingSwimmers,
  writeSwimmerFile,
  rebuildIndex,
  loadSkipUntil,
  saveSkipUntil,
} from "./lib/fs-utils.js";
import {
  hasPotentialSplits,
  parseGridFromDOM,
  getSwimmerInfo,
  fetchGender,
  selectSwimmer,
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
const SKIP_UNTIL_FILE = path.join(DATA_DIR, "skip-until.json");
const DEFAULT_MODE = (process.env.MODE || "auto").trim();

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

/** Format a timestamp as "Xd Yh ago", "Xh ago", "Xm ago", or "just now". */
function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return "just now";
  const totalMinutes = Math.floor(diff / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0)
    return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
  return `${hours}h ago`;
}

/** Return a human-readable stats string from an existing swimmer data object. */
function formatSwimmerStats(data) {
  if (!data) return "no data yet";
  const allRaces = flattenRaces(data);
  const total = allRaces.length;
  const withSplits = allRaces.filter(
    (r) => r.splits !== undefined && r.splits.length > 0,
  ).length;
  return `${total} races, ${withSplits} with split times`;
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
  const skipUntil = loadSkipUntil(SKIP_UNTIL_FILE);

  /* ── Main loop ────────────────────────────────────────────────── */
  let cbIdx = 1; // 0 = placeholder
  let loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
  let processedInSession = 0;
  let totalRaces = 0;

  /** Remember the name of the last swimmer that was saved successfully. */
  let lastSwimmerName = null;

  /**
   * Set by thisSwimmer when an internal failure (e.g. grid never loaded)
   * may have left the page in an inconsistent state.  The main loop will
   * reload the page and reposition cbIdx via findSwimmerIdx.
   */
  let needsReposition = false;

  console.log(`Mode: ${mode}`);

  /* ─── ANSI color helpers ────────────────────────────────────────── */
  const C = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    red: "\x1b[31m",
    dim: "\x1b[2m",
  };
  const color = (code, s) => `${code}${s}${C.reset}`;

  /** Navigate back to BASE_URL, re-apply filters, reset loadedCount. */
  async function reloadPage() {
    console.log(color(C.dim, `    Reloading page to clear state...`));
    await navigateAndFilter(page, BASE_URL);
    loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
  }

  /**
   * Find the combo-box index of a swimmer by name.
   *
   * Opens the dropdown and reads item data from the DevExpress internal
   * data store (cmbUtover.GetItem(i)) rather than from the DOM.  This is
   * critical because DevExpress virtual scrolling only keeps ~10 items in
   * the DOM at any time (recycling rows on scroll), so DOM-based lookups
   * miss all items in the middle of loaded batches.
   *
   * Between batch loads the dropdown is closed and re-opened because
   * DevExpress may not fire scroll callbacks for programmatic scrollTop
   * changes on an already-open dropdown — closing and re-opening forces
   * a fresh view update that triggers the server callback.
   *
   * IMPORTANT: GetItemCount() is NOT used for batch-detection because in
   * callback mode it returns the total server-known item count, not the
   * count of items actually available in the client store.  Instead we
   * count items where GetItem(i) returns non-null.
   */
  async function findSwimmerIdx(page, name) {
    let prevLoaded = 0;

    while (true) {
      // Open dropdown to trigger initial load / show loaded items
      await page.evaluate(() => cmbUtover.ShowDropDown());
      await sleep(600);

      // Count truly loaded items (non-null GetItem) and search for target.
      const result = await page.evaluate((target) => {
        try {
          const total = cmbUtover.GetItemCount();
          let loadedUpTo = 0;
          for (let i = 0; i < total; i++) {
            const item = cmbUtover.GetItem(i);
            if (!item) break; // items are loaded sequentially from 0
            loadedUpTo = i + 1;
            if (item.text && item.text.trim() === target) {
              return { found: true, idx: i, loadedUpTo };
            }
          }
          return { found: false, loadedUpTo };
        } catch {
          return { found: false, loadedUpTo: 0 };
        }
      }, name);

      if (result.found) {
        await page.evaluate(() => {
          try {
            cmbUtover.HideDropDown();
          } catch {}
        });
        await sleep(300);
        return result.idx;
      }

      // Close dropdown so the next ShowDropDown triggers a fresh view
      await page.evaluate(() => {
        try {
          cmbUtover.HideDropDown();
        } catch {}
      });
      await sleep(300);

      // No new items loaded since last iteration — checked everything
      if (result.loadedUpTo <= prevLoaded) break;
      prevLoaded = result.loadedUpTo;
    }

    return null;
  }

  /**
   * Load combo batches until the item at `idx` is available in the client
   * data store (cmbUtover.GetItem(idx) !== null).  After a page reload,
   * only the first batch (~100 items) is loaded — and GetItemCount()
   * returns the loaded count, not the server total — so we cannot rely on
   * GetItemCount() for termination.  Instead, the dropdown is opened once
   * and scrolled incrementally (one viewport per iteration) to trigger
   * sequential batch loading from the server.  Returns true once the item
   * is found (and closes the dropdown), false if scrolling reaches the
   * bottom without finding it (index doesn't exist).
   */
  async function loadUntilIdx(idx, maxScrolls = 200) {
    // Open dropdown once — it stays open while we scroll incrementally
    await page.evaluate(() => {
      try {
        cmbUtover.ShowDropDown();
      } catch {}
    });
    await sleep(400);

    for (let s = 0; s < maxScrolls; s++) {
      // Check if the target item is already loaded
      const ready = await page.evaluate((i) => {
        try {
          return cmbUtover.GetItem(i) != null;
        } catch {
          return false;
        }
      }, idx);
      if (ready) {
        // Item found — close dropdown and return
        await page.evaluate(() => {
          try {
            cmbUtover.HideDropDown();
          } catch {}
        });
        await sleep(300);
        return true;
      }

      // Scroll down by one viewport to trigger the next batch
      const atBottom = await page.evaluate(async () => {
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (!d) return true;
        const prev = d.scrollTop;
        d.scrollTop = d.scrollTop + d.clientHeight;
        if (d.scrollTop <= prev) return true; // already at bottom
        await new Promise((r) => setTimeout(r, 2_000));
        return false;
      });

      if (atBottom) {
        // Can't scroll further — item doesn't exist
        await page.evaluate(() => {
          try {
            cmbUtover.HideDropDown();
          } catch {}
        });
        await sleep(300);
        return false;
      }
    }

    // Exhausted all scrolls without finding the item
    await page.evaluate(() => {
      try {
        cmbUtover.HideDropDown();
      } catch {}
    });
    await sleep(300);
    return false;
  }

  while (true) {
    // Ensure the combo has loaded items up to cbIdx before trying to read.
    // After a page reload, only the first batch is loaded.  The
    // loadUntilIdx helper scrolls incrementally through batches until
    // cbIdx is reachable or we hit the end of the list.
    if (!(await loadUntilIdx(cbIdx))) {
      console.log(
        color(C.dim, `    Reached end of swimmer list at index ${cbIdx}`),
      );
      break;
    }

    // Read swimmer info from combo box
    const sw = await page.evaluate((idx) => {
      try {
        cmbUtover.SetSelectedIndex(idx);
        const text = cmbUtover.GetText();
        const value = cmbUtover.GetValue();
        if (!text || !value || value === "0") return null;
        return { id: String(value), text: text.trim(), index: idx };
      } catch (e) {
        return { error: e.message, index: idx };
      }
    }, cbIdx);

    if (sw && sw.error) {
      console.log(
        color(C.red, `    ⚠ Combo box error at index ${cbIdx}: ${sw.error}`),
      );
      cbIdx++;
      continue;
    }

    if (!sw) {
      console.log(
        color(
          C.dim,
          `    [debug] combo item at index ${cbIdx} has no text/value — skipping`,
        ),
      );
      cbIdx++;
      continue;
    }

    const selIdx = cbIdx;
    cbIdx++;
    processedInSession++;

    // Skip if this swimmer was fully scraped within the last 24 hours
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const existing = existingSwimmers.get(sw.id);
    if (
      existing &&
      existing.timestamp &&
      new Date(existing.timestamp).getTime() >= twentyFourHoursAgo
    ) {
      if (mode !== "splits") {
        // Collect pass: we saved ALL race data last time — no need to re-fetch
        // within 24 h, regardless of whether splits are present (splits are
        // only extracted in the splits pass).
        console.log(
          `  ${color(C.yellow, "→")} ${processedInSession} — ${sw.text} — ${formatSwimmerStats(existing)}, last updated ${timeAgo(existing.timestamp)} (skipped)`,
        );
        continue;
      }
      // Splits pass: only skip if every eligible race already has split data.
      const savedRaces = flattenRaces(existing);
      const missingSplits = savedRaces.some(
        (r) => r.splits === undefined && hasPotentialSplits(r.Distanse),
      );
      if (!missingSplits) {
        console.log(
          `  ${color(C.yellow, "→")} ${processedInSession} — ${sw.text} — ${formatSwimmerStats(existing)}, last updated ${timeAgo(existing.timestamp)} (skipped)`,
        );
        continue;
      }
    }

    // Skip-until check (grid never loaded on a previous run)
    const skipInfo = skipUntil.get(sw.id);
    if (skipInfo && new Date(skipInfo).getTime() > Date.now()) {
      const statsMsg = existing ? formatSwimmerStats(existing) : "no data yet";
      const ago = existing?.timestamp ? timeAgo(existing.timestamp) : "";
      const retryAfter = new Date(skipInfo).toLocaleString("nb-NO", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      console.log(
        `  ${color(C.yellow, "→")} ${processedInSession} — ${sw.text} — ${statsMsg}${ago ? ", last updated " + ago : ""} (skipped — retry after ${retryAfter})`,
      );
      continue;
    }

    // In splits mode, log the swimmer name before processing so progress
    // is visible during slow split extraction.  Collect mode is fast so
    // we skip this line and only show the ✓ result line.
    if (mode === "splits") {
      console.log(`  ${color(C.cyan, processedInSession)} — ${sw.text}`);
    }

    // Retry loop with hang detection + page reload
    let attempts = 0;
    let swimmerOk = false;
    let pageWasReloaded = false;
    while (attempts < 3 && !swimmerOk) {
      attempts++;
      try {
        // Collect mode is fast (~3s/swimmer); splits mode can take minutes
        // per swimmer when hundreds of detail rows are expanded.
        const swimmerTimeout = mode === "splits" ? 7_200_000 : 60_000;
        const saved = await withTimeout(
          thisSwimmer(sw, selIdx),
          swimmerTimeout,
          sw.text,
        );
        if (saved) {
          swimmerOk = true;
          lastSwimmerName = sw.text;
        } else {
          // false = grid never loaded / no data — retrying won't help.
          // The page state is fine (no stuck DevExpress callback), so
          // mark as ok to skip the reload + findSwimmerIdx block below.
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
          try {
            await withTimeout(reloadPage(), 30_000, "reload");
            pageWasReloaded = true;
          } catch {
            // If even the reload hangs, we can't recover
            console.log(
              color(C.red, `  ⚠ ${sw.text}: reload also hung, skipping`),
            );
            break;
          }
          if (attempts < 3) {
            console.log(color(C.dim, `    retry ${attempts}/3...`));
          }
        } else {
          // Non-timeout error (e.g. missing data) — log and move on
          console.log(color(C.red, `  ⚠ ${sw.text}: ${msg.slice(0, 100)}`));
          swimmerOk = true; // don't retry
        }
      }
    }

    // If the page was reloaded during the retry loop (due to a timeout or
    // protocol error), we must reposition cbIdx via findSwimmerIdx even if
    // the retry eventually succeeded — the combo box was reset and cbIdx
    // is no longer valid for the current page state.
    if (!swimmerOk || pageWasReloaded || needsReposition) {
      needsReposition = false;
      try {
        await withTimeout(reloadPage(), 30_000, "reload");
      } catch {
        // If reload hangs too, skip and try again later
      }

      // After a reload, the combo box resets. Reposition cbIdx by finding
      // the last successfully processed swimmer by name, so we don't skip
      // swimmers due to stale index tracking.
      if (lastSwimmerName) {
        const foundIdx = await findSwimmerIdx(page, lastSwimmerName);
        if (foundIdx !== null) {
          cbIdx = foundIdx + 1;
          // findSwimmerIdx loaded batches via the dropdown; sync loadedCount
          // so the main loop safety net doesn't re-scroll unnecessarily.
          loadedCount = await page.evaluate(() => cmbUtover.GetItemCount());
          console.log(
            color(
              C.cyan,
              `    Repositioned to index ${cbIdx} (after "${lastSwimmerName}")`,
            ),
          );
        } else {
          console.log(
            color(
              C.yellow,
              `    Could not find "${lastSwimmerName}" in combo — continuing at index ${cbIdx}`,
            ),
          );
        }
      }
    }

    await sleep(DELAY_BETWEEN);
  }

  /**
   * Find indices of races in currentRaces that don't exist in savedRaces,
   * matched by distance + date + time. Skips ineligible (< 100 m) races.
   */
  function findNewRaceIndices(currentRaces, savedRaces) {
    const indices = [];
    for (let i = 0; i < currentRaces.length; i++) {
      const cr = currentRaces[i];
      if (!hasPotentialSplits(cr.Distanse)) continue;
      const exists = savedRaces.some(
        (sr) =>
          sr.Distanse === cr.Distanse &&
          sr.Dato === cr.Dato &&
          sr.Tid === cr.Tid,
      );
      if (!exists) indices.push(i);
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
      const existing = existingSwimmers.get(sw.id);
      const ago = existing?.timestamp ? timeAgo(existing.timestamp) : "";
      const statsMsg = existing ? formatSwimmerStats(existing) : "no data yet";
      console.log(
        color(
          C.yellow,
          `  ⚠ Grid never loaded — ${sw.text} — ${statsMsg}${ago ? ", last updated " + ago : ""}`,
        ),
      );
      skipUntil.set(
        sw.id,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      );
      saveSkipUntil(skipUntil, SKIP_UNTIL_FILE);
      // The failed callback may have left the JS thread stuck.  Signal the
      // main loop to reload the page and reposition cbIdx via findSwimmerIdx
      // before the next loadUntilIdx call.
      needsReposition = true;
      return false; // not saved
    }

    // Parse the grid table directly from the DOM.
    // The array indices are the grid's visible indices, which is what
    // GVShowDetailRow expects. CSV export would include filtered-out
    // rows (D/F) and cause index mismatches.
    const races = await parseGridFromDOM(page);
    if (!races || races.length === 0) {
      console.log(color(C.yellow, `  ⚠ No data — ${sw.text}`));
      return false; // not saved
    }

    // Merge saved races that aren't in the current grid back into the
    // races array.  This preserves historical data when the date filter
    // (dtFraDato) is narrowed — without this, pre-filter races would be
    // silently dropped on the next save.
    const prevData = existingSwimmers.get(sw.id);
    if (prevData && prevData.timestamp) {
      const savedRaces = flattenRaces(prevData);
      for (const sr of savedRaces) {
        const inGrid = races.some(
          (r) =>
            r.Distanse === sr.Distanse &&
            r.Dato === sr.Dato &&
            r.Tid === sr.Tid,
        );
        if (!inGrid) races.push(sr);
      }
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
      const gender = await fetchGender(page);

      // Show whether this is new, grown, or unchanged
      const existing = existingSwimmers.get(sw.id);
      let changeLabel;
      if (existing && existing.timestamp) {
        const savedRaces = flattenRaces(existing);
        const diff = races.length - savedRaces.length;
        if (diff === 0) {
          changeLabel = `unchanged`;
        } else {
          changeLabel = `${savedRaces.length}→${races.length}`;
        }
      } else {
        changeLabel = `new`;
      }

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
        gender,
        timestamp: new Date().toISOString(),
        disciplines,
      };

      writeSwimmerFile(entry, SWIMMERS_DIR);
      totalRaces += races.length;
      const ago = existing?.timestamp ? timeAgo(existing.timestamp) : "";
      console.log(
        `  ${color(C.green, "✓")} ${processedInSession} — ${sw.text} — ${races.length} races, ${changeLabel}${ago ? ", last updated " + ago : ""} (processed in ${elapsed(swStart)})`,
      );

      // Rebuild index every swimmer; push to GitHub every 25 so Pages
      // doesn't get flooded with individual deployments.
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
      });
      if (processedInSession % 25 === 0) {
        console.log(
          color(
            C.cyan,
            `    checkpoint — pushing ${processedInSession} swimmers to GitHub...`,
          ),
        );
        gitCheckpoint(`${processedInSession}/${loadedCount - 1} swimmers`);
      }
      return true; // saved
    }

    // ── Splits mode: extract new or missing splits only ──
    const eligible = races.filter((r) => hasPotentialSplits(r.Distanse)).length;
    const existing = existingSwimmers.get(sw.id);

    /**
     * Merge saved splits back into races that weren't touched by extractSplits.
     * This prevents existing split data from being silently dropped on save.
     */
    function mergeSavedSplits(races, savedRaces) {
      for (const r of races) {
        if (r.splits === undefined && hasPotentialSplits(r.Distanse)) {
          const saved = savedRaces.find(
            (sr) =>
              sr.Distanse === r.Distanse &&
              sr.Dato === r.Dato &&
              sr.Tid === r.Tid,
          );
          if (saved && saved.splits !== undefined) {
            r.splits = saved.splits;
          }
        }
      }
    }

    /**
     * Persist the current state of races as a partial checkpoint so that
     * data is never lost if the process crashes mid-extraction. Clones
     * race objects so the final save's destructive column-dropping is
     * unaffected.
     */
    async function saveProgress() {
      let info;
      try {
        info = await getSwimmerInfo(page);
      } catch {
        info = { name: null, club: null, birthYear: null };
      }
      const swimmerName = info.name || sw.text;

      const discMap = new Map();
      for (const r of races) {
        const dist = r.Distanse || "Ukjent";
        if (!discMap.has(dist)) discMap.set(dist, []);
        discMap.get(dist).push(r);
      }
      const disciplines = [];
      for (const [distanse, dRaces] of discMap) {
        const cloned = dRaces.map((r) => {
          const c = { ...r };
          delete c.Nr;
          delete c.Poeng;
          delete c.Poengtype;
          delete c.D;
          if (c.RK == null) delete c.RK;
          if (c.RA == null) delete c.RA;
          delete c.Distanse;
          return c;
        });
        disciplines.push({ distanse, races: cloned });
      }

      writeSwimmerFile(
        {
          swimmerId: sw.id,
          name: swimmerName,
          club: info.club,
          birthYear: info.birthYear,
          timestamp: new Date().toISOString(),
          disciplines,
        },
        SWIMMERS_DIR,
      );
    }

    if (existing && existing.timestamp) {
      const savedRaces = flattenRaces(existing);

      if (savedRaces.length === races.length) {
        // Race count unchanged — extract only rows where split data is
        // missing from the saved file, then skip if all are present.
        const missingSplits = [];
        for (let i = 0; i < races.length; i++) {
          const cr = races[i];
          if (!hasPotentialSplits(cr.Distanse)) continue;
          const saved = savedRaces.find(
            (sr) =>
              sr.Distanse === cr.Distanse &&
              sr.Dato === cr.Dato &&
              sr.Tid === cr.Tid,
          );
          if (!saved || saved.splits === undefined) {
            missingSplits.push(i);
          }
        }

        if (missingSplits.length === 0) {
          // If gender isn't known yet, fetch and update the file even though
          // splits are all present — we still want to fill in the gap.
          if (!existing.gender) {
            existing.gender = await fetchGender(page);
          }
          console.log(
            `  ✓ ${processedInSession} — ${sw.text} — ${formatSwimmerStats(existing)}, last updated ${timeAgo(existing.timestamp)} (processed in ${elapsed(swStart)})`,
          );
          existing.timestamp = new Date().toISOString();
          writeSwimmerFile(existing, SWIMMERS_DIR);
          return true;
        }

        console.log(
          color(
            C.cyan,
            `  ${sw.text} → extracting ${missingSplits.length} missing splits from ${races.length} races`,
          ),
        );
        await extractSplits(page, races, {
          log: (msg) => console.log(`    ${msg}`),
          onProgress: saveProgress,
          onlyRows: new Set(missingSplits),
        });
        mergeSavedSplits(races, savedRaces);
      } else {
        // Race count changed — find which races are new and extract only those.
        const newIndices = findNewRaceIndices(races, savedRaces);

        if (newIndices.length > 0) {
          console.log(
            color(
              C.cyan,
              `  ${sw.text} → extracting ${newIndices.length} new splits from ${races.length} races`,
            ),
          );
          await extractSplits(page, races, {
            log: (msg) => console.log(`    ${msg}`),
            onProgress: saveProgress,
            onlyRows: new Set(newIndices),
          });
        }
        mergeSavedSplits(races, savedRaces);
      }
    } else {
      console.log(
        color(
          C.cyan,
          `  ${sw.text} → extracting ${eligible} splits from ${races.length} races`,
        ),
      );
      await extractSplits(page, races, {
        log: (msg) => console.log(`    ${msg}`),
        onProgress: saveProgress,
      });
    }

    // Check if page is still alive after all the expansion work.
    // Use a short timeout — if the JS thread is stuck from a previous
    // DevExpress callback, page.evaluate would hang for protocolTimeout.
    try {
      await withTimeout(
        page.evaluate(() => true),
        10_000,
      );
    } catch {
      console.log(
        color(
          C.red,
          `    ⚠ Page unresponsive after split extraction, reloading...`,
        ),
      );
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

    // Fetch gender once per swimmer (skip if already known from earlier run)
    const gender = existing?.gender || (await fetchGender(page));

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
      gender,
      timestamp: new Date().toISOString(),
      disciplines,
    };

    writeSwimmerFile(entry, SWIMMERS_DIR);
    totalRaces += races.length;

    const withSplits = races.filter(
      (r) => r.splits !== undefined && r.splits.length > 0,
    ).length;
    console.log(
      `  ✓ ${processedInSession} — ${sw.text} — ${races.length} races, ${withSplits} with split times` +
        ` (processed in ${elapsed(swStart)})`,
    );

    // Rebuild index every swimmer; push to GitHub every 25 so Pages
    // doesn't get flooded with individual deployments.
    rebuildIndex({
      swimmersDir: SWIMMERS_DIR,
      dataDir: DATA_DIR,
      indexFile: INDEX_FILE,
      baseUrl: BASE_URL,
    });
    if (processedInSession % 25 === 0) {
      console.log(
        color(
          C.cyan,
          `    checkpoint — pushing ${processedInSession} swimmers to GitHub...`,
        ),
      );
      gitCheckpoint(`${processedInSession}/${loadedCount - 1} swimmers`);
    }
    return true; // saved
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
    color(
      C.green,
      `  ✓ ${mode} pass complete! ${processedInSession} swimmers checked, ${totalRaces} new/updated races`,
    ),
  );

  // Don't let a stuck browser.close() prevent the process from exiting.
  try {
    await withTimeout(browser.close(), 10_000, "browser close");
  } catch {
    // All work is done — force exit if the browser won't close cleanly.
    process.exit(0);
  }
}

/* ─── Entry point ────────────────────────────────────────────────── */
/**
 * Single-pass mode: for each swimmer, collect race data and extract split
 * times in one go. This cuts the runtime roughly in half compared to the
 * old two-pass (collect → splits) approach.
 *
 * When running against existing data, unchanged swimmers with complete
 * splits are skipped quickly (~3 s/swimmer).
 *
 * For manual use:
 *   MODE=collect   — race data only (no splits), fast per swimmer
 *   MODE=splits    — split extraction only (same as "auto" default)
 */
async function main() {
  if (DEFAULT_MODE === "auto") {
    // Single-pass: collect race data and extract splits in one go.
    // On the first run each swimmer gets full race data + splits.
    // Subsequent runs skip unchanged swimmers with complete splits.
    await runPass("splits");
  } else {
    await runPass(DEFAULT_MODE);
  }
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err);
  process.exit(1);
});
