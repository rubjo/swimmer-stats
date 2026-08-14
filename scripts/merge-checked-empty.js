#!/usr/bin/env node
/**
 * Union the checked-empty ledgers from every shard into data/checked-empty.json.
 *
 * In sharded mode each shard confirms a DIFFERENT subset of swimmers as
 * zero-race (the shards process disjoint candidates), and each writes its own
 * partial data/checked-empty.json. If the merge job just copied files, the last
 * shard's ledger would overwrite the others and re-expose everyone else's
 * confirmed-empty swimmers as backfill candidates next run — the exact
 * re-scrape-forever loop the ledger exists to prevent.
 *
 * This script unions:
 *   1. the ledger already committed on main (data/checked-empty.json), plus
 *   2. every shard ledger passed as an argument,
 * keeping the EARLIEST checkedAt for any id seen more than once, and writes the
 * combined result back to data/checked-empty.json in the standard format.
 *
 * It only ADDS ids — it never drops one — so it cannot lose prior verdicts.
 *
 *   node scripts/merge-checked-empty.js /tmp/shards/shard-*/checked-empty.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LEDGER_FILE = path.join(DATA_DIR, "checked-empty.json");

/** Read a ledger file's swimmers array, or [] if missing/unreadable. */
function readLedger(fp) {
  try {
    if (!fs.existsSync(fp)) return [];
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return Array.isArray(data?.swimmers) ? data.swimmers : [];
  } catch {
    console.warn(`⚠ Skipping unreadable ledger: ${fp}`);
    return [];
  }
}

// Sources: the already-committed ledger first (so its verdicts are the
// baseline), then each shard ledger from argv.
const shardFiles = process.argv.slice(2);
const sources = [LEDGER_FILE, ...shardFiles];

const merged = new Map(); // id -> entry (earliest checkedAt kept)
let filesRead = 0;

for (const fp of sources) {
  const swimmers = readLedger(fp);
  if (swimmers.length > 0) filesRead++;
  for (const sw of swimmers) {
    if (!sw || sw.id == null) continue;
    const id = String(sw.id);
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, { ...sw, id });
      continue;
    }
    // Keep the earliest checkedAt so the recorded verdict reflects first
    // confirmation. Prefer a non-null name/club if one source has it.
    const keepEarlier =
      Boolean(sw.checkedAt) &&
      (!existing.checkedAt || sw.checkedAt < existing.checkedAt);
    merged.set(id, {
      id,
      name: existing.name ?? sw.name ?? null,
      club: existing.club ?? sw.club ?? null,
      checkedAt: keepEarlier ? sw.checkedAt : existing.checkedAt,
    });
  }
}

// Sort by id for a stable, diff-friendly file (matches saveCheckedEmpty).
const swimmers = [...merged.values()].sort((a, b) =>
  String(a.id).localeCompare(String(b.id)),
);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  LEDGER_FILE,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), swimmers },
    null,
    2,
  ),
  "utf-8",
);

console.log(
  `✓ Merged ${filesRead} ledger file(s) → ${swimmers.length} checked-empty ids in data/checked-empty.json`,
);
