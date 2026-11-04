# US midterms 2026: chart data

Data for three Datawrapper charts: a Senate hexmap, a Senate seats bar and a House seats bar.
Election day is Tue 3 Nov 2026 (US). First polls close 6pm ET, which is **10am AEDT Wed 4 Nov**. Alaska closes last, at about 5pm AEDT.

## Files you'll upload / link

| File | Chart | Rows | Datawrapper match |
|---|---|---|---|
| `output/senate_map.csv` | Senate map | 50 states (DC left out: it has no senators) | Basemap **USA » States (hexagons)**. Match column `state_code` to key **Code** |
| `output/senate_bar.csv` | Senate bar | 1 | Stacked bar. 51 seats for a Dem majority, 50 for a Rep majority (VP Vance breaks ties) |
| `output/house_bar.csv` | House bar | 1 | Stacked bar. 218 for a majority |

Every CSV also has a matching `.json` file next to it (e.g. `output/senate_map.json`, `data/base/senate_base.json`), written at the same time. Each one is a list of rows, with the same columns in the same order. Number columns are real numbers and blank cells are `null`. Codes like `state_fips` stay as text, so `"01"` keeps its leading zero.


## The three Senate maps

All three use `output/senate_map.csv` on **USA » States (hexagons)**, matching `state_code` to the key **Code**. Each one colours by a different column:

| Map | Colour by | Values |
|---|---|---|
| Current Senate | `current_category` | Democratic, Republican, Split |
| Predicted | `forecast_category` | Safe D, Likely D, Lean D, Toss-up, Lean R, Likely R, Safe R, No election |
| Results | `result_category` | Democrat won, Republican won, Independent won, Democrat leading, Republican leading, Independent leading, Runoff, Awaiting results, No election |

Chart colours: Safe R `#b81f14`, Likely R `#d8352a`, Lean R `#e37169`, Toss-up `#ffc338`, Lean D `#6d76c5`, Likely D `#505aaf`, Safe D `#29339b`, No election `#d6d6da`, Independent `#7a4fb0`.

Independents (King, Sanders) count as Democratic in `current_category`, because they caucus with the Democrats.

## How it's organised

Everything is JavaScript and needs Node.js 22 or newer (already installed on this Mac). There's nothing to install.

| File | What it is |
|---|---|
| `src/midterms.js` | **All the logic**: settings, building the Senate base table, reading the results feed, the seat counts, CSV/JSON. It doesn't read or write files, so the local runner and the Worker share it |
| `src/run.js` | Runs it **on your computer**: downloads sources and writes `data/` and `output/` |
| `.github/workflows/update.yml` | Runs it **on GitHub** every 5 minutes and publishes to the `data` branch |
| `worker/` | The old Cloudflare Worker (no longer used) |
| `data/sources/` | Downloaded sources (Wikipedia, senators) |
| `data/base/senate_base.csv` | Everything that doesn't change on election night. Built from `data/sources/` |
| `data/manual_overrides.csv` | Races you call by hand |

## Running it on your computer

From the project folder:

| Command | What it does |
|---|---|
| `npm run sources` | Re-downloads ratings, candidates and senators, then rebuilds everything |
| `npm run base` | Rebuilds `data/base/senate_base.csv` from the files already in `data/sources/` |
| `npm run update` | Fetches the live results once and writes `output/`, plus a zip of it at `output_zip/output.zip` |
| `npm run watch` | Same, every 60 seconds, until you press Ctrl+C |
| `npm run push` | `update`, then publishes the chart files to GitHub (see below) |
| `npm run watch:push` | Same, every 60 seconds |
| `npm run offline` | Rebuilds `output/` without fetching (base data + manual overrides only) |

Each live fetch also saves a copy of the feed in `data/live/`. To rebuild from saved feed files instead of fetching, run:
`node src/run.js update --senate-file data/live/latest-senate.json --house-file data/live/latest-house.json`

