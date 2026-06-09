/**
 * Per-swimmer processing: grid polling, split extraction, and file writing.
 *
 * The main orchestrator is `processSwimmer()` which is called once per
 * swimmer from the main loop in index.js.
 */

import {
  hasPotentialSplits,
  parseGridFromDOM,
  getSwimmerInfo,
  fetchGender,
  selectSwimmer,
  extractSplits,
  pollFor,
} from "./browser.js";
import {
  flattenRaces,
  writeSwimmerFile,
  rebuildIndex,
  saveSkipUntil,
} from "./fs-utils.js";

/* ─── Helpers — kept small and local ─────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};
const color = (code, s) => `${code}${s}${C.reset}`;

function elapsed(start) {
  const secs = Math.round((Date.now() - start) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const totalMinutes = Math.floor(diff / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const hours = Math.floor(totalMinutes / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0) return `${days}d ${remHours}h ago`;
  return `${hours}h ago`;
}

function formatSwimmerStats(data) {
  const allRaces = flattenRaces(data);
  const total = allRaces.length;
  const withSplits = allRaces.filter(
    (r) => r.splits !== undefined && r.splits.length > 0,
  ).length;
  return `${total} races, ${withSplits} with split times`;
}

/* ─── Main entry point ──────────────────────────────────────────── */

/**
 * Process a single swimmer: select them in the combo, poll for the grid,
 * parse race data, extract splits (if applicable), write to disk, and
 * rebuild the index.
 *
 * @param {Page} page - Puppeteer page object
 * @param {{ id: string, text: string }} sw - Swimmer combo info
 * @param {number} selIdx - Combo-box index for this swimmer
 * @param {object} ctx - Context / configuration
 * @param {string} ctx.mode - "splits" or "collect"
 * @param {Map} ctx.existingSwimmers - Map<swimmerId, data> of previously saved data
 * @param {Map} ctx.skipUntil - Map<swimmerId, ISO string> of skip-until timestamps
 * @param {string} ctx.SKIP_UNTIL_FILE - Path to persist skip-until
 * @param {string} ctx.SWIMMERS_DIR - Swimmer data directory
 * @param {string} ctx.DATA_DIR - Data directory
 * @param {string} ctx.INDEX_FILE - Index file path
 * @param {string} ctx.BASE_URL - Base URL for index metadata
 * @param {number} ctx.processedInSession - Sequential counter (for logging)
 * @param {function} ctx.reloadPage - Callback to reload/reset the page
 * @param {function} ctx.gitCheckpoint - Callback for git commit+push
 *
 * @returns {{ saved: boolean, totalRaces: number, needsReposition: boolean }}
 *   saved: true if race data was written to disk
 *   totalRaces: number of races processed this swimmer
 *   needsReposition: true if the page combo may need realignment
 */
