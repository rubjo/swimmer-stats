import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import {
  flattenRaces,
  loadExistingSwimmers,
  rebuildIndex,
  loadSkipUntil,
} from "./lib/fs-utils.js";
import {
  hasPotentialSplits,
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

const DELAY_BETWEEN = 250;
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
  let page = await browser.newPage();
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

  /**
   * Navigate back to BASE_URL, re-apply filters.  If the page's JS thread
   * is stuck (navigation times out), create a fresh page.
   * Returns the (possibly new) page and its initial loadedCount.
   */
  async function reloadPage() {
    console.log(color(C.dim, `    Reloading page to clear state...`));
    let p = page;
    try {
      await navigateAndFilter(p, BASE_URL);
    } catch {
      console.log(
        color(C.yellow, `    Page unresponsive, creating new page...`),
      );
      p = await browser.newPage();
      await p.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );
      await p.setViewport({ width: 1400, height: 900 });
      await navigateAndFilter(p, BASE_URL);
    }
    const lc = await p.evaluate(() => cmbUtover.GetItemCount());
    return { page: p, loadedCount: lc };
  }

  /**
   * Create a brand-new page with a clean CDP session (for when the
   * current page's CDP session is stuck).  Returns the new page and
   * its initial loadedCount.
   */
  async function replacePage() {
    console.log(color(C.yellow, `    Creating new page after stuck state...`));
    // Attempt to close the old page, but don't wait if it's stuck.
    try {
      await withTimeout(page.close(), 5_000, "close old page");
    } catch {
      // Old page CDP session is hung — abandon it.
    }
    const p = await browser.newPage();
    await p.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    await p.setViewport({ width: 1400, height: 900 });
    await navigateAndFilter(p, BASE_URL);
    const lc = await p.evaluate(() => cmbUtover.GetItemCount());
    return { page: p, loadedCount: lc };
  }

  /**
   * Find the combo-box index of a swimmer by name.
   *
   * Opens the dropdown and scrolls incrementally (like loadUntilIdx) to
   * trigger DevExpress virtual-scroll batch loading.  At each scroll
   * position, all currently loaded items are scanned via the internal
   * data store (cmbUtover.GetItem(i)) rather than from the DOM — critical
   * because DevExpress virtual scrolling only keeps ~10 items visible in
   * the DOM at any time, so DOM-based lookups miss items in the middle of
   * loaded batches.
   *
   * Earlier versions of this function relied on open/close cycles to
   * trigger batch loading, but that doesn't work — DevExpress only loads
   * new batches on scroll callbacks.  The incremental scroll approach
   * mirrors loadUntilIdx and reliably exposes all items.
   */
  async function findSwimmerIdx(page, name, maxScrolls = 200) {
    await page.evaluate(() => {
      try {
        cmbUtover.ShowDropDown();
      } catch {}
    });
    await sleep(400);

    for (let s = 0; s < maxScrolls; s++) {
      // Search currently loaded items for the target name
      const result = await page.evaluate((target) => {
        try {
          const total = cmbUtover.GetItemCount();
          for (let i = 0; i < total; i++) {
            const item = cmbUtover.GetItem(i);
            if (!item) break;
            if (item.text && item.text.trim() === target) {
              return { found: true, idx: i };
            }
          }
          return { found: false };
        } catch {
          return { found: false };
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

      // Scroll down by one viewport to load the next batch
      const atBottom = await page.evaluate(async () => {
        try {
          const d = cmbUtover.GetListBoxScrollDivElement();
          if (!d) return true;
          const prev = d.scrollTop;
          d.scrollTop = d.scrollTop + d.clientHeight;
          if (d.scrollTop <= prev) return true;
          await new Promise((r) => setTimeout(r, 2_000));
          return false;
        } catch {
          return true;
        }
      });

      if (atBottom) break;
    }

    // Close dropdown
    await page.evaluate(() => {
      try {
        cmbUtover.HideDropDown();
      } catch {}
    });
    await sleep(300);
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
    try {
      // If loadUntilIdx hangs (DevExpress callback never completes), the
      // underlying CDP Runtime.callFunctionOn is stuck and blocks every
      // subsequent command on that page session.  Use a shorter timeout
      // than the 120s protocolTimeout so we detect hangs early.  The
      // .catch() prevents unhandled rejection when the orphaned promise
      // eventually fails.
      const found = await withTimeout(
        loadUntilIdx(cbIdx).catch(() => false),
        60_000,
        `loadUntilIdx(${cbIdx})`,
      );
      if (!found) {
        console.log(
          color(C.dim, `    Reached end of swimmer list at index ${cbIdx}`),
        );
        break;
      }
    } catch {
      // loadUntilIdx timed out — the combo's DevExpress callback hung.
      // Create a fresh page with a clean CDP session and retry.
      console.log(
        color(
          C.yellow,
          `    loadUntilIdx timed out at index ${cbIdx}, replacing page...`,
        ),
      );
      const rp = await replacePage();
      page = rp.page;
      loadedCount = rp.loadedCount;
      continue;
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

    // Build context for processSwimmer
    const ctx = {
      mode,
      existingSwimmers,
      skipUntil,
      SKIP_UNTIL_FILE,
      SWIMMERS_DIR,
      DATA_DIR,
      INDEX_FILE,
      BASE_URL,
      processedInSession,
      reloadPage: async () => {
        const rp = await reloadPage();
        page = rp.page;
        loadedCount = rp.loadedCount;
        return rp.page;
      },
      gitCheckpoint,
    };

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
        const result = await withTimeout(
          processSwimmer(page, sw, selIdx, ctx),
          swimmerTimeout,
          sw.text,
        );
        if (result.saved) {
          swimmerOk = true;
          lastSwimmerName = sw.text;
          totalRaces += result.totalRaces;
        } else {
          // false = grid never loaded / no data — retrying won't help.
          needsReposition = result.needsReposition;
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
            const rp = await withTimeout(reloadPage(), 60_000, "reload");
            page = rp.page;
            loadedCount = rp.loadedCount;
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

    // Handle page state after a failed swimmer.
    //
    // Three cases:
    //   1. Grid never loaded / no data (processSwimmer returned !saved):
    //      Page state is clean — the DevExpress callback completed, it just
    //      returned no rows. cbIdx was already incremented past the swimmer.
    //      No reload or reposition needed — loadUntilIdx(cbIdx) on the next
    //      loop iteration will naturally scroll to the right position.
    //
    //   2. Timeout / protocol error (retry loop caught and reloaded):
    //      reloadPage() was already called inside the retry loop. The combo
    //      is reset to the beginning. cbIdx still points to the next swimmer
    //      after the one that timed out. loadUntilIdx(cbIdx) will scroll to
    //      the right batch.
    //
    //   3. Non-timeout error with swimmerOk=false (page may be stuck):
    //      Reload the page to clear state, then continue. cbIdx was already
    //      incremented so the next loop iteration handles positioning.
    if (!swimmerOk || pageWasReloaded || needsReposition) {
      needsReposition = false;

      // Only reload when the page might be in a bad state.  For case 1
      // (grid-never-loaded) the page is clean.  For case 2 the page was
      // already reloaded in the retry loop above.
      if (!swimmerOk && !pageWasReloaded) {
        try {
          const rp = await withTimeout(reloadPage(), 60_000, "reload");
          page = rp.page;
          loadedCount = rp.loadedCount;
        } catch {
          // If reload hangs too, skip and try again later
        }
      }

      // After an actual page reload (case 2 or 3), the combo was reset.
      // Reposition cbIdx relative to the last successfully processed
      // swimmer.  findSwimmerIdx now scrolls incrementally (like
      // loadUntilIdx) so it can find names at any index.  If it still
      // fails (e.g. the swimmer was removed from the list), we fall back
      // to the existing cbIdx which already points to the next swimmer.
      if (pageWasReloaded && lastSwimmerName) {
        const foundIdx = await findSwimmerIdx(page, lastSwimmerName);
        if (foundIdx !== null) {
          cbIdx = foundIdx + 1;
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

  // All work is done — force exit immediately.
  // Do NOT attempt browser.close() — orphaned pages from timeout recovery
  // may have stuck CDP sessions that would hang the shutdown indefinitely.
  process.exit(0);
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
