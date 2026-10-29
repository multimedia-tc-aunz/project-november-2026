"""Election-night updater: pulls live results and writes the chart CSVs.

Source: the AP-sourced results JSON the New York Times publishes for its own
results pages. It is free but UNOFFICIAL: no guarantee it stays up, keeps its
format, or isn't blocked. If it breaks, use data/manual_overrides.csv to call
races by hand (the charts keep working).

Writes (each as .csv and .json):
  output/senate_map.csv   one row per state (no DC), for Datawrapper "USA » States (hexagons)"
                          -> match on column state_code to basemap key "Code"
  output/senate_bar.csv   seat totals incl. the 65 seats not up this year
  output/house_bar.csv    seat totals, 218 for a majority

Usage:
  python3 scripts/update_results.py                 # fetch once
  python3 scripts/update_results.py --every 60      # keep refreshing every 60s
  python3 scripts/update_results.py --offline       # no fetch: rebuild from base + overrides
  python3 scripts/update_results.py --senate-file X.json --house-file Y.json   # local files
"""
import argparse
import csv
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from table_io import write_table

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LIVE = DATA / "live"
OUT = ROOT / "output"

ELECTION_DATE = "2026-11-03"
NYT_URL = "https://static01.nyt.com/elections-assets/pages/data/{date}/results-{office}.json"

HOUSE_SEATS, HOUSE_MAJORITY = 435, 218
# VP JD Vance (R) breaks ties: Democrats need 51 seats, Republicans 50.
SENATE_MAJORITY_D, SENATE_MAJORITY_R = 51, 50

PARTY = {"DEM": "D", "GOP": "R"}  # everything else counts as other / independent
PARTY_NAME = {"D": "Democrat", "R": "Republican", "I": "Independent", "O": "Other"}


# ---------- fetching ----------

def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "midterms-chart-updater/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_feed(office, args):
    """Return the parsed feed, or None. Saves a copy of each good fetch."""
    local = getattr(args, f"{office}_file")
    if local:
        return json.load(open(local))
    if args.offline:
        return None
    url = NYT_URL.format(date=args.date, office=office)
    try:
        data = fetch_json(url)
    except Exception as e:  # keep going with whatever we had last time
        print(f"  ! could not fetch {office}: {e}")
        cached = LIVE / f"latest-{office}.json"
        if cached.exists():
            print(f"    using last good copy ({cached.relative_to(ROOT)})")
            return json.load(open(cached))
        return None
    LIVE.mkdir(parents=True, exist_ok=True)
    (LIVE / f"latest-{office}.json").write_text(json.dumps(data))
    return data


# ---------- parsing ----------

def party_of(meta):
    pid = (meta.get("party") or {}).get("nyt_id", "")
    if pid in PARTY:
        return PARTY[pid]
    return "I" if pid in ("IND", "NPA", "UNA") else "O"


def parse_race(race):
    """Pull one race into a flat dict of votes, leader and call."""
    units = race.get("reporting_units") or []
    top = next((u for u in units if u.get("level") == "state"), units[0] if units else {})
    meta = race.get("candidate_metadata") or {}
    votes = {"D": 0, "R": 0, "O": 0}
    cands = []
    for c in top.get("candidates", []):
        m = meta.get(c["nyt_id"], {})
        p = party_of(m)
        v = (c.get("votes") or {}).get("total") or 0
        votes["D" if p == "D" else "R" if p == "R" else "O"] += v
        cands.append((v, c["nyt_id"], p, f"{m.get('first_name', '')} {m.get('last_name', '')}".strip()))
    total = sum(votes.values())
    cands.sort(reverse=True)

    outcome = race.get("outcome") or {}
    won = outcome.get("won") or []
    runoff = outcome.get("advanced_to_runoff") or []
    winner = next((c for c in cands if c[1] in won), None)
    if winner is None and won:  # winner with no votes reported (e.g. uncontested)
        m = meta.get(won[0], {})
        winner = (0, won[0], party_of(m), f"{m.get('first_name', '')} {m.get('last_name', '')}".strip())

    leader = cands[0] if cands and cands[0][0] > 0 else None
    second = cands[1][0] if len(cands) > 1 else 0
    return {
        "state": top.get("state_postal", ""),
        "seat_number": race.get("seat_number") or "",
        "dem_votes": votes["D"],
        "rep_votes": votes["R"],
        "other_votes": votes["O"],
        "total_votes": total,
        "dem_pct": round(100 * votes["D"] / total, 1) if total else "",
        "rep_pct": round(100 * votes["R"] / total, 1) if total else "",
        "other_pct": round(100 * votes["O"] / total, 1) if total else "",
        "leader": leader[3] if leader else "",
        "leader_party": PARTY_NAME[leader[2]] if leader else "",
        "lead_pct_points": round(100 * (leader[0] - second) / total, 1) if leader and total else "",
        "pct_expected_vote_counted": top.get("eevp", ""),
        "called": "Yes" if winner else "No",
        "winner": winner[3] if winner else "",
        "winner_party": PARTY_NAME[winner[2]] if winner else "",
        "runoff": "Yes" if runoff else "No",
        "results_updated": race.get("updated_at", ""),
    }


