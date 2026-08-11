# medley-svommer-scraper

Collects swimming race statistics from [medley.no](https://www.medley.no/).

## Backfill-only mode (`BACKFILL_ONLY=1`)

When no meets are scheduled, the licensed incremental batch has nothing new to
find. `BACKFILL_ONLY=1` skips it and spends the **entire run** backfilling
non-licensed ("old") swimmers' full race history, with periodic checkpoints so
progress survives a kill. Set it back to `0` to resume normal incremental
scraping.
