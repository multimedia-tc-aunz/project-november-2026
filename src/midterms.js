// All the data logic for the US midterms charts.
//
// This file only turns data into tables: it doesn't read or write files and doesn't
// know about Cloudflare, so the same code runs on your computer (src/run.js) and in
// the Cloudflare Worker (worker/index.js).
//
//   1. Settings
//   2. Senate base table: who holds each seat, candidates, ratings (built before election night)
//   3. Election-night results: the NYT/AP feed -> map and bar chart tables
//   4. CSV and JSON

// ---------- 1. Settings ----------

export const ELECTION_DATE = "2026-11-03";
export const TIMEZONE = "Australia/Sydney"; // for the last_refreshed column

// Pre-election sources (downloaded into data/sources/ by `npm run sources`)
export const SOURCES = {
  "wiki-senate.json": "https://en.wikipedia.org/w/api.php?action=parse&page=2026_United_States_Senate_elections&prop=wikitext&format=json&formatversion=2",
  "legislators-current.json": "https://unitedstates.github.io/congress-legislators/legislators-current.json",
};

// Live results: AP data the New York Times publishes for its own results pages.
// Free but UNOFFICIAL: no guarantee it stays up or keeps its format.
export const nytUrl = (office, date = ELECTION_DATE) =>
  `https://static01.nyt.com/elections-assets/pages/data/${date}/results-${office}.json`;

// Which raters feed the consensus, and what counts as marginal.
const CONSENSUS_RATERS = ["cook", "inside_elections", "sabato"];
const MARGINAL_RATINGS = new Set(["Toss-up", "Lean D", "Lean R"]);

// Column order of the Wikipedia predictions table (checked against its header).
const RATERS = ["cook", "ddhq", "economist", "fiftyplusone", "fox", "inside_elections",
  "nbc", "rcp", "sabato", "silver_bulletin", "split_ticket"];

export const HOUSE_SEATS = 435;
export const HOUSE_MAJORITY = 218;
// VP JD Vance (R) breaks ties: Democrats need 51 seats, Republicans 50.
export const SENATE_MAJORITY_D = 51;
export const SENATE_MAJORITY_R = 50;

// Hand fixes where Wikipedia's section infobox has no nominees yet.
// Alaska has a top-four primary, so its infobox lists no nominees.
const NOMINEE_FIXES = {
  AK: [["Mary Peltola", "Democratic"], ["Dan Sullivan", "Republican"]],
};
const DISPLAY_NAME_FIXES = { AK: "Dan Sullivan" }; // Wikipedia adds "S." to tell him from a namesake

const NO = "No election"; // label for text columns in states without a 2026 race

// Senate class -> year its seats are next up (class 2 is this year's regular election)
const CLASS_NEXT_ELECTION = { 1: 2030, 2: 2026, 3: 2028 };

const STRENGTH = { safe: 3, solid: 3, likely: 2, lean: 1, tilt: 0.5 };

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const NAME_TO_CODE = new Map(Object.entries(STATES).map(([code, name]) => [name, code]));

// State FIPS codes (2-digit, as text so leading zeros are kept). DC is left out: no senators.
const FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10",
  FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20",
  KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28",
  MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36",
  NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45",
  SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56",
};

const PARTY_SHORT = { Democrat: "D", Democratic: "D", Republican: "R", Independent: "I" };

// ---------- 2. Senate base table ----------

function find(text, needle, from = 0) {
  const i = text.indexOf(needle, from);
  if (i < 0) throw new Error(`couldn't find "${needle}" (has the Wikipedia page changed?)`);
  return i;
}

/** Turn a chunk of wikitext into plain text. */
function stripWiki(s) {
  return s
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{sortname\|([^|}]+)\|([^|}]+)[^}]*\}\}/g, "$1 $2")
    .replace(/\{\{(?:small|Small)\|([^}]*)\}\}/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanParty(party) {
  party = party.replaceAll(" (United States)", "").replaceAll(" politician", "").replaceAll(" Party", "");
  if (party.includes("Democratic–Farmer–Labor") || party.includes("Democratic-Farmer-Labor")) {
    return "Democratic"; // Minnesota's Democratic Party
  }
  return party.trim();
}

