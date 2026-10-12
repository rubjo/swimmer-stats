/**
 * Duplicate-race detection, shared by the incremental scrape
 * (lib/swimmer.js) and the historical cleanup (scripts/dedupe-races.js).
 *
 * Background: when medley.no re-registers a stevne's results, every race in
 * it is re-issued with a NEW PID. The scraper deduplicates by PID, so the
 * old registration's rows linger in the swimmer file alongside the new ones.
 * Only the newest registration keeps tracking the ranking lists — the stale
 * rows froze at whatever RK/RA they had when scraped — so the correct row of
 * a duplicate group is the one with the HIGHEST RK/RA (rank numbers drift
 * upward as other swimmers overtake the time), with the highest PID as the
 * final tiebreak (PIDs are issued sequentially, so the re-issued row's is
 * always larger).
 *
 * Ranking lists only drift within the current season — once a year closes,
 * its data is frozen — so duplicates can only exist among current-year
 * races and the pass is scoped to those. Past years are left untouched.
 */

/** Parse the year out of a "DD.MM.YYYY" Dato. */
export function raceYear(dato) {
  const m = /(\d{4})\s*$/.exec(dato || "");
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Content identity of a race (everything but the PID). Two rows of the same
 * discipline with the same key but different PIDs are the same race stored
 * twice — one of them stale.
 *
 * `partOf` is included: without it, two D-rows of the same discipline with
 * byte-identical split times on the same day from *different* parent races
 * (e.g. the first 100 of a 100m final and of a 200m free) would be conflated.
 * A re-issued race gets its partOf re-derived identically by extractSplits,
 * so including it never misses a genuine duplicate.
 */
export function raceKey(race, distanse) {
  return [
    distanse ?? race.Distanse ?? "",
    race.Tid ?? "",
    race.Dato ?? "",
    race.Sted ?? "",
    race.Basseng ?? "",
    race.D || "",
    race.partOf || "",
  ].join("|");
}

const rankNum = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : -1;
};

const pidNum = (pid) => {
  const n = parseInt(pid, 10);
  return Number.isFinite(n) ? n : -1;
};

/**
 * Order two races of the same duplicate group, most-correct first.
 * Highest RA, then highest RK, then highest PID wins.
 */
export function compareRaceCorrectness(a, b) {
  return (
    rankNum(b.RA) - rankNum(a.RA) ||
    rankNum(b.RK) - rankNum(a.RK) ||
    pidNum(b.pid) - pidNum(a.pid)
  );
}

/**
 * Remove stale duplicate rows from an entry's disciplines, in place.
 * Returns the removed races (for logging):
 * `[{ distanse, kept: pid, stale: race }]`.
 *
 * Splits are carried over to the kept race if it lacks them and a stale
 * duplicate has them, so cleanup never loses split data.
 */
export function dedupeEntry(entry, currentYear = new Date().getFullYear()) {
  const removed = [];
  for (const disc of entry.disciplines || []) {
    const groups = new Map();
    for (const r of disc.races || []) {
      if (!r.pid || raceYear(r.Dato) !== currentYear) continue;
      const key = raceKey(r, disc.distanse);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push(r);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort(compareRaceCorrectness);
      const [kept, ...stale] = group;
      for (const dup of stale) {
        if (!kept.splits && dup.splits) kept.splits = dup.splits;
        disc.races.splice(disc.races.indexOf(dup), 1);
        removed.push({ distanse: disc.distanse, kept: kept.pid, stale: dup });
      }
    }
  }
  return removed;
}
