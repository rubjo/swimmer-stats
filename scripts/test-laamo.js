#!/usr/bin/env node
/**
 * Tests for lib/laamo.js (the LÅMØ / ÅM list parsing).
 *
 *   node scripts/test-laamo.js
 *
 * No test framework — plain asserts, exits non-zero on failure. The rows are
 * from LÅMØ 2027, 2011 Herrer, "Vis uavhengig av landsdel" (2026-11-25).
 */

import assert from "assert";
import {
  isEntered,
  mergeViews,
  parseClassLabel,
  parseGrid,
  parsePeriod,
  parseTitle,
} from "../lib/laamo.js";

const HEADER = ["", "", "Navn", "Navn", "Klubb", "Født", "Poeng",
  "400m Fri", "100m Butterfly", "200m Rygg", "200m Bryst", "200m IM"];

const row = (rank, id, name, club, total, cells, pids = []) => ({
  texts: ["", String(rank), name, name, club, "2011", String(total), ...cells],
  hrefs: ["", "", `svommer.aspx?id=${id}`, `svommer.aspx?id=${id}`, "", "", "",
    ...cells.map((c, i) => (c && pids[i] ? `resultat.aspx?pid=${pids[i]}` : null))],
});

/* Period, title and class labels. */
assert.deepEqual(
  parsePeriod(
    "Listen inneholder tider oppnådd fom 1. april 2026\nKvalifiseringsperioden til ÅMØ Landsdel startet 1. april 2026 og varer til 31. mars 2027.",
  ),
  { from: "01.04.2026", to: "31.03.2027" },
);
assert.equal(parsePeriod("Listen inneholder tider oppnådd under LÅMØ 2026."), null);
// Until 2020 (LÅMØ 2019, 2020): "er X til Y".
assert.deepEqual(
  parsePeriod(
    "Listen inneholder tider oppnådd fom 28. februar 2018.\nKvalifiseringsperioden til ÅMØ Landsdel er 28. februar 2018 til 27. februar 2019. Klassene 2003 til 2008",
  ),
  { from: "28.02.2018", to: "27.02.2019" },
);
assert.deepEqual(parseTitle("LÅMØ 2027"), { kind: "LÅMØ", year: 2027 });
assert.deepEqual(parseTitle(" ÅM 2026 "), { kind: "ÅM", year: 2026 });
assert.equal(parseTitle("Sammenlagt"), null);
assert.deepEqual(parseClassLabel("2015 - Para"), { born: 2015, para: true });
assert.deepEqual(parseClassLabel("2011"), { born: 2011, para: false });
assert.equal(parseClassLabel("Vis uavhengig av klasse"), null);

/* The grid: events after "Poeng", the rank before "Navn", ids from links. */
const tid = parseGrid(HEADER, [
  row(1, "60001", "Åsmund Faag", "Sandnes SLK", 3060,
    ["3.58,20", "55,58", "2.02,61", "2.31,38", "2.10,35"], ["1", "2", "3", "4", "5"]),
  row(48, "34420", "Henrik Daniloff Emblemsvåg", "Nordlysbyen SLK", 1832,
    ["4.47,91", "1.11,96", "2.33,71", "2.39,14", "2.29,40"], ["4131316"]),
  row(96, "34975", "Borgar Rinaldo Trondsen Sørnes", "Vardø SK", 1364,
    ["", "1.06,26", "2.36,83", "2.53,38", "2.33,85"]),
  { texts: ["", "", "Antall = 3"], hrefs: [] },
]);
assert.deepEqual(tid.events, HEADER.slice(7));
assert.equal(tid.rows.length, 3, "the footer row is not a swimmer");
assert.equal(tid.rows[1].id, "34420");
assert.equal(tid.rows[1].rank, 48);
assert.equal(tid.rows[1].cells[0].pid, "4131316");
assert.equal(tid.rows[2].cells[0], null, "a blank event is null");

/* The same page read twice (a failed GotoPage) doesn't double the swimmers. */
const henrikRow = row(48, "34420", "Henrik Daniloff Emblemsvåg", "Nordlysbyen SLK", 1832,
  ["4.47,91", "1.11,96", "2.33,71", "2.39,14", "2.29,40"]);
assert.equal(parseGrid(HEADER, [henrikRow, henrikRow, henrikRow]).rows.length, 1);

/* Joining Tid and Poeng: points per swim, and totals checked. */
const poeng = parseGrid(HEADER, [
  row(1, "60001", "Åsmund Faag", "Sandnes SLK", 3060, ["612", "640", "598", "590", "620"]),
  row(48, "34420", "Henrik Daniloff Emblemsvåg", "Nordlysbyen SLK", 1832, ["400", "330", "352", "430", "320"]),
  row(96, "34975", "Borgar Rinaldo Trondsen Sørnes", "Vardø SK", 1364, ["", "380", "341", "300", "343"]),
]);
const merged = mergeViews(tid, poeng, {
  classId: 141,
  gender: "M",
  para: false,
  districtOf: (club) => ({ "Nordlysbyen SLK": 6, "Vardø SK": 6, "Sandnes SLK": 9 })[club] ?? null,
});
assert.deepEqual(merged.problems, []);
const henrik = merged.rows.find((r) => r.id === "34420");
assert.equal(henrik.district, 6);
assert.deepEqual(henrik.swims[0], { time: "4.47,91", points: 400, pid: "4131316" });
assert.equal(merged.rows[2].swims[0], null);

/* A total that doesn't add up is reported, not dropped. */
const off = mergeViews(tid, parseGrid(HEADER, [
  row(48, "34420", "Henrik Daniloff Emblemsvåg", "Nordlysbyen SLK", 1832, ["1", "1", "1", "1", "1"]),
]), { classId: 141, gender: "M", para: false, districtOf: () => null });
assert.equal(off.rows.length, 3);
assert.equal(off.problems.length, 3, "two missing from Poeng, one bad total");

/* ÅM's "Påmeldt": text, a checkbox or an icon. */
assert.equal(isEntered("", null), false);
assert.equal(isEntered("Ja", null), true);
assert.equal(isEntered("Nei", null), false);
assert.equal(isEntered("", "checked"), true);
assert.equal(isEntered("", "unchecked"), false);
assert.equal(isEntered("", "dxICheckBox dxWeb_edtCheckBoxChecked"), true);
assert.equal(isEntered("", "dxICheckBox dxWeb_edtCheckBoxUnchecked"), false);
assert.equal(isEntered("", "ok.png Påmeldt"), true);

console.log("laamo: all tests passed");
