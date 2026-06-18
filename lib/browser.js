/**
 * Browser/page interaction and combo-box navigation for medley.no.
 */

/* ─── Timing helpers ─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      return dom.body?.textContent || null;
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

/* ─── Swimmer selection ──────────────────────────────────────────── */

export async function selectSwimmer(page, comboBoxIndex) {
  await page.evaluate((idx) => {
    cmbUtover.SetSelectedIndex(idx);
    ASPx.CBLBSelectedIndexChanged("cmbUtover");
  }, comboBoxIndex);
}

/* ─── Navigation & filter setup ──────────────────────────────────── */

/**
 * Navigate to the Medley swimmer page and apply filters:
 * - KUN lisensiert 2026 (licensed swimmers)
 * - From date: 2000-01-01
 * - Ikke vis deldistanser (hide split-distance rows)
 * - Ikke vis førsteetapper (hide first-leg rows)
 * - Vis kun første resultat: OFF
 */

export async function navigateAndFilter(page, baseUrl, opts = {}) {
  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60_000 });
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
  const { fraDato, tilDato } = opts;
  await page.evaluate(
    ({ fd, td }) => {
      ctl00_ctl00_Content_MainContent_chkKunLisensiert.SetChecked(true);

      // Parse fraDato (YYYY-MM-DD) — default 2000-01-01
      if (fd) {
        const [fy, fm, fd2] = fd.split("-").map(Number);
        dtFraDato.SetDate(new Date(fy, fm - 1, fd2));
      } else {
        dtFraDato.SetDate(new Date(2000, 0, 1));
      }

      // Parse tilDato if provided (default = website's today)
      if (td) {
        const [ty, tm, td2] = td.split("-").map(Number);
        dtTilDato.SetDate(new Date(ty, tm - 1, td2));
      }

      chkKunForste.SetChecked(false);
      chkIkkeVisDeldistaner.SetChecked(false);
      chkIkkeVisForsteetapper.SetChecked(false);
    },
    { fd: fraDato, td: tilDato },
  );
  await sleep(2_000);
}

/* ─── Grid DOM parsing ─────────────────────────────────────────── */

/**
 * Parse the race-results grid table directly from the DOM.
 * Returns an array of race objects, or null if the grid has no data rows.
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

/* ─── Combo-box navigation (virtual-scroll) ───────────────────── */

/**
 * Load combo batches until the item at `idx` is available in the client
 * data store (cmbUtover.GetItem(idx) !== null).
 *
 * Uses incremental scrolling (one viewport at a time) to trigger
 * DevExpress virtual-scroll batch loading.  Each scroll advances the
 * cursor by one batch (~100 items).  Jumping directly to scrollHeight
 * would teleport to the end of the list and load items near the end,
 * skipping sequential batches in the middle — incremental scrolling
 * avoids this and reliably loads items in order.
 *
 * Each page.evaluate call is short (~2.5 s) so a timeout on this
 * function won't leave the CDP session blocked by a long-running
 * evaluate.
 *
 * Returns true once the item is found (and closes the dropdown), false
 * if all items were loaded but the index does not exist.
 */
