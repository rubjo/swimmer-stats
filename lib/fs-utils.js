/**
 * Filesystem helpers for index/resume, swimmer file I/O.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

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

/* ─── Merge conflict resolution ────────────────────────────────────── */

/**
 * Attempt to resolve merge conflicts in a JSON file by keeping the ours version.
 * Returns true if a conflict was detected and resolved; false otherwise.
 */
export function resolveConflictedFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    // Check if file has git merge conflict markers
    if (!content.includes("<<<<<<< HEAD")) {
      return false; // No conflict
    }
    
    // Use git to resolve the conflict by taking our version
    try {
      execSync(`git checkout --ours "${filepath}"`, {
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch {
      // If git checkout fails, fall back to manual resolution
      const resolved = content
        .split("\n")
        .reduce((result, line, idx, lines) => {
          // Keep only the "ours" section (<<<<<<< HEAD to =======)
          if (line.startsWith("<<<<<<< HEAD")) {
            const endMarkerIdx = lines.findIndex(
              (l, i) => i > idx && l.startsWith("=======")
            );
            if (endMarkerIdx > idx) {
              // Find the end of conflict marker
              const conflictEnd = lines.findIndex(
                (l, i) => i > endMarkerIdx && l.startsWith(">>>>>>>")
              );
              if (conflictEnd > endMarkerIdx) {
                // Collect lines between HEAD marker and ======= marker
                result.push(...lines.slice(idx + 1, endMarkerIdx));
                // Skip to after the >>>>>>> marker
                return result;
              }
            }
          } else if (
            !line.startsWith("=======") &&
            !line.startsWith(">>>>>>>")
          ) {
            result.push(line);
          }
          return result;
        }, [])
        .join("\n");

      fs.writeFileSync(filepath, resolved, "utf-8");
      return true;
    }
  } catch {
    return false;
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
 * @param {Set<string>} [opts.processedIds] - Set of swimmerIds that were
 *        successfully checked this run (even with no new races).
 *        Their lastChecked timestamp is set to now.
 */
export function rebuildIndex({
  swimmersDir,
  dataDir,
  indexFile,
  baseUrl,
  fraDato,
  tilDato,
  indexedSwimmers,
  processedIds,
}) {
  const swimmers = [];
  const corruptedFiles = [];
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
      let content = fs.readFileSync(fp, "utf-8");
      
      // Check for and resolve merge conflicts
      if (content.includes("<<<<<<< HEAD")) {
        console.warn(`⚠ Merge conflict detected in ${fp}, attempting to resolve...`);
        if (resolveConflictedFile(fp)) {
          console.log(`✓ Resolved merge conflict in ${fp}`);
          content = fs.readFileSync(fp, "utf-8");
        } else {
          throw new Error("Failed to resolve merge conflict");
        }
      }
      
      const data = JSON.parse(content);

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

      // Update lastChecked for swimmers processed in this run;
      // otherwise preserve the existing timestamp so batch rotation
      // works correctly across runs.
      const lastChecked = processedIds?.has(swimmerId)
        ? now
        : (existingEntry?.lastChecked || null);

      swimmers.push({
        id: swimmerId,
        name: data.name,
        club: data.club,
        birthYear: data.birthYear,
        gender: data.gender || null,
        totalRaces: raceCount,
        splitsComplete,
        indexedDateTime: splitsComplete ? now : (existingEntry?.indexedDateTime || null),
        lastChecked,
      });
      totalRaces += raceCount;
    } catch (err) {
      corruptedFiles.push({ file: fp, error: err.message });
      console.error(`✗ Corrupted swimmer file: ${fp}\n  Error: ${err.message}`);
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
      corruptedFiles: corruptedFiles.length > 0 ? corruptedFiles : undefined,
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

  if (corruptedFiles.length > 0) {
    console.warn(
      `\n⚠ Warning: ${corruptedFiles.length} corrupted swimmer file(s) were skipped during index rebuild.`
    );
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
}
