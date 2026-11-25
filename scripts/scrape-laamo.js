#!/usr/bin/env node
/**
 * Scrape the LÅMØ / ÅM lists (medley.no/sl.aspx?slid=N) into
 * data/laamo/<slid>.json, plus data/laamo/index.json listing them all. The
 * format is documented in lib/laamo.js.
 *
 *   node scripts/scrape-laamo.js            the two newest lists (daily run)
 *   node scripts/scrape-laamo.js 17 16      these lists
 *   node scripts/scrape-laamo.js --all      every list in medley's menu (backfill)
 *   node scripts/scrape-laamo.js --index    rebuild <slid>/<born>.json + index.json only
 *
 * The page is DevExpress: the filters are combos and radios whose change
 * handlers call grdAam.PerformCallback() (a partial-page POST), and clicking
 * their DOM does nothing. So values are set through the DevExpress client
 * API and RaiseValueChangedEvent(), which runs those handlers, and the grid
 * is read once it is out of its callback. Per list:
 *   - each district (6–12) once, for its club list: club → district;
 *   - "Vis uavhengig av landsdel", then per gender every class in the Tid
 *     view and again in the Poeng view (~40 callbacks, ~400 kB each).
 * A list whose scrape fails or comes back empty keeps its previous file and
 * the run exits non-zero.
 */

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import {
  mergeViews,
  parseClassLabel,
  parseGrid,
  parsePeriod,
  parseTitle,
} from "../lib/laamo.js";

const BASE = "https://www.medley.no/sl.aspx";
const OUT_DIR = path.resolve("data/laamo");
const GENDERS = [
  { radio: "rbDamer", gender: "F" },
  { radio: "rbHerrer", gender: "M" },
];

const log = (...a) => console.log(...a);

/** Wait until neither the grid nor the club combo is in a callback. */
async function settle(page) {
  await new Promise((r) => setTimeout(r, 150));
  await page.waitForFunction(
    () =>
      ["grdAam", "cmbKlubb"].every(
        (n) => !ASPxClientControl.GetControlCollection().GetByName(n)?.InCallback?.(),
      ),
    { polling: 100, timeout: 90_000 },
  );
}

async function setCombo(page, name, value) {
  const changed = await page.evaluate(
    (name, value) => {
      const c = ASPxClientControl.GetControlCollection().GetByName(name);
      if (String(c.GetValue()) === String(value)) return false;
      const i = [...Array(c.GetItemCount()).keys()].find(
        (i) => String(c.GetItem(i).value) === String(value),
      );
      if (i == null) throw new Error(`${name} has no item ${value}`);
      c.SetSelectedIndex(i);
      c.RaiseValueChangedEvent();
      return true;
    },
    name,
    value,
  );
  if (changed) await settle(page);
}

async function setRadio(page, name) {
  const changed = await page.evaluate((name) => {
    const c = ASPxClientControl.GetControlCollection().GetByName(name);
    if (c.GetChecked()) return false;
    c.SetChecked(true);
    c.RaiseValueChangedEvent();
    return true;
  }, name);
  if (changed) await settle(page);
}

async function comboItems(page, name) {
  return page.evaluate((name) => {
    const c = ASPxClientControl.GetControlCollection().GetByName(name);
    return [...Array(c.GetItemCount()).keys()].map((i) => ({
      value: c.GetItem(i).value,
      text: c.GetItem(i).text,
    }));
  }, name);
}

/**
 * The grid's header and data rows as text + link per cell. The grid shows
 * every row on one page even though GetPageCount() reports pages of 10, and
 * GotoPage() then fails on the server ("Callback mislyktes pga intern
 * serverfeil") and leaves the same page up. So the page is read once, and
 * paged only if it holds fewer swimmers than the footer's "Antall".
 */
async function readGrid(page) {
  const first = await readGridPage(page);
  if (first.footer == null || linkedRows(first.rows) >= first.footer) return first;

  const pages = await page.evaluate(
    () => ASPxClientControl.GetControlCollection().GetByName("grdAam").GetPageCount?.() || 1,
  );
  const rows = [...first.rows];
  for (let p = 1; p < pages && linkedRows(rows) < first.footer; p++) {
    await page.evaluate((p) => ASPxClientControl.GetControlCollection().GetByName("grdAam").GotoPage(p), p);
    await settle(page);
    rows.push(...(await readGridPage(page)).rows);
  }
  return { ...first, rows };
}

