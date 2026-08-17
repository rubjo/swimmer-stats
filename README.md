# medley-svommer-scraper

Collects swimming race statistics from [medley.no](https://www.medley.no/).

## Backfill-only mode (`BACKFILL_ONLY=1`)

When no meets are scheduled, the licensed incremental batch has nothing new to
find. `BACKFILL_ONLY=1` skips it and spends the **entire run** backfilling
non-licensed ("old") swimmers' full race history, with periodic checkpoints so
progress survives a kill. Set it back to `0` to resume normal incremental
scraping.

## Confirmed-empty swimmers (`data/checked-empty.json`)

Many non-licensed swimmers have no races at all (retired officials, duplicate
profiles, never-competed registrations). These are deliberately never written
as swimmer files, so they stay out of the total swimmer count — which counts
only swimmers with actual races.

To stop them from being re-discovered and re-scraped on every run, each one is
recorded in `data/checked-empty.json` the first time backfill confirms it has 0
races. This ledger is subtracted from the backfill candidate pool but never
feeds the index, so an empty swimmer is checked exactly once and never counted.

The verdict is permanent by design. To re-check previously-empty swimmers (e.g.
if an old swimmer starts competing), run once with `FORCE_RECHECK_EMPTY=1` or
delete `data/checked-empty.json`.

`scripts/prune-zero-race.js --apply` removes any legacy zero-race files created
by older runs and seeds their ids into this ledger, so pruning them doesn't
re-expose them as candidates.

## data/index.json and merge driver

The file `data/index.json` is a generated artifact. To avoid merge conflicts in
commits produced by concurrent CI jobs, this repository now declares a merge
strategy for the generated index.

- The repository includes a `.gitattributes` entry that marks `data/index.json`
  to use the `ours` merge driver on merges.

- To enable the driver locally (and make merge behavior consistent), add the
  following to your local git config (or to `.git/config`):

```ini
[merge "ours"]
  name = Keep ours during merge
  driver = true
```

This tells Git to keep the current branch's copy of `data/index.json` during a
merge, which is appropriate because `data/index.json` is rebuilt by the merge
job and is not hand-edited.