/** Turn Wikipedia's status note into a short label. */
function incumbentStatus(note) {
  const n = note.toLowerCase();
  if (n.includes("lost renomination")) return "Lost primary";
  if (n.includes("retiring")) return "Retiring";
  if (n.includes("ineligible") || n.includes("not running")) return "Not running";
  return "Running";
}

/** 'Lean|D|flip' -> ['Lean D', -1] */
function ratingLabel(tmpl) {
  const parts = tmpl.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts[0].toLowerCase() === "tossup") return ["Toss-up", 0];
  const strength = parts[0].toLowerCase();
  const party = parts[1].toUpperCase();
  if (!(strength in STRENGTH)) throw new Error(`unknown rating "${tmpl}"`);
  const level = strength === "solid" ? "Safe" : strength[0].toUpperCase() + strength.slice(1);
  return [`${level} ${party}`, STRENGTH[strength] * (party === "D" ? -1 : 1)];
}

function scoreToRating(score) {
  const a = Math.abs(score);
  if (a < 0.5) return "Toss-up";
  const side = score < 0 ? "D" : "R";
  if (a < 1.5) return `Lean ${side}`;
  if (a < 2.5) return `Likely ${side}`;
  return `Safe ${side}`;
}

/** Round to 2 decimals and print like 1.33, -3.0, 0.0 */
function score2(x) {
  const n = Number(x.toFixed(2));
  return Number.isInteger(n) ? (Object.is(n, -0) ? "-0.0" : n.toFixed(1)) : String(n);
}

function stateFromRowHeader(block) {
  const m = block.match(/^\s*! \[\[[^|\]]+\|([^\]]+)\]\]/);
  return m ? m[1].trim() : null;
}

/** Ratings table: {CODE: {wikiIncumbent, ratings: {rater: [label, score]}}} */
function parsePredictions(text) {
  const start = find(text, "== Predictions ==");
  const end = find(text, "== Generic congressional ballot", start);
  const rows = {};
  for (const block of text.slice(start, end).split(/\n\|-\s*\n/)) {
    const state = stateFromRowHeader(block);
    if (!state) continue;
    const code = NAME_TO_CODE.get(state);
    if (!code) throw new Error(`unknown state "${state}" in the predictions table`);
    const ratings = [...block.matchAll(/\{\{USRaceRating\|([^}]*)\}\}/g)].map((m) => m[1]);
    if (ratings.length !== RATERS.length) {
      throw new Error(`${state}: expected ${RATERS.length} ratings, got ${ratings.length}`);
    }
    const senatorCell = block.match(/\n\|[^\n]*?\{\{sortname\|([^}]*)\}\}/);
    let senator = null;
    if (senatorCell) {
      const bits = senatorCell[1].split("|");
      senator = `${bits[0]} ${bits[1]}`;
    } else {
      const cell = block.match(/\n\| \{\{Party shading\/\w+\}\} \| (\[\[[^\]]+\]\])/);
      senator = cell ? stripWiki(cell[1]) : null;
    }
    rows[code] = {
      wikiIncumbent: senator,
      ratings: Object.fromEntries(RATERS.map((r, i) => [r, ratingLabel(ratings[i])])),
    };
  }
  return rows;
}

/** Main nominees from each state's section infobox (nominee1/party1, ...). */
function parseNominees(text) {
  const out = {};
  for (const m of text.matchAll(/^== ([A-Za-z ]+?)(?: \(special\))? ==\s*$/gm)) {
    const code = NAME_TO_CODE.get(m[1].trim());
    if (!code) continue;
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/^== /m);
    const section = next >= 0 ? rest.slice(0, next) : rest;
    const box = section.match(/\{\{Infobox election([\s\S]*?)\n\}\}/);
    const noms = [];
    if (box) {
      const fields = Object.fromEntries(
        [...box[1].matchAll(/^\|\s*(\w+)\s*=\s*(.*?)\s*$/gm)].map((f) => [f[1], f[2]]));
      for (let i = 1; i < 6; i++) {
        const name = stripWiki(fields[`nominee${i}`] ?? "");
        const party = cleanParty(stripWiki(fields[`party${i}`] ?? ""));
        if (name) noms.push([name, party]);
      }
    }
    out[code] = noms;
  }
  return { ...out, ...NOMINEE_FIXES };
}

