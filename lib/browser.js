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
 * Fetch gender for the currently selected swimmer by reading race
 * resultat.aspx pages and scanning the Øvelse (Event) field for
 * gender keywords.
 *
 * Tries up to 5 race PIDs because some meets use English event names
 * ("Men" / "Women") while others use Norwegian ("herrer" / "damer").
 * The Øvelse field is targeted specifically, avoiding false positives
 * from Norwegian "men" (="but") in general body text.
 *
 * Returns "male", "female", or null if undetermined.
 */
export async function fetchGender(page) {
  // Collect up to 5 race PIDs from the grid
  const pids = await page.evaluate(() => {
    const links = document.querySelectorAll(
      "#grdRanking_DXMainTable .dxgvDataRow_PlasticBlue td a",
    );
    const result = [];
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      const m = href.match(/pid=(\d+)/);
      if (m) result.push(m[1]);
      if (result.length >= 5) break;
    }
    return result;
  });
  if (!pids || pids.length === 0) return null;

  // Try each PID until we find a gender
  for (const pid of pids) {
    const gender = await page.evaluate(async (pid) => {
      try {
        const res = await fetch(
          `https://www.medley.no/resultat.aspx?pid=${pid}`,
        );
        if (!res.ok) return null;
        const html = await res.text();
        const dom = new DOMParser().parseFromString(html, "text/html");

        // Method 1: Targeted extraction from the Øvelse/Event field
        const tds = dom.querySelectorAll("td");
        for (const td of tds) {
          const label = td.textContent.trim();
          if (label === "Øvelse:" || label === "Event:") {
            const next = td.nextElementSibling;
            if (next) {
              const eventText = next.textContent.trim().toLowerCase();
              // Norwegian keywords
              if (/\b(herrer|menn|gutter|gutt)\b/.test(eventText))
                return "male";
              if (/\b(damer|jenter|kvinner|jente)\b/.test(eventText))
                return "female";
              // English keywords (safe here because Øvelse is small & targeted)
              if (/\b(men|boys|male)\b/.test(eventText)) return "male";
              if (/\b(women|girls|female)\b/.test(eventText)) return "female";
            }
            break;
          }
        }

        // Method 2: Fallback – scan all body text with Norwegian-only keywords
        // (avoiding "men" which is a common Norwegian word meaning "but").
        const lower = dom.body?.textContent?.toLowerCase() || "";
        if (/\b(herrer|menn|gutter)\b/.test(lower)) return "male";
        if (/\b(damer|jenter|kvinner)\b/.test(lower)) return "female";

        return null;
      } catch {
        return null;
      }
    }, pid);

    if (gender) return gender;
  }

  return null;
}

/* ─── Combo item loading ─────────────────────────────────────────── */

/**
 * Load ALL combo items into the client data store by scrolling through
 * the entire list. After this call, `cmbUtover.GetItem(i)` returns the
 * item for any index 0..N-1, and `cmbUtover.GetItemCount()` reflects
 * the total loaded count — not just the current scroll window.
 *
 * Must be called after any page reload (which resets the combo data
 * store to only the first ~100 items). Without this, findSwimmerIdx
 * may find no items when scanning from index 0.
 *
 * Based on the same scroll-and-grow strategy used in discoverAllSwimmers.
 * Takes ~90–150 seconds for ~4600 swimmers.
 */
