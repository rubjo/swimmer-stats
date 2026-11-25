/**
 * Parsing for the LÅMØ / ÅM lists on medley.no/sl.aspx?slid=N. No browser
 * code here: scripts/scrape-laamo.js reads the grid's cells out of the page
 * and hands them to these functions, so they can be tested on plain arrays
 * (scripts/test-laamo.js).
 *
 * Output, one file per list (data/laamo/<slid>.json):
 *   {
 *     slid, kind: "LÅMØ" | "ÅM", year, title, info,
 *     period: { from: "DD.MM.YYYY", to } | null,
 *     scrapedAt,
 *     districts: [{ id, name }],
 *     classes: [{ id, label, born, para, gender: "F" | "M", events: ["400m Fri", …] }],
 *     rows: [{
 *       id, name, club, born, para, gender, classId, district, rank, total,
 *       entered,                      // ÅM only: true / false ("Påmeldt"), else null
 *       swims: [{ time, points, pid } | null, …]   // aligned to the class's events
 *     }]
 *   }
 * `rank` is medley's national rank within class and gender (the list is
 * scraped with "Vis uavhengig av landsdel"); `district` comes from the club
 * list each district's filter offers.
 */

const MONTHS = {
  januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

const pad = (n) => String(n).padStart(2, "0");

/** "1. april 2026" → "01.04.2026", or null. */
function norDate(s) {
  const m = String(s || "").match(/(\d{1,2})\.\s*([a-zæøå]+)\s+(\d{4})/i);
  const mon = m && MONTHS[m[2].toLowerCase()];
  return mon ? `${pad(m[1])}.${pad(mon)}.${m[3]}` : null;
}

/**
 * The qualifying period from the list's info text. LÅMØ: "Listen inneholder
 * tider oppnådd fom 1. april 2026 … varer til 31. mars 2027", or until 2020
 * "Kvalifiseringsperioden … er 28. februar 2018 til 27. februar 2019". ÅM
 * lists say "tider oppnådd under LÅMØ 2026" and have no period (null).
 */
export function parsePeriod(info) {
  const text = String(info || "").replace(/\s+/g, " ");
  const DATE = "(\\d{1,2}\\.\\s*[a-zæøå]+\\s+\\d{4})";
  const from = norDate(text.match(new RegExp(`(?:fom|fra og med|startet)\\s+${DATE}`, "i"))?.[1]);
  if (!from) return null;
  const to = norDate(
    text.match(new RegExp(`(?:varer til|til og med|tom)\\s+${DATE}`, "i"))?.[1] ??
      text.match(new RegExp(`${DATE}\\s+til\\s+${DATE}`, "i"))?.[2],
  );
  return { from, to };
}

/** "LÅMØ 2027" / "ÅM 2026" → { kind, year }, or null. */
export function parseTitle(title) {
  const m = String(title || "").trim().match(/^(LÅMØ|ÅMØ|ÅM)\s+(\d{4})$/i);
  if (!m) return null;
  return { kind: /^LÅMØ$/i.test(m[1]) ? "LÅMØ" : "ÅM", year: Number(m[2]) };
}

/** A class combo item: "2015 - Para" → { born: 2015, para: true }. */
export function parseClassLabel(label) {
  const m = String(label || "").match(/^(\d{4})(\s*-\s*para)?\s*$/i);
  return m ? { born: Number(m[1]), para: Boolean(m[2]) } : null;
}

const SWIMMER_ID = /svommer\.aspx\?id=(\d+)/i;
const PID = /resultat\.aspx\?pid=(\d+)/i;
const EVENT = /^\d+\s*m\s/i;

/**
 * ÅM's "Påmeldt" cell → true / false. It may be text ("Ja", "X"), a
 * checkbox, or an icon (`mark`: what scrape-laamo.js found in the cell, e.g.
 * "dxWeb_edtCheckBoxChecked" or an image's title). An empty cell is false.
 */
export function isEntered(text, mark) {
  const t = String(text || "").trim();
  if (t) return !/^(nei|no|-|0|false)$/i.test(t);
  if (!mark) return false;
  if (/unchecked|nei|ikke/i.test(mark)) return false;
  return true;
}

/**
 * One view of the grid (Tid or Poeng) as rows of cells.
 *   header: the header row's texts, e.g.
 *     ["", "", "Navn", "Navn", "Klubb", "Født", "Poeng", "400m Fri", …, "Påmeldt"]
 *   rows: [{ texts: [...], hrefs: [...] }], one entry per cell
 * Returns { events, rows: [{ id, name, club, born, rank, total, entered,
 * cells: [{ text, pid } | null] }] }, cells aligned to `events`.
 */
export function parseGrid(header, rows) {
  const name = header.indexOf("Navn");
  const club = header.indexOf("Klubb");
  const born = header.indexOf("Født");
  const total = header.indexOf("Poeng");
  const entered = header.indexOf("Påmeldt");
  if (name < 0 || club < 0 || total < 0) {
    throw new Error(`unexpected header: ${JSON.stringify(header)}`);
  }
  const eventCols = header
    .map((h, i) => (i > total && EVENT.test(h) ? i : -1))
    .filter((i) => i >= 0);

  const out = [];
  const seen = new Set();
  for (const { texts, hrefs, marks } of rows) {
    const id = hrefs.map((h) => h?.match(SWIMMER_ID)?.[1]).find(Boolean);
    // A swimmer appears once per list; a repeat is the same page read twice.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rank = Number(texts[name - 1]);
    out.push({
      id,
      name: texts[name],
      club: texts[club],
      born: born >= 0 ? Number(texts[born]) || null : null,
      rank: Number.isFinite(rank) && rank > 0 ? rank : null,
      total: Number(texts[total]) || 0,
      entered: entered >= 0 ? isEntered(texts[entered], marks?.[entered]) : null,
      cells: eventCols.map((i) => {
        const text = (texts[i] || "").trim();
        if (!text) return null;
        return { text, pid: hrefs[i]?.match(PID)?.[1] || null };
      }),
    });
  }
  return { events: eventCols.map((i) => header[i]), rows: out };
}

/**
 * Join a class's Tid and Poeng views on swimmer id into the output rows.
 * Returns { events, rows, problems } where problems lists rows whose total
 * is neither the sum of their points (LÅMØ) nor the sum less the weakest
 * (ÅM: best 4 of 5), and swimmers missing from one of the views.
 */
export function mergeViews(tid, poeng, { classId, gender, para, districtOf }) {
  const pts = new Map(poeng.rows.map((r) => [r.id, r]));
  const problems = [];
  const rows = tid.rows.map((r) => {
    const p = pts.get(r.id);
    if (!p) problems.push(`${r.name} (${r.id}) missing from the Poeng view`);
    const swims = r.cells.map((c, i) => {
      if (!c) return null;
      const points = Number(p?.cells[i]?.text);
      return { time: c.text, points: Number.isFinite(points) ? points : null, pid: c.pid };
    });
    const got = swims.map((s) => s?.points ?? 0);
    const sum = got.reduce((a, b) => a + b, 0);
    const bestFour = sum - Math.min(...got);
    if (p && r.total !== sum && r.total !== bestFour) {
      problems.push(`${r.name} (${r.id}): total ${r.total}, points sum ${sum}`);
    }
    return {
      id: r.id,
      name: r.name,
      club: r.club,
      born: r.born,
      para,
      gender,
      classId,
      district: districtOf(r.club),
      rank: r.rank,
      total: r.total,
      entered: r.entered,
      swims,
    };
  });
  return { events: tid.events, rows, problems };
}