/** Status column ('Incumbent renominated', 'Incumbent retiring ...') per state. */
function parseRaceStatus(text) {
  const start = find(text, "== Race summary ==");
  const end = find(text, "== Alabama ==", start);
  const out = {};
  for (const block of text.slice(start, end).split(/\n\|-\s*\n/)) {
    const code = NAME_TO_CODE.get(stateFromRowHeader(block));
    if (!code) continue;
    let status = "";
    for (const c of block.split("\n| ").filter((c) => c.includes("data-sort-value"))) {
      const bar = c.indexOf("|");
      let txt = stripWiki(bar >= 0 ? c.slice(bar + 1) : c);
      txt = txt.replace(/^.*?data-sort-value=\S+\s*\|?\s*/, "").replace(/^[ |]+|[ |]+$/g, "");
      if (/^(incumbent|interim)/i.test(txt)) status = txt;
    }
    out[code] = status;
  }
  return out;
}

/** Sitting senators from unitedstates/congress-legislators. */
function parseSenators(people) {
  const [ey, em, ed] = ELECTION_DATE.split("-").map(Number);
  const out = [];
  for (const p of people) {
    const term = p.terms.at(-1);
    if (term.type !== "sen") continue;
    const senTerms = p.terms.filter((t) => t.type === "sen");
    let age = "";
    if (p.bio?.birthday) {
      const [by, bm, bd] = p.bio.birthday.split("-").map(Number);
      age = ey - by - (em < bm || (em === bm && ed < bd) ? 1 : 0);
    }
    out.push({
      name: p.name.official_full || `${p.name.first} ${p.name.last}`,
      common_name: `${p.name.nickname || p.name.first} ${p.name.last}`,
      last_name: p.name.last,
      state: term.state,
      class: term.class ?? null,
      party: term.party,
      caucus: term.caucus ?? term.party,
      rank: term.state_rank ?? "",
      senator_since: senTerms[0].start.slice(0, 4),
      age_on_election_day: age,
      gender: { M: "Male", F: "Female" }[p.bio?.gender] ?? "",
    });
  }
  return out;
}

const fmtSenator = (s) => `${s.common_name} (${PARTY_SHORT[s.party] ?? s.party.slice(0, 1)})`;

/**
 * Build the Senate base table: one row per state (50; DC has no senators).
 * Inputs are the two source files in data/sources/, already parsed from JSON.
 * Returns { rows, warnings }.
 */