def load_overrides():
    path = DATA / "manual_overrides.csv"
    out = {"senate": {}, "house": {}}
    if not path.exists():
        return out
    for r in csv.DictReader(open(path)):
        if not r.get("key") or not r.get("winner_party"):
            continue
        party = {"D": "Democrat", "R": "Republican", "I": "Independent"}.get(
            r["winner_party"].strip().upper()[:1], r["winner_party"].strip())
        out[r["chamber"].strip().lower()][r["key"].strip().upper()] = {
            "called": "Yes", "winner": r.get("winner_name", "").strip(), "winner_party": party,
            "override_note": r.get("note", "").strip() or "Manual call",
        }
    return out


# ---------- builders ----------

RESULT_COLS = ["result_status", "result_category", "dem_votes", "rep_votes", "other_votes",
               "total_votes", "dem_pct", "rep_pct", "other_pct", "leader", "leader_party",
               "lead_pct_points", "pct_expected_vote_counted", "called", "winner",
               "winner_party", "flip", "runoff", "results_updated", "override_note"]


def status_and_category(row):
    """result_status (text for tooltips) and result_category (colour for the results map)."""
    if row["up_in_2026"] != "Yes":
        return "No election", "No election"
    if row.get("called") == "Yes":
        return "Called", f"{row['winner_party']} won"
    if row.get("runoff") == "Yes":
        return "Runoff", "Runoff"
    if row.get("total_votes") and row.get("leader_party"):
        return "Counting", f"{row['leader_party']} leading"
    return "No results yet", "Awaiting results"


def build_senate(feed, overrides, stamp):
    base = list(csv.DictReader(open(DATA / "senate_base.csv")))
    results = {}
    if feed:
        for race in feed.get("races", []):
            r = parse_race(race)
            if r["state"] in results:
                print(f"  ! two Senate races in {r['state']}: check feed")
            results[r["state"]] = r

    rows = []
    for b in base:
        row = dict(b)
        for c in RESULT_COLS:
            row[c] = ""
        if b["up_in_2026"] == "Yes":
            row.update(results.get(b["state_code"], {}))
            row.update(overrides["senate"].get(b["state_code"], {}))
            if row.get("called") == "Yes":
                # Flip = seat changes party. The incumbent's caucus counts, so an
                # Independent seat that caucuses Democratic counts as Democratic.
                was = "Democrat" if b["incumbent_caucus"] in ("Democrat", "Independent") else b["incumbent_caucus"]
                row["flip"] = "Yes" if row["winner_party"] != was else "No"
        else:
            for c in ("leader", "leader_party", "called", "winner", "winner_party", "flip", "runoff"):
                row[c] = "No election"  # text columns; vote numbers stay blank
        row.pop("state", None)
        row.pop("seat_number", None)
        row["result_status"], row["result_category"] = status_and_category(row)
        row["last_refreshed"] = stamp
        rows.append(row)
    write_table(OUT / "senate_map.csv", rows)

    # Seat totals. Seats not up count for the senator's caucus (King and Sanders -> Dem).
    legislators = json.load(open(DATA / "raw" / "legislators-current.json"))
    up = {(b["state_code"], b["seat_class"]) for b in base if b["up_in_2026"] == "Yes"}
    holdover = {"D": 0, "R": 0}
    for p in legislators:
        t = p["terms"][-1]
        if t["type"] == "sen" and (t["state"], str(t.get("class"))) not in up:
            holdover["D" if t.get("caucus", t["party"]) in ("Democrat", "Independent") else "R"] += 1
    won = {"Democrat": 0, "Republican": 0, "Independent": 0}
    for r in rows:
        if r["up_in_2026"] == "Yes" and r["called"] == "Yes":
            won[r["winner_party"]] = won.get(r["winner_party"], 0) + 1
    races = sum(r["up_in_2026"] == "Yes" for r in rows)
    undecided = races - sum(won.values())
    bar = [{
        "chamber": "Senate",
        "Democrats (not up)": holdover["D"],
        "Democrats (won)": won["Democrat"],
        "Independents (won)": won["Independent"],
        "Undecided": undecided,
        "Republicans (won)": won["Republican"],
        "Republicans (not up)": holdover["R"],
        "Democrats total": holdover["D"] + won["Democrat"],
        "Republicans total": holdover["R"] + won["Republican"],
        "Dem majority line": SENATE_MAJORITY_D,
        "Rep majority line": SENATE_MAJORITY_R,
        "last_refreshed": stamp,
    }]
    write_table(OUT / "senate_bar.csv", bar)
    called = races - undecided
    print(f"  Senate: {called}/{races} called | D {bar[0]['Democrats total']} "
          f"R {bar[0]['Republicans total']} I {won['Independent']} | {undecided} undecided")
    return rows, bar


