// Run the data pipeline on this computer: for setup, troubleshooting, or as a backup
// to the Cloudflare Worker on election night. All the logic is in midterms.js; this
// file just reads and writes files.
//
//   node src/run.js sources                 download Wikipedia + senators, rebuild everything
//   node src/run.js base                    rebuild data/base/senate_base.csv from data/sources/
//   node src/run.js update                  fetch live results once -> output/
//   node src/run.js update --every 60       keep fetching every 60 seconds
//   node src/run.js update --offline        no fetch: base data + manual overrides only
//   node src/run.js update --senate-file X.json --house-file Y.json   use local feed files
//
// (or the shortcuts in package.json: npm run sources / base / update / watch / offline)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  SOURCES, buildOutputs, buildSenateBase, fetchFeed, formatStamp, parseCsv, parseHouseFeed,
  parseOverrides, parseSenateFeed, summarise, toCsv, toJson,
} from "./midterms.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SOURCES_DIR = join(DATA, "sources");
const LIVE = join(DATA, "live"); // last good copy of each feed
const OUT = join(ROOT, "output");
const BASE_CSV = join(DATA, "base", "senate_base.csv");

const rel = (p) => relative(ROOT, p);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path); // readers never see a half-written file
}

/** Write rows to name.csv and name.json. */
function writeTable(csvPath, rows) {
  writeAtomic(csvPath, toCsv(rows));
  writeAtomic(csvPath.replace(/\.csv$/, ".json"), toJson(rows));
}

// ---------- commands ----------

async function sources() {
  const files = {};
  for (const [name, url] of Object.entries(SOURCES)) {
    console.log(`downloading ${name}`);
    const res = await fetch(url, { headers: { "User-Agent": "midterms-data-prep/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    files[name] = await res.text();
    JSON.parse(files[name]); // check it's valid before saving anything
  }
  for (const [name, text] of Object.entries(files)) writeAtomic(join(SOURCES_DIR, name), text);
  base();
  await update({ offline: true });
}

function base() {
  const { rows, warnings } = buildSenateBase({
    wikiSenate: readJson(join(SOURCES_DIR, "wiki-senate.json")),
    legislators: readJson(join(SOURCES_DIR, "legislators-current.json")),
  });
  writeTable(BASE_CSV, rows);
  const up = rows.filter((r) => r.up_in_2026 === "Yes");
  console.log(`Wrote ${rel(BASE_CSV)} (+ .json): ${rows.length} rows, ${up.length} races `
    + `(${up.filter((r) => r.race_type === "Special").length} special)`);
  for (const w of warnings) console.log("CHECK:", w);
}

/** The feed for one office, or null. Saves a copy of each good fetch and falls back to it. */
async function loadFeed(office, opts) {
  const local = opts[`${office}-file`];
  if (local) return readJson(local);
  if (opts.offline) return null;
  const cached = join(LIVE, `latest-${office}.json`);
  try {
    const feed = await fetchFeed(office);
    writeAtomic(cached, JSON.stringify(feed));
    return feed;
  } catch (e) {
    console.log(`  ! could not fetch ${office}: ${e.message}`);
    if (!existsSync(cached)) return null;
    console.log(`    using last good copy (${rel(cached)})`);
    return readJson(cached);
  }
}

async function update(opts) {
  const stamp = formatStamp();
  console.log(`[${stamp}] updating`);
  const baseRows = parseCsv(readFileSync(BASE_CSV, "utf8"));
  const states = new Set(baseRows.map((r) => r.state_code));
  const overridesPath = join(DATA, "manual_overrides.csv");
  const overrides = parseOverrides(existsSync(overridesPath) ? readFileSync(overridesPath, "utf8") : "");

  const senateFeed = await loadFeed("senate", opts);
  const houseFeed = await loadFeed("house", opts);
  const senate = senateFeed ? parseSenateFeed(senateFeed) : { results: {}, warnings: [] };
  const house = houseFeed ? parseHouseFeed(houseFeed, states) : { results: {}, warnings: [] };
  for (const w of [...senate.warnings, ...house.warnings]) console.log(`  ! ${w}`);

  const tables = buildOutputs({
    base: baseRows, senate: senate.results, house: house.results, overrides, stamp,
  });
  for (const [name, rows] of Object.entries(tables)) writeTable(join(OUT, `${name}.csv`), rows);
  for (const line of summarise(tables)) console.log(`  ${line}`);
}

// ---------- main ----------

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    every: { type: "string" },
    offline: { type: "boolean" },
    "senate-file": { type: "string" },
    "house-file": { type: "string" },
  },
});

const command = positionals[0];
if (command === "sources") await sources();
else if (command === "base") base();
else if (command === "update" && !opts.every) await update(opts);
else if (command === "update") {
  const seconds = Number(opts.every);
  for (;;) {
    try {
      await update(opts);
    } catch (e) { // never die mid-night; report and retry
      console.error(`  ! update failed: ${e.stack || e}`);
    }
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[0].replace(/^\/\/ ?/gm, ""));
  process.exitCode = command ? 1 : 0;
}