export function buildSenateBase({ wikiSenate, legislators }) {
  const text = wikiSenate.parse.wikitext;
  const preds = parsePredictions(text);
  const noms = parseNominees(text);
  const status = parseRaceStatus(text);
  const senators = parseSenators(legislators);

  const predText = text.slice(find(text, "== Predictions =="), find(text, "== Generic"));
  const specials = new Set(Object.keys(preds).filter((code) =>
    text.includes(`${STATES[code]}<br />{{small|(special)}}`)
    || new RegExp(`\\[\\[[^\\]]*special election in ${STATES[code]}\\|`).test(predText)));

  const warnings = [];
  const rows = [];
  for (const code of Object.keys(FIPS).sort()) {
    const stateSens = senators.filter((s) => s.state === code);
    const up = code in preds;
    const seatClass = specials.has(code) ? "3" : up ? "2" : "";
    let holder = null;
    if (up) {
      holder = stateSens.find((s) => String(s.class) === seatClass) || null;
      if (!holder) {
        warnings.push(`${code}: no class ${seatClass} senator found`);
      } else {
        const wiki = (preds[code].wikiIncumbent || "").toLowerCase();
        if (!wiki.includes(holder.last_name.split(/\s+/)[0].toLowerCase())) {
          warnings.push(`${code}: legislators file says ${holder.name}, Wikipedia says ${preds[code].wikiIncumbent}`);
        }
      }
    }

    const row = {
      state_code: code,
      state_fips: FIPS[code],
      state_name: STATES[code],
      up_in_2026: up ? "Yes" : "No",
      race_type: up ? (specials.has(code) ? "Special" : "Regular") : NO,
      seat_class: seatClass,
      next_senate_election: up ? 2026
        : stateSens.length ? Math.min(...stateSens.map((s) => CLASS_NEXT_ELECTION[s.class])) : "",
      senators: stateSens.map(fmtSenator).join("; "),
    };

    // Current Senate: both senators (senior first) and the delegation's colour category.
    // Independents (King, Sanders) caucus with the Democrats, so they count as Democratic.
    const ordered = [...stateSens].sort((a, b) => (a.rank === "senior" ? 0 : 1) - (b.rank === "senior" ? 0 : 1));
    for (const i of [1, 2]) {
      const s = ordered[i - 1];
      row[`senator_${i}`] = s?.common_name ?? "";
      row[`senator_${i}_party`] = s?.party ?? "";
      row[`senator_${i}_since`] = s?.senator_since ?? "";
      row[`senator_${i}_up_in_2026`] = s ? (s === holder ? "Yes" : "No") : "";
    }
    const sides = new Set(stateSens.map((s) =>
      ["Democrat", "Independent"].includes(s.caucus) ? "Democratic" : "Republican"));
    row.current_category = sides.size === 1 ? [...sides][0] : "Split";
    // Both senators' parties as letters in a fixed order (D, R, I): DD, RR, DR, DI, RI
    const letters = stateSens.map((s) => PARTY_SHORT[s.party] ?? "?");
    row.current_parties = letters.sort((a, b) => "DRI".indexOf(a) - "DRI".indexOf(b)).join("") || "None";

    // Incumbent = senator whose seat is up; in states with no race, the senior senator.
    const h = holder || ordered[0] || null;
    if (!up && h) row.seat_class = String(h.class);
    const incStatus = up ? incumbentStatus(status[code] ?? "") : h ? "Not up in 2026" : "";
    Object.assign(row, {
      incumbent: up ? DISPLAY_NAME_FIXES[code] || preds[code].wikiIncumbent || h?.name || "" : h?.common_name ?? "",
      incumbent_official_name: h?.name ?? "",
      incumbent_party: h?.party ?? "",
      incumbent_caucus: h?.caucus ?? "",
      incumbent_status: incStatus,
      open_seat: up ? (incStatus === "Running" ? "No" : "Yes") : NO,
      race_status_note: up ? status[code] ?? "" : "No election in 2026",
      incumbent_senator_since: h?.senator_since ?? "",
      incumbent_age: h?.age_on_election_day ?? "",
      incumbent_gender: h?.gender ?? "",
    });

    // Nominees: one Democrat, one Republican, and the strongest other.
    let dem = "", rep = "", oth = "";
    for (const [n, party] of noms[code] || []) {
      if (party.startsWith("Democrat") && !dem) dem = n;
      else if (party.startsWith("Republican") && !rep) rep = n;
      else if (!oth) oth = `${n} (${party})`;
    }
    if (!up) dem = rep = oth = NO;
    Object.assign(row, { dem_candidate: dem, rep_candidate: rep, other_candidate: oth });

    // Ratings
    const r = preds[code]?.ratings;
    for (const rater of RATERS) row[`rating_${rater}`] = r ? r[rater][0] : NO;
    if (r) {
      const cons = CONSENSUS_RATERS.reduce((sum, k) => sum + r[k][1], 0) / CONSENSUS_RATERS.length;
      const allAvg = RATERS.reduce((sum, k) => sum + r[k][1], 0) / RATERS.length;
      const rating = scoreToRating(cons);
      const incSide = PARTY_SHORT[h?.caucus ?? ""] ?? "";
      const fav = rating !== "Toss-up" ? rating.slice(-1) : "";
      Object.assign(row, {
        consensus_score: score2(cons),
        consensus_rating: rating,
        forecast_category: rating,
        all_raters_score: score2(allAvg),
        all_raters_rating: scoreToRating(allAvg),
        marginal: MARGINAL_RATINGS.has(rating) ? "Yes" : "No",
        predicted_flip: fav && incSide && fav !== incSide ? "Yes" : "No",
      });
    } else {
      Object.assign(row, {
        consensus_score: "", consensus_rating: NO, forecast_category: NO,
        all_raters_score: "", all_raters_rating: NO, marginal: NO, predicted_flip: NO,
      });
    }
    rows.push(row);
  }
  return { rows, warnings };
}

