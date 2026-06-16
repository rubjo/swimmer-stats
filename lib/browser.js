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
    dtFraDato.SetDate(new Date(2000, 0, 1));
    chkKunForste.SetChecked(false);
    chkIkkeVisDeldistaner.SetChecked(false);
    chkIkkeVisForsteetapper.SetChecked(false);
  });
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
 * DevExpress virtual-scroll callback mode loads items in batches of 100.
 * Jumping the scroll DIV to `scrollHeight` triggers a callback for the
 * NEXT batch.  Each jump grows `scrollHeight` as more items are loaded.
 *
 * This function opens the dropdown, then repeatedly jumps to the bottom
 * (triggering sequential batch loading) until the target item is found
 * or no more items can be loaded (scrollHeight stops growing).
 *
 * Returns true once the item is found (and closes the dropdown), false
 * if all items were loaded but the index does not exist.
 */
/**
 * Load combo batches until the item at `idx` is available.
 *
 * Opens the dropdown and jumps to scrollHeight repeatedly to trigger
 * DevExpress virtual-scroll batch loading.  After each jump, polls
 * inside the browser (via setTimeout) for up to 8 s until the item
 * appears or the item count grows, adapting to actual server speed.
 */
export async function loadUntilIdx(page, idx, maxJumps = 60) {
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
      // Reset scroll to top so we load from the beginning
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
    } catch {}
  });
  await sleep(400);

  let prevCount = -1;
  for (let s = 0; s < maxJumps; s++) {
    // Scroll, then poll for up to 8 s for the item or count growth.
    // All inside a single evaluate so there is no CDP roundtrip gap.
    const result = await page.evaluate(async (targetIdx) => {
      // Helper: is the item loaded?
      const itemReady = () => {
        try {
          return cmbUtover.GetItem(targetIdx) != null;
        } catch {
          return false;
        }
      };
      if (itemReady()) return { found: true };

      const startCount = cmbUtover.GetItemCount();

      // Jump to bottom
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (!d) return { found: false, reason: "no scroll div" };
      const prevScroll = d.scrollTop;
      d.scrollTop = d.scrollHeight;
      if (d.scrollTop <= prevScroll) {
        // Already at bottom — poll for up to 8 s for a pending
        // callback to complete and load this batch.
        for (let p = 0; p < 16; p++) {
          await new Promise((r) => setTimeout(r, 500));
          if (itemReady()) return { found: true };
          if (cmbUtover.GetItemCount() > startCount) {
            // Count grew but item not yet loaded — the callback
            // loaded a different batch.  Signal to try again.
            return {
              found: false,
              grew: true,
              count: cmbUtover.GetItemCount(),
            };
          }
        }
        return { found: false, grew: false, count: startCount };
      }

      // Scrolled — poll for up to 8 s for the item or count to grow
      for (let p = 0; p < 16; p++) {
        await new Promise((r) => setTimeout(r, 500));
        if (itemReady()) return { found: true };
        if (cmbUtover.GetItemCount() > startCount) {
          return { found: false, grew: true, count: cmbUtover.GetItemCount() };
        }
      }
      return { found: false, grew: true, count: cmbUtover.GetItemCount() };
    }, idx);

    if (result.found) {
      await page.evaluate(() => {
        try {
          cmbUtover.HideDropDown();
        } catch {}
      });
      await sleep(300);
      return true;
    }

    if (result.grew && result.count !== undefined) {
      prevCount = result.count;
      continue; // more items loaded — jump again
    }

    if (result.count !== undefined && result.count <= prevCount) {
      break; // no progress — item doesn't exist
    }
    prevCount = result.count !== undefined ? result.count : prevCount;
  }

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
 * Uses the same jump-to-bottom + inline-polling strategy as loadUntilIdx.
 * Scans all currently loaded items, then loads more batches until the
 * name is found or no more items exist.
 *
 * Returns the 0-based combo index, or null if the name was not found.
 */
export async function findSwimmerIdx(page, name, maxJumps = 60) {
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

  let prevCount = -1;
  for (let s = 0; s < maxJumps; s++) {
    // Scroll + scan + poll in one evaluate to avoid CDP gaps.
    const result = await page.evaluate(async (targetName) => {
      // Helper: scan all currently loaded items for the target
      const scan = () => {
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
        return null;
      };

      let hit = scan();
      if (hit) return hit;

      const startCount = cmbUtover.GetItemCount();

      // Jump to bottom
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (!d) return { found: false, reason: "no scroll div" };
      const prevScroll = d.scrollTop;
      d.scrollTop = d.scrollHeight;
      if (d.scrollTop <= prevScroll) {
        // Already at bottom — poll for pending callback
        for (let p = 0; p < 16; p++) {
          await new Promise((r) => setTimeout(r, 500));
          hit = scan();
          if (hit) return hit;
          if (cmbUtover.GetItemCount() > startCount) {
            return {
              found: false,
              grew: true,
              count: cmbUtover.GetItemCount(),
            };
          }
        }
        return { found: false, grew: false, count: startCount };
      }

      // Scrolled — poll for up to 8 s
      for (let p = 0; p < 16; p++) {
        await new Promise((r) => setTimeout(r, 500));
        hit = scan();
        if (hit) return hit;
        if (cmbUtover.GetItemCount() > startCount) {
          return { found: false, grew: true, count: cmbUtover.GetItemCount() };
        }
      }
      return { found: false, grew: true, count: cmbUtover.GetItemCount() };
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

    if (result.grew && result.count !== undefined) {
      prevCount = result.count;
      continue;
    }

    if (result.count !== undefined && result.count <= prevCount) break;
    prevCount = result.count !== undefined ? result.count : prevCount;
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
export async function extractSplits(
  page,
  csvRaces,
  { log = () => {}, onlyRows, onProgress } = {},
) {
  const CONCURRENCY = 10;
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
            if (!res.ok) return { vi }; // leave splits undefined — preserve prior data
            const html = await res.text();
            const dom = new DOMParser().parseFromString(html, "text/html");
            const table = dom.getElementById("grdMellomtider_DXMainTable");
            if (!table) return { vi, splits: [] };
            const rows = table.querySelectorAll("tr.dxgvDataRow_PlasticBlue");
            const splits = Array.from(rows).map((row) => {
              const cells = row.querySelectorAll("td");
              return cells[2]?.textContent?.trim() || "";
            });
            return { vi, splits };
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
