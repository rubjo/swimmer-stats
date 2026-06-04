/**
 * Browser/page interaction functions for medley.no.
 */

import fs from "fs";
import path from "path";

/* ─── Timing helpers ─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (range) => Math.random() * range;

/**
 * Poll a condition function in the page every `interval` ms until it
 * returns a truthy value or `timeout` ms elapses. Returns the truthy
 * result or null.
 */
export async function pollFor(
  page,
  condition,
  { interval = 200, timeout = 15_000 } = {},
  ...args
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await page.evaluate(condition, ...args);
      if (result !== undefined && result !== null && result !== false)
        return result;
    } catch {}
    await sleep(interval);
  }
  return null;
}

/* ─── Download ───────────────────────────────────────────────────── */

async function waitForDownload(dir, timeoutMs) {
  const start = Date.now();
  const seen = new Set(fs.readdirSync(dir));
  while (Date.now() - start < timeoutMs) {
    const now = fs.readdirSync(dir);
    const newFiles = now.filter((f) => !seen.has(f) && f.endsWith(".csv"));
    if (newFiles.length > 0) {
      const fp = path.join(dir, newFiles[0]);
      for (let tries = 0; tries < 10; tries++) {
        const size1 = fs.statSync(fp).size;
        await sleep(200);
        const size2 = fs.statSync(fp).size;
        if (size1 === size2 && size1 > 0) return fp;
      }
      return fp;
    }
    await sleep(200);
  }
  return null;
}

/**
 * Click the CSV export button and return the downloaded text.
 * Uses CDP-based download to a temp directory because response.text()
 * fails for attachment downloads in Puppeteer.
 */
export async function exportCSV(page, dlDir, exportTimeout) {
  for (const f of fs.readdirSync(dlDir)) fs.unlinkSync(path.join(dlDir, f));
  await page.evaluate(() =>
    document.getElementById("mnuEksport_DXI2_Img")?.click(),
  );
  const fp = await waitForDownload(dlDir, exportTimeout);
  if (!fp) return null;
  const buf = fs.readFileSync(fp);
  fs.unlinkSync(fp);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.toString("utf-8");
  return buf.toString("latin1");
}

/* ─── Page info ──────────────────────────────────────────────────── */

export async function getSwimmerInfo(page) {
  return page.evaluate(() => {
    const nameEl = document.getElementById("lblNavn");
    const clubEl = document.getElementById("lblKlubb");
    const årEl = document.getElementById("lblFodeaar");
    const birthMatch = årEl ? årEl.textContent.trim().match(/\d{4}/) : null;
    return {
      name: nameEl ? nameEl.textContent.trim() : null,
      club: clubEl ? clubEl.textContent.trim() : null,
      birthYear: birthMatch ? parseInt(birthMatch[0], 10) : null,
    };
  });
}

/**
 * Fetch gender for the currently selected swimmer by reading the
 * first race's resultat.aspx page and scanning the event title
 * for gender keywords (herrer/menn/gutter → male; damer/jenter/kvinner → female).
 * Returns "male", "female", or null if undetermined.
 */
export async function fetchGender(page) {
  const pid = await page.evaluate(() => {
    const firstLink = document.querySelector(
      "#grdRanking_DXMainTable .dxgvDataRow_PlasticBlue td a",
    );
    if (!firstLink) return null;
    const href = firstLink.getAttribute("href");
    if (!href) return null;
    const m = href.match(/pid=(\d+)/);
    return m ? m[1] : null;
  });
  if (!pid) return null;

  const html = await page.evaluate(async (pid) => {
    try {
      const res = await fetch(`https://www.medley.no/resultat.aspx?pid=${pid}`);
      const html = await res.text();
      // Parse with DOMParser so CSS class names (e.g. "dxm-gutter") don't
      // trigger false gender matches. Only visible text is scanned.
      const dom = new DOMParser().parseFromString(html, "text/html");
      return dom.body?.innerText || null;
    } catch {
      return null;
    }
  }, pid);
  if (!html) return null;

  const lower = html.toLowerCase();
  if (/\b(herrer|menn|gutter)\b/.test(lower)) return "male";
  if (/\b(damer|jenter|kvinner)\b/.test(lower)) return "female";
  return null;
}

