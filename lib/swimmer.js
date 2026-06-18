/**
 * Per-swimmer processing: grid polling, split extraction, and file writing.
 *
 * Simplified version — always does a full scrape: select swimmer,
 * parse the grid, extract splits for all eligible races (≥100 m),
 * then save. No mode distinction, no merge with old data, no
 * mid-extraction saves.
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

function formatSwimmerStats(entry) {
  const total = entry.disciplines.reduce((sum, d) => sum + d.races.length, 0);
  const withSplits = entry.disciplines.reduce(
    (sum, d) =>
      sum +
      d.races.filter((r) => r.splits !== undefined && r.splits.length > 0)
        .length,
    0,
  );
  return `${total} races, ${withSplits} with split times`;
}

/* ─── Main entry point ──────────────────────────────────────────── */

/**
 * Process a single swimmer: select them in the combo, poll for the
 * grid, parse race data, extract splits for eligible races (≥100 m),
 * then save to disk.
 *
 * @param {Page}                                 page   - Puppeteer page object
 * @param {{ id: string, text: string }}         sw     - Swimmer combo info
 * @param {number}                               selIdx - Combo-box index
 * @param {{ SWIMMERS_DIR: string, processedInSession: number }} ctx
 * @returns {{ saved: boolean, totalRaces: number, needsReposition: boolean }}
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
    { interval: 300, timeout: 20_000 },
  );

  if (!gridReady) {
    console.log(color(C.yellow, `  ⚠ Grid never loaded — ${sw.text}`));
    return { saved: false, totalRaces: 0, needsReposition: true };
  }

  /* ── Parse grid ──────────────────────────────────────────────── */
  const races = await parseGridFromDOM(page);
  if (!races || races.length === 0) {
    console.log(color(C.yellow, `  ⚠ No data — ${sw.text}`));
    return { saved: false, totalRaces: 0, needsReposition: false };
  }

  /* ── Capture gender while the grid still shows this swimmer ──── */
  const gender = await fetchGender(page).catch(() => null);

  /*
   * D-rows ("deldistanser") are kept — they represent intermediate
   * split-distance attempts within longer races. Their splits are
   * truncated to the first 2 segment times inside extractSplits, and
   * a `partOf` field is added to reference the parent race discipline.
   * The index race count excludes them (r.D !== "D" in rebuildIndex),
   * so they don't inflate totals.
   */

  /* ── Extract splits for eligible races (≥100 m) and D-rows ──── */
  const eligible = races.filter(
    (r) => hasPotentialSplits(r.Distanse) || r.D === "D",
  );
  if (eligible.length > 0) {
    await extractSplits(page, races);
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

  /* ── Clean up columns ────────────────────────────────────────── */
  for (const r of races) {
    delete r.Nr;
    delete r.Poeng;
    delete r.Poengtype;
    if (r.RK == null) delete r.RK;
    if (r.RA == null) delete r.RA;
  }

  /* ── Get swimmer info ────────────────────────────────────────── */
  const info = await getSwimmerInfo(page);
  const swimmerName = info.name || sw.text;

  /* ── Group by distance into disciplines ──────────────────────── */
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

  /* ── Write to disk ───────────────────────────────────────────── */
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

  console.log(
    `  ${color(C.green, "✓")} ${ctx.processedInSession} — ${sw.text} — ${formatSwimmerStats(entry)} (processed in ${elapsed(swStart)})`,
  );

  return { saved: true, totalRaces, needsReposition: false };
}
