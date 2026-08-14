#!/usr/bin/env node
/**
 * Rebuild data/index.json from all swimmer files on disk, standalone.
 *
 * Used by the sharded Scrape workflow's `merge` job: after every shard's
 * data/swimmers/** files have been copied into place, this rebuilds the index
 * ONCE over the union of all shards. Running it here (instead of letting each
 * shard rebuild its own partial index) is what keeps totalSwimmers/totalRaces
 * correct — a shard only ever sees its own ~1/N of the swimmers, so a
 * shard-built index would undercount massively.
 *
 * lastChecked handling: rebuildIndex preserves the existing index.json's
 * lastChecked for any swimmer not in `processedIds`. We pass no processedIds
 * here (the shards didn't push their own index, and the merge job has no
 * reliable per-swimmer processed set), so every swimmer keeps whatever
 * lastChecked was already committed. That's correct for the backfill-only use
 * case: the candidate pool is file-based (a file on disk excludes a swimmer
 * from future runs), so lastChecked is consistency metadata, not rotation state.
 *
 *   node scripts/rebuild-index.js
 */

import path from "path";
import { fileURLToPath } from "url";
import { rebuildIndex } from "../lib/fs-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const BASE_URL = "https://www.medley.no/svommer.aspx";

rebuildIndex({
  swimmersDir: SWIMMERS_DIR,
  dataDir: DATA_DIR,
  indexFile: INDEX_FILE,
  baseUrl: BASE_URL,
  // No processedIds — preserve every swimmer's committed lastChecked as-is.
});

console.log("✓ Rebuilt data/index.json from merged shard files");
