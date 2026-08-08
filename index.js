import fs from "fs";
import { execSync } from "child_process";
import puppeteer from "puppeteer";
import path from "path";
import { loadIndex, rebuildIndex, walkJsonFiles } from "./lib/fs-utils.js";
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
const ROSTER_FILE = path.join(DATA_DIR, "roster.json");

// How long a cached roster stays valid before a full re-discovery is forced.
// The roster is the full {id, text, index} swimmer list from the combo box.
// Full discovery is the slowest, flakiest part of a run, so we cache it and
// only rebuild periodically (or when FORCE_DISCOVERY=1). Index positions can
// drift as swimmers are added/removed server-side, but the existing identity
// check + name-lookup retry already corrects stale indices, so a slightly
// stale roster is safe — it never corrupts saved data.
const ROSTER_MAX_AGE_MS =
  parseInt(process.env.ROSTER_MAX_AGE_HOURS || "48", 10) * 3_600_000;
const FORCE_DISCOVERY = process.env.FORCE_DISCOVERY === "1";

// Date range for incremental scraping.
// Trailing window: default FRA_DATO to LOOKBACK_DAYS before today so the
// per-run grid stays small and constant instead of widening forever.
// Dedup-by-PID makes overlap harmless; the window only needs to exceed one
// full batch-rotation cycle so no new race can slip through between visits.
// An explicit FRA_DATO env var still overrides (handy for one-off backfills).
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || "30", 10);
const FRA_DATO =
  process.env.FRA_DATO ||
  new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
const TIL_DATO = process.env.TIL_DATO || "";

// Batch size: process at most this many swimmers per run, sorted by
// least-recently-checked first. This keeps each run well within the
// 6-hour GitHub Actions timeout while cycling through all swimmers
// over several runs.
const MAX_SWIMMERS_PER_RUN = parseInt(
  process.env.MAX_SWIMMERS_PER_RUN || "500",
  10,
);

// Per-swimmer time budgets. A batch of 500 must fit inside the 6-hour
// GitHub Actions ceiling (~43s/swimmer), so a single swimmer must never be
// allowed to consume minutes/hours. These caps skip a stuck swimmer instead
// of letting one drain the whole run before the first checkpoint lands.
const SWIMMER_TIMEOUT_MS = parseInt(
  process.env.SWIMMER_TIMEOUT_MS || "90000", // 90s to fully process one swimmer
  10,
);
const LOOKUP_TIMEOUT_MS = parseInt(
  process.env.LOOKUP_TIMEOUT_MS || "120000", // 120s to locate one swimmer in the combo
  10,
);

// Global run budget: stop cleanly and checkpoint before Actions force-kills
// the job at 6h. A clean exit lets lastChecked advance so the batch rotates.
const RUN_BUDGET_MS = parseInt(
  process.env.RUN_BUDGET_MS || String(5 * 3_600_000 + 20 * 60_000), // 5h20m
  10,
);

// Full (unlicensed-inclusive) roster — used by the gradual backfill of
// non-licensed ("old") swimmers. Discovered the same way as the licensed
// roster but with the "Kun lisensiert" checkbox OFF, so it lists every swimmer
// ever registered. It is several times larger than the licensed list, so it
// gets its own cache file, TTL, discovery budget, and a growth-friendly cache
// trust rule (see getRoster opts.trustRule).
const FULL_ROSTER_FILE = path.join(DATA_DIR, "roster-full.json");
const FULL_ROSTER_MAX_AGE_MS =
  parseInt(process.env.FULL_ROSTER_MAX_AGE_HOURS || "168", 10) * 3_600_000;
const FORCE_FULL_DISCOVERY = process.env.FORCE_FULL_DISCOVERY === "1";
const MAX_FULL_DISCOVERY_MS = parseInt(
  process.env.MAX_FULL_DISCOVERY_MS || `${30 * 60_000}`,
  10,
);
const MAX_FULL_SUFFIX_SCROLLS = 600;