/**
 * Grid rows that link to a swimmer: what the footer's "Antall" counts. Not
 * distinct swimmers, since one swimmer can have two rows; counting distinct
 * ones made a 279-row grid look short and sent it paging (server errors).
 */
function linkedRows(rows) {
  return rows.filter((r) => r.hrefs.some((h) => /svommer\.aspx\?id=\d+/.test(h || ""))).length;
}

async function readGridPage(page) {
  const part = await page.evaluate(() => {
    const grid = document.getElementById("grdAam_DXMainTable");
    if (!grid) return null;
    const cells = (tr) => [...tr.cells];
    const trs = [...grid.rows];
    // The header is in the grid's own table unless DevExpress renders it
    // apart; then take the page's (a container row holding the whole grid
    // also "includes" Navn and Poeng, hence the cell-count limit).
    const isHead = (tr) => {
      const t = cells(tr).map((td) => td.innerText.trim());
      return tr.cells.length < 30 && t.includes("Navn") && t.includes("Poeng");
    };
    const head = trs.find(isHead) || [...document.querySelectorAll("tr")].find(isHead);
    const header = head ? cells(head).map((td) => td.innerText.trim()) : null;
    const rows = trs
      .filter((tr) => /DXDataRow/.test(tr.id) || (header && tr.cells.length === header.length && tr !== head))
      .map((tr) => ({
        texts: cells(tr).map((td) => td.innerText.trim()),
        hrefs: cells(tr).map((td) => td.querySelector("a[href]")?.getAttribute("href") || null),
        // What a cell shows besides text (ÅM's "Påmeldt" is not text): a
        // checkbox's state or class, an image's title / alt / file name.
        marks: cells(tr).map((td) => {
          const box = td.querySelector("input[type=checkbox]");
          if (box) return box.checked ? "checked" : "unchecked";
          const icon = td.querySelector("[class*=heck], img, svg");
          if (!icon) return null;
          return [icon.getAttribute("class"), icon.getAttribute("title"), icon.getAttribute("alt"), icon.getAttribute("src")]
            .filter(Boolean)
            .join(" ") || "icon";
        }),
      }));
    const footer = grid.innerText.match(/Antall\s*=\s*(\d+)/)?.[1];
    return { header, rows, footer: footer ? Number(footer) : null };
  });
  if (!part?.header) throw new Error("no grid header");
  return part;
}

/** The list's title and info text, from the page. */
async function readMeta(page) {
  return page.evaluate(() => {
    // Not the menu: it names every list ("ÅM 2026", "LÅMØ 2025", …).
    const els = [...document.querySelectorAll("td, div, span, h1, h2, h3")].filter(
      (el) => !el.closest("a, li, nav, ul"),
    );
    const title = els
      .map((el) => el.innerText?.trim())
      .find((t) => /^(LÅMØ|ÅMØ|ÅM)\s+\d{4}$/i.test(t || ""));
    // The info is several paragraphs in one cell; the smallest element that
    // starts with "Listen inneholder" is only its first line. Take the
    // DevExpress info panel's text, else the largest such element that is
    // still above the filters ("Landsdel:").
    const panel = ASPxClientControl.GetControlCollection().GetByName("panInfo")?.GetMainElement?.();
    const fromPanel = panel?.innerText.trim().replace(/^Info\s*/, "");
    const info =
      (/Listen inneholder/i.test(fromPanel || "") && fromPanel) ||
      els
        .map((el) => el.innerText?.trim() || "")
        .filter((t) => /^Listen inneholder/i.test(t) && !/Landsdel:/.test(t))
        .sort((a, b) => b.length - a.length)[0];
    return { title: title || null, info: info || "" };
  });
}

/** Every list in medley's menu: [{ slid, text }], newest first. */
async function listSlids(page) {
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="sl.aspx?slid="]')].map((a) => ({
      slid: Number(a.getAttribute("href").match(/slid=(\d+)/)[1]),
      text: a.innerText.trim(),
    })),
  );
  const bySlid = new Map(seen.map((s) => [s.slid, s]));
  return [...bySlid.values()].sort((a, b) => b.slid - a.slid);
}

