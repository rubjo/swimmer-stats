/**
 * Per-swimmer processing: grid polling, split extraction, dedup, merge, and file writing.
 *
 * Incremental mode — for each swimmer: select them, parse the grid, deduplicate
 * against existing data by PID, extract splits for new eligible races, merge
 * new races into existing disciplines, then save. Swimmers with no new races
 * are skipped (no write).
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
import { writeSwimmerFile } from "./fs-utils.js";

/* ─── Helpers ────────────────────────────────────────────────────── */
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

/* ─── Main entry point ──────────────────────────────────────────── */

/**
 * Process a single swimmer incrementally: select them in the combo,
 * poll for the grid, parse race data, deduplicate against existing
 * races by PID, extract splits for new eligible races,
 * merge into existing data, and save.
 *
 * @param {Page}                                 page          - Puppeteer page object
 * @param {{ id: string, text: string }}         sw            - Swimmer combo info
 * @param {number}                               selIdx        - Combo-box index
 * @param {{ SWIMMERS_DIR: string, processedInSession: number }} ctx
 * @param {object|null}                          existingEntry - Full swimmer data from
 *        previous scrape, or null for a brand-new swimmer.
 * @returns {{ saved: boolean, totalRaces: number, totalNewRaces: number }}
 */
export async function processSwimmer(page, sw, selIdx, ctx, existingEntry = null) {
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
    { interval: 300, timeout: 10_000 },
  );

  /* ── Grid never loaded ───────────────────────────────────────── */
  if (!gridReady) {
    if (existingEntry) {
      // Swimmer has prior data and grid had a hiccup — preserve existing,
      // don't overwrite with empty.
      console.log(color(C.dim, `  — ${sw.text} — grid never loaded (existing data preserved)`));
      return { saved: false, totalRaces: 0, totalNewRaces: 0 };
    }
    // Brand-new swimmer: save a minimal 0-race entry so they are
    // indexed and never retried.
    console.log(
      color(C.yellow, `  ⚠ Grid never loaded — ${sw.text} (saving as 0 races)`),
    );
    const info = await getSwimmerInfo(page).catch(() => ({}));
    const entry = {
      swimmerId: sw.id,
      name: info.name || sw.text,
      club: info.club || null,
      birthYear: info.birthYear || null,
      gender: null,
      timestamp: new Date().toISOString(),
      disciplines: [],
    };
    writeSwimmerFile(entry, ctx.SWIMMERS_DIR);
    return { saved: true, totalRaces: 0, totalNewRaces: 0 };
  }

  /* ── Parse grid ──────────────────────────────────────────────── */
  const races = await parseGridFromDOM(page);

  if (!races || races.length === 0) {
    if (existingEntry) {
      // Grid loaded but shows zero rows for this date range.
      // No new races — preserve existing data.
      console.log(color(C.dim, `  — ${sw.text} — no new races in grid`));
      return { saved: false, totalRaces: 0, totalNewRaces: 0 };
    }
    console.log(
      color(C.yellow, `  ⚠ No data — ${sw.text} (saving as 0 races)`),
    );
    const info = await getSwimmerInfo(page);
    const entry = {
      swimmerId: sw.id,
      name: info.name || sw.text,
      club: info.club || null,
      birthYear: info.birthYear || null,
      gender: null,
      timestamp: new Date().toISOString(),
      disciplines: [],
    };
    writeSwimmerFile(entry, ctx.SWIMMERS_DIR);
    return { saved: true, totalRaces: 0, totalNewRaces: 0 };
  }

  /* ── Capture gender while the grid still shows this swimmer ──── */
  const gender = await fetchGender(page).catch(() => null);

  /*
   * ── Identity verification ────────────────────────────────────
   * After selecting a swimmer and loading the grid, confirm that
   * the swimmer name shown on the page (lblNavn) matches the
   * expected name from the combo box. This guards against combo
   * index drift when swimmers are added/removed on the server,
   * which can cause the index-based selection to pick the wrong
   * swimmer and pollute existing data with another swimmer's races.
   */
  const idCheck = await getSwimmerInfo(page).catch(() => null);
  if (idCheck?.name && sw.text) {
    // Normalize names for comparison:
    // - Combo box uses "Lastname; Firstname(s)" format
    // - Page label (lblNavn) uses "Firstname(s) Lastname(s)" format
    // - Page labels sometimes have extra whitespace
    const norm = (s) => {
      let name = s.trim();
      // Reverse "Lastname; Firstname" → "Firstname Lastname"
      if (name.includes(";")) {
        const parts = name.split(";").map((p) => p.trim());
        name = parts.reverse().join(" ");
      }
      return name.replace(/\s+/g, " ").toLowerCase();
    };
    if (norm(idCheck.name) !== norm(sw.text)) {
      console.log(
        color(C.yellow, `  ⚠ Swimmer identity mismatch — page shows "${idCheck.name}", expected "${sw.text}" (will retry)`)
      );
      return { saved: false, totalRaces: 0, totalNewRaces: 0, identityMismatch: true };
    }
  }

  /*
   * ── Dedup against existing data ─────────────────────────────
   * Every race from the grid has a PID (extracted from the time link).
   * Build a set of PIDs already stored for this swimmer and filter
   * to keep only genuinely new races.
   */
  const existingPids = new Set();
  if (existingEntry) {
    for (const disc of existingEntry.disciplines) {
      for (const r of disc.races) {
        if (r.pid) existingPids.add(r.pid);
      }
    }
  }

  const newRaces = races.filter((r) => r.pid && !existingPids.has(r.pid));

  if (newRaces.length === 0 && existingEntry) {
    console.log(
      color(C.dim, `  — ${sw.text} — all ${races.length} races already indexed`),
    );
    return { saved: false, totalRaces: 0, totalNewRaces: 0 };
  }

  /*
   * D-rows ("deldistanser") are kept — they represent intermediate
   * split-distance attempts within longer races. Their splits are
   * truncated to the expected segment count inside extractSplits, and
   * a `partOf` field is added to reference the parent race discipline.
   * The index race count excludes them (r.D !== "D" in rebuildIndex),
   * so they don't inflate totals.
   */

  /* ── Extract splits for eligible new races (≥100 m) and new D-rows ──── */
  const eligible = newRaces.filter(
    (r) => hasPotentialSplits(r.Distanse) || r.D === "D",
  );
  if (eligible.length > 0) {
    await extractSplits(page, newRaces);
  }

  /* ── Check if page is still alive after all the fetch work ───── */
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
        "    ⚠ Page unresponsive after split extraction, reloading...",
      ),
    );
  }

  /* ── Clean up columns on new races ──────────────────────────── */
  for (const r of newRaces) {
    delete r.Nr;
    delete r.Poeng;
    delete r.Poengtype;
    if (r.RK == null) delete r.RK;
    if (r.RA == null) delete r.RA;
  }

  /* ── Get swimmer info ────────────────────────────────────────── */
  const info = await getSwimmerInfo(page);
  const swimmerName = info.name || sw.text;

  /* ── Build merged entry ──────────────────────────────────────────
   * Start with existing data (deep-cloned) or create a fresh entry
   * for brand-new swimmers. Then merge new races into the appropriate
   * discipline groups. */
  const finalEntry = existingEntry
    ? JSON.parse(JSON.stringify(existingEntry))
    : {
        swimmerId: sw.id,
        name: swimmerName,
        club: null,
        birthYear: null,
        gender,
        timestamp: new Date().toISOString(),
        disciplines: [],
      };

  // Refresh metadata from the current page
  finalEntry.name = swimmerName;
  finalEntry.club = info.club || finalEntry.club;
  finalEntry.birthYear = info.birthYear || finalEntry.birthYear;
  finalEntry.gender = gender || finalEntry.gender;
  finalEntry.timestamp = new Date().toISOString();

  // Group new races by distance into a temporary map
  const newDiscMap = new Map();
  for (const r of newRaces) {
    const dist = r.Distanse || "Ukjent";
    if (!newDiscMap.has(dist)) newDiscMap.set(dist, []);
    // Remove Distanse from the individual race object — it lives on the
    // discipline container.
    const rClean = { ...r };
    delete rClean.Distanse;
    newDiscMap.get(dist).push(rClean);
  }

  // Merge new discipline entries into the final entry's discipline map
  const discMap = new Map();
  for (const disc of finalEntry.disciplines) {
    discMap.set(disc.distanse, disc.races);
  }
  for (const [distanse, dRaces] of newDiscMap) {
    if (discMap.has(distanse)) {
      discMap.get(distanse).push(...dRaces);
    } else {
      discMap.set(distanse, dRaces);
    }
  }
  finalEntry.disciplines = [];
  for (const [distanse, races] of discMap) {
    finalEntry.disciplines.push({ distanse, races });
  }

  /* ── Write to disk ───────────────────────────────────────────── */
  writeSwimmerFile(finalEntry, ctx.SWIMMERS_DIR);
  const totalRaces = races.length;
  const totalNewRaces = newRaces.length;

  console.log(
    `  ${color(C.green, "✓")} ${ctx.processedInSession} — ${sw.text} — +${totalNewRaces} new races (${totalRaces} total in grid, processed in ${elapsed(swStart)})`,
  );

  return { saved: true, totalRaces, totalNewRaces };
}
