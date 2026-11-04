// Run the data pipeline on this computer: for setup, troubleshooting, or as a backup
// to the Cloudflare Worker on election night. All the logic is in midterms.js; this
// file just reads and writes files.
//
//   node src/run.js sources                 download Wikipedia + senators, rebuild everything
//   node src/run.js base                    rebuild data/base/senate_base.csv from data/sources/
//   node src/run.js update                  fetch live results once -> output/ (+ output_zip/output.zip)
//   node src/run.js update --every 60       keep fetching every 60 seconds
//   node src/run.js update --offline        no fetch: base data + manual overrides only
//   node src/run.js update --push           also publish the chart files to GitHub (the `data` branch)
//   node src/run.js update --senate-file X.json --house-file Y.json   use local feed files
//
// (or the shortcuts in package.json: npm run sources / base / update / watch / offline)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import {
  SOURCES, buildOutputs, buildSenateBase, fetchFeed, formatStamp, parseCsv, parseHouseFeed,
  parseOverrides, parseSenateFeed, summarise, toCsv, toJson,
} from "./midterms.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SOURCES_DIR = join(DATA, "sources");
const LIVE = join(DATA, "live"); // last good copy of each feed
const OUT = join(ROOT, "output");
const ZIP = join(ROOT, "output_zip", "output.zip"); // everything in output/, zipped after each update
const BASE_CSV = join(DATA, "base", "senate_base.csv");
const BRANCH = "data"; // GitHub branch that holds only the published chart files

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
  zipOutput();

  if (opts.push) {
    // Never replace published results with an empty table because a fetch failed.
    if (senateFeed && houseFeed) pushToGitHub(Object.keys(tables).flatMap((n) => [`${n}.csv`, `${n}.json`]), stamp);
    else console.log(`  ! not pushing: a feed is missing, so GitHub keeps the last good files`);
  }
}

// ---------- publish to GitHub ----------

const git = (args, env) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env }).trim();

/**
 * Replace the `data` branch on GitHub with one commit holding just these files from output/.
 * Uses a throwaway git index, so your working folder and current branch are untouched. The
 * branch never builds up history: each push replaces it.
 */
function pushToGitHub(names, stamp) {
  const env = { ...process.env, GIT_INDEX_FILE: join(tmpdir(), `midterms-index-${process.pid}`) };
  try {
    git(["read-tree", "--empty"], env);
    for (const name of names) {
      const blob = git(["hash-object", "-w", join(OUT, name)], env);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${name}`], env);
    }
    const commit = git(["commit-tree", git(["write-tree"], env), "-m", `Results at ${stamp}`], env);
    git(["push", "--force", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`], env);
    console.log(`  pushed ${names.length} files to the ${BRANCH} branch on GitHub`);
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

// ---------- zip of output/ ----------

/** Zip everything in output/ (except hidden files and other zips) into output_zip/output.zip. */
function zipOutput() {
  const names = readdirSync(OUT)
    .filter((n) => !n.startsWith(".") && !/\.(zip|tmp)$/i.test(n) && statSync(join(OUT, n)).isFile())
    .sort();
  writeAtomic(ZIP, makeZip(names.map((name) => ({ name, data: readFileSync(join(OUT, name)) }))));
  console.log(`  zipped ${names.length} files -> ${rel(ZIP)}`);
}

/** A standard .zip file (deflate compression) from [{name, data}]. */
function makeZip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // file names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory entry
    central.writeUInt16LE(20, 4); // version made by
    local.copy(central, 6, 4, 26); // version needed .. sizes, same as the local header
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ---------- main ----------

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    every: { type: "string" },
    offline: { type: "boolean" },
    push: { type: "boolean" },
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