## How the forecast works

- **`consensus_rating`** averages **Cook, Inside Elections and Sabato**. Each rating is scored Safe ±3, Likely ±2, Lean ±1, Tilt ±0.5, Toss-up 0 (D negative, R positive). The average is rounded back to a rating: under 0.5 is Toss-up, under 1.5 Lean, under 2.5 Likely, otherwise Safe.
- **`marginal`** = consensus is Toss-up or Lean. To change this, edit `MARGINAL_RATINGS` in `src/midterms.js`.
- **`all_raters_rating`** uses the same method across all 11 forecasters on Wikipedia's table (Cook, DDHQ, Economist, FiftyPlusOne, Fox, IE, NBC, RCP, Sabato, Silver Bulletin, Split Ticket), for comparison. Each one is also its own `rating_*` column.
- **`predicted_flip`** = the consensus favours the party that doesn't hold the seat.

## GitHub (hosted files, automatic updates)

The chart files are published to a branch called `data` in the GitHub repo, which holds nothing else. Datawrapper links to the raw files:

```
https://raw.githubusercontent.com/<you>/<repo>/data/senate_map.csv
https://raw.githubusercontent.com/<you>/<repo>/data/senate_bar.csv
https://raw.githubusercontent.com/<you>/<repo>/data/house_bar.csv
```

(and the same names ending `.json`). GitHub caches these for up to 5 minutes.

Two things update the branch:

- **GitHub Actions** (`.github/workflows/update.yml`) runs every 5 minutes without your laptop. GitHub often runs scheduled jobs late when it's busy, so treat it as the backup. Run it straight away from **Actions → Update results → Run workflow**. Turn it off from the same page (**••• → Disable workflow**).
- **`npm run watch:push`** on your computer updates every minute. Use this on election night.

Both are safe to run at once. Each push replaces the branch with one fresh commit, so the repo doesn't grow. If a feed fetch fails, nothing is pushed, and the last good files stay up.

The repo must be **public** for the raw links to work without a login. It's also free for Actions minutes when public.

### One-time setup

1. On github.com, click **New repository**. Name it (e.g. `us-midterms-2026`), set it to **Public**, and don't add a README, .gitignore or licence.
2. From the project folder, connect it and push (GitHub shows these lines too):
   ```
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. `npm run push` publishes the first copy of the files. Open one of the raw links above to check.
4. In the repo on GitHub, open the **Actions** tab and enable workflows if it asks.

### Calling a race by hand

Edit `data/manual_overrides.csv` (format in the runbook below). Then either commit and push it to `main`, so the next Actions run picks it up, or just run `npm run push` on your computer. If you only do it locally, the next Actions run will publish without your override until you push it to `main`. So do both.

## Cloudflare Worker (no longer used)

Kept for reference. It was retired because the free address was flooded with outside requests.

The Worker fetches the results on a schedule and serves the chart files at a public web address. Link Datawrapper to that address and the charts update by themselves, without your laptop.

- **Schedule:** no automatic fetches until **10am AEDT Wed 4 Nov** (when the first polls close). Then every 5 minutes until midnight AEDT at the end of Sat 7 Nov, then hourly for late calls. It switches automatically. To change the times, edit `FAST_START` / `FAST_END` (in UTC) in `worker/wrangler.toml` and redeploy. Before the start, the chart files still work: they show the Senate base data with every race "Awaiting results".
- **Files:** `/senate_map.csv`, `/senate_bar.csv`, `/house_bar.csv`, plus the same names ending `.json`. They're identical to what `npm run update` writes.
- **Status page:** the root address `/` shows when it last fetched, the seat counts, and any errors or warnings.

### One-time setup

You need a free Cloudflare account. From the project folder:

```
npx wrangler login                                                # sign in to Cloudflare in your browser
npx wrangler kv namespace create RESULTS                          # prints an id: paste it into worker/wrangler.toml
npx wrangler secret put REFRESH_TOKEN --config worker/wrangler.toml   # make up a password for /refresh
npm run worker:deploy                                             # prints your address, e.g. https://us-midterms-2026.<you>.workers.dev
```

Then open `https://us-midterms-2026.<you>.workers.dev/refresh?token=<your password>` once to check it can fetch the feed. Before 10am AEDT on 4 Nov it only fetches when you do this.

