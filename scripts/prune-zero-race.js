#!/usr/bin/env node
/**
 * One-off cleanup: prune swimmer files that hold 0 races.
 *
 * Backfill used to persist a file for every non-licensed swimmer it visited,
 * including the large share with an empty grid (retired officials, duplicate
 * profiles, never-competed registrations). Those zero-race files bloated the
 * index and — because a file on disk marks an id as "already done" in
 * computeBackfillCandidates — permanently excluded those ids from ever being
 * re-checked. lib/fs-utils.js#writeSwimmerFile now refuses to CREATE such files
 * going forward; this script removes the ones already on disk and rebuilds the
 * index so the two stay consistent.
 *
 * Deleting a zero-race file would normally re-expose that id as a backfill
 * candidate (the exact re-scrape-forever loop the checked-empty ledger exists
 * to prevent). Since each deleted file is itself proof the swimmer was checked
 * and found empty, this script seeds those ids into the checked-empty ledger as
 * it deletes them, so they stay excluded without being re-scraped.
 *
 * Race count matches rebuildIndex exactly: D-rows ("deldistanser", intermediate
 * splits) do NOT count, so a swimmer whose only rows are D-flagged is treated
 * as zero races and pruned.
 *
 *   node scripts/prune-zero-race.js            # dry run — lists, deletes nothing
 *   node scripts/prune-zero-race.js --apply    # actually delete + seed ledger + rebuild index
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  walkJsonFiles,
  rebuildIndex,
  loadCheckedEmpty,
  saveCheckedEmpty,
} from "../lib/fs-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const CHECKED_EMPTY_FILE = path.join(DATA_DIR, "checked-empty.json");
const BASE_URL = "https://www.medley.no/svommer.aspx";

const APPLY = process.argv.includes("--apply");

/** Count races the way rebuildIndex does: exclude D-flagged split rows. */
function raceCount(data) {
  let n = 0;
  for (const d of data.disciplines || []) {
    for (const r of d.races || []) {
      if (r.D !== "D") n++;
    }
  }
  return n;
}

const zero = [];
let total = 0;
let corrupt = 0;

for (const fp of walkJsonFiles(SWIMMERS_DIR)) {
  total++;
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (raceCount(data) === 0)
      zero.push({ fp, id: data.swimmerId, name: data.name, club: data.club });
  } catch (err) {
    // Never delete a file we can't parse — surface it instead.
    corrupt++;
    console.error(`✗ Could not parse ${fp}: ${err.message}`);
  }
}

console.log(`Scanned ${total} swimmer files.`);
if (corrupt > 0) {
  console.log(`⚠ ${corrupt} unreadable file(s) left untouched (see above).`);
}
console.log(`Found ${zero.length} zero-race file(s).`);

for (const z of zero) {
  console.log(`  - ${z.name || "(no name)"} [id ${z.id}] — ${z.fp}`);
}

if (!APPLY) {
  console.log(
    "\nDry run. Re-run with --apply to delete these, seed the checked-empty ledger, and rebuild the index.",
  );
  process.exit(0);
}

let deleted = 0;
const seededOk = [];
for (const z of zero) {
  try {
    fs.unlinkSync(z.fp);
    deleted++;
    // Only seed the ledger for files we actually removed, so a failed delete
    // doesn't quietly exclude a swimmer whose (empty) file still exists.
    if (z.id != null) seededOk.push(z);
  } catch (err) {
    console.error(`✗ Failed to delete ${z.fp}: ${err.message}`);
  }
}
console.log(`\nDeleted ${deleted} file(s).`);

// Seed the checked-empty ledger with the pruned ids so backfill doesn't
// re-discover and re-scrape them next run.
const ledger = loadCheckedEmpty(CHECKED_EMPTY_FILE);
const added = saveCheckedEmpty(CHECKED_EMPTY_FILE, ledger, seededOk, DATA_DIR);
console.log(`Seeded ${added} id(s) into the checked-empty ledger.`);

// Prune now-empty club directories so the tree stays tidy.
let emptyDirs = 0;
if (fs.existsSync(SWIMMERS_DIR)) {
  for (const entry of fs.readdirSync(SWIMMERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SWIMMERS_DIR, entry.name);
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      emptyDirs++;
    }
  }
}
if (emptyDirs > 0) console.log(`Removed ${emptyDirs} empty club dir(s).`);

console.log("Rebuilding index…");
rebuildIndex({
  swimmersDir: SWIMMERS_DIR,
  dataDir: DATA_DIR,
  indexFile: INDEX_FILE,
  baseUrl: BASE_URL,
});
console.log("✓ Index rebuilt.");
