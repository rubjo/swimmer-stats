/**
 * Filesystem helpers for index/resume, swimmer file I/O.
 */

import fs from "fs";
import path from "path";

/* ─── Filename sanitisation ───────────────────────────────────────── */

/** Make a string safe for use as a filename component. */
export function safeFilename(name) {
  if (!name) return "ukjent";
  return String(name)
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
}

/* ─── Directory walking ────────────────────────────────────────────── */

/** Recursively yield all .json file paths under a directory. */
export function* walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonFiles(fp);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield fp;
  }
}

/* ─── Swimmer file I/O ─────────────────────────────────────────────── */

/** Write a single swimmer JSON file under <swimmersDir>/<club>/<name>.json. */
export function writeSwimmerFile(swimmer, swimmersDir) {
  const clubDir = safeFilename(swimmer.club || "ukjent");
  const dir = path.join(swimmersDir, clubDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const namePart = safeFilename(swimmer.name || swimmer.swimmerId);
  fs.writeFileSync(
    path.join(dir, `${namePart}.json`),
    JSON.stringify(swimmer, null, 2),
    "utf-8",
  );
}

/* ─── Index loading (for resume) ──────────────────────────────────── */

/**
 * Load index.json and return { meta, swimmersMap }.
 * swimmersMap is a Map<swimmerId, indexedEntry> for fast O(1) lookups
 * by swimmer ID.
 * Returns { meta: null, swimmersMap: null } if the file doesn't exist
 * or is corrupted.
 */
export function loadIndex(filepath) {
  try {
    if (!fs.existsSync(filepath)) return { meta: null, swimmersMap: null };
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    if (!data || !Array.isArray(data.swimmers)) {
      return { meta: null, swimmersMap: null };
    }
    const map = new Map();
    for (const entry of data.swimmers) {
      map.set(String(entry.id), entry);
    }
    return { meta: data.meta || null, swimmersMap: map };
  } catch {
    return { meta: null, swimmersMap: null };
  }
}

/* ─── Index rebuild ───────────────────────────────────────────────── */

/**
 * Rebuild the top-level index.json from all swimmer files.
 *
 * @param {object} opts
 * @param {string} opts.swimmersDir   - Directory containing swimmer JSON files
 * @param {string} opts.dataDir       - Parent data directory
 * @param {string} opts.indexFile     - Path to write index.json
 * @param {string} opts.baseUrl       - Source URL for meta
 * @param {string} [opts.fraDato]     - From-date filter
 * @param {string} [opts.tilDato]     - To-date filter
 * @param {Set<string>} [opts.indexedSwimmers] - Set of swimmerIds fully
 *        processed in this run. Matched swimmers get indexedDateTime set.
 */
export function rebuildIndex({
  swimmersDir,
  dataDir,
  indexFile,
  baseUrl,
  fraDato,
  tilDato,
  indexedSwimmers,
}) {
  const swimmers = [];
  let totalRaces = 0;
  let totalIndexedSwimmers = 0;
  const now = new Date().toISOString();

  // Load existing index to preserve indexedDateTime for swimmers
  // that were not processed in this run.
  const existingMap = new Map();
  try {
    if (fs.existsSync(indexFile)) {
      const existing = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      if (existing && Array.isArray(existing.swimmers)) {
        for (const entry of existing.swimmers) {
          existingMap.set(String(entry.id), entry);
        }
      }
    }
  } catch {}

  for (const fp of walkJsonFiles(swimmersDir)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));

      // Count races, excluding deldistanser (D-flagged rows) which are
      // intermediate split-distances already counted under their parent race.
      let raceCount = 0;
      for (const d of data.disciplines || []) {
        for (const r of d.races || []) {
          if (r.D !== "D") raceCount++;
        }
      }

      // Check whether every eligible race (≥100 m) has been checked for splits.
      // `splits === undefined` means the race's result page was never fetched;
      // `splits: []` means it was fetched but has no split segments.
      let splitsComplete = true;
      for (const d of data.disciplines || []) {
        const distMatch = d.distanse?.match(/^(\d+)m/);
        if (!distMatch || parseInt(distMatch[1], 10) < 100) continue;
        for (const r of d.races || []) {
          if (r.splits === undefined) {
            splitsComplete = false;
            break;
          }
        }
        if (!splitsComplete) break;
      }

      if (splitsComplete) totalIndexedSwimmers++;

      const swimmerId = String(data.swimmerId);
      const existingEntry = existingMap.get(swimmerId);
      swimmers.push({
        id: swimmerId,
        name: data.name,
        club: data.club,
        birthYear: data.birthYear,
        gender: data.gender || null,
        totalRaces: raceCount,
        splitsComplete,
        indexedDateTime: indexedSwimmers?.has(swimmerId)
          ? now
          : existingEntry?.indexedDateTime || null,
      });
      totalRaces += raceCount;
    } catch {
      /* skip corrupted */
    }
  }

  // Sort swimmers alphabetically by last name (surname), then first name.
  swimmers.sort((a, b) => {
    const aName = a.name || "";
    const bName = b.name || "";
    const aLast = aName.trim().split(/\s+/).pop() || "";
    const bLast = bName.trim().split(/\s+/).pop() || "";
    const cmp = aLast.localeCompare(bLast, "nb");
    if (cmp !== 0) return cmp;
    return aName.localeCompare(bName, "nb");
  });

  const index = {
    meta: {
      source: baseUrl,
      generatedAt: now,
      totalSwimmers: swimmers.length,
      totalIndexedSwimmers,
      totalRaces,
      settings: {
        kunLisensiert2026: true,
        fraDato: fraDato || "2000-01-01",
        tilDato: tilDato || "",
        ikkeVisDeldistanser: false,
        ikkeVisForsteetapper: false,
        visKunForsteResultat: false,
      },
    },
    swimmers,
  };

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
}
