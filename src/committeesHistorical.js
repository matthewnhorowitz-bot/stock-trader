// Period-accurate committee assignments: a trade is scored against the committees
// its member held IN THAT CONGRESS, not today's. Source: the git history of
// unitedstates/congress-legislators (public domain) — its committee YAML at a commit
// from each Congress is a snapshot of that Congress's roster, in the same shape the
// current-data path uses. ~2 files x ~7 Congresses, fetched once and cached.

import { createRequire } from 'node:module';
import { readState, writeState } from './stateStore.js';
import { buildCommitteeIndex } from './enrich.js';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const CACHE = 'committees_historical.json';
const REPO = 'unitedstates/congress-legislators';
const MEMBERSHIP = 'committee-membership-current.yaml';
const COMMITTEES = 'committees-current.yaml';
const FIRST_CONGRESS = 113; // repo committee history starts ~2013 (113th)
const REFRESH_DAYS = 14; // only the current Congress is mutable
const UA = 'congress-trade-notifier';

const congressForYear = (y) => Math.max(FIRST_CONGRESS, Math.floor((y - 1789) / 2) + 1);
const firstYearOf = (c) => 2 * c + 1787;
const currentCongress = () => congressForYear(new Date().getUTCFullYear());

function ghHeaders() {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// Newest commit SHA touching `path` on/before `untilISO`.
async function shaAt(path, untilISO) {
  const url = `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(path)}&until=${untilISO}&per_page=1`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`commits API ${r.status}`);
  const j = await r.json();
  if (!j.length) throw new Error('no commit found');
  return j[0].sha;
}

async function rawYaml(sha, path) {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${path}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${path}@${sha.slice(0, 7)} ${r.status}`);
  return yaml.load(await r.text());
}

// Fetch + build one Congress's committee index. `current` uses the latest snapshot.
async function fetchCongress(congress, current) {
  const untilISO = current ? new Date().toISOString() : `${firstYearOf(congress)}-06-01T00:00:00Z`;
  const sha = await shaAt(MEMBERSHIP, untilISO);
  const [committees, membership] = await Promise.all([rawYaml(sha, COMMITTEES), rawYaml(sha, MEMBERSHIP)]);
  return buildCommitteeIndex(committees, membership);
}

// (de)serialize an index ({byBioguide,byName,lastSeen} of Map<string,Set>) for JSON.
const ser = (idx) => {
  const m = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));
  return { byBioguide: m(idx.byBioguide), byName: m(idx.byName), lastSeen: m(idx.lastSeen) };
};
const de = (o) => {
  const m = (obj) => new Map(Object.entries(obj || {}).map(([k, v]) => [k, new Set(v)]));
  return { byBioguide: m(o.byBioguide), byName: m(o.byName), lastSeen: m(o.lastSeen) };
};

let _promise = null;
async function load() {
  if (_promise) return _promise;
  _promise = (async () => {
    const cache = await readState(CACHE, { congresses: {} });
    const cur = currentCongress();
    const want = [];
    for (let c = FIRST_CONGRESS; c <= cur; c++) want.push(c);
    let changed = false;
    for (const c of want) {
      const have = cache.congresses[c];
      const isCur = c === cur;
      const stale = isCur && (!have || Date.now() - Date.parse(have.fetchedAt || 0) > REFRESH_DAYS * 864e5);
      if (have && !stale) continue;
      try {
        const idx = await fetchCongress(c, isCur);
        cache.congresses[c] = { fetchedAt: new Date().toISOString(), ...ser(idx) };
        changed = true;
        console.log(`[committees] fetched ${c}th Congress (${[...idx.byName.keys()].length} members)`);
      } catch (e) {
        console.error(`[committees] ${c}th Congress failed: ${e.message}`);
      }
    }
    if (changed) await writeState(CACHE, cache);
    // rebuild Map-based indexes in memory
    const built = {};
    for (const [c, o] of Object.entries(cache.congresses)) built[c] = de(o);
    return { built, cur };
  })();
  return _promise;
}

// Returns { indexForYear(year) -> {byBioguide,byName,lastSeen} | null }.
export async function getHistoricalCommittees() {
  const { built, cur } = await load();
  const indexForYear = (year) => {
    let c = congressForYear(year);
    if (c > cur) c = cur;
    return built[c] || built[cur] || null;
  };
  return { indexForYear };
}