/** Every LÅMØ list on disk that has districts. */
function laamoLists() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf-8")))
    .filter((l) => l.kind === "LÅMØ" && l.districts?.length);
}

/**
 * The LÅMØ list on disk closest in year (the ÅM of a year takes its
 * districts from it): the same year, else the nearest, earlier on a tie.
 * Not the newest: the districts changed (5 until LÅMØ 2025, 7 since), so ÅM
 * 2018 has to come from LÅMØ 2019, not 2027.
 */
function laamoListFor(year) {
  const lists = laamoLists().sort(
    (a, b) => Math.abs(a.year - year) - Math.abs(b.year - year) || a.year - b.year,
  );
  return lists[0] || null;
}

/** The district ids a list uses, as a key: "1,2,3,4,5" or "6,…,12". */
const districtKey = (districts) => districts.map((d) => d.id).join(",");

/**
 * Clubs that no longer exist, so neither medley's club combo nor any list
 * gives their district. By the club's home town, under the five districts
 * used until LÅMØ 2025 (the only lists they appear in). Matched by district
 * name, so the ids don't matter.
 */
const CLOSED_CLUBS = {
  "Austevoll IL": "Vest",
  "Stord IL": "Vest",
  "Stord Symjing": "Vest",
  "Haugesund Triathlonklubb": "Vest",
  "Mysen SK": "Øst",
  "Kattem IL": "Midt",
  "Nordlysbyen STK": "Nord",
};

/**
 * club → district from the rows of the other LÅMØ lists with the same
 * districts, then CLOSED_CLUBS. The club combo only offers clubs that exist
 * today, so a club that has since closed or merged has no district in its
 * own list; another year that has it fills it in.
 */
function clubDistrictsFromOtherLists(districts, slid) {
  const key = districtKey(districts);
  const map = new Map();
  for (const l of laamoLists()) {
    if (l.slid === slid || districtKey(l.districts) !== key) continue;
    for (const r of l.rows) if (r.district != null && !map.has(r.club)) map.set(r.club, r.district);
  }
  for (const [club, name] of Object.entries(CLOSED_CLUBS)) {
    const d = districts.find((d) => d.name === name);
    if (d && !map.has(club)) map.set(club, d.id);
  }
  return map;
}

/**
 * ÅM lists have a second "Vis" pair, Alle / Kun påmeldte, under names this
 * script doesn't know. Pick the radio whose text is "Alle", so the list holds
 * every qualified swimmer and the "Påmeldt" column says who entered.
 */
async function chooseAll(page) {
  const radios = await page.evaluate(() => {
    const known = new Set(["rbDamer", "rbHerrer", "rbTid", "rbPoeng"]);
    const out = [];
    ASPxClientControl.GetControlCollection().ForEachControl((c) => {
      if (typeof c.SetChecked !== "function" || known.has(c.name)) return;
      const el = c.GetMainElement?.();
      const text = (c.GetText?.() || el?.innerText || el?.closest("td")?.innerText || "").trim();
      out.push({ name: c.name, text, checked: c.GetChecked() });
    });
    return out;
  });
  if (!radios.length) return;
  log(`  other radios: ${radios.map((r) => `${r.name} "${r.text}"${r.checked ? " ✓" : ""}`).join(", ")}`);
  const all = radios.find((r) => /^alle$/i.test(r.text)) || radios.find((r) => /alle/i.test(r.text));
  if (all && !all.checked) await setRadio(page, all.name);
}

