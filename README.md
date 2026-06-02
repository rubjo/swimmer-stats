# Medley Svømmer Scraper

Puppeteer-based scraper for [medley.no/svommer.aspx](https://www.medley.no/svommer.aspx).
Extracts all race data for every licensed swimmer and saves it as structured JSON.

Designed to run daily via **GitHub Actions**, with the resulting data served on **GitHub Pages**.

## How it works

1. Navigates to the swimmer page in a headless browser
2. Configures filters:
   - ✅ **Kun lisensiert 2026** — only 2026-licensed swimmers
   - **Fra dato** → `01.01.2000` — get complete history
   - ❌ **Vis kun første resultat pr distanse** — show all attempts
   - ✅ **Ikke vis deldistanser (D)** — hides split-distance rows
   - ✅ **Ikke vis førsteetapper (F)** — hides first-leg relay rows
3. Discovers all licensed swimmers via the dropdown
4. For each swimmer:
   - Selects them, exports CSV, parses the data
   - Expands each grid row's detail panel to extract meet name (`Stevne`) and split times
   - Groups races by discipline
5. Writes each swimmer to `data/swimmers/<club>/<name>.json`
6. Builds `data/index.json` — a searchable index of all swimmers

## Output structure

### Individual swimmer file (`data/swimmers/<club>/<name>.json`)

```json
{
  "swimmerId": "54831",
  "name": "Luka Yavorskyi",
  "club": "Mandal SK",
  "birthYear": 2009,
  "timestamp": "2026-06-02T12:00:00.000Z",
  "disciplines": [
    {
      "distanse": "800m Fri",
      "races": [
        {
          "Tid": "10.17,46",
          "Dato": "14.03.2026",
          "Sted": "Lillesand",
          "Basseng": "25m",
          "RK": "13",
          "RA": "89",
          "Stevne": "Agdermesterskapet 2026",
          "splits": ["29,26", "34,97", "37,73", "38,83"]
        }
      ]
    }
  ]
}
```

### Index (`data/index.json`)

A summary of all swimmers with name, club, birth year, and race count — used by the frontend.

## GitHub Actions

The scraper runs daily at 06:00 UTC via the workflow in `.github/workflows/scrape.yml`:

1. Checks out the repo (preserving existing data)
2. Runs the scraper to update/add swimmer files
3. Commits and pushes any data changes back
4. Deploys the `data/` directory to **GitHub Pages**

You can also trigger a run manually from the Actions tab.

## GitHub Pages

The `data/` directory is deployed as a static site with:

- **`index.json`** — machine-readable index of all swimmers
- **`swimmers/**`** — individual swimmer JSON files

The raw JSON files are accessible at their direct URLs.

Optionally add an `index.html` to the `data/` directory for a browsable frontend.

## Setup

1. Create a GitHub repository and push this code
2. In the repo Settings → Pages, set **Source** to **GitHub Actions**
3. The first run starts automatically (or trigger it manually from the Actions tab)

## Run locally

```bash
npm install
node index.js
```

Requires Node.js 20+ and a working internet connection.

## Notes

- Rate-limited (1.5–2.5 s between swimmers) to avoid hammering the server.
- CSV export is captured via CDP download handling.
- On re-run, swimmers scraped within the last 24 hours are skipped but their timestamp is refreshed.
- Swimmers without changes are skipped, but the timestamp is still bumped so the 24-hour window stays fresh.