// Dedicated discovery-only mode: run with DISCOVERY_ONLY=full|licensed to
// build a roster cache in a single long pass — scrolling the combo until the
// very last item is reached — then exit without scraping. Used mainly to grow
// the full roster, which is far too large to discover during a normal
// incremental run. DISCOVERY_ONLY_MAX_MS caps the pass (default 3 h — a
// multi-thousand-swimmer list at ~100 items/batch takes ~15-30 min).
const DISCOVERY_ONLY = (process.env.DISCOVERY_ONLY || "").toLowerCase();
const DISCOVERY_ONLY_MAX_MS = parseInt(
  process.env.DISCOVERY_ONLY_MAX_MS || String(3 * 3_600_000),
  10,
);

// Backfill of non-licensed ("old") swimmers: after the licensed batch, scrape
// up to BACKFILL_NEW_PER_RUN candidates with their FULL race history.
const BACKFILL_ENABLED = process.env.BACKFILL_ENABLED !== "0";
const BACKFILL_NEW_PER_RUN = parseInt(
  process.env.BACKFILL_NEW_PER_RUN || "10",
  10,
);
const BACKFILL_SWIMMER_TIMEOUT_MS = parseInt(
  process.env.BACKFILL_SWIMMER_TIMEOUT_MS || "300000",
  10,
);
// Skip backfill entirely if fewer than this many ms of run budget remain — a
// kill mid-backfill would lose the unsaved files anyway, and candidates stay
// candidates for the next run.
const BACKFILL_MIN_REMAINING_MS = 15 * 60_000;

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
      // Push rejected (likely remote moved) — rebase and retry once.
      try {
        execSync(`git pull --rebase origin main`, {
          stdio: "ignore",
          timeout: 30_000,
        });
        execSync(`git push origin HEAD:main`, {
          stdio: "ignore",
          timeout: 60_000,
        });
      } catch {
        // Rebase failed (likely merge conflict in data/index.json).
        // Abort the rebase to leave a clean working tree, then
        // force-push our local commit — it has the authoritative data.
        try {
          execSync(`git rebase --abort`, { stdio: "ignore", timeout: 10_000 });
        } catch {}
        execSync(`git push --force origin HEAD:main`, {
          stdio: "ignore",
          timeout: 60_000,
        });
      }
    }
  } catch (err) {
    // A failed checkpoint means committed progress may not be on the remote.
    // Surface it instead of silently continuing as if the push succeeded.
    console.warn(
      color(C.red, `  ⚠ gitCheckpoint("${label}") failed: ${err.message}`),
    );
  }
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
async function discoverAllSwimmers(browser, baseUrl, opts = {}) {
  const {
    kunLisensiert = true,
    maxDiscoveryMs = 250_000,
    maxSuffixScrolls = 80,
  } = opts;
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1400, height: 900 });
  await navigateAndFilter(page, baseUrl, {
    fraDato: FRA_DATO,
    tilDato: TIL_DATO,
    kunLisensiert,
  });

  page.setDefaultTimeout(300_000);

  const rawData = await page.evaluate(
    async ({ MAX_DISCOVERY_MS, MAX_SUFFIX_SCROLLS }) => {
    const startMs = Date.now();

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

    // Wait for the loaded item count to grow past prevCount, re-jumping to the
    // bottom once mid-way to re-trigger a slow callback. Returns true when it
    // grew, "timeout" when the discovery budget ran out, false when the count
    // stayed flat (list fully loaded).
    async function pump(prevCount) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          d.scrollTop = d.scrollHeight; // re-trigger the callback
          await new Promise((r) => setTimeout(r, 3_000));
        }
        if (Date.now() - startMs > MAX_DISCOVERY_MS) return "timeout";
        // 60 × 500ms = 30s per attempt. Batches can stall well past 10 s under
        // server throttle — a too-short wait was truncating full-roster
        // discoveries part-way through the list.
        for (let p = 0; p < 60; p++) {
          await new Promise((r) => setTimeout(r, 500));
          if (Date.now() - startMs > MAX_DISCOVERY_MS) return "timeout";
          if (cmbUtover.GetItemCount() > prevCount) return true;
        }
      }
      return false;
    }

    // Phase A: load the ENTIRE list by jumping the listbox scrollbar to the
    // bottom repeatedly. Empirically (probed against the live site) each jump
    // lands on the freshly-growing bottom edge and triggers DevExpress to load
    // the NEXT sequential batch (~100 items) — the loaded store grows
    // contiguously 0..N-1 with no gaps, and scrollHeight grows as items load.
    // (One-viewport scrolling does NOT trigger callbacks, and the old
    // "jump to scrollHeight skips the middle" belief does not hold here.)
    //
    // We are certain we reached the very last item when a bottom jump no
    // longer moves the scrollbar AND the loaded count stays flat through pump's
    // generous wait + re-jump retry.
    let timedOut = false;
    let exhausted = false;
    for (let i = 0; i < MAX_SUFFIX_SCROLLS; i++) {
      if (Date.now() - startMs > MAX_DISCOVERY_MS) { timedOut = true; break; }
      const prevCount = cmbUtover.GetItemCount();
      d.scrollTop = d.scrollHeight;
      const grew = await pump(prevCount);
      if (grew === "timeout") { timedOut = true; break; }
      if (!grew) { exhausted = true; break; }
    }
    if (Date.now() - startMs > MAX_DISCOVERY_MS) timedOut = true;

    // Phase B: read all items from the client data store. The store is
    // cumulative — every loaded batch is retained even after the DOM scrolls
    // away, so a single pass reading indices 0..N-1 captures everything.
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
    return {
      swimmers: all,
      timedOut,
      exhausted,
      loadedCount: cmbUtover.GetItemCount(),
    };
    },
    { MAX_DISCOVERY_MS: maxDiscoveryMs, MAX_SUFFIX_SCROLLS: maxSuffixScrolls },
  );

  if (rawData.error) {
    console.log(color(C.red, `  Discovery error: ${rawData.error}`));
    await page.close();
    return { swimmers: [], complete: false };
  }

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await page.close();

  const swimmers = rawData.swimmers;
  // A discovery is "complete" only when the scroll loop exhausted the list
  // naturally — the scrollbar stopped advancing AND the loaded count stopped
  // growing, i.e. we reached the very last item. A timed-out discovery (or one
  // that hit the MAX_SUFFIX_SCROLLS ceiling) has almost certainly loaded only
  // a prefix of the combo, so its roster must not be trusted to overwrite a
  // good cached one.
  const complete = !!rawData.exhausted && !rawData.timedOut;
  if (rawData.timedOut) {
    console.log(
      color(
        C.yellow,
        `  ⚠ Discovery hit the time limit — roster likely partial (${swimmers.length} of ~${rawData.loadedCount} loaded)`,
      ),
    );
  } else if (!rawData.exhausted) {
    console.log(
      color(
        C.yellow,
        `  ⚠ Discovery hit the scroll cap (${maxSuffixScrolls}) without reaching the end — roster partial (${swimmers.length} of ~${rawData.loadedCount} loaded)`,
      ),
    );
  }
  console.log(
    color(
      C.dim,
      `  Found ${swimmers.length} swimmers (${complete ? "complete" : "partial"})`,
    ),
  );
  return { swimmers, complete };
}

