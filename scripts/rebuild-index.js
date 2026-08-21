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
 * lastChecked handling: each shard writes a data/processed-shard-<i>.json file
 * listing the swimmerIds it checked this run (even those with no new races).
 * Set PROCESSED_SCAN_DIR to the directory holding the downloaded shard
 * artifacts (e.g. /tmp/shards); this script unions every shard's list and
 * stamps lastChecked=now for those swimmers, while preserving the committed
 * lastChecked for everyone not checked this run. That advancing timestamp is
 * what drives the least-recently-checked-first rotation across runs. When
 * PROCESSED_SCAN_DIR is unset (or matches nothing), every swimmer simply keeps
 * its existing lastChecked.
 *
 *   node scripts/rebuild-index.js
 *   PROCESSED_SCAN_DIR=/tmp/shards node scripts/rebuild-index.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { rebuildIndex } from "../lib/fs-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SWIMMERS_DIR = path.join(DATA_DIR, "swimmers");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const BASE_URL = "https://www.medley.no/svommer.aspx";

// Union the processed-swimmer ids reported by each shard, if a scan dir is set.
const processedIds = new Set();
const scanDir = process.env.PROCESSED_SCAN_DIR;
if (scanDir && fs.existsSync(scanDir)) {
  const stack = [scanDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
      } else if (
        entry.isFile() &&
        /^processed-shard-\d+\.json$/.test(entry.name)
      ) {
        try {
          const ids = JSON.parse(fs.readFileSync(fp, "utf-8"));
          if (Array.isArray(ids)) for (const id of ids) processedIds.add(String(id));
        } catch {
          console.warn(`⚠ Could not read processed-ids file ${fp}`);
        }
      }
    }
  }
  console.log(`  ${processedIds.size} swimmers checked this run (lastChecked → now)`);
}

rebuildIndex({
  swimmersDir: SWIMMERS_DIR,
  dataDir: DATA_DIR,
  indexFile: INDEX_FILE,
  baseUrl: BASE_URL,
  processedIds: processedIds.size ? processedIds : undefined,
});

console.log("✓ Rebuilt data/index.json from merged shard files");