export async function readPoengtype(page) {
  return page.evaluate(() => {
    try {
      return cmbPoengtype.GetText() || null;
    } catch {
      return null;
    }
  });
}

/* ─── Swimmer selection ──────────────────────────────────────────── */

export async function selectSwimmer(page, comboBoxIndex) {
  await page.evaluate((idx) => {
    cmbUtover.SetSelectedIndex(idx);
    ASPx.CBLBSelectedIndexChanged("cmbUtover");
  }, comboBoxIndex);
}

/* ─── Batch loading ──────────────────────────────────────────────── */

/**
 * Scroll the swimmer dropdown to trigger the virtual-scroll callback
 * that loads the next batch of items.
 * Returns the new item count, or the previous count if nothing changed.
 */
export async function loadNextBatch(page) {
  await page.evaluate(() => cmbUtover.ShowDropDown());
  await sleep(600);

  const prevCount = await page.evaluate(() => cmbUtover.GetItemCount());

  await page.evaluate(async () => {
    const scrollDiv = cmbUtover.GetListBoxScrollDivElement();
    if (scrollDiv) scrollDiv.scrollTop = scrollDiv.scrollHeight;
    await new Promise((r) => setTimeout(r, 2_000));
  });

  const newCount = await page.evaluate(() => cmbUtover.GetItemCount());

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(300);

  return newCount > prevCount ? newCount : prevCount;
}

/* ─── Navigation & filter setup ──────────────────────────────────── */

export async function navigateAndFilter(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle0", timeout: 30_000 });
  await sleep(2_000);

  // Cookie acceptance
  try {
    const [btn] = await page.$x('//button[contains(text(),"Jeg forstår")]');
    if (btn) {
      await btn.click();
      await sleep(500);
    }
  } catch {}

  // Configure filters
  await page.evaluate(() => {
    ctl00_ctl00_Content_MainContent_chkKunLisensiert.SetChecked(true);
    dtFraDato.SetDate(new Date(2010, 0, 1));
    chkKunForste.SetChecked(false);
    chkIkkeVisDeldistaner.SetChecked(true);
    chkIkkeVisForsteetapper.SetChecked(true);
  });
  await sleep(2_000);
}

/* ─── Grid DOM parsing (fallback when CSV fails) ───────────────── */

/**
 * Parse the grid table directly from the DOM as a fallback when the CSV
 * export fails. Returns an array of race objects with the same shape as
 * parseCSV(), or null if the grid has no data rows.
 */
export async function parseGridFromDOM(page) {
  return page.evaluate(() => {
    const table = document.getElementById("grdRanking_DXMainTable");
    if (!table) return null;

    const rows = table.querySelectorAll(".dxgvDataRow_PlasticBlue");
    if (!rows || rows.length === 0) return null;

    // Known column names in display order
    const cols = [
      "Nr",
      "Distanse",
      "Tid",
      "Poeng",
      "Dato",
      "Sted",
      "Basseng",
      "D",
      "RK",
      "RA",
    ];

    const races = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      // First cell is the detail-row expand button. The data columns
      // start at index 1. Minimum cells = 1 (button) + 10 (data).
      if (cells.length < cols.length + 1) continue;

      const race = {};
      for (let ci = 0; ci < cols.length; ci++) {
        race[cols[ci]] = cells[ci + 1]?.textContent.trim() || "";
      }

      // Extract the race PID from the time link (resultat.aspx?pid=X).
      // The Tid column is at cells[3] (index 2 in cols, shifted by 1).
      const tidLink = cells[3]?.querySelector("a");
      if (tidLink) {
        const m = tidLink.getAttribute("href")?.match(/pid=(\d+)/);
        if (m) race.pid = m[1];
      }

      // Nr should be numeric; skip summary / footer rows
      if (!race.Nr || isNaN(parseInt(race.Nr, 10))) continue;

      races.push(race);
    }

    return races.length > 0 ? races : null;
  });
}