/**
 * Load the swimmer roster, preferring a cached data/roster.json over a full
 * combo-box scroll. Full discovery runs only when the cache is missing,
 * unreadable, older than ROSTER_MAX_AGE_MS, or FORCE_DISCOVERY=1.
 *
 * When a fresh discovery runs, the result is written back to roster.json —
 * but only if it is trustworthy. A discovery that timed out (partial) or that
 * returns fewer swimmers than the existing cache is NOT written over a good
 * cache, so a truncated run can never silently drop swimmers (e.g. names near
 * the end of the alphabet). The partial list is still used for the current run
 * so work isn't wasted; only the persisted cache is protected.
 *
 * A stale-but-complete roster is safe: index positions may drift, but the
 * per-swimmer identity check and name-lookup retry correct that without
 * touching saved race data.
 */
async function getRoster(browser, baseUrl, opts = {}) {
  const {
    cacheFile = ROSTER_FILE,
    maxAgeMs = ROSTER_MAX_AGE_MS,
    force = FORCE_DISCOVERY,
    kunLisensiert = true,
    label = "roster",
    discovery = {},
    // "strict" (licensed roster): overwrite cache only when the discovery is
    // complete AND at least as large as the cached copy.
    // "growth" (full roster): overwrite when complete OR when it returned MORE
    // swimmers than the cached copy — lets the cached full roster grow across
    // runs even when individual discoveries time out part-way.
    trustRule = "strict",
  } = opts;

  // Read whatever is cached (even if stale) so we can (a) return it when fresh
  // and (b) protect it from being overwritten by a shorter/partial discovery.
  let cached = null;
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (Array.isArray(raw.swimmers)) cached = raw;
    }
  } catch {
    console.log(
      color(C.dim, `  ${label} cache unreadable — running full discovery`),
    );
  }

  if (!force && cached && cached.swimmers.length > 0) {
    const ageMs = Date.now() - new Date(cached.generatedAt || 0).getTime();
    if (ageMs < maxAgeMs) {
      const ageH = Math.round(ageMs / 3_600_000);
      console.log(
        color(
          C.green,
          `  Using cached ${label}: ${cached.swimmers.length} swimmers (${ageH}h old)`,
        ),
      );
      return cached.swimmers;
    }
    console.log(color(C.dim, `  ${label} cache stale — running full discovery`));
  } else if (force) {
    console.log(color(C.dim, `  FORCE_DISCOVERY=1 — running ${label} discovery`));
  }

  const { swimmers, complete } = await discoverAllSwimmers(browser, baseUrl, {
    kunLisensiert,
    ...discovery,
  });
  const cachedCount = cached?.swimmers?.length || 0;

  // Only overwrite the cache when the new discovery is at least as trustworthy
  // as the existing one: it must be complete (didn't time out) AND not shrink
  // the known roster. Otherwise keep the old cache but still use the fresh
  // partial list for this run.
  const trustworthy =
    swimmers.length > 0 &&
    (trustRule === "growth"
      ? complete || swimmers.length > cachedCount
      : complete && swimmers.length >= cachedCount);

  if (trustworthy) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify(
          { generatedAt: new Date().toISOString(), swimmers },
          null,
          2,
        ),
        "utf-8",
      );
      console.log(color(C.dim, `  ${label} cached to ${cacheFile}`));
    } catch (err) {
      console.warn(
        color(C.yellow, `  ⚠ Could not write ${label} cache: ${err.message}`),
      );
    }
  } else if (swimmers.length > 0) {
    console.log(
      color(
        C.yellow,
        `  ⚠ Not overwriting ${label} cache — discovery was ${
          !complete
            ? "partial"
            : `shorter (${swimmers.length} < cached ${cachedCount})`
        }; using fresh list for this run only`,
      ),
    );
  }

  // Use the fresh list if we got one; otherwise fall back to the cached roster
  // so a failed discovery doesn't leave the run with nothing.
  if (swimmers.length > 0) return swimmers;
  if (cachedCount > 0) {
    console.log(
      color(C.yellow, `  ⚠ ${label} discovery empty — falling back to cached roster`),
    );
    return cached.swimmers;
  }
  return swimmers;
}

