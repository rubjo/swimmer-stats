#!/usr/bin/env node
/**
 * Restore swimmer files clobbered to `disciplines: []` by the duplicate-
 * swimmerId backfill bug (two medley.no ids for one person share a
 * <club>/<name>.json path; backfilling the empty profile overwrote the
 * populated one — see lib/fs-utils.js for the fix).
 *
 * FAST: a clobber has a precise signature — a single commit that CHANGED a
 * file to contain the line `"disciplines": []`. We find every such commit in
 * ONE `git log` pickaxe pass over the whole tree, then read each file's
 * pre-clobber state from that commit's parent. That's one git-log process plus
 * one `git show` per actual clobber — not a history walk per empty file (the
 * old per-file approach spawned ~850 git processes and took minutes).
 *
 * Modes (all safe unless --write):
 *   node scripts/restore-clobbered.js              # dry-run report + per-file list
 *   node scripts/restore-clobbered.js --diagnose   # counts only, no list, no writes
 *   node scripts/restore-clobbered.js --write        # restore in place
 *
 * Run from the repo root with a clean working tree (commit/stash first).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SWIMMERS_DIR_REL = "data/swimmers";

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const DIAGNOSE = args.has("--diagnose");

/* ─── helpers ─────────────────────────────────────────────────────── */

function raceCount(entry) {
  if (!entry || !Array.isArray(entry.disciplines)) return 0;
  return entry.disciplines.reduce(
    (s, d) => s + (Array.isArray(d.races) ? d.races.length : 0),
    0,
  );
}

// Pipe (don't inherit) stderr so git's expected "fatal: path … not in
// <commit>" chatter never reaches the terminal; callers handle the throw.
const git = (a) =>
  execSync(`git ${a}`, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

/** Parse a blob at <ref>:<path>, or null if absent/unparseable. */
function readBlob(ref, relPath) {
  try {
    return JSON.parse(git(`show ${ref}:"${relPath}"`));
  } catch {
    return null;
  }
}

/* ─── main ────────────────────────────────────────────────────────── */

try {
  git("rev-parse --is-inside-work-tree");
} catch {
  console.error("✗ Not a git repository (or git unavailable). Aborting.");
  process.exit(1);
}

// ── One pass: every commit that INTRODUCED the empty-disciplines line to a
// changed swimmer file. -G matches added/removed lines matching the regex;
// --diff-filter=M restricts to modifications (not file creation), so a
// brand-new empty profile — which is legitimate — is never flagged. For each
// such commit we get the files it touched under data/swimmers.
//
// Output format: a commit hash line, then the paths it changed, repeating.
const PICKAXE = String.raw`"disciplines": \[\]`;
let log;
try {
  log = git(
    `log --diff-filter=M -G'${PICKAXE}' --format=%H --name-only -- ${SWIMMERS_DIR_REL}`,
  );
} catch (e) {
  console.error("✗ git log pickaxe failed:", e.message);
  process.exit(1);
}

// Collect candidate (path → newest clobber commit). A file may appear in
// several commits; the FIRST time we see it walking newest→oldest is the most
// recent clobber, which is the one whose parent holds the freshest good data.
const clobberCommitForPath = new Map();
let commit = null;
for (const line of log.split("\n")) {
  const t = line.trim();
  if (!t) continue;
  if (/^[0-9a-f]{40}$/.test(t)) {
    commit = t;
  } else if (commit && t.endsWith(".json")) {
    if (!clobberCommitForPath.has(t)) clobberCommitForPath.set(t, commit);
  }
}

const restored = [];
const notActuallyClobbered = []; // matched pickaxe but parent had no races
let missingOnDisk = 0;

for (const [relPath, clobberCommit] of clobberCommitForPath) {
  const abs = path.join(REPO_ROOT, relPath);

  // Only care if the file is STILL empty on disk. If it's non-empty now, it
  // was clobbered then later re-populated — nothing to restore.
  let current = null;
  if (fs.existsSync(abs)) {
    try {
      current = JSON.parse(fs.readFileSync(abs, "utf-8"));
    } catch {}
  } else {
    missingOnDisk++;
    continue;
  }
  if (raceCount(current) > 0) continue;

  // The pre-clobber state is this file at the clobber commit's PARENT.
  const before = readBlob(`${clobberCommit}^`, relPath);
  const races = raceCount(before);
  if (races === 0) {
    // Pickaxe matched for another reason (e.g. the line moved) but the parent
    // had no races either — not a real data loss.
    notActuallyClobbered.push(relPath);
    continue;
  }

  const differentId =
    String(before.swimmerId ?? "") !== String(current?.swimmerId ?? "");
  restored.push({
    relPath,
    races,
    ref: clobberCommit.slice(0, 10),
    differentId,
    goodId: before.swimmerId,
    currentId: current?.swimmerId,
    entry: before,
    abs,
  });

  if (WRITE) {
    fs.writeFileSync(abs, JSON.stringify(before, null, 2), "utf-8");
  }
}

/* ─── report ──────────────────────────────────────────────────────── */

console.log(
  `\nPickaxe found ${clobberCommitForPath.size} file(s) whose disciplines` +
    ` were emptied in a modifying commit.\n`,
);
console.log(`── Damage assessment ─────────────────────────────`);
console.log(`  Confirmed clobbers (parent had races, empty now): ${restored.length}`);
console.log(`  Emptied but parent had no races (not a loss):     ${notActuallyClobbered.length}`);
console.log(`  Referenced file no longer on disk:                ${missingOnDisk}`);
const crossId = restored.filter((r) => r.differentId).length;
console.log(`  …of clobbers, good data from a DIFFERENT id:      ${crossId}`);

if (!DIAGNOSE && restored.length) {
  console.log(`\n${WRITE ? "RESTORED" : "WOULD RESTORE"} ${restored.length} file(s):\n`);
  for (const r of restored) {
    const idNote = r.differentId
      ? `good id ${r.goodId} ≠ current empty id ${r.currentId} (empty id may need separate re-scrape)`
      : `same id ${r.goodId}`;
    console.log(`  ✓ ${r.relPath}`);
    console.log(`      +${r.races} races from ${r.ref}^ — ${idNote}`);
  }
}

if (!DIAGNOSE && !WRITE && restored.length) {
  console.log(`\nDry run only. Restore with:\n    node scripts/restore-clobbered.js --write`);
}

if (WRITE && restored.length) {
  console.log(`\n⚠ Rebuild the index so totals reflect restored races — run the`);
  console.log(`  scraper once, or call rebuildIndex() from lib/fs-utils.js.`);
}
