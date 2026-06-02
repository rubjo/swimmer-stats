/**
 * Filesystem helpers for reading/writing swimmer JSON data.
 */

import fs from "fs";
import path from "path";

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

/** True when two race arrays have the same count and same times/points. */
export function racesMatch(a, b) {
  if (a.length !== b.length) return false;
  const key = (r) =>
    `${r.Distanse}|${r.Dato}|${r.Tid}|${r.Poeng}|${r.Sted}|${r.Basseng}`;
  const sa = [...a].sort((x, y) => key(x).localeCompare(key(y)));
  const sb = [...b].sort((x, y) => key(x).localeCompare(key(y)));
  return sa.every((r, i) => key(r) === key(sb[i]));
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

  for (const fp of walkJsonFiles(swimmersDir)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const raceCount = (data.disciplines || []).reduce(
        (sum, d) => sum + (d.races?.length || 0),
        0,
      );
      swimmers.push({
        id: String(data.swimmerId),
        name: data.name,
        club: data.club,
        birthYear: data.birthYear,
        totalRaces: raceCount,
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
      totalRaces,
      settings: {
        kunLisensiert2026: true,
        fraDato: "01.01.2010",
        ikkeVisDeldistanser: true,
        ikkeVisForsteetapper: true,
        visKunForsteResultat: false,
      },
    },
    swimmers,
  };

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
}