/**
 * Dedicated discovery-only run: build a roster cache (full or licensed) in a
 * single long pass and exit without scraping. Used mainly to grow the full
 * roster, which is too large to discover during a normal incremental run.
 *
 * The combo is scrolled until the scrollbar stops advancing AND the loaded
 * item count stops growing — i.e. until we are certain we reached the very
 * last name (see discoverAllSwimmers). The cache is committed so subsequent
 * scrape runs reuse it.
 */
async function runDiscoveryOnly(scope) {
  const isFull = scope === "full";
  const label = isFull ? "full roster" : "roster";
  const cacheFile = isFull ? FULL_ROSTER_FILE : ROSTER_FILE;

  console.log(`\n=== Roster discovery only (${label}) ===`);
  console.log(
    color(
      C.dim,
      `  Scope: "Kun lisensiert" ${isFull ? "OFF (every swimmer ever)" : "ON (current year)"}`,
    ),
  );

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 300_000,
  });
  try {
    const roster = await getRoster(browser, BASE_URL, {
      cacheFile,
      maxAgeMs: 0, // always rediscover in dedicated mode
      force: true,
      kunLisensiert: !isFull,
      label,
      trustRule: isFull ? "growth" : "strict",
      discovery: {
        maxDiscoveryMs: DISCOVERY_ONLY_MAX_MS,
        maxSuffixScrolls: isFull ? 3000 : 500,
      },
    });

    if (roster.length === 0) {
      console.log(color(C.red, `  ✗ ${label} discovery returned no swimmers`));
      return;
    }
    const first = roster[0];
    const last = roster[roster.length - 1];
    console.log(
      color(
        C.green,
        `  ✓ ${label}: ${roster.length} swimmers cached to ${cacheFile}`,
      ),
    );
    console.log(`    first: ${first.text} (id ${first.id})`);
    console.log(`    last:  ${last.text} (id ${last.id})`);

    // Persist the roster for future runs (data-only; [skip ci] stops the
    // Scrape workflow re-triggering on the commit).
    console.log("    Committing roster…");
    gitCheckpoint(`roster discovery: ${label} (${roster.length} swimmers)`);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Compute backfill candidates: full roster − licensed roster − swimmers who
 * already have a data file on disk. Returns up to `limit` candidates sorted
 * by ascending combo index so loadUntilIdx scrolls monotonically across the
 * batch (keeping the combo's incremental batches warm).
 */
function computeBackfillCandidates(full, licensed, existingIds, limit) {
  const licensedIds = new Set(licensed.map((s) => String(s.id)));
  const candidates = [];
  for (const sw of full) {
    const id = String(sw.id);
    if (licensedIds.has(id)) continue;
    if (existingIds.has(id)) continue;
    candidates.push(sw);
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates.slice(0, limit);
}

/**
 * Backfill non-licensed ("old") swimmers after the licensed batch.
 *
 * Runs on a dedicated page with the "Kun lisensiert" checkbox OFF and an
 * empty date range (2000-01-01 → today), so each candidate gets its FULL race
 * history in one pass. Candidates are processed with the normal per-swimmer
 * pipeline (processSwimmer) — stable-id selection, grid parse, PID dedup
 * against an existing file, split extraction — and written under data/swimmers/.
 *
 * Skipped when the run budget is nearly exhausted (a kill mid-backfill would
 * lose unsaved files anyway; candidates stay candidates and are retried later).
 *
 * Returns the number of swimmers saved with new data.
 */

// After navigateAndFilter toggles the "Kun lisensiert" checkbox off, the
// full-roster combo reload is a multi-phase server callback whose in-flight
// gaps can fool navigateAndFilter's wait loop into returning early. On top of
// that, the page fires an INITIAL grid callback for the default swimmer's
// full history (2000→today) that can take ~10s+ to complete. Selecting a
// swimmer while either callback is still in flight races the selection — the
// combo clobbers it, or the grid result gets overwritten by the slow initial
// callback, leaving the grid header-only forever (poll times out as "never
// loaded"). settleComboForBackfill waits until BOTH the combo (its index-1
// item matches the first full-roster swimmer we know from the roster cache)
// and the grid report as idle, twice in a row, before the first selection.
async function settleComboForBackfill(page, firstFullId, timeoutMs = 60_000) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate((id) => {
      try {
        const item = cmbUtover.GetItem(1);
        if (!item || String(item.value) !== String(id)) return false;
        let gridBusy = true;
        try {
          gridBusy = grdRanking.InCallback();
        } catch {
          gridBusy = false;
        }
        if (gridBusy) return false;
        return !cmbUtover.InCallback();
      } catch {
        return false;
      }
    }, firstFullId);
    if (ok) {
      quiet++;
      if (quiet >= 2) return true;
    } else {
      quiet = 0;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.log(
    color(
      C.yellow,
      "  ⇠ backfill — ⚠ page never settled to idle; continuing anyway",
    ),
  );
  return false;
}

/* ─── Backfill (non-licensed swimmers) ──────────────────────────── */

async function runBackfill({ browser, licensedRoster, existingIds, runStart }) {
  if (!BACKFILL_ENABLED) return 0;

  const remainingMs = RUN_BUDGET_MS - (Date.now() - runStart);
  if (remainingMs < BACKFILL_MIN_REMAINING_MS) {
    console.log(
      color(
        C.dim,
        `  ⇠ backfill skipped — only ${Math.round(remainingMs / 60_000)}m of run budget left`,
      ),
    );
    return 0;
  }

  // Load the full (unlicensed-inclusive) roster. This may trigger a slow
  // discovery on a cold cache (data/roster-full.json); on later runs the
  // cache makes it fast. Loading it here — after the licensed batch — means a
  // cold full discovery never delays the licensed swimmers.
  console.log("Loading full roster for backfill…");
  const fullRoster = await getRoster(browser, BASE_URL, {
    cacheFile: FULL_ROSTER_FILE,
    maxAgeMs: FULL_ROSTER_MAX_AGE_MS,
    force: FORCE_FULL_DISCOVERY,
    kunLisensiert: false,
    label: "full roster",
    trustRule: "growth",
    discovery: {
      maxDiscoveryMs: MAX_FULL_DISCOVERY_MS,
      maxSuffixScrolls: MAX_FULL_SUFFIX_SCROLLS,
    },
  });
  if (fullRoster.length === 0) {
    console.log(
      color(C.yellow, `  ⇠ backfill skipped — full roster unavailable`),
    );
    return 0;
  }

  const candidates = computeBackfillCandidates(
    fullRoster,
    licensedRoster,
    existingIds,
    BACKFILL_NEW_PER_RUN,
  );
  if (candidates.length === 0) {
    console.log(
      color(
        C.dim,
        `  ⇠ backfill: no candidates (all non-licensed swimmers already on disk)`,
      ),
    );
    return 0;
  }

  const candidatePool =
    fullRoster.length - licensedRoster.length - existingIds.size;
  console.log(
    color(
      C.dim,
      `  ⇠ backfill: ${Math.max(0, candidatePool)} candidates, trying ${candidates.length}`,
    ),
  );

  let backfillPage = await browser.newPage();
  await backfillPage.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await backfillPage.setViewport({ width: 1400, height: 900 });
  // kunLisensiert:false + empty date range ⇒ full roster and FULL history.
  const backfillFilters = { kunLisensiert: false, fraDato: "", tilDato: "" };
  await navigateAndFilter(backfillPage, BASE_URL, backfillFilters);

  let saved = 0;
  let empty = 0;

  for (let i = 0; i < candidates.length; i++) {
    const sw = candidates[i];
    let attempt = 0;
    while (true) {
      try {
        // The combo can still be mid full-roster reload after a fresh
        // navigateAndFilter (or a reload retry) — wait for it to settle so
        // the selection isn't clobbered by the combo callback.
        const firstFullItem =
          fullRoster.find((x) => x.index === 1) || fullRoster[0];
        if (firstFullItem) {
          await settleComboForBackfill(backfillPage, firstFullItem.id);
        }
        const result = await withTimeout(
          processSwimmer(
            backfillPage,
            sw,
            sw.index,
            {
              SWIMMERS_DIR,
              gridPollTimeoutMs: 20_000,
              skipIfGridNeverLoaded: true,
              processedInSession: i + 1,
            },
            null,
          ),
          BACKFILL_SWIMMER_TIMEOUT_MS,
          `backfill ${sw.text}`,
        );
        if (result?.saved) {
          saved++;
          console.log(
            color(
              C.green,
              `  ⇠ backfill — ✓ ${i}: ${sw.text} — +${result.totalNewRaces} races (${result.totalRaces} total)`,
            ),
          );
        } else if (result?.gridNeverLoaded && attempt < 1) {
          // Grid hiccuped on a full-history load — reload the backfill page
          // (restores full mode) and retry once. If it fails again, the
          // swimmer is left as a candidate for a future run.
          attempt++;
          console.log(
            color(
              C.yellow,
              `  ⇠ backfill — ${sw.text}: grid never loaded, retrying (${attempt})`,
            ),
          );
          backfillPage = await reloadPage(
            backfillPage,
            browser,
            BASE_URL,
            backfillFilters,
          );
          continue;
        } else {
          empty++;
          console.log(
            color(
              C.dim,
              `  ⇠ backfill — ⚠ ${sw.text} — no data / grid never loaded`,
            ),
          );
        }
        break;
      } catch (err) {
        empty++;
        console.log(
          color(
            C.yellow,
            `  ⇠ backfill — ⚠ ${sw.text}: ${(err.message || String(err)).slice(0, 80)}`,
          ),
        );
        // Reload the backfill page (restores full mode) and continue with the
        // next candidate — one reload, no infinite retry loop.
        try {
          backfillPage = await reloadPage(
            backfillPage,
            browser,
            BASE_URL,
            backfillFilters,
          );
        } catch {}
        break;
      }
    }
  }

  try {
    await backfillPage.close();
  } catch {}

  console.log(
    color(C.dim, `  ⇠ backfill done: ${saved} saved, ${empty} empty`),
  );
  return saved;
}

/**
 * Reload the page (navigate back to BASE_URL, re-apply filters).
 * If the page is stuck, creates a fresh one.
 * filterOpts overrides the default licensed incremental filters (e.g. the
 * backfill page needs kunLisensiert:false + full date range on reload).
 */
async function reloadPage(page, browser, baseUrl, filterOpts = {}) {
  try {
    await navigateAndFilter(page, baseUrl, {
      fraDato: FRA_DATO,
      tilDato: TIL_DATO,
      ...filterOpts,
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
      ...filterOpts,
    });
    return newPage;
  }
}

/* ─── Main sequential scrape loop ──────────────────────────────────── */

async function main() {
  // Dedicated discovery-only mode: build a roster cache (full or licensed)
  // and exit without scraping. See DISCOVERY_ONLY env.
  if (DISCOVERY_ONLY === "full" || DISCOVERY_ONLY === "licensed") {
    await runDiscoveryOnly(DISCOVERY_ONLY);
    return;
  }

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

  // ── Discover all swimmers (cached roster when fresh) ────────────
  console.log("Loading swimmer roster…");
  const allSwimmers = await getRoster(browser, BASE_URL);
  console.log(color(C.green, `  ${allSwimmers.length} swimmers in roster`));

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
  //
  // NOTE: on warm runs `allSwimmers` comes from the cached roster, which
  // won't include swimmers added server-side since the roster was built.
  // Those are picked up when the roster refreshes (ROSTER_MAX_AGE_HOURS,
  // default weekly) or on a FORCE_DISCOVERY=1 run. This delays — but never
  // drops — brand-new swimmers, and never affects already-saved data.
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

  // Checkpoint bookkeeping: rebuild index + git push whenever a new save
  // lands OR every CHECKPOINT_EVERY processed swimmers OR every
  // CHECKPOINT_INTERVAL_MS of wall-clock time (whichever comes first), so
  // lastChecked advances — and progress becomes durable — long before the
  // 6h Actions ceiling. A low interval matters because a run can be killed
  // mid-batch; without a recent checkpoint, lastChecked never advances and
  // the next run re-picks the same overdue swimmers, stalling on the front.
  const CHECKPOINT_EVERY = 10;
  const CHECKPOINT_INTERVAL_MS = 10 * 60_000; // 10 minutes
  let lastCheckpointSaved = 0;
  let lastCheckpointProcessed = 0;
  let lastCheckpointAt = Date.now();

  // Global run budget: once exceeded, checkpoint and exit cleanly.
  const runStart = Date.now();

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
            LOOKUP_TIMEOUT_MS,
            `findSwimmerIdx(${sw.text})`,
          );
          if (nameIdx !== null) {
            currentIndex = nameIdx;
            console.log(
              color(C.yellow, `  ${sw.text} — found by name, proceeding...`),
            );
            found = true;
          } else {
            // Name lookup failed. Reload and retry — findSwimmerIdx filters
            // server-side, so no full combo pre-load is needed.
            page = await reloadPage(page, browser, BASE_URL);
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
            LOOKUP_TIMEOUT_MS,
            `loadUntilIdx(${currentIndex})`,
          );

          if (!found) {
            // Index-based lookup failed. Reload, then try name-based lookup
            // (findSwimmerIdx filters server-side — no full pre-load needed).
            page = await reloadPage(page, browser, BASE_URL);
            pageReloaded = true;
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
          SWIMMER_TIMEOUT_MS,
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
            // On the next retry, use name-based lookup (skip stale index)
            useNameLookup = true;
            // Also try immediately — if successful, the next retry uses the
            // fresh index instead of wasting an attempt on stale loadUntilIdx.
            const nameIdx = await withTimeout(
              findSwimmerIdx(page, sw.text),
              LOOKUP_TIMEOUT_MS,
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

    // Checkpoint on a save boundary, every CHECKPOINT_EVERY processed
    // swimmers, OR every CHECKPOINT_INTERVAL_MS. Most checks find no new
    // races (no save), so a save-only checkpoint would never advance
    // lastChecked for those swimmers — a kill between saves would re-pick
    // them next run and the batch would stall on the same front block.
    const saveBoundary = saved > 0 && saved - lastCheckpointSaved >= 10;
    const processedBoundary =
      processed - lastCheckpointProcessed >= CHECKPOINT_EVERY;
    const timeBoundary =
      Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS;
    if (saveBoundary || processedBoundary || timeBoundary) {
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
        processedIds,
      });
      gitCheckpoint(`${saved} saved / ${processed} checked`);
      console.log(
        color(C.dim, `  Checkpoint: ${saved} saved, ${processed} checked`),
      );
      lastCheckpointSaved = saved;
      lastCheckpointProcessed = processed;
      lastCheckpointAt = Date.now();
    }

    // Global run budget: stop cleanly before Actions force-kills the job so
    // the just-written checkpoint (and lastChecked) survives and the batch
    // rotates on the next run instead of re-processing the same front block.
    if (Date.now() - runStart >= RUN_BUDGET_MS) {
      console.log(
        color(
          C.red,
          `  ✗ Run budget (${Math.round(RUN_BUDGET_MS / 60_000)}m) reached — checkpointing and exiting`,
        ),
      );
      rebuildIndex({
        swimmersDir: SWIMMERS_DIR,
        dataDir: DATA_DIR,
        indexFile: INDEX_FILE,
        baseUrl: BASE_URL,
        processedIds,
      });
      gitCheckpoint(`partial — run budget reached (${processed} checked)`);
      await browser.close().catch(() => {});
      process.exit(0);
    }

    // Log progress every 50 swimmers
    if (processed % 50 === 0) {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(color(C.dim, `  Progress: ${processed}/${total} (${pct}%)`));
    }
  }

  // ── Backfill non-licensed swimmers (after the licensed batch) ──
  // Adds old swimmers' full history a few at a time. Runs after the licensed
  // loop so it never delays or interrupts the regular incremental batch.
  const backfillSaved = await runBackfill({
    browser,
    licensedRoster: allSwimmers,
    existingIds: new Set(existingDataMap.keys()),
    runStart,
  });
  saved += backfillSaved;

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

// Only auto-run when invoked directly (`node index.js`). When imported (e.g. a
// test importing getRoster/discoverAllSwimmers/computeBackfillCandidates),
// main() must NOT start a scrape.
import { fileURLToPath } from "url";
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("\n✗ Fatal error:", err);
    process.exit(1);
  });
}

export {
  discoverAllSwimmers,
  getRoster,
  computeBackfillCandidates,
  runBackfill,
  runDiscoveryOnly,
};