async function scrapeList(page, slid) {
  await page.goto(`${BASE}?slid=${slid}`, { waitUntil: "networkidle2", timeout: 90_000 });
  const meta = await readMeta(page);
  const parsed = parseTitle(meta.title);
  if (!parsed) throw new Error(`slid ${slid}: no LÅMØ/ÅM title (got ${meta.title})`);
  log(`slid ${slid}: ${meta.title}`);

  // Districts and their clubs. ÅM is national and its page has no district
  // combo; its clubs get their district from the LÅMØ list of the same year
  // (ÅM 2026 ← LÅMØ 2026), else the newest LÅMØ list on disk.
  const hasDistricts = await page.evaluate(
    () => !!ASPxClientControl.GetControlCollection().GetByName("cmbLandsdel"),
  );
  let districts = [];
  const clubDistrict = new Map();
  if (hasDistricts) {
    districts = (await comboItems(page, "cmbLandsdel"))
      .filter((d) => String(d.value) !== "0")
      .map((d) => ({ id: Number(d.value), name: d.text }));
    for (const d of districts) {
      await setCombo(page, "cmbLandsdel", d.id);
      for (const c of await comboItems(page, "cmbKlubb")) {
        if (String(c.value) !== "0") clubDistrict.set(c.text, d.id);
      }
    }
    // The session keeps the last filters (a browser came back still filtered
    // to one club), so the club is reset as well as the district.
    await setCombo(page, "cmbLandsdel", 0);
  } else {
    const source = laamoListFor(parsed.year);
    if (source) {
      districts = source.districts;
      for (const r of source.rows) if (r.district != null) clubDistrict.set(r.club, r.district);
      log(`  districts from ${source.title}`);
    } else {
      log("  no LÅMØ list on disk to take districts from; scrape one first");
    }
  }
  log(`  ${districts.length} districts, ${clubDistrict.size} clubs`);
  await setCombo(page, "cmbKlubb", 0);
  await chooseAll(page);

  const classItems = (await comboItems(page, "cmbKlasse"))
    .map((c) => ({ id: Number(c.value), label: c.text, ...parseClassLabel(c.text) }))
    .filter((c) => c.born);

  const classes = [];
  const rows = [];
  const problems = [];
  const unmapped = new Set();
  const enteredSamples = [];
  const fallback = clubDistrictsFromOtherLists(districts, slid);
  const districtOf = (club) => {
    if (clubDistrict.has(club)) return clubDistrict.get(club);
    if (fallback.has(club)) return fallback.get(club);
    // Swimmers registered abroad belong to no district.
    if (club !== "Utlandet") unmapped.add(club);
    return null;
  };

  for (const { radio, gender } of GENDERS) {
    await setRadio(page, radio);
    const views = { Tid: new Map(), Poeng: new Map() };
    for (const view of ["Tid", "Poeng"]) {
      await setRadio(page, `rb${view}`);
      for (const c of classItems) {
        await setCombo(page, "cmbKlasse", c.id);
        const grid = await readGrid(page);
        const g = parseGrid(grid.header, grid.rows);
        const col = grid.header.indexOf("Påmeldt");
        if (col >= 0 && enteredSamples.length < 5) {
          for (const r of grid.rows.slice(0, 5 - enteredSamples.length)) {
            enteredSamples.push({ text: r.texts[col], mark: r.marks?.[col] });
          }
        }
        // "Antall" counts rows, and a swimmer can have two (LÅMØ 2021, 2006
        // girls: 279 rows, 278 swimmers). parseGrid keeps the first, the
        // better-ranked one; the repeat is reported.
        const linked = linkedRows(grid.rows);
        if (grid.footer != null && grid.footer !== linked) {
          throw new Error(`${c.label} ${gender} ${view}: ${linked} rows, footer says ${grid.footer}`);
        }
        if (view === "Tid" && linked > g.rows.length) {
          problems.push(`${c.label} ${gender}: ${linked - g.rows.length} swimmer(s) listed twice, first row kept`);
        }
        views[view].set(c.id, g);
      }
    }
    await setRadio(page, "rbTid");
    for (const c of classItems) {
      const m = mergeViews(views.Tid.get(c.id), views.Poeng.get(c.id), {
        classId: c.id,
        gender,
        para: c.para,
        districtOf,
      });
      classes.push({ id: c.id, label: c.label, born: c.born, para: c.para, gender, events: m.events });
      rows.push(...m.rows);
      problems.push(...m.problems.map((p) => `${c.label} ${gender}: ${p}`));
      log(`  ${c.label} ${gender}: ${m.rows.length}`);
    }
  }

  if (unmapped.size) problems.push(`clubs with no district: ${[...unmapped].join(", ")}`);
  // A held ÅM has ~30 entered per class; none means "Påmeldt" wasn't read.
  if (enteredSamples.length && !rows.some((r) => r.entered)) {
    problems.push(`nobody marked "Påmeldt"; first cells: ${JSON.stringify(enteredSamples)}`);
  }
  const period = parsePeriod(meta.info);
  // LÅMØ lists state their period; the app's score chart needs both ends.
  if (parsed.kind === "LÅMØ" && !period?.to) {
    problems.push(`no complete period in the info text: ${JSON.stringify(meta.info.slice(0, 200))}`);
  }
  return {
    slid,
    ...parsed,
    title: meta.title,
    info: meta.info,
    period,
    scrapedAt: new Date().toISOString(),
    districts,
    classes,
    rows,
    problems,
  };
}

