"""Build the static Senate base table (one row per state; DC is left out).

Inputs (data/raw/):
  wiki-senate.json            Wikipedia "2026 United States Senate elections" wikitext
                              (races, nominees, ratings from 11 forecasters)
  legislators-current.json    unitedstates/congress-legislators (sitting senators, bios)
  wiki-pvi.json               Wikipedia "Cook Partisan Voting Index" (2025 PVI for every state)

Output:
  data/senate_base.csv/.json  Everything that doesn't change on election night.
                              update_results.py adds the live vote columns.

Run:  python3 scripts/build_senate.py
"""
import json
import re
from datetime import date
from pathlib import Path

from table_io import write_table

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "senate_base.csv"

ELECTION_DAY = date(2026, 11, 3)

# Which raters feed the consensus, and what counts as marginal.
CONSENSUS_RATERS = ["cook", "inside_elections", "sabato"]
MARGINAL_RATINGS = {"Toss-up", "Lean D", "Lean R"}

# Column order of the Wikipedia predictions table (checked against its header).
RATERS = ["cook", "ddhq", "economist", "fiftyplusone", "fox", "inside_elections",
          "nbc", "rcp", "sabato", "silver_bulletin", "split_ticket"]

NO = "No election"  # label for text columns in states without a 2026 race

# Senate class -> year its seats are next up (class 2 is this year's regular election)
CLASS_NEXT_ELECTION = {1: 2030, 2: 2026, 3: 2028}

STRENGTH = {"safe": 3, "solid": 3, "likely": 2, "lean": 1, "tilt": 0.5}

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
NAME_TO_CODE = {v: k for k, v in STATES.items()}

# State FIPS codes (2-digit, as text so leading zeros are kept)
FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09", "DE": "10",
    "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20",
    "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27", "MS": "28",
    "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35", "NY": "36",
    "NC": "37", "ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45",
    "SD": "46", "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54",
    "WI": "55", "WY": "56",
}

PARTY_SHORT = {"Democrat": "D", "Democratic": "D", "Republican": "R", "Independent": "I"}

# Hand fixes where Wikipedia's section infobox has no nominees yet.
# Alaska has a top-four primary, so its infobox lists no nominees.
NOMINEE_FIXES = {
    "AK": [("Mary Peltola", "Democratic"), ("Dan Sullivan", "Republican")],
}
DISPLAY_NAME_FIXES = {"AK": "Dan Sullivan"}  # Wikipedia adds "S." to tell him from a namesake


def clean_party(party):
    party = party.replace(" (United States)", "").replace(" politician", "").replace(" Party", "")
    if "Democratic–Farmer–Labor" in party or "Democratic-Farmer-Labor" in party:
        return "Democratic"  # Minnesota's Democratic Party
    return party.strip()


def incumbent_status(note, up):
    """Turn Wikipedia's status note into a short label."""
    if not up:
        return ""
    n = note.lower()
    if "lost renomination" in n:
        return "Lost primary"
    if "retiring" in n:
        return "Retiring"
    if "ineligible" in n or "not running" in n:
        return "Not running"
    return "Running"


# ---------- wikitext helpers ----------