export async function loadAllComboItems(page) {
  // Clear any residual filter text so the dropdown shows all items
  await page.evaluate(() => {
    try {
      cmbUtover.SetText("");
    } catch {}
  });
  await sleep(300);

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(200);

  const ddReady = await page.evaluate(() => {
    try {
      cmbUtover.ShowDropDown();
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
      return !!d;
    } catch {
      return false;
    }
  });
  if (!ddReady) return;
  await sleep(600);

  // Phase A: scroll to the end (loads suffix batches)
  for (let i = 0; i < 80; i++) {
    const grown = await page.evaluate(async () => {
      try {
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (!d) return false;
        const prevCount = cmbUtover.GetItemCount();
        const prevScroll = d.scrollTop;
        d.scrollTop = d.scrollHeight;
        if (d.scrollTop <= prevScroll) {
          for (let p = 0; p < 20; p++) {
            await new Promise((r) => setTimeout(r, 500));
            if (cmbUtover.GetItemCount() > prevCount) return true;
          }
          return false;
        }
        await new Promise((r) => setTimeout(r, 1_500));
        return true;
      } catch {
        return false;
      }
    });
    if (!grown) break;
  }

  // Phase B: close & reopen to reload the prefix
  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(300);
  await page.evaluate(() => {
    try {
      cmbUtover.ShowDropDown();
      const d = cmbUtover.GetListBoxScrollDivElement();
      if (d) d.scrollTop = 0;
    } catch {}
  });
  await sleep(1_000);

  // Phase C: scroll to end again for remaining suffix
  for (let i = 0; i < 40; i++) {
    const grown = await page.evaluate(async () => {
      try {
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (!d) return false;
        const prevCount = cmbUtover.GetItemCount();
        const prevScroll = d.scrollTop;
        d.scrollTop = d.scrollHeight;
        if (d.scrollTop <= prevScroll) {
          for (let p = 0; p < 20; p++) {
            await new Promise((r) => setTimeout(r, 500));
            if (cmbUtover.GetItemCount() > prevCount) return true;
          }
          return false;
        }
        await new Promise((r) => setTimeout(r, 1_500));
        return true;
      } catch {
        return false;
      }
    });
    if (!grown) break;
  }

  await page.evaluate(() => {
    try {
      cmbUtover.HideDropDown();
    } catch {}
  });
  await sleep(200);
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
 * - KUN lisensiert (licensed swimmers, year detected from current date)
 * - From date: 2000-01-01
 * - Ikke vis deldistanser (show split-distance rows)
 * - Ikke vis førsteetapper (show first-leg rows)
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
      // Set "Kun lisensiert" checkbox — ID changes every year
      const year = new Date().getFullYear();
      const cbId = `ctl00_ctl00_Content_MainContent_chkKunLisensiert${year}`;
      const cb = document.getElementById(cbId);
      if (cb && typeof cb.SetChecked === "function") {
        cb.SetChecked(true);
      } else {
        // Fallback: try previous year
        const prevId = `ctl00_ctl00_Content_MainContent_chkKunLisensiert${year - 1}`;
        const prevCb = document.getElementById(prevId);
        if (prevCb && typeof prevCb.SetChecked === "function") {
          prevCb.SetChecked(true);
        }
      }

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

  // Wait for the swimmer combo to finish loading after the "Kun lisensiert"
  // callback. We poll until no callback is in flight AND at least one batch
  // of items has been loaded into the client data store. The InCallback()
  // check is wrapped in try/catch since it may not exist on all versions.
  await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      try {
        if (!cmbUtover.InCallback() && cmbUtover.GetItemCount() > 0) return;
      } catch {
        // InCallback() not supported — fall back to GetItemCount only
        try {
          if (cmbUtover.GetItemCount() > 0) return;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });
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
export async function loadUntilIdx(page, idx, maxScrolls = 1000) {
  // Fast path: check if the item is already loaded in the client data
  // store without opening the dropdown. This avoids the ~800 ms
  // open/close/scroll cycle when processing swimmers sequentially in
  // index order (subsequent items in an already-loaded batch).
  const fastCheck = await page.evaluate((i) => {
    try {
      return cmbUtover.GetItem(i) != null;
    } catch {
      return false;
    }
  }, idx);
  if (fastCheck) return true;

  // Clear any residual filter text so the dropdown shows all items
  await page.evaluate(() => {
    try {
      cmbUtover.SetText("");
    } catch {}
  });
  await sleep(300);

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
  await sleep(600);

  // Safety net: if the dropdown opened with 0 items, close + reopen
  // to force a fresh server callback (handles the case where the combo
  // was in a half-initialized state after a page reload).
  const loadHasItems = await page.evaluate(() => {
    try {
      return cmbUtover.GetItemCount() > 0;
    } catch {
      return false;
    }
  });
  if (!loadHasItems) {
    await page.evaluate(() => {
      try {
        cmbUtover.HideDropDown();
      } catch {}
    });
    await sleep(300);
    await page.evaluate(() => {
      try {
        cmbUtover.SetText("");
      } catch {}
    });
    await sleep(200);
    await page.evaluate(() => {
      try {
        cmbUtover.ShowDropDown();
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (d) d.scrollTop = 0;
      } catch {}
    });
    await sleep(800);
  }

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

    // Scroll to bottom to trigger the next batch — same patient strategy
    // as findSwimmerIdx/discoverAllSwimmers.
    const exhausted = await page.evaluate(async (targetIdx) => {
      try {
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (!d) return true;

        const prevScroll = d.scrollTop;
        const prevCount = cmbUtover.GetItemCount();

        // Jump to the bottom to trigger loading the next suffix batch
        d.scrollTop = d.scrollHeight;

        if (d.scrollTop <= prevScroll) {
          // Couldn't scroll further — wait for more items to arrive
          for (let p = 0; p < 30; p++) {
            await new Promise((r) => setTimeout(r, 500));
            // Check if our target item arrived
            try {
              if (cmbUtover.GetItem(targetIdx) != null) return false;
            } catch {}
            if (cmbUtover.GetItemCount() > prevCount) return false;
          }
          return true;
        }

        // Give the jump-triggered callback time to complete
        await new Promise((r) => setTimeout(r, 3_000));
        return false;
      } catch {
        return true;
      }
    }, idx);

    if (exhausted) {
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
 * Handles name format variations (e.g. "Last; First" vs "First Last")
 * to match against display names that may be formatted differently.
 *
 * Returns the 0-based combo index, or null if the name was not found.
 */
export async function findSwimmerIdx(page, name, maxScrolls = 500) {
  const target = name.trim();

  // Clear any residual filter text in the combo before searching.
  // After a page reload the combo may retain earlier filter state from
  // viewstate, which would limit visible items and make name lookup fail.
  await page.evaluate(() => {
    try {
      cmbUtover.SetText("");
    } catch {}
  });
  await sleep(300);

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
  await sleep(600);

  // Safety net: if the dropdown opened with 0 items, close + reopen
  // to force a fresh server callback.
  const hasItems = await page.evaluate(() => {
    try {
      return cmbUtover.GetItemCount() > 0;
    } catch {
      return false;
    }
  });
  if (!hasItems) {
    await page.evaluate(() => {
      try {
        cmbUtover.HideDropDown();
      } catch {}
    });
    await sleep(300);
    await page.evaluate(() => {
      try {
        cmbUtover.SetText("");
      } catch {}
    });
    await sleep(200);
    await page.evaluate(() => {
      try {
        cmbUtover.ShowDropDown();
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (d) d.scrollTop = 0;
      } catch {}
    });
    await sleep(800);
  }

  // Patiently scroll and scan: scroll to scrollHeight (like discovery),
  // wait for items to load (GetItemCount grows as batches load), repeat.
  for (let s = 0; s < maxScrolls; s++) {
    // Scan all currently loaded items for the target
    const result = await page.evaluate((targetName) => {
      try {
        const total = cmbUtover.GetItemCount();
        for (let i = 0; i < total; i++) {
          const item = cmbUtover.GetItem(i);
          if (!item) continue;
          if (!item.text) continue;

          const itemText = item.text.trim();

          // Try exact match first
          if (itemText === targetName) {
            return { found: true, idx: i };
          }

          // Try normalized matching (handle whitespace/semicolon variations)
          const normalized = itemText.replace(/;\s*/g, " ").toLowerCase();
          const targetNorm = targetName.replace(/;\s*/g, " ").toLowerCase();
          if (normalized === targetNorm) {
            return { found: true, idx: i };
          }

          // Try reversed name format: "Last; First" vs "First Last"
          // or "First Last" vs "Last; First"
          const targetParts = targetName.split(/;\s*/);
          if (targetParts.length === 2) {
            // Target is "Last; First" format — try "First Last"
            const reversed = `${targetParts[1].trim()} ${targetParts[0].trim()}`;
            if (itemText.toLowerCase() === reversed.toLowerCase()) {
              return { found: true, idx: i };
            }
          } else {
            // Target is likely "First Last" format — try to match against "Last; First"
            const parts = itemText.split(/;\s*/);
            if (parts.length === 2) {
              const reversed = `${parts[1].trim()} ${parts[0].trim()}`;
              if (reversed.toLowerCase() === targetName.toLowerCase()) {
                return { found: true, idx: i };
              }
            }
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

    // Scroll to the bottom of the dropdown to trigger loading of the
    // next batch of items, same strategy as discoverAllSwimmers uses.
    // After jumping, wait for GetItemCount() to grow (items are loaded
    // lazily by the DevExpress combo as callback batches arrive). Break
    // when scroll can't advance and no more items load after 15 seconds.
    const exhausted = await page.evaluate(async () => {
      try {
        const d = cmbUtover.GetListBoxScrollDivElement();
        if (!d) return true;

        const prevScroll = d.scrollTop;
        const prevCount = cmbUtover.GetItemCount();

        // Jump to the bottom to trigger loading the next suffix batch
        d.scrollTop = d.scrollHeight;

        if (d.scrollTop <= prevScroll) {
          // Couldn't scroll further — wait for items to arrive
          for (let p = 0; p < 30; p++) {
            await new Promise((r) => setTimeout(r, 500));
            if (cmbUtover.GetItemCount() > prevCount) return false;
          }
          return true;
        }

        // Waited long enough for the jump-triggered callback to arrive
        await new Promise((r) => setTimeout(r, 3_000));
        return false;
      } catch {
        return true;
      }
    });

    if (exhausted) break;
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
            // page body's "Distanse:" field (e.g. "200m Fri").
            // We prefer querying the field over the <title> tag because
            // an expired session causes the fetch to return the login page
            // whose title is "Medley.no - Hjem" instead of the real title.
            let partOf;
            if (isD) {
              const tds = dom.querySelectorAll("td");
              for (const td of tds) {
                if (td.textContent.trim() === "Distanse:") {
                  const next = td.nextElementSibling;
                  if (next) partOf = next.textContent.trim();
                  break;
                }
              }
              // Fallback: title-based extraction (works when session is valid,
              // but prone to "Hjem" on login redirects).
              if (!partOf) {
                const title = dom.querySelector("title")?.textContent || "";
                const extracted = title.split(" - ").pop()?.trim() || "";
                // "Hjem" = login/home page (expired session) — skip
                if (extracted && extracted !== "Hjem") {
                  partOf = extracted;
                }
              }
            }

            // Short D-rows (<100 m) only need partOf — no split extraction.
            // Omit `splits` entirely so the race won't get a padding-induced
            // [""] entry in the saved JSON (the D-row trim logic below would
            // pad an empty array to 1 element for a 50m split-distance row).
            if (!isLong) {
              return { vi, partOf };
            }

            const table = dom.getElementById("grdMellomtider_DXMainTable");
            if (!table) return { vi, splits: [], partOf };
            const rows = table.querySelectorAll("tr.dxgvDataRow_PlasticBlue");
            let splits = Array.from(rows).map((row) => {
              const cells = row.querySelectorAll("td");
              return cells[2]?.textContent?.trim() || "";
            });

            // NOTE: Previously D-rows were truncated to the first two
            // 50m segments here. That caused D-rows of other lengths
            // (100m/200m parts) to be incorrectly shortened. Instead,
            // return the full split list and trim on the Node side where
            // we have access to the D-row distance string.

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
        const newSplits = r.splits || [];
        const existing = csvRaces[r.vi]?.splits;

        // Merge/choose strategy: prefer the array with more *non-empty*
        // segment values to avoid overwriting richer existing data with
        // an empty or shorter fetch result. If counts tie, prefer the
        // existing data unless the new array has strictly more segments.
        const countNonEmpty = (arr) =>
          (arr || []).filter((s) => s && s.trim() !== "").length;
        let chosen;
        if (!existing || existing.length === 0) {
          chosen = newSplits;
        } else if (!newSplits || newSplits.length === 0) {
          chosen = existing;
        } else {
          const newCount = countNonEmpty(newSplits);
          const oldCount = countNonEmpty(existing);
          if (newCount > oldCount) chosen = newSplits;
          else if (newCount < oldCount) chosen = existing;
          else {
            // tie on non-empty count: prefer the longer array, otherwise keep existing
            if (newSplits.length > existing.length) chosen = newSplits;
            else chosen = existing;
          }
        }

        // If this is a D-row, trim to the expected number of 50m segments
        // based on the Distanse string on the Node side. Use Math.ceil to
        // avoid losing partial segments for non-multiples of 50 (e.g. 150m)
        try {
          if (csvRaces[r.vi]?.D === "D") {
            const distMatch = String(csvRaces[r.vi].Distanse || "").match(
              /^(\d+)m/,
            );
            if (distMatch) {
              const dist = parseInt(distMatch[1], 10);
              const expectedSegments = Math.max(1, Math.ceil(dist / 50));
              if ((chosen || []).length > expectedSegments) {
                chosen = (chosen || []).slice(0, expectedSegments);
              } else {
                // ensure length matches expectedSegments by padding with empty strings
                while ((chosen || []).length < expectedSegments)
                  chosen.push("");
              }
            }
          }
        } catch {
          // Ignore trimming errors and keep chosen as-is
        }

        csvRaces[r.vi].splits = chosen;
        if (countNonEmpty(chosen) > 0) splitsFound++;
      }

      // Only set partOf when we don't already have one — preserves any
      // previously collected parent reference.
      if (r.partOf) {
        // Ignore "Hjem" which comes from the login/home page when the
        // session has expired during split extraction.
        if (
          r.partOf !== "Hjem" &&
          (!csvRaces[r.vi].partOf || csvRaces[r.vi].partOf.trim() === "")
        ) {
          csvRaces[r.vi].partOf = r.partOf;
        }
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
