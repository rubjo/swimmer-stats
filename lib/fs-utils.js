/**
 * Filesystem helpers for reading/writing swimmer JSON data.
 */

import fs from "fs";
import path from "path";

/* ─── Skip-until persistence ──────────────────────────────────────── */

/**
 * Load the skip-until map from disk. Returns a Map<swimmerId, ISO timestamp>.
 * Expired entries are automatically cleaned up.
 */
export function loadSkipUntil(filepath) {
  try {
    if (!fs.existsSync(filepath)) return new Map();
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    const map = new Map(Object.entries(data));
    const now = Date.now();
    for (const [id, until] of map) {
      if (new Date(until).getTime() <= now) map.delete(id);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persist the skip-until map to disk (only future entries). */
export function saveSkipUntil(map, filepath) {
  const obj = {};
  const now = Date.now();
  for (const [id, until] of map) {
    if (new Date(until).getTime() > now) obj[id] = until;
  }
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), "utf-8");
}

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

/** Recursively yield all .json file paths under a directory. */
export function* walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonFiles(fp);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield fp;
  }
}

/** Load all existing swimmer files into a Map keyed by swimmerId. */
export function loadExistingSwimmers(swimmersDir) {
  const map = new Map();
  for (const fp of walkJsonFiles(swimmersDir)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      map.set(String(data.swimmerId), data);
    } catch {
      /* skip corrupted */
    }
  }
  return map;
}

/** Flatten a swimmer's disciplines back into a comparable race array. */
export function flattenRaces(data) {
  if (data.races) return data.races;
  const out = [];
  for (const d of data.disciplines || []) {
    for (const r of d.races) {
      out.push({ ...r, Distanse: d.distanse });
    }
  }
  return out;
}

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

/** Rebuild the top-level index.json from all swimmer files. */
export function rebuildIndex({ swimmersDir, dataDir, indexFile, baseUrl }) {
  const swimmers = [];
  let totalRaces = 0;
  let totalIndexedSwimmers = 0;

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

      swimmers.push({
        id: String(data.swimmerId),
        name: data.name,
        club: data.club,
        birthYear: data.birthYear,
        gender: data.gender || null,
        totalRaces: raceCount,
        splitsComplete,
      });
      totalRaces += raceCount;
    } catch {
      /* skip corrupted */
    }
  }

  const index = {
    meta: {
      source: baseUrl,
      generatedAt: new Date().toISOString(),
      totalSwimmers: swimmers.length,
      totalIndexedSwimmers,
      totalRaces,
      settings: {
        kunLisensiert2026: true,
        fraDato: "01.01.2000",
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