/* ─── Detail-row extraction ──────────────────────────────────────── */

/** Return true when a race is long enough (≥100 m) to plausibly have split times. */
export function hasPotentialSplits(distanse) {
  const dMatch = distanse?.match(/^(\d+)m/);
  if (!dMatch) return false;
  return parseInt(dMatch[1], 10) >= 100;
}

/**
 * Fetch split/intermediate times for races ≥100 m by loading each race's
 * resultat.aspx page directly via fetch() + DOMParser, rather than
 * expanding DevExpress detail rows one-by-one.
 *
 * Races are processed in concurrent batches (CONCURRENCY=5) with a small
 * inter-batch delay to avoid hammering the server. Short races (<100 m)
 * are skipped entirely.
 *
 * Each race must have a `.pid` property (extracted from the grid link by
 * parseGridFromDOM). Splits are assigned to `race.splits` in-place.
 */
export async function extractSplits(
  page,
  csvRaces,
  { log = () => {}, onlyRows, onProgress } = {},
) {
  const CONCURRENCY = 5;
  const BATCH_DELAY = 500;

  // Collect eligible races with PIDs
  const eligible = [];
  for (let vi = 0; vi < csvRaces.length; vi++) {
    const race = csvRaces[vi];
    if (!race) continue;
    if (!hasPotentialSplits(race.Distanse)) continue;
    if (onlyRows && !onlyRows.has(vi)) continue;
    if (!race.pid) {
      log(`row ${vi} has no PID — skipping`);
      continue;
    }
    eligible.push({ vi, pid: race.pid });
  }

  const eligibleTotal = eligible.length;
  let splitsFound = 0;
  const progressStart = Date.now();

  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);

    // Fetch all result pages in this batch concurrently via a single
    // page.evaluate call. The browser handles parallel HTTP requests
    // (typically 6–10 connections per domain), and DOMParser strips
    // non-visible markup so CSS class names don't interfere.
    const results = await page.evaluate(async (batch) => {
      const results = await Promise.all(
        batch.map(async ({ vi, pid }) => {
          try {
            const res = await fetch(`/resultat.aspx?pid=${pid}`);
            if (!res.ok) return { vi, splits: [] };
            const html = await res.text();
            const dom = new DOMParser().parseFromString(html, "text/html");
            const table = dom.getElementById("grdMellomtider_DXMainTable");
            if (!table) return { vi, splits: [] };
            const rows = table.querySelectorAll("tr.dxgvDataRow_PlasticBlue");
            const splits = Array.from(rows)
              .map((row) => {
                const cells = row.querySelectorAll("td");
                return cells[2]?.textContent?.trim() || "";
              });
            return { vi, splits };
          } catch {
            return { vi, splits: [] };
          }
        }),
      );
      return results;
    }, batch);

    for (const r of results) {
      csvRaces[r.vi].splits = r.splits;
      if (r.splits.length > 0) splitsFound++;
    }

    const elapsed = Math.round((Date.now() - progressStart) / 1000);
    const done = Math.min(i + CONCURRENCY, eligible.length);
    log(
      `${done}/${eligibleTotal} — ${splitsFound} rows with splits (${elapsed}s)`,
    );

    // Persist progress after each batch (e.g., saveProgress in the caller)
    if (onProgress) await onProgress();

    // Be kind to the server — short pause between batches
    if (i + CONCURRENCY < eligible.length) {
      await sleep(BATCH_DELAY);
    }
  }

  const totalElapsed = Math.round((Date.now() - progressStart) / 1000);
  const withSplits = eligible.filter(
    (e) => csvRaces[e.vi].splits && csvRaces[e.vi].splits.length > 0,
  ).length;
  log(
    `done — ${withSplits}/${eligibleTotal} rows with splits (${totalElapsed}s)`,
  );
}