def strip_wiki(s):
    """Turn a chunk of wikitext into plain text."""
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"\{\{sortname\|([^|}]+)\|([^|}]+)[^}]*\}\}", r"\1 \2", s)
    s = re.sub(r"\{\{(?:small|Small)\|([^}]*)\}\}", r"\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"'{2,}", "", s)
    return re.sub(r"\s+", " ", s).strip()


def rating_label(tmpl):
    """'Lean|D|flip' -> ('Lean D', -1.0)."""
    parts = [p.strip() for p in tmpl.split("|") if p.strip()]
    if parts[0].lower() == "tossup":
        return "Toss-up", 0.0
    strength, party = parts[0].lower(), parts[1].upper()
    level = {"solid": "Safe"}.get(strength, strength.capitalize())
    score = STRENGTH[strength] * (-1 if party == "D" else 1)
    return f"{level} {party}", score


def score_to_rating(score):
    a = abs(score)
    if a < 0.5:
        return "Toss-up"
    side = "D" if score < 0 else "R"
    if a < 1.5:
        return f"Lean {side}"
    if a < 2.5:
        return f"Likely {side}"
    return f"Safe {side}"


# ---------- parse Wikipedia ----------

def parse_predictions(text):
    start = text.index("== Predictions ==")
    end = text.index("== Generic congressional ballot", start)
    table = text[start:end]
    rows = {}
    for block in re.split(r"\n\|-\s*\n", table):
        m = re.match(r"\s*! \[\[[^|\]]+\|([^\]]+)\]\]", block)
        if not m:
            continue
        state = m.group(1).strip()
        code = NAME_TO_CODE[state]
        ratings = re.findall(r"\{\{USRaceRating\|([^}]*)\}\}", block)
        if len(ratings) != len(RATERS):
            raise ValueError(f"{state}: expected {len(RATERS)} ratings, got {len(ratings)}")
        pvi = re.search(r"\{\{Shading PVI\|([DR])\|(\d+)\}\}", block)
        senator_cell = re.search(r"\n\|[^\n]*?\{\{sortname\|([^}]*)\}\}", block)
        senator = None
        if senator_cell:
            bits = senator_cell.group(1).split("|")
            senator = f"{bits[0]} {bits[1]}"
        else:
            cell = re.search(r"\n\| \{\{Party shading/\w+\}\} \| (\[\[[^\]]+\]\])", block)
            senator = strip_wiki(cell.group(1)) if cell else None
        rows[code] = {
            "pvi": f"{pvi.group(1)}+{pvi.group(2)}" if pvi else "",
            "wiki_incumbent": senator,
            "ratings": dict(zip(RATERS, (rating_label(r) for r in ratings))),
        }
    return rows


def parse_nominees(text):
    """Main nominees from each state's section infobox (nominee1/party1, ...)."""
    out = {}
    for m in re.finditer(r"^== ([A-Za-z ]+?)(?: \(special\))? ==\s*$", text, re.M):
        state = m.group(1).strip()
        if state not in NAME_TO_CODE:
            continue
        nxt = re.search(r"^== ", text[m.end():], re.M)
        section = text[m.end(): m.end() + (nxt.start() if nxt else len(text))]
        box = re.search(r"\{\{Infobox election(.*?)\n\}\}", section, re.S)
        noms = []
        if box:
            fields = dict(re.findall(r"^\|\s*(\w+)\s*=\s*(.*?)\s*$", box.group(1), re.M))
            for i in range(1, 6):
                name = strip_wiki(fields.get(f"nominee{i}", ""))
                party = clean_party(strip_wiki(fields.get(f"party{i}", "")))
                if name:
                    noms.append((name, party))
        out[NAME_TO_CODE[state]] = noms
    out.update(NOMINEE_FIXES)
    return out


def parse_race_status(text):
    """Status column ('Incumbent renominated', 'Incumbent retiring ...') per state."""
    start = text.index("== Race summary ==")
    end = text.index("== Alabama ==", start)
    out = {}
    for block in re.split(r"\n\|-\s*\n", text[start:end]):
        m = re.match(r"\s*! \[\[[^|\]]+\|([^\]]+)\]\]", block)
        if not m or m.group(1).strip() not in NAME_TO_CODE:
            continue
        cells = [c for c in block.split("\n| ") if "data-sort-value" in c]
        status = ""
        for c in cells:
            txt = strip_wiki(c.split("|", 1)[-1] if "data-sort-value" in c else c)
            txt = re.sub(r"^.*?data-sort-value=\S+\s*\|?\s*", "", txt).strip(" |")
            if txt.lower().startswith(("incumbent", "interim")):
                status = txt
        out[NAME_TO_CODE[m.group(1).strip()]] = status
    return out


def load_pvi():
    """2025 Cook PVI for every state, from Wikipedia's 'By state' table."""
    text = json.load(open(RAW / "wiki-pvi.json"))["parse"]["wikitext"]
    table = text[text.index("==By state=="):]
    out = {}
    for m in re.finditer(r"^\| \[\[([^\]|]+)(?:\|([^\]]*))?\]\]\s*\n\| \{\{Shading PVI\|([^}]*)\}\}", table, re.M):
        target, label = m.group(1), m.group(2) or m.group(1)  # [[Georgia (U.S. state)|Georgia]]
        name = label
        parts = m.group(3).split("|")
        if name in NAME_TO_CODE:
            out[NAME_TO_CODE[name]] = "EVEN" if parts[0] == "EVEN" else f"{parts[0]}+{parts[1]}"
    return out


# ---------- senators ----------

def load_senators():
    people = json.load(open(RAW / "legislators-current.json"))
    out = []
    for p in people:
        term = p["terms"][-1]
        if term["type"] != "sen":
            continue
        sen_terms = [t for t in p["terms"] if t["type"] == "sen"]
        bday = p["bio"].get("birthday")
        age = ""
        if bday:
            b = date.fromisoformat(bday)
            age = ELECTION_DAY.year - b.year - ((ELECTION_DAY.month, ELECTION_DAY.day) < (b.month, b.day))
        name = p["name"].get("official_full") or f"{p['name']['first']} {p['name']['last']}"
        common = f"{p['name'].get('nickname') or p['name']['first']} {p['name']['last']}"
        out.append({
            "name": name,
            "common_name": common,
            "last_name": p["name"]["last"],
            "state": term["state"],
            "class": term.get("class"),
            "party": term["party"],
            "caucus": term.get("caucus", term["party"]),
            "rank": term.get("state_rank", ""),
            "senator_since": sen_terms[0]["start"][:4],
            "age_on_election_day": age,
            "gender": {"M": "Male", "F": "Female"}.get(p["bio"].get("gender"), ""),
        })
    return out


def fmt_senator(s):
    return f"{s['common_name']} ({PARTY_SHORT.get(s['party'], s['party'][:1])})"


# ---------- build ----------

def main():
    text = json.load(open(RAW / "wiki-senate.json"))["parse"]["wikitext"]
    preds = parse_predictions(text)
    noms = parse_nominees(text)
    status = parse_race_status(text)
    senators = load_senators()
    pvi = load_pvi()

    specials = {code for code in preds if f"{STATES[code]}<br />{{{{small|(special)}}}}" in text
                or re.search(rf"\[\[[^\]]*special election in {STATES[code]}\|", text[text.index('== Predictions =='):text.index('== Generic')])}

    warnings = []
    rows = []
    for code in sorted(FIPS):  # the 50 states (DC has no senators, so it's left out)
        name = STATES[code]
        state_sens = [s for s in senators if s["state"] == code]
        up = code in preds
        seat_class = "3" if code in specials else ("2" if up else "")
        holder = None
        if up:
            matches = [s for s in state_sens if str(s["class"]) == seat_class]
            holder = matches[0] if matches else None
            if not holder:
                warnings.append(f"{code}: no class {seat_class} senator found")
            else:
                wiki = (preds[code]["wiki_incumbent"] or "").lower()
                if holder["last_name"].split()[0].lower() not in wiki:
                    warnings.append(f"{code}: legislators file says {holder['name']}, "
                                    f"Wikipedia says {preds[code]['wiki_incumbent']}")

        row = {
            "state_code": code,
            "state_fips": FIPS[code],
            "state_name": name,
            "up_in_2026": "Yes" if up else "No",
            "race_type": ("Special" if code in specials else "Regular") if up else NO,
            "seat_class": seat_class,
            "pvi": pvi.get(code, "") if up else "",  # PVI only for states with a 2026 race
            "next_senate_election": 2026 if up else (
                min(CLASS_NEXT_ELECTION[s["class"]] for s in state_sens) if state_sens else ""),
            "senators": "; ".join(fmt_senator(s) for s in state_sens),
        }

        # Current Senate: both senators (senior first) and the delegation's colour category.
        # Independents (King, Sanders) caucus with the Democrats, so they count as Democratic.
        ordered = sorted(state_sens, key=lambda s: 0 if s["rank"] == "senior" else 1)
        for i in (1, 2):
            s = ordered[i - 1] if len(ordered) >= i else {}
            row[f"senator_{i}"] = s.get("common_name", "")
            row[f"senator_{i}_party"] = s.get("party", "")
            row[f"senator_{i}_since"] = s.get("senator_since", "")
            row[f"senator_{i}_up_in_2026"] = ("Yes" if s is holder else "No") if s else ""
        sides = {"Democratic" if s["caucus"] in ("Democrat", "Independent") else "Republican" for s in state_sens}
        row["current_category"] = sides.pop() if len(sides) == 1 else "Split"
        # Both senators' parties as letters in a fixed order (D, R, I): DD, RR, DR, DI, RI
        letters = [PARTY_SHORT.get(s["party"], "?") for s in state_sens]
        row["current_parties"] = "".join(sorted(letters, key="DRI".index)) or "None"

        # Incumbent = senator whose seat is up; in states with no race, the senior senator.
        h = holder or (ordered[0] if ordered else {})
        if not up and h:
            row["seat_class"] = str(h["class"])
        inc_status = incumbent_status(status.get(code, ""), up) if up else ("Not up in 2026" if h else "")
        display = (DISPLAY_NAME_FIXES.get(code) or preds.get(code, {}).get("wiki_incumbent") or h.get("name", "")) \
            if up else h.get("common_name", "")
        row.update({
            "incumbent": display,
            "incumbent_official_name": h.get("name", ""),
            "incumbent_party": h.get("party", ""),
            "incumbent_caucus": h.get("caucus", ""),
            "incumbent_status": inc_status,
            "open_seat": ("No" if inc_status == "Running" else "Yes") if up else NO,
            "race_status_note": status.get(code, "") if up else "No election in 2026",
            "incumbent_senator_since": h.get("senator_since", ""),
            "incumbent_age": h.get("age_on_election_day", ""),
            "incumbent_gender": h.get("gender", ""),
        })

        # Nominees: one Democrat, one Republican, and the strongest other.
        dem = rep = oth = ""
        for n, party in noms.get(code, []):
            if party.startswith("Democrat") and not dem:
                dem = n
            elif party.startswith("Republican") and not rep:
                rep = n
            elif not oth:
                oth = f"{n} ({party})"
        if not up:
            dem = rep = oth = NO
        row.update({"dem_candidate": dem, "rep_candidate": rep, "other_candidate": oth})

        # Ratings
        r = preds.get(code, {}).get("ratings", {})
        for rater in RATERS:
            row[f"rating_{rater}"] = r[rater][0] if r else NO
        if r:
            cons = sum(r[k][1] for k in CONSENSUS_RATERS) / len(CONSENSUS_RATERS)
            allavg = sum(v[1] for v in r.values()) / len(r)
            row["consensus_score"] = round(cons, 2)
            row["consensus_rating"] = score_to_rating(cons)
            row["forecast_category"] = row["consensus_rating"]
            row["all_raters_score"] = round(allavg, 2)
            row["all_raters_rating"] = score_to_rating(allavg)
            row["marginal"] = "Yes" if row["consensus_rating"] in MARGINAL_RATINGS else "No"
            inc_side = PARTY_SHORT.get(h.get("caucus", ""), "")
            fav = row["consensus_rating"][-1] if row["consensus_rating"] != "Toss-up" else ""
            row["predicted_flip"] = "Yes" if fav and inc_side and fav != inc_side else "No"
        else:
            row.update({"consensus_score": "", "consensus_rating": NO, "forecast_category": NO,
                        "all_raters_score": "", "all_raters_rating": NO, "marginal": NO,
                        "predicted_flip": NO})
        rows.append(row)

    write_table(OUT, rows)

    up = [r for r in rows if r["up_in_2026"] == "Yes"]
    print(f"Wrote {OUT.relative_to(ROOT)} (+ .json): {len(rows)} rows, {len(up)} races "
          f"({sum(r['race_type'] == 'Special' for r in up)} special)")
    for w_ in warnings:
        print("CHECK:", w_)


if __name__ == "__main__":
    main()