### In Datawrapper

On the **Upload data** step, choose **Link external dataset** and paste the CSV address (e.g. `…workers.dev/senate_map.csv`).

### Troubleshooting the Worker

- `npm run worker:dev` runs the Worker on your computer at `http://localhost:8787`, with its own local storage (separate from the live Worker's). First create a file `worker/.dev.vars` containing `REFRESH_TOKEN=test`. Then visit `http://localhost:8787/refresh?token=test` to make it fetch, and open `/` or `/senate_map.csv`.
- `npm run worker:logs` shows the live Worker's activity as it happens.
- If the Worker shows an error, `npm run update` on your computer tells you whether the problem is the NYT feed or Cloudflare.

## Election-night runbook

1. **Before polls close:** `npm run sources`, check the `CHECK:` lines it prints, then commit and push to `main`. This brings in the latest ratings, candidates and senators.
2. **Start the updates:** `npm run watch:push` and leave it running. GitHub Actions keeps going as a backup if the laptop sleeps.
3. **Check it's working:** open a raw link (or the `data` branch on GitHub). `last_refreshed` should be recent.
4. **Feed broken or slow? Call races by hand** in `data/manual_overrides.csv`. These always win over the feed:
   ```
   chamber,key,winner_name,winner_party,note
   senate,ME,Susan Collins,R,AP call 11:42
   house,CA-1,Doug LaMalfa,R,AP call
   ```
   `key` = state code for the Senate, state-district for the House (e.g. `CA-1`; at-large seats are `-1`, e.g. `AK-1`). `winner_party` = D / R / I.
   Then commit and push it to `main` (for Actions). `watch:push` picks it up on its next run.

## Sources

- **Live results:** AP-sourced JSON that the New York Times publishes for its results pages (`static01.nyt.com/elections-assets/pages/data/2026-11-03/results-{senate,house}.json`). Unofficial and free. The AP's race calls come through in the same files.
- **Races, nominees, ratings:** Wikipedia, [2026 United States Senate elections](https://en.wikipedia.org/wiki/2026_United_States_Senate_elections). Ratings are dated 15–27 Oct 2026.
- **Sitting senators:** [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators).
- **State codes and FIPS:** built into `src/midterms.js`.

## Caveats

- **The NYT feed is unofficial.** It isn't documented, and it could change format or block requests (including from GitHub's servers: check the Actions tab for failed runs). The 2026 files went live on 29 Oct and have the same structure as 2022 and 2024. If the address changes, edit `nytUrl` in `src/midterms.js`. Have someone ready to use the manual overrides file.
- **Wikipedia is crowd-edited.** Spot-check the Toss-up / Lean races against cookpolitical.com, insideelections.com and centerforpolitics.org before publishing.
- **Hand fixes** in `src/midterms.js`: Alaska's nominees (Peltola D vs Sullivan R; Wikipedia's infobox is blank because of the top-four primary). Minnesota's DFL is treated as Democratic.
- **Appointed senators:** Oklahoma (Alan Armstrong, not running) and South Carolina (Darline Graham, running) have appointees in the seats up this year. Both appear consistently in both sources.
- **Independents:** King and Sanders are counted with the Democrats in the Senate bar, since they caucus with them. A newly elected independent (e.g. Dan Osborn, NE) goes in `Independents (won)`, because their caucus isn't known.
- **Georgia** can go to a 1 Dec runoff, and **Alaska** uses ranked-choice voting, so these may stay uncalled for days.