export async function processSwimmer(page, sw, selIdx, ctx) {
  const swStart = Date.now();

  /* ── Select swimmer & wait for grid ──────────────────────────── */
  await selectSwimmer(page, selIdx);

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
    const existing = ctx.existingSwimmers.get(sw.id);
    const ago = existing?.timestamp ? timeAgo(existing.timestamp) : "";
    const statsMsg = existing ? formatSwimmerStats(existing) : "no data yet";
    console.log(
      color(
        C.yellow,
        `  ⚠ Grid never loaded — ${sw.text} — ${statsMsg}${ago ? ", last updated " + ago : ""}`,
      ),
    );
    ctx.skipUntil.set(
      sw.id,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    saveSkipUntil(ctx.skipUntil, ctx.SKIP_UNTIL_FILE);
    return { saved: false, totalRaces: 0, needsReposition: true };
  }

  /* ── Parse grid ──────────────────────────────────────────────── */
  const races = await parseGridFromDOM(page);
  if (!races || races.length === 0) {
    console.log(color(C.yellow, `  ⚠ No data — ${sw.text}`));
    return { saved: false, totalRaces: 0, needsReposition: false };
  }

  // Merge saved races that aren't in the current grid (preserves historical
  // data when the date filter is narrowed).
  const prevData = ctx.existingSwimmers.get(sw.id);
  if (prevData && prevData.timestamp) {
    const savedRaces = flattenRaces(prevData);
    for (const sr of savedRaces) {
      const inGrid = races.some(
        (r) =>
          r.Distanse === sr.Distanse && r.Dato === sr.Dato && r.Tid === sr.Tid,
      );
      if (!inGrid) races.push(sr);
    }
  }

  /* ── Collect mode: skip split extraction, save immediately ───── */
  if (ctx.mode !== "splits") {
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
    const gender = await fetchGender(page);

    const existing = ctx.existingSwimmers.get(sw.id);
    let changeLabel;
    if (existing && existing.timestamp) {
      const savedRaces = flattenRaces(existing);
      const diff = races.length - savedRaces.length;
      changeLabel =
        diff === 0 ? "unchanged" : `${savedRaces.length}→${races.length}`;
    } else {
      changeLabel = "new";
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

    writeSwimmerFile(entry, ctx.SWIMMERS_DIR);
    const totalRaces = races.length;
    const ago = existing?.timestamp ? timeAgo(existing.timestamp) : "";
    console.log(
      `  ${color(C.green, "✓")} ${ctx.processedInSession} — ${sw.text} — ${races.length} races, ${changeLabel}${ago ? ", last updated " + ago : ""} (processed in ${elapsed(swStart)})`,
    );

    rebuildIndex({
      swimmersDir: ctx.SWIMMERS_DIR,
      dataDir: ctx.DATA_DIR,
      indexFile: ctx.INDEX_FILE,
      baseUrl: ctx.BASE_URL,
    });
    if (ctx.processedInSession % 25 === 0) {
      console.log(
        color(
          C.cyan,
          `    checkpoint — pushing ${ctx.processedInSession} swimmers to GitHub...`,
        ),
      );
      ctx.gitCheckpoint(`${ctx.processedInSession} swimmers`);
    }

    return { saved: true, totalRaces, needsReposition: false };
  }

  /* ── Splits mode: extract new or missing splits only ─────────── */

  /**
   * Merge saved splits back into races that weren't touched by extractSplits.
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
   * Persist the current state of races as a partial checkpoint so data
   * is never lost if the process crashes mid-extraction.
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
      ctx.SWIMMERS_DIR,
    );
  }

  const eligible = races.filter((r) => hasPotentialSplits(r.Distanse)).length;
  const existing = ctx.existingSwimmers.get(sw.id);

  if (existing && existing.timestamp) {
    const savedRaces = flattenRaces(existing);

    if (savedRaces.length === races.length) {
      // Race count unchanged — extract only rows with missing splits.
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
        if (!existing.gender) {
          existing.gender = await fetchGender(page);
        }
        console.log(
          `  ✓ ${ctx.processedInSession} — ${sw.text} — ${formatSwimmerStats(existing)}, last updated ${timeAgo(existing.timestamp)} (processed in ${elapsed(swStart)})`,
        );
        existing.timestamp = new Date().toISOString();
        writeSwimmerFile(existing, ctx.SWIMMERS_DIR);
        return {
          saved: true,
          totalRaces: races.length,
          needsReposition: false,
        };
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
      // Race count changed — find and extract only new races.
      const newIndices = [];

      // Find indices of races that don't exist in saved data (≥100 m only)
      for (let i = 0; i < races.length; i++) {
        const cr = races[i];
        if (!hasPotentialSplits(cr.Distanse)) continue;
        const exists = savedRaces.some(
          (sr) =>
            sr.Distanse === cr.Distanse &&
            sr.Dato === cr.Dato &&
            sr.Tid === cr.Tid,
        );
        if (!exists) newIndices.push(i);
      }

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

  // Check if page is still alive after all the fetch work.
  // Use a short timeout — if the JS thread is stuck from a previous
  // DevExpress callback, page.evaluate would hang indefinitely.
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("page evaluate timed out")),
        10_000,
      );
      page
        .evaluate(() => true)
        .then((v) => {
          clearTimeout(timer);
          resolve(v);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  } catch {
    console.log(
      color(
        C.red,
        `    ⚠ Page unresponsive after split extraction, reloading...`,
      ),
    );
    if (ctx.reloadPage) {
      page = await ctx.reloadPage();
    } else {
      console.log(
        color(
          C.red,
          `    ⚠ No reloadPage callback available — page may be stuck`,
        ),
      );
    }
  }

  // Drop unwanted columns
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

  writeSwimmerFile(entry, ctx.SWIMMERS_DIR);
  const totalRaces = races.length;

  const withSplits = races.filter(
    (r) => r.splits !== undefined && r.splits.length > 0,
  ).length;
  console.log(
    `  ✓ ${ctx.processedInSession} — ${sw.text} — ${races.length} races, ${withSplits} with split times` +
      ` (processed in ${elapsed(swStart)})`,
  );

  rebuildIndex({
    swimmersDir: ctx.SWIMMERS_DIR,
    dataDir: ctx.DATA_DIR,
    indexFile: ctx.INDEX_FILE,
    baseUrl: ctx.BASE_URL,
  });
  if (ctx.processedInSession % 25 === 0) {
    console.log(
      color(
        C.cyan,
        `    checkpoint — pushing ${ctx.processedInSession} swimmers to GitHub...`,
      ),
    );
    ctx.gitCheckpoint(`${ctx.processedInSession} swimmers`);
  }

  return { saved: true, totalRaces, needsReposition: false };
}
