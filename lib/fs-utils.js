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
    // Quick check for merge markers
    if (!/<<<<<<< /.test(content)) return false;

    // Replace each conflict block with the "ours" section (the first part).
    // This uses a global regex that captures the first section between <<<<<<< and =======
    const resolved = content.replace(
      /<<<<<<<[^\n]*\n([\s\S]*?)\n=======[\s\S]*?\n>>>>>>>[^\n]*\n?/g,
      "$1",
    );

    // Validate JSON before overwriting the file to avoid producing corrupted output.
    JSON.parse(resolved);

    // Atomic write: write to a temp file and rename.
    const tmp = `${filepath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, resolved, "utf-8");
    fs.renameSync(tmp, filepath);
    return true;
  } catch {
    return false;
  }
}

/* ─── Swimmer file I/O ─────────────────────────────────────────────── */

/** Count total races (including D-rows) across an entry's disciplines. */
function raceCountOf(entry) {
  if (!entry || !Array.isArray(entry.disciplines)) return 0;
  return entry.disciplines.reduce(
    (sum, d) => sum + (Array.isArray(d.races) ? d.races.length : 0),
    0,
  );
}

/**
 * Write a single swimmer JSON file under <swimmersDir>/<club>/<name>.json.
 *
 * Two swimmerIds on medley.no can share the same person's name (duplicate
 * profiles, one with races, one empty). Both resolve to the same
 * <club>/<name>.json path, so a naive write lets an empty profile clobber a
 * populated one. Two guards prevent that:
 *
 *   1. Filename collision → different id: if the target path already holds a
 *      DIFFERENT swimmerId, write to <name>-<id>.json instead so both
 *      identities coexist. The suffixed path is itself collision-checked.
 *   2. Empty-over-nonempty (same id): never replace an on-disk entry that has
 *      races with an incoming entry that has none. This is the backstop that
 *      catches any case the id check misses.
 *   3. No-new-empty: never CREATE a brand-new file for a swimmer with 0 races.
 *      A newly-licensed swimmer who hasn't raced within the incremental window
 *      yet has an empty grid; persisting that would bloat the index with a
 *      zero-race entry. Skipping the write keeps the index restricted to
 *      swimmers who actually raced — the swimmer still has no file, so the next
 *      run re-checks them and picks up their races once they compete.
 *
 * @returns {string|null} the absolute path written (or the skipped path), or
 *   null when guard #3 skipped a brand-new zero-race swimmer entirely.
 */
export function writeSwimmerFile(swimmer, swimmersDir) {
  const clubDir = safeFilename(swimmer.club || "ukjent");
  const dir = path.join(swimmersDir, clubDir);

  const incomingId = String(swimmer.swimmerId ?? "");
  const namePart = safeFilename(swimmer.name || swimmer.swimmerId);

  // Resolve the target path, walking around collisions with a DIFFERENT id.
  let target = path.join(dir, `${namePart}.json`);
  const suffixedTarget = path.join(dir, `${namePart}-${incomingId}.json`);

  // Guard #3: a zero-race incoming entry that has no existing file to update
  // adds no data — skip it so the swimmer stays uncached (re-checked next run)
  // and the index stays restricted to swimmers who actually raced. We check
  // both candidate paths; if neither exists yet, there is nothing to preserve
  // and nothing worth creating.
  if (raceCountOf(swimmer) === 0) {
    const existsAtTarget = fs.existsSync(target);
    const existsAtSuffixed = fs.existsSync(suffixedTarget);
    if (!existsAtTarget && !existsAtSuffixed) {
      console.warn(
        `⚠ Skipping zero-race swimmer ${swimmer.name || incomingId} (id ${incomingId}) — no new file created`,
      );
      return null;
    }
  }

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const onDisk = readEntryIfExists(target);

  if (onDisk && String(onDisk.swimmerId ?? "") !== incomingId) {
    // A different swimmer already owns this name+club — separate them by id so
    // neither clobbers the other. This is the duplicate-profile case.
    console.warn(
      `⚠ Name collision at ${target}: on-disk id ${onDisk.swimmerId} ≠ incoming id ${incomingId} — writing ${suffixedTarget} instead`,
    );
    target = suffixedTarget;
  }

  // Empty-over-nonempty backstop: if the resolved target already holds this
  // same swimmer's data WITH races and the incoming entry has none, refuse the
  // write rather than wiping their history.
  const finalOnDisk = readEntryIfExists(target);
  if (
    finalOnDisk &&
    raceCountOf(finalOnDisk) > 0 &&
    raceCountOf(swimmer) === 0
  ) {
    console.warn(
      `⚠ Refusing empty write: ${target} has ${raceCountOf(finalOnDisk)} races on disk, incoming entry has 0 — preserving existing data`,
    );
    return target;
  }

  const payload = JSON.stringify(swimmer, null, 2);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, payload, "utf-8");
  fs.renameSync(tmp, target);
  return target;
}

/** Read and parse a swimmer JSON file, or return null if absent/unreadable. */
function readEntryIfExists(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

/* ─── Index loading (for resume) ──────────────────────────────────── */

/**
 * Load index.json and return { meta, swimmersMap }.
 * swimmersMap is a Map<swimmerId, indexEntry> for fast O(1) lookups
 * by swimmer ID (used for lastChecked timestamps during batch rotation).
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
 * @param {Set<string>} [opts.processedIds] - Set of swimmerIds that were
 *        successfully checked this run (even with no new races).
 *        Their lastChecked timestamp is set to now.
 */
export function rebuildIndex({
  swimmersDir,
  dataDir,
  indexFile,
  baseUrl,
  processedIds,
}) {
  const swimmers = [];
  const corruptedFiles = [];
  let totalRaces = 0;
  const now = new Date().toISOString();

  // Load existing index to preserve lastChecked for swimmers
  // that were not processed in this run.
  const existingMap = new Map();
  try {
    if (fs.existsSync(indexFile)) {
      let raw = fs.readFileSync(indexFile, "utf-8");

      // Guard against merge-conflict markers left behind by a failed
      // `git pull --rebase`.  Abort the in-progress rebase first so the
      // working tree is clean, then re-read the file (git may have
      // restored a valid version) or fall through to an empty map.
      if (raw.includes("<<<<<<<")) {
        console.warn("⚠ data/index.json has merge conflict markers — aborting stale rebase");
        try {
          execSync("git rebase --abort", { stdio: "ignore", timeout: 10_000 });
        } catch {}
        if (fs.existsSync(indexFile)) {
          raw = fs.readFileSync(indexFile, "utf-8");
        }
      }

      const existing = JSON.parse(raw);
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
        console.warn(`\u26a0 Merge conflict detected in ${fp}, attempting to resolve...`);
        if (resolveConflictedFile(fp)) {
          console.log(`\u2713 Resolved merge conflict in ${fp}`);
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
        lastChecked,
      });
      totalRaces += raceCount;
    } catch (err) {
      corruptedFiles.push({ file: fp, error: err.message });
      console.error(`\u2717 Corrupted swimmer file: ${fp}\n  Error: ${err.message}`);
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
      totalRaces,
      corruptedFiles: corruptedFiles.length > 0 ? corruptedFiles : undefined,
      settings: {
        kunLisensiert: new Date().getFullYear(),
        ikkeVisDeldistanser: false,
        ikkeVisForsteetapper: false,
        visKunForsteResultat: false,
      },
    },
    swimmers,
  };

  if (corruptedFiles.length > 0) {
    console.warn(
      `\n\u26a0 Warning: ${corruptedFiles.length} corrupted swimmer file(s) were skipped during index rebuild.`
    );
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const payload = JSON.stringify(index, null, 2);
  const tmp = `${indexFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, payload, "utf-8");
  fs.renameSync(tmp, indexFile);
}