export async function loadUntilIdx(page, idx, maxScrolls = 200) {
  // Close any previous dropdown state to reset scroll position.
  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(100);
  await page.evaluate(() => {
    try {
      cmbUtover.ShowDropDown();
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
    } catch {}
  });
  await sleep(400);

  for (let s = 0; s < maxScrolls; s++) {
    // Check if the target item is already loaded (fast evaluate)
    const ready = await page.evaluate((i) => {
      try {
        return cmbUtover.GetItem(i) != null;
      } catch {
        return false;
      }
    }, idx);
    if (ready) {
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
      if (d.scrollTop <= prev) return true;
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

/**
 * Find the combo-box index of a swimmer by name.
 *
 * Uses the same incremental-scrolling strategy as loadUntilIdx.
 * Scans all currently loaded items, then scrolls by one viewport
 * at a time to load the next batch until the name is found or no
 * more items exist.
 *
 * Returns the 0-based combo index, or null if the name was not found.
 */
export async function findSwimmerIdx(page, name, maxScrolls = 200) {
  const target = name.trim();
  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(100);
  await page.evaluate(() => {
    try {
      cmbUtover.ShowDropDown();
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
    } catch {}
  });
  await sleep(400);

  for (let s = 0; s < maxScrolls; s++) {
    // Scan all currently loaded items for the target
    const result = await page.evaluate((targetName) => {
      try {
        const total = cmbUtover.GetItemCount();
        for (let i = 0; i < total; i++) {
          const item = cmbUtover.GetItem(i);
          if (!item) break;
          if (item.text && item.text.trim() === targetName) {
            return { found: true, idx: i };
          }
        }
      } catch {}
      return { found: false };
    }, target);

    if (result.found) {
      await page.evaluate(() => {
        try {
          cmbUtover.HideDropDown();
        } catch {}
      });
      await sleep(300);
      return result.idx;
    }

    // Scroll down by one viewport to trigger the next batch
    const atBottom = await page.evaluate(async () => {
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (!d) return true;
      const prev = d.scrollTop;
      d.scrollTop = d.scrollTop + d.clientHeight;
      if (d.scrollTop <= prev) return true;
      await new Promise((r) => setTimeout(r, 2_000));
      return false;
    });

    if (atBottom) break;
  }

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(300);
  return null;
}

/* ─── Split extraction ─────────────────────────────────────────── */

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
export async function extractSplits(page, csvRaces, { log = () => {} } = {}) {
  const CONCURRENCY = 10;
  const BATCH_DELAY = 500;

  // Collect eligible races with PIDs.
  // D-rows (".D === "D"") are always included so their `partOf` field
  // can be extracted, even when the race distance is <100 m.
  const eligible = [];
  for (let vi = 0; vi < csvRaces.length; vi++) {
    const race = csvRaces[vi];
    if (!race) continue;
    const isLong = hasPotentialSplits(race.Distanse);
    const isD = race.D === "D";
    if (!isLong && !isD) continue;
    if (!race.pid) {
      log(`row ${vi} has no PID — skipping`);
      continue;
    }
    eligible.push({ vi, pid: race.pid, isD, isLong });
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
        batch.map(async ({ vi, pid, isD, isLong }) => {
          try {
            const res = await fetch(`/resultat.aspx?pid=${pid}`);
            if (!res.ok) return { vi }; // leave splits undefined — preserve prior data
            const html = await res.text();
            const dom = new DOMParser().parseFromString(html, "text/html");

            // For D-rows, extract the parent race discipline from the
            // result page title (e.g. "Resultat - Name - 1500m Fri").
            let partOf;
            if (isD) {
              const title = dom.querySelector("title")?.textContent || "";
              partOf = title.split(" - ").pop()?.trim() || "";
            }

            // Short D-rows (<100 m) only need partOf — no split extraction
            if (!isLong) {
              return { vi, splits: [], partOf };
            }

            const table = dom.getElementById("grdMellomtider_DXMainTable");
            if (!table) return { vi, splits: [], partOf };
            const rows = table.querySelectorAll("tr.dxgvDataRow_PlasticBlue");
            let splits = Array.from(rows).map((row) => {
              const cells = row.querySelectorAll("td");
              return cells[2]?.textContent?.trim() || "";
            });

            // D-rows are intermediate splits within a longer race. Keep
            // only the first 2 segment times (the 50m with the dive, and
            // the following 50m). The full split list lives on the parent.
            if (isD && splits.length > 2) {
              splits = splits.slice(0, 2);
            }

            return { vi, splits, partOf };
          } catch {
            return { vi }; // leave splits undefined — preserve prior data
          }
        }),
      );
      return results;
    }, batch);

    for (const r of results) {
      if (r.splits !== undefined) {
        csvRaces[r.vi].splits = r.splits;
        if (r.splits.length > 0) splitsFound++;
      }
      // When r.splits is undefined (fetch failure), keep whatever was on
      // race.splits (from a previous successful scrape) — do NOT overwrite.
      if (r.partOf) {
        csvRaces[r.vi].partOf = r.partOf;
      }
    }

    const elapsed = Math.round((Date.now() - progressStart) / 1000);
    const done = Math.min(i + CONCURRENCY, eligible.length);
    log(
      `${done}/${eligibleTotal} — ${splitsFound} rows with splits (${elapsed}s)`,
    );

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
