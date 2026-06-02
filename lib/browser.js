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
      if (cells.length < cols.length) continue;

      const race = {};
      for (let ci = 0; ci < cols.length; ci++) {
        race[cols[ci]] = cells[ci]?.textContent.trim() || "";
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
 * Expand grid rows for races ≥100 m and extract
 * split/intermediate times from the sub-grid. Short races are skipped
 * entirely — no detail expansion, no Stevne extraction.
 */
export async function extractSplits(
  page,
  csvRaces,
  { log = () => {}, expandDelay = 10_000, onlyRows } = {},
) {
  let consecutiveNotReady = 0;
  let timeouts = 0;

  for (let vi = 0; vi < csvRaces.length; vi++) {
    const race = csvRaces[vi];
    if (!race) continue;
    if (!hasPotentialSplits(race.Distanse)) continue;
    if (onlyRows && !onlyRows.has(vi)) continue;

    try {
      await page.evaluate((idx) => {
        ASPx.GVShowDetailRow("grdRanking", idx, { cancelBubble: true });
      }, vi);

      // Poll for the split table to appear instead of a fixed sleep
      const detailReady = await pollFor(
        page,
        (idx) => {
          const detailRow = grdRanking?.GetDetailRow(idx);
          if (!detailRow) return false;
          return (
            detailRow.querySelector("#grdMellomtider_DXMainTable") !== null
          );
        },
        { interval: 200, timeout: expandDelay },
        vi,
      );

      if (!detailReady) {
        // Check if the detail row actually exists — if so, the race
        // genuinely has no split data. Mark it so we don't retry.
        const detailExists = await page.evaluate((idx) => {
          return grdRanking?.GetDetailRow(idx) !== null;
        }, vi);
        if (detailExists) {
          // Collapse the detail row so the grid is in a clean state
          // for the next iteration. Leaving it open can cause subsequent
          // GVShowDetailRow calls to hang in some DevExpress versions.
          await page.evaluate((idx) => {
            ASPx.GVHideDetailRow("grdRanking", idx, { cancelBubble: true });
          }, vi);
          race.splits = [];
          consecutiveNotReady = 0;
        } else {
          log(`    ⚠ split table not ready for row ${vi}`);
          consecutiveNotReady++;
          if (consecutiveNotReady >= 10) {
            log(`    ⚠ bailing (${consecutiveNotReady} consecutive not-ready)`);
            break;
          }
        }
        continue;
      }
      consecutiveNotReady = 0;

      // Small buffer so the split data rows render before we extract
      await sleep(300);

      // Extract segment times from the split sub-grid
      const splits = await page.evaluate((idx) => {
        const detailRow = grdRanking?.GetDetailRow(idx);
        if (!detailRow) return null;
        const splitTable = detailRow.querySelector(
          "#grdMellomtider_DXMainTable",
        );
        if (!splitTable) return null;
        const rows = splitTable.querySelectorAll("tr.dxgvDataRow_PlasticBlue");
        return Array.from(rows)
          .map((sr) => {
            const cells = sr.querySelectorAll("td");
            return cells[2]?.textContent?.trim() || "";
          })
          .filter((s) => s !== "");
      }, vi);

      if (splits && splits.length > 0) {
        race.splits = splits;
      }
      consecutiveNotReady = 0;
      timeouts = 0;
    } catch (err) {
      const msg = err.message || String(err);
      log(`    ⚠ split extraction failed for row ${vi}: ${msg.slice(0, 80)}`);
      timeouts++;
      if (timeouts >= 3) {
        log(`    ⚠ bailing (${timeouts} consecutive timeouts)`);
        break;
      }
    }
  }
}