/**
 * The list split by birth year: data/laamo/<slid>/<born>.json, the list's
 * metadata with only that year's classes and rows (both genders, Para too).
 * The app loads these, not the whole list (up to ~0.9 MB): a swimmer needs
 * one per list, and the ranking modal one per class it shows.
 */
function writeParts(data) {
  const dir = path.join(OUT_DIR, String(data.slid));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { rows, classes, ...meta } = data;
  for (const born of bornYears(data)) {
    fs.writeFileSync(
      path.join(dir, `${born}.json`),
      JSON.stringify({
        ...meta,
        born,
        classes: classes.filter((c) => c.born === born),
        rows: rows.filter((r) => r.born === born),
      }),
    );
  }
}

const bornYears = (data) => [...new Set(data.classes.map((c) => c.born))].sort((a, b) => a - b);

function writeIndex() {
  const lists = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf-8")))
    .map((data) => {
      const { slid, kind, year, title, period, scrapedAt, rows } = data;
      // Lists scraped before the parts existed get them here.
      if (!fs.existsSync(path.join(OUT_DIR, String(slid)))) writeParts(data);
      return { slid, kind, year, title, period, scrapedAt, rows: rows.length, born: bornYears(data) };
    })
    .sort((a, b) => b.slid - a.slid);
  fs.writeFileSync(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), lists }, null, 2),
  );
}

const args = process.argv.slice(2);
fs.mkdirSync(OUT_DIR, { recursive: true });

// Rebuild the per-birth-year parts and index.json from the lists on disk,
// without touching medley.
if (args.includes("--index")) {
  for (const f of fs.readdirSync(OUT_DIR).filter((f) => /^\d+\.json$/.test(f))) {
    writeParts(JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf-8")));
  }
  writeIndex();
  log("rebuilt parts and index.json");
  process.exit(0);
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "Accept-Language": "nb-NO,nb;q=0.9" });
// Medley reports failed callbacks in an alert ("Callback mislyktes pga intern
// serverfeil"). The grid may then still show the previous filter's rows, so
// a list with any such alert is not written.
let serverErrors = 0;
page.on("dialog", (d) => {
  serverErrors++;
  log(`  dialog: ${d.message()}`);
  d.dismiss();
});

let failed = 0;
try {
  await page.goto(`${BASE}?slid=1`, { waitUntil: "networkidle2", timeout: 90_000 });
  const menu = await listSlids(page);
  const wanted = args.includes("--all")
    ? menu.map((m) => m.slid)
    : args.filter((a) => /^\d+$/.test(a)).map(Number).length
      ? args.filter((a) => /^\d+$/.test(a)).map(Number)
      : menu.slice(0, 2).map((m) => m.slid);
  // Oldest first: a year's LÅMØ (odd slid) is written before its ÅM (the
  // next slid), which takes its districts from it.
  const slids = [...new Set(wanted)].sort((a, b) => a - b);
  log(`lists: ${slids.join(", ")}`);

  for (const slid of slids) {
    // Medley's callbacks fail now and then; a fresh page load usually works.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        serverErrors = 0;
        const list = await scrapeList(page, slid);
        const { problems, ...data } = list;
        problems.forEach((p) => log(`  ! ${p}`));
        if (serverErrors) throw new Error(`${serverErrors} server error(s) from medley`);
        if (!data.rows.length) throw new Error("no rows");
        fs.writeFileSync(path.join(OUT_DIR, `${slid}.json`), JSON.stringify(data));
        writeParts(data);
        log(`  wrote ${slid}.json: ${data.rows.length} rows, ${problems.length} problem(s)`);
        break;
      } catch (e) {
        if (attempt < 2) {
          log(`  retrying slid ${slid}: ${e.message}`);
          continue;
        }
        failed++;
        console.error(`  ✗ slid ${slid}: ${e.message}`);
      }
    }
  }
  writeIndex();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