def build_house(feed, overrides, stamp):
    """Seat totals for the House bar chart, counted straight from the feed.
    Races are keyed like 'CA-1' (state + district; at-large seats are '-1')."""
    states = {r["state_code"] for r in csv.DictReader(open(DATA / "senate_base.csv"))}
    races = {}
    if feed:
        for race in feed.get("races", []):
            r = parse_race(race)
            if r["state"] not in states:
                continue  # non-voting delegates (DC, territories)
            key = f"{r['state']}-{int(r['seat_number'] or 1)}"
            if key in races:
                print(f"  ! duplicate House race {key}")
            races[key] = r
        if len(races) != HOUSE_SEATS:
            print(f"  ! feed has {len(races)} House races (expected {HOUSE_SEATS})")
    for key, o in overrides["house"].items():
        races.setdefault(key, {}).update(o)

    won = {"Democrat": 0, "Republican": 0, "Independent": 0, "Other": 0}
    for r in races.values():
        if r.get("called") == "Yes":
            won[r["winner_party"]] = won.get(r["winner_party"], 0) + 1
    bar = [{
        "chamber": "House",
        "Democrats": won["Democrat"],
        "Others": won["Independent"] + won["Other"],
        "Undecided": HOUSE_SEATS - sum(won.values()),
        "Republicans": won["Republican"],
        "Majority line": HOUSE_MAJORITY,
        "last_refreshed": stamp,
    }]
    write_table(OUT / "house_bar.csv", bar)
    print(f"  House: {sum(won.values())}/{HOUSE_SEATS} called | D {won['Democrat']} "
          f"R {won['Republican']} other {bar[0]['Others']}")
    return bar


# ---------- main ----------

def run_once(args):
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    print(f"[{stamp}] updating")
    overrides = load_overrides()
    build_senate(load_feed("senate", args), overrides, stamp)
    build_house(load_feed("house", args), overrides, stamp)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=ELECTION_DATE)
    ap.add_argument("--every", type=int, default=0, help="refresh every N seconds (0 = once)")
    ap.add_argument("--offline", action="store_true", help="don't fetch; base data + overrides only")
    ap.add_argument("--senate-file", help="read Senate results from a local JSON file")
    ap.add_argument("--house-file", help="read House results from a local JSON file")
    args = ap.parse_args()
    if not args.every:
        run_once(args)
        return
    while True:
        try:
            run_once(args)
        except Exception as e:  # never die mid-night; report and retry
            print(f"  ! update failed: {e}", file=sys.stderr)
        time.sleep(args.every)


if __name__ == "__main__":
    main()