// ---------- 3. Election-night results ----------

const PARTY = { DEM: "D", GOP: "R" }; // everything else counts as other / independent
const PARTY_NAME = { D: "Democrat", R: "Republican", I: "Independent", O: "Other" };

const RESULT_COLS = ["result_status", "result_category", "dem_votes", "rep_votes", "other_votes",
  "total_votes", "dem_pct", "rep_pct", "other_pct", "leader", "leader_party",
  "lead_pct_points", "pct_expected_vote_counted", "called", "winner",
  "winner_party", "flip", "runoff", "results_updated", "override_note"];

/** Download one NYT results feed ("senate" or "house"). Throws if it fails. */
export async function fetchFeed(office, init = {}) {
  const url = nytUrl(office);
  const res = await fetch(url, { ...init, headers: { "User-Agent": "midterms-chart-updater/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  if (!Array.isArray(data.races)) throw new Error(`unexpected format from ${url}`);
  return data;
}

function partyOf(meta) {
  const pid = meta?.party?.nyt_id || "";
  if (Object.hasOwn(PARTY, pid)) return PARTY[pid];
  return ["IND", "NPA", "UNA"].includes(pid) ? "I" : "O";
}

const fullName = (m) => `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim();
const round1 = (x) => x.toFixed(1);

/** Pull one race into a flat object of votes, leader and call. */
export function parseRace(race) {
  const units = race.reporting_units || [];
  const top = units.find((u) => u.level === "state") || units[0] || {};
  const meta = race.candidate_metadata || {};
  const votes = { D: 0, R: 0, O: 0 };
  const cands = [];
  for (const c of top.candidates || []) {
    const m = meta[c.nyt_id] || {};
    const p = partyOf(m);
    const v = c.votes?.total || 0;
    votes[p === "D" ? "D" : p === "R" ? "R" : "O"] += v;
    cands.push({ votes: v, id: c.nyt_id, party: p, name: fullName(m) });
  }
  const total = votes.D + votes.R + votes.O;
  cands.sort((a, b) => b.votes - a.votes || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  // The AP's call: outcome.won lists the winner once the AP calls the race.
  const outcome = race.outcome || {};
  const won = outcome.won || [];
  const runoff = outcome.advanced_to_runoff || [];
  let winner = cands.find((c) => won.includes(c.id)) || null;
  if (!winner && won.length) { // winner with no votes reported (e.g. uncontested)
    const m = meta[won[0]] || {};
    winner = { votes: 0, id: won[0], party: partyOf(m), name: fullName(m) };
  }

  const leader = cands.length && cands[0].votes > 0 ? cands[0] : null;
  const second = cands.length > 1 ? cands[1].votes : 0;
  const pct = (n) => (total ? round1((100 * n) / total) : "");
  return {
    state: top.state_postal || "",
    seat_number: race.seat_number || "",
    dem_votes: votes.D,
    rep_votes: votes.R,
    other_votes: votes.O,
    total_votes: total,
    dem_pct: pct(votes.D),
    rep_pct: pct(votes.R),
    other_pct: pct(votes.O),
    leader: leader ? leader.name : "",
    leader_party: leader ? PARTY_NAME[leader.party] : "",
    lead_pct_points: leader && total ? round1((100 * (leader.votes - second)) / total) : "",
    pct_expected_vote_counted: top.eevp ?? "",
    called: winner ? "Yes" : "No",
    winner: winner ? winner.name : "",
    winner_party: winner ? PARTY_NAME[winner.party] : "",
    runoff: runoff.length ? "Yes" : "No",
    results_updated: race.updated_at ?? "",
  };
}

/** Senate feed -> { results: {STATE: race}, warnings } */
export function parseSenateFeed(feed) {
  const results = {};
  const warnings = [];
  for (const race of feed.races || []) {
    const r = parseRace(race);
    if (results[r.state]) warnings.push(`two Senate races in ${r.state}: check feed`);
    results[r.state] = r;
  }
  return { results, warnings };
}

/** House feed -> { results: {"CA-1": {called, winner_party}}, warnings }.
 *  Only the 50 states count (drops DC, territories and the national summary row). */
export function parseHouseFeed(feed, states) {
  const results = {};
  const warnings = [];
  for (const race of feed.races || []) {
    const r = parseRace(race);
    if (!states.has(r.state)) continue;
    const key = `${r.state}-${parseInt(r.seat_number || 1, 10)}`; // at-large seats are -1
    if (results[key]) warnings.push(`duplicate House race ${key}`);
    results[key] = { called: r.called, winner_party: r.winner_party };
  }
  const n = Object.keys(results).length;
  if (n !== HOUSE_SEATS) warnings.push(`feed has ${n} House races (expected ${HOUSE_SEATS})`);
  return { results, warnings };
}

/** data/manual_overrides.csv text -> { senate: {ME: {...}}, house: {"CA-1": {...}} } */
export function parseOverrides(text) {
  const out = { senate: {}, house: {} };
  for (const r of parseCsv(text)) {
    if (!r.key || !r.winner_party) continue;
    const chamber = (r.chamber || "").trim().toLowerCase();
    if (!out[chamber]) continue;
    const wp = r.winner_party.trim();
    const party = { D: "Democrat", R: "Republican", I: "Independent" }[wp.toUpperCase().slice(0, 1)] || wp;
    out[chamber][r.key.trim().toUpperCase()] = {
      called: "Yes", winner: (r.winner_name || "").trim(), winner_party: party,
      override_note: (r.note || "").trim() || "Manual call",
    };
  }
  return out;
}

function statusAndCategory(row) {
  if (row.up_in_2026 !== "Yes") return ["No election", "No election"];
  if (row.called === "Yes") return ["Called", `${row.winner_party} won`];
  if (row.runoff === "Yes") return ["Runoff", "Runoff"];
  if (row.total_votes && row.leader_party) return ["Counting", `${row.leader_party} leading`];
  return ["No results yet", "Awaiting results"];
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function buildSenate(base, results, overrides, stamp) {
  const rows = [];
  for (const b of base) {
    const row = { ...b };
    for (const c of RESULT_COLS) row[c] = "";
    if (b.up_in_2026 === "Yes") {
      Object.assign(row, results[b.state_code] || {});
      Object.assign(row, overrides.senate[b.state_code] || {});
      if (row.called === "Yes") {
        // Flip = seat changes party. An Independent seat that caucuses Democratic counts as Democratic.
        const was = ["Democrat", "Independent"].includes(b.incumbent_caucus) ? "Democrat" : b.incumbent_caucus;
        row.flip = row.winner_party !== was ? "Yes" : "No";
      }
    } else {
      for (const c of ["leader", "leader_party", "called", "winner", "winner_party", "flip", "runoff"]) {
        row[c] = "No election"; // text columns; vote numbers stay blank
      }
    }
    delete row.state;
    delete row.seat_number;
    [row.result_status, row.result_category] = statusAndCategory(row);
    row.last_refreshed = stamp;
    rows.push(row);
  }

  // Seat totals. Seats not up count for the senator's caucus (King and Sanders -> Dem).
  const holdover = { D: 0, R: 0 };
  for (const b of base) {
    for (const i of [1, 2]) {
      if (b[`senator_${i}`] && b[`senator_${i}_up_in_2026`] !== "Yes") {
        holdover[["Democrat", "Independent"].includes(b[`senator_${i}_party`]) ? "D" : "R"] += 1;
      }
    }
  }
  const won = { Democrat: 0, Republican: 0, Independent: 0 };
  for (const r of rows) {
    if (r.up_in_2026 === "Yes" && r.called === "Yes") won[r.winner_party] = (won[r.winner_party] || 0) + 1;
  }
  const races = rows.filter((r) => r.up_in_2026 === "Yes").length;
  const bar = [{
    "chamber": "Senate",
    "Democrats (not up)": holdover.D,
    "Democrats (won)": won.Democrat,
    "Independents (won)": won.Independent,
    "Undecided": races - sum(Object.values(won)),
    "Republicans (won)": won.Republican,
    "Republicans (not up)": holdover.R,
    "Democrats total": holdover.D + won.Democrat,
    "Republicans total": holdover.R + won.Republican,
    "Dem majority line": SENATE_MAJORITY_D,
    "Rep majority line": SENATE_MAJORITY_R,
    "last_refreshed": stamp,
  }];
  return { map: rows, bar };
}

function buildHouse(results, overrides, stamp) {
  const races = { ...results };
  for (const [key, o] of Object.entries(overrides.house)) races[key] = { ...(races[key] || {}), ...o };
  const won = { Democrat: 0, Republican: 0, Independent: 0, Other: 0 };
  for (const r of Object.values(races)) {
    if (r.called === "Yes") won[r.winner_party] = (won[r.winner_party] || 0) + 1;
  }
  return [{
    "chamber": "House",
    "Democrats": won.Democrat,
    "Others": won.Independent + won.Other,
    "Undecided": HOUSE_SEATS - sum(Object.values(won)),
    "Republicans": won.Republican,
    "Majority line": HOUSE_MAJORITY,
    "last_refreshed": stamp,
  }];
}

/**
 * Everything for the charts in one go.
 *   base      rows of data/base/senate_base.csv
 *   senate    results from parseSenateFeed (or {} before any results)
 *   house     results from parseHouseFeed (or {})
 *   overrides from parseOverrides
 *   stamp     text for the last_refreshed column (see formatStamp)
 * Returns { senate_map, senate_bar, house_bar }: lists of rows, ready for toCsv / toJson.
 */
export function buildOutputs({ base, senate = {}, house = {}, overrides, stamp }) {
  const s = buildSenate(base, senate, overrides, stamp);
  return { senate_map: s.map, senate_bar: s.bar, house_bar: buildHouse(house, overrides, stamp) };
}

/** One-line summaries of the seat counts, for logs. */
export function summarise(tables) {
  const s = tables.senate_bar[0];
  const h = tables.house_bar[0];
  const races = tables.senate_map.filter((r) => r.up_in_2026 === "Yes").length;
  const houseCalled = HOUSE_SEATS - h.Undecided;
  return [
    `Senate: ${races - s.Undecided}/${races} called | D ${s["Democrats total"]} R ${s["Republicans total"]} `
      + `I ${s["Independents (won)"]} | ${s.Undecided} undecided`,
    `House: ${houseCalled}/${HOUSE_SEATS} called | D ${h.Democrats} R ${h.Republicans} other ${h.Others}`,
  ];
}

/** "2026-11-04 10:05 AEDT" */
export function formatStamp(date = new Date(), timeZone = TIMEZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-AU", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// ---------- 4. CSV and JSON ----------

/** Parse CSV text into a list of objects keyed by the header row. */
export function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field); field = "";
      records.push(record); record = [];
    } else field += ch;
  }
  if (field !== "" || record.length) { record.push(field); records.push(record); }
  const [header, ...body] = records.filter((r) => r.length > 1 || r[0] !== "");
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const cols = Object.keys(rows[0]);
  return [cols, ...rows.map((r) => cols.map((c) => r[c]))]
    .map((r) => r.map(csvField).join(",") + "\r\n").join("");
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const blank = (v) => v === "" || v === null || v === undefined;

/** List of row objects, same columns as the CSV. A column becomes numbers only if every
 *  non-blank value is a plain number (so codes like FIPS "01" stay text). Blanks become null. */
export function toJson(rows) {
  const cols = Object.keys(rows[0]);
  const numeric = new Set(cols.filter((c) => {
    const vals = rows.map((r) => r[c]).filter((v) => !blank(v));
    return vals.length && vals.every((v) => NUMBER.test(String(v)));
  }));
  const records = rows.map((r) => Object.fromEntries(cols.map((c) => {
    const v = r[c];
    if (blank(v)) return [c, null];
    return [c, numeric.has(c) ? Number(v) : String(v)];
  })));
  return JSON.stringify(records, null, 1) + "\n";
}
