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
      return await res.text();
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
  { log = () => {}, expandDelay = 5_000, onlyRows, onProgress } = {},
) {
  let consecutiveNotReady = 0;

  // Count eligible rows ahead of time for progress reporting
  const eligibleTotal = csvRaces.filter((r, i) => {
    if (!r) return false;
    if (!hasPotentialSplits(r.Distanse)) return false;
    if (onlyRows && !onlyRows.has(i)) return false;
    return true;
  }).length;

  let eligibleProcessed = 0;
  let splitsFound = 0;
  const progressStart = Date.now();

  for (let vi = 0; vi < csvRaces.length; vi++) {
    const race = csvRaces[vi];
    if (!race) continue;
    if (!hasPotentialSplits(race.Distanse)) continue;
    if (onlyRows && !onlyRows.has(vi)) continue;

    eligibleProcessed++;

    // Log progress and persist every 5 eligible rows
    if (eligibleProcessed % 5 === 0) {
      const elapsed = Math.round((Date.now() - progressStart) / 1000);
      log(
        `row ${eligibleProcessed}/${eligibleTotal} — ${splitsFound} splits found (${elapsed}s)`,
      );
      if (onProgress) await onProgress();
    }

    // Small delay to let DevExpress finish processing the
    // previous row's collapse before we expand the next one.
    await sleep(150);

    try {
      // Scroll the row into view, then use the DevExpress API to
      // expand the detail row.  Button .click() is a no-op in this
      // DevExpress version — the documented API is GVShowDetailRow
      // / GVHideDetailRow (see AGENTS.md).
      await page.evaluate((idx) => {
        const row = grdRanking?.GetRow(idx);
        if (row) row.scrollIntoView({ block: "nearest" });
        ASPx.GVShowDetailRow("grdRanking", idx, { cancelBubble: true });
      }, vi);

      // Poll for the split table to appear. The DevExpress callback
      // is async (AJAX to the server), so we wait for the detail row
      // to be populated with the sub-grid.
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
        // When pollFor fails (5s expandDelay), the page JS thread may
        // be stuck from a previous DevExpress callback. Any further
        // page.evaluate calls would each hang for the full protocolTimeout
        // (60s). Use short-circuit timeouts to detect this early and bail.
        const detailExists = await Promise.race([
          page.evaluate((idx) => grdRanking?.GetDetailRow(idx) !== null, vi),
          new Promise((r) => setTimeout(() => r("__STUCK__"), 5_000)),
        ]);
        if (detailExists === "__STUCK__") {
          log(
            `    ⚠ page JS thread stuck (GVShowDetailRow never responded) — bailing`,
          );
          break;
        }
        if (detailExists) {
          // Row has no split data — collapse and mark as done
          await Promise.race([
            page.evaluate((idx) => {
              ASPx.GVHideDetailRow("grdRanking", idx, { cancelBubble: true });
            }, vi),
            new Promise((r) => setTimeout(() => r("__STUCK__"), 5_000)),
          ]);
          race.splits = [];
          consecutiveNotReady = 0;
        } else {
          // Detail row doesn't exist at all — likely a rendering issue
          const diag = await Promise.race([
            page.evaluate((idx) => {
              const row = grdRanking?.GetRow(idx);
              const rowHtml = row
                ? row.outerHTML.slice(0, 300).replace(/\s+/g, " ")
                : "null";
              return {
                hasRow: row !== null && row !== undefined,
                rowSnippet: rowHtml,
                dataRows: document.querySelectorAll(
                  "#grdRanking_DXMainTable .dxgvDataRow_PlasticBlue",
                ).length,
              };
            }, vi),
            new Promise((r) => setTimeout(() => r("__STUCK__"), 5_000)),
          ]);
          if (diag === "__STUCK__") {
            log(
              `    ⚠ page JS thread stuck (detail row diagnostics) — bailing`,
            );
            break;
          }
          log(
            `    ⚠ split table not ready for row ${vi}` +
              ` (${diag.dataRows} data rows,` +
              ` rowExists=${diag.hasRow})` +
              ` row: ${diag.rowSnippet.slice(0, 200)}`,
          );
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
      await sleep(150);

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
        splitsFound++;
      }

      // Collapse via the DevExpress API
      await page.evaluate((idx) => {
        ASPx.GVHideDetailRow("grdRanking", idx, { cancelBubble: true });
      }, vi);

      consecutiveNotReady = 0;
    } catch (err) {
      const msg = err.message || String(err);
      log(`    ⚠ split extraction failed for row ${vi}: ${msg.slice(0, 80)}`);
      // A protocol timeout means the page JS thread is stuck — retrying
      // won't help. Bail the entire extraction loop immediately rather than
      // wasting more time on the remaining rows.
      if (
        msg.includes("Runtime.callFunctionOn timed out") ||
        msg.includes("protocolTimeout") ||
        msg.includes("Protocol error")
      ) {
        log(`    ⚠ bailing — protocol timeout means page is stuck`);
        break;
      }
    }
  }

  const totalElapsed = Math.round((Date.now() - progressStart) / 1000);
  log(
    `done — ${splitsFound}/${eligibleProcessed} rows with splits (${totalElapsed}s)`,
  );
}
