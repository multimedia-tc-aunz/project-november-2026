# US midterms 2026: chart data

Data for three Datawrapper charts: a Senate hexmap, a Senate seats bar and a House seats bar.
Election day is Tue 3 Nov 2026 (US). First polls close 6pm ET, which is **10am AEDT Wed 4 Nov**. Alaska closes last, at about 5pm AEDT.

## Files you'll upload / link

| File | Chart | Rows | Datawrapper match |
|---|---|---|---|
| `output/senate_map.csv` | Senate map | 50 states (DC left out: it has no senators) | Basemap **USA » States (hexagons)**. Match column `state_code` to key **Code** |
| `output/senate_bar.csv` | Senate bar | 1 | Stacked bar. 51 seats for a Dem majority, 50 for a Rep majority (VP Vance breaks ties) |
| `output/house_bar.csv` | House bar | 1 | Stacked bar. 218 for a majority |

Every CSV also has a matching `.json` file next to it (e.g. `output/senate_map.json`, `data/senate_base.json`), written at the same time. Each one is a list of rows, with the same columns in the same order. Number columns are real numbers and blank cells are `null`. Codes like `state_fips` stay as text, so `"01"` keeps its leading zero.


## The three Senate maps

All three use `output/senate_map.csv` on **USA » States (hexagons)**, matching `state_code` to the key **Code**. Each one colours by a different column and has its own tooltip in `datawrapper/`:

| Map | Colour by | Values | Tooltip |
|---|---|---|---|
| Current Senate | `current_category` | Democratic, Republican, Split | `tooltip_current.txt` |
| Predicted | `forecast_category` | Safe D, Likely D, Lean D, Toss-up, Lean R, Likely R, Safe R, No election | `tooltip_forecast.txt` |
| Results | `result_category` | Democrat won, Republican won, Independent won, Democrat leading, Republican leading, Independent leading, Runoff, Awaiting results, No election | `tooltip_results.txt` |

Colours used in the tooltips: Safe R `#b81f14`, Likely R `#d8352a`, Lean R `#e37169`, Toss-up `#ffc338`, Lean D `#6d76c5`, Likely D `#505aaf`, Safe D `#29339b`, No election `#d6d6da`, Independent `#7a4fb0`.

Independents (King, Sanders) count as Democratic in `current_category`, because they caucus with the Democrats.

To change a tooltip, edit its `datawrapper/tooltip_*.txt` file directly. Keep each `{{ … }}` expression on one line: Datawrapper can't read expressions that span lines.

## How the forecast works

- **`consensus_rating`** averages **Cook, Inside Elections and Sabato**. Each rating is scored Safe ±3, Likely ±2, Lean ±1, Tilt ±0.5, Toss-up 0 (D negative, R positive). The average is rounded back to a rating: under 0.5 is Toss-up, under 1.5 Lean, under 2.5 Likely, otherwise Safe.
- **`marginal`** = consensus is Toss-up or Lean. To change this, edit `MARGINAL_RATINGS` in `scripts/build_senate.py`.
- **`all_raters_rating`** uses the same method across all 11 forecasters on Wikipedia's table (Cook, DDHQ, Economist, FiftyPlusOne, Fox, IE, NBC, RCP, Sabato, Silver Bulletin, Split Ticket), for comparison. Each one is also its own `rating_*` column.
- **`predicted_flip`** = the consensus favours the party that doesn't hold the seat.

## Election-night runbook

1. **Morning of (AEDT 4 Nov), before polls close:** `sh scripts/refresh_sources.sh`. This re-pulls ratings, candidates and senators, then rebuilds everything.
2. **Check the feed is live:** `python3 scripts/update_results.py`. If it prints `could not fetch ... 404`, the NYT files aren't up yet (or the URL changed: see Caveats).
3. **Run continuously:** `python3 scripts/update_results.py --every 60`. It rewrites `output/*.csv` every minute. If a fetch fails, it keeps the last good data.
4. **Getting it into Datawrapper:** re-upload the CSVs from `output/` when something changes.
5. **Feed broken or slow? Call races by hand** in `data/manual_overrides.csv`. These always win over the feed:
   ```
   chamber,key,winner_name,winner_party,note
   senate,ME,Susan Collins,R,AP call 11:42
   house,CA-1,Doug LaMalfa,R,AP call
   ```
   `key` = state code for the Senate, state-district for the House (e.g. `CA-1`; at-large seats are `-1`, e.g. `AK-1`). `winner_party` = D / R / I.
   Then run `python3 scripts/update_results.py --offline` to rebuild without fetching.

## Sources

- **Live results:** AP-sourced JSON that the New York Times publishes for its results pages (`static01.nyt.com/elections-assets/pages/data/2026-11-03/results-{senate,house}.json`). Unofficial and free.
- **Races, nominees, ratings:** Wikipedia, [2026 United States Senate elections](https://en.wikipedia.org/wiki/2026_United_States_Senate_elections). Ratings are dated 15–27 Oct 2026.
- **Sitting senators** (bio, photo, contact): [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators).
- **State codes and FIPS:** built into `scripts/build_senate.py`.

## Caveats

- **The NYT feed is unofficial.** It isn't documented, it could change format or block requests, and the 2026 files don't exist yet (they returned 404 on 28 Oct). They normally appear on or just before election day. The parser was tested against the 2024 files, which have the same structure. If the 2026 URL is different, change `NYT_URL` in `scripts/update_results.py`. Have someone ready to use the manual overrides file.
- **Wikipedia is crowd-edited.** Spot-check the Toss-up / Lean races against cookpolitical.com, insideelections.com and centerforpolitics.org before publishing.
- **Hand fixes** in `scripts/build_senate.py`: Alaska's nominees (Peltola D vs Sullivan R; Wikipedia's infobox is blank because of the top-four primary). Minnesota's DFL is treated as Democratic.
- **Appointed senators:** Oklahoma (Alan Armstrong, not running) and South Carolina (Darline Graham, running) have appointees in the seats up this year. Both appear consistently in both sources.
- **Independents:** King and Sanders are counted with the Democrats in the Senate bar, since they caucus with them. A newly elected independent (e.g. Dan Osborn, NE) goes in `Independents (won)`, because their caucus isn't known.
- **Georgia** can go to a 1 Dec runoff, and **Alaska** uses ranked-choice voting, so these may stay uncalled for days.
