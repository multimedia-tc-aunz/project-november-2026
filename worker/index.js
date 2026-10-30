// Cloudflare Worker: fetches the results on a schedule and serves the chart files.
// All the data logic is in src/midterms.js; this file is only the Cloudflare parts.
//
//   /senate_map.csv  /senate_bar.csv  /house_bar.csv   (and the same names as .json)
//   /                status: when it last fetched, any errors
//   /refresh?token=… fetch now, instead of waiting for the next scheduled run
//
// The schedule (wrangler.toml) fires every 5 minutes. Outside the election-night
// window (FAST_START to FAST_END) it only does the on-the-hour run, so it's hourly.
//
// The Senate base table and manual overrides are bundled in when you deploy, so
// after editing data/manual_overrides.csv or running `npm run sources`, redeploy.

import baseCsv from "../data/base/senate_base.csv";
import overridesCsv from "../data/manual_overrides.csv";
import {
  buildOutputs, fetchFeed, formatStamp, parseCsv, parseHouseFeed, parseOverrides, parseSenateFeed,
  summarise, toCsv, toJson,
} from "../src/midterms.js";

const BASE = parseCsv(baseCsv);
const STATES = new Set(BASE.map((r) => r.state_code));
const OVERRIDES = parseOverrides(overridesCsv);
const KV_KEY = "latest";
const FILES = ["senate_map", "senate_bar", "house_bar"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ---------- schedule ----------

function inFastWindow(time, env) {
  return time >= Date.parse(env.FAST_START) && time < Date.parse(env.FAST_END);
}

/** Fetch both feeds and save the parsed results to KV. If one fails, its last good copy is kept. */
async function update(env) {
  const prev = (await env.RESULTS.get(KV_KEY, "json")) || {};
  const next = { ...prev, ran_at: new Date().toISOString(), errors: {}, warnings: [] };
  for (const office of ["senate", "house"]) {
    try {
      const feed = await fetchFeed(office, { cache: "no-store" });
      const { results, warnings } = office === "senate" ? parseSenateFeed(feed) : parseHouseFeed(feed, STATES);
      next[office] = { fetched_at: new Date().toISOString(), results };
      next.warnings.push(...warnings);
    } catch (e) {
      next.errors[office] = String(e?.message || e);
    }
  }
  await env.RESULTS.put(KV_KEY, JSON.stringify(next));
  memo = null;
  console.log(JSON.stringify({ errors: next.errors, warnings: next.warnings }));
  return next;
}

// ---------- serving ----------

let memo = null; // brief in-memory copy, so busy charts don't read KV on every request

async function loadState(env) {
  if (memo && Date.now() - memo.at < 30_000) return memo.state;
  const state = (await env.RESULTS.get(KV_KEY, "json")) || {};
  memo = { at: Date.now(), state };
  return state;
}

function tablesFor(state) {
  // last_refreshed = when the Worker last fetched results
  return buildOutputs({
    base: BASE,
    senate: state.senate?.results,
    house: state.house?.results,
    overrides: OVERRIDES,
    stamp: formatStamp(state.ran_at ? new Date(state.ran_at) : new Date()),
  });
}

function statusBody(state, env, origin) {
  return {
    files: FILES.flatMap((f) => [`${origin}/${f}.csv`, `${origin}/${f}.json`]),
    schedule: inFastWindow(Date.now(), env) ? "every 5 minutes (election window)" : "hourly",
    election_window: `${env.FAST_START} to ${env.FAST_END}`,
    last_run: state.ran_at || "never: visit /refresh or wait for the next scheduled run",
    senate_fetched_at: state.senate?.fetched_at || null,
    house_fetched_at: state.house?.fetched_at || null,
    seats: summarise(tablesFor(state)),
    errors: state.errors || {},
    warnings: state.warnings || [],
    manual_overrides: { senate: Object.keys(OVERRIDES.senate), house: Object.keys(OVERRIDES.house) },
  };
}

const asJson = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const asFile = (body, type) =>
  new Response(body, {
    headers: { ...CORS, "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "public, max-age=60" },
  });

export default {
  async scheduled(event, env, ctx) {
    const onTheHour = new Date(event.scheduledTime).getUTCMinutes() === 0;
    if (!onTheHour && !inFastWindow(event.scheduledTime, env)) return; // hourly outside the window
    ctx.waitUntil(update(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") return asJson({ error: "GET only" }, 405);

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");

    if (path === "refresh") {
      const given = url.searchParams.get("token") || (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
      if (!env.REFRESH_TOKEN || given !== env.REFRESH_TOKEN) return asJson({ error: "wrong or missing token" }, 403);
      return asJson(statusBody(await update(env), env, url.origin));
    }

    if (path === "" || path === "status") return asJson(statusBody(await loadState(env), env, url.origin));

    const m = path.match(/^(senate_map|senate_bar|house_bar)\.(csv|json)$/);
    if (!m) return asJson({ error: "not found", files: FILES.map((f) => `/${f}.csv`) }, 404);

    const rows = tablesFor(await loadState(env))[m[1]];
    return m[2] === "csv" ? asFile(toCsv(rows), "text/csv") : asFile(toJson(rows), "application/json");
  },
};
