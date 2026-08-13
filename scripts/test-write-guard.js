#!/usr/bin/env node
/**
 * Regression tests for the duplicate-swimmerId clobber fix in
 * lib/fs-utils.js#writeSwimmerFile.
 *
 *   node scripts/test-write-guard.js
 *
 * No test framework — plain asserts, exits non-zero on failure.
 */

import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { writeSwimmerFile } from "../lib/fs-utils.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swim-test-"));

const withRaces = (id) => ({
  swimmerId: id,
  name: "Celina Skarstad Austrheim",
  club: "Sandane TIL",
  disciplines: [{ distanse: "50 Fri", races: [{ pid: "p1" }, { pid: "p2" }] }],
});
const empty = (id) => ({
  swimmerId: id,
  name: "Celina Skarstad Austrheim",
  club: "Sandane TIL",
  disciplines: [],
});

const clubDir = path.join(tmp, "Sandane TIL");
const namePath = path.join(clubDir, "Celina Skarstad Austrheim.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/* 1. Populated file must survive an empty write from a DIFFERENT id. */
writeSwimmerFile(withRaces("10000"), tmp);
const p2 = writeSwimmerFile(empty("44442"), tmp);
assert.strictEqual(
  readJson(namePath).swimmerId,
  "10000",
  "good id 10000 must still own the plain name file",
);
assert.strictEqual(
  readJson(namePath).disciplines[0].races.length,
  2,
  "good id's races must be intact",
);
// The empty different id must NOT create/overwrite anything with 0 races.
// (empty-over-nonempty guard fires before the suffix write, returning the
// plain path and writing nothing new)
assert.strictEqual(p2, namePath, "empty write should be refused, returning the plain path");
assert.ok(
  !fs.existsSync(path.join(clubDir, "Celina Skarstad Austrheim-44442.json")),
  "no empty suffixed file should be created",
);

/* 2. A DIFFERENT id WITH races must land at a suffixed path, not clobber. */
const p3 = writeSwimmerFile(withRaces("55555"), tmp);
assert.strictEqual(
  p3,
  path.join(clubDir, "Celina Skarstad Austrheim-55555.json"),
  "different id with races must be suffixed",
);
assert.strictEqual(
  readJson(namePath).swimmerId,
  "10000",
  "original file must be untouched by the suffixed write",
);

/* 3. Same id may update its own file normally (incl. adding races). */
const grown = withRaces("10000");
grown.disciplines[0].races.push({ pid: "p3" });
const p4 = writeSwimmerFile(grown, tmp);
assert.strictEqual(p4, namePath, "same id writes to its own plain path");
assert.strictEqual(
  readJson(namePath).disciplines[0].races.length,
  3,
  "same id may grow its own races",
);

/* 4. A brand-new zero-race swimmer with no existing file must NOT be created. */
const p5 = writeSwimmerFile(empty("99999"), tmp);
assert.strictEqual(
  p5,
  null,
  "brand-new zero-race swimmer must be skipped (null return)",
);
assert.ok(
  !fs.existsSync(path.join(tmp, "Nykommer Ingenrace", "Nykommer Ingenrace.json")),
  "no file should be created for a zero-race newcomer",
);

/* 4b. writeSwimmerFile computes the target from name+club, so a distinct
 * zero-race newcomer (unique name) still yields null and creates nothing. */
const newcomer = {
  swimmerId: "88888",
  name: "Nykommer Ingenrace",
  club: "Ingen Klubb",
  disciplines: [],
};
const p6 = writeSwimmerFile(newcomer, tmp);
assert.strictEqual(p6, null, "distinct zero-race newcomer must be skipped");
assert.ok(
  !fs.existsSync(path.join(tmp, "Ingen Klubb")),
  "no club dir should be created for a skipped zero-race newcomer",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ all write-guard regression tests passed");
