#!/usr/bin/env node
/**
 * One-off historical cleanup: remove stale duplicate race rows from all
 * swimmer files.
 *
 * When medley.no re-registers a stevne's results, every race gets a new PID.
 * The scraper deduplicates by PID, so both registrations can end up stored —
 * the stale row frozen at old RK/RA values alongside the live one. This script
 * removes the stale twin of every such pair (see lib/dedupe.js for the rule),
 * restricted to current-season races: ranking lists only drift within the
 * current year, so past years cannot contain these duplicates.
 *
 * Usage:
 *   node scripts/dedupe-races.js           # dry run — report only
 *   node scripts/dedupe-races.js --apply   # rewrite files + rebuild index.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { walkJsonFiles, rebuildIndex } from "../lib/fs-utils.js";
import { dedupeEntry } from "../lib/dedupe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const BASE_URL = "https://www.medley.no/svommer.aspx";

const apply = process.argv.includes("--apply");
const CURRENT_YEAR = new Date().getFullYear();

let filesChanged = 0;
let racesRemoved = 0;
let filesScanned = 0;

for (const fp of walkJsonFiles(SWIMMERS_DIR)) {
  filesScanned++;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    continue; // corrupted files are rebuildIndex's problem to report
  }
  if (!Array.isArray(entry.disciplines)) continue;

  const removed = dedupeEntry(entry, CURRENT_YEAR);
  if (removed.length === 0) continue;

  filesChanged++;
  racesRemoved += removed.length;
  const rel = path.relative(ROOT, fp);
  for (const { distanse, kept, stale } of removed.slice(0, 3)) {
    console.log(
      `  ${apply ? "removed" : "would remove"} ${stale.Tid} ${distanse} ${stale.Dato} (stale pid ${stale.pid}, kept pid ${kept}) — ${rel}`,
    );
  }
  if (removed.length > 3)
    console.log(`  … and ${removed.length - 3} more in ${rel}`);

  if (apply) {
    const payload = JSON.stringify(entry, null, 2);
    const tmp = `${fp}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, payload, "utf-8");
    fs.renameSync(tmp, fp);
  }
}

console.log(
  `\n${apply ? "Removed" : "Would remove"} ${racesRemoved} stale duplicate race(s) ` +
    `from ${filesChanged} swimmer file(s) (${filesScanned} scanned, season ${CURRENT_YEAR})`,
);

if (apply) {
  if (filesChanged > 0) {
    rebuildIndex({
      swimmersDir: SWIMMERS_DIR,
      dataDir: DATA_DIR,
      indexFile: INDEX_FILE,
      baseUrl: BASE_URL,
    });
    console.log("✓ Rebuilt data/index.json (race totals now exclude duplicates)");
  }
} else {
  console.log("Dry run — pass --apply to write changes and rebuild the index.");
}
