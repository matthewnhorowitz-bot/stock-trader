// Pluggable legislative data source — the mirror of src/fetcher.js for the
// FINANCIAL side. Normalizes congressional votes + (co-)sponsorships into one shape
// the Divergence Score consumes:
//
//   { chamber, politician, billId, title, policyArea, sector, billStance, action, date, source }
//
//   action:    'yea' | 'nay' | 'sponsor' | 'cosponsor'
//   billStance: +1 bill supports the sector, -1 bill restricts it (from billTagging)
//
// Provider is chosen by config.votesProvider (default 'sample'). Like the financial
// fetcher, every record is tagged best-effort and a failed source never throws past
// the caller — it just yields fewer records.

import { config } from './config.js';
import { readState, writeState } from './stateStore.js';
import { ensureTagged } from './billTagging.js';
import { loadTrades } from './performance.js';
import { getBioguideIndex } from './legislators.js';
import * as cg from './sources/congressGov.js';

const VALID_ACTIONS = new Set(['yea', 'nay', 'sponsor', 'cosponsor']);
const CACHE = 'votes_cache.json';
const REFRESH_DAYS = 10; // re-pull a member's legislation at most this often

function normAction(a) {
  const s = String(a || '').toLowerCase().trim();
  if (s === 'yes' || s === 'aye' || s === 'yea') return 'yea';
  if (s === 'no' || s === 'nay') return 'nay';
  if (s.includes('cosponsor') || s.includes('co-sponsor')) return 'cosponsor';
  if (s.includes('sponsor')) return 'sponsor';
  return VALID_ACTIONS.has(s) ? s : 'yea';
}

// Bundled offline dataset (default). Works with no key, mirrors data/sample_trades.json.
async function fromSampleVotes() {
  const rows = await readState('sample_votes.json', []);
  return rows;
}

// Live feed — Congress.gov API (free key). Pulls sponsored + cosponsored legislation
// (both chambers) and recent House roll-call positions for the members who appear in
// the trade corpus, BOUNDED per run and accumulated in data/votes_cache.json (warms
// over runs, like sector data). Sector + stance are derived later by ensureTagged()
// from each bill's policyArea + title. Falls back to sample when there's no key.
async function fromCongressGov() {
  if (!config.providers.congressKey) {
    console.error('[votes] no CONGRESS_API_KEY — falling back to sample data');
    return fromSampleVotes();
  }

  // Members we care about = those with trades, mapped to a bioguide ID.
  const trades = await loadTrades(config.dataProvider === 'sample' ? ['sample_trades.json'] : undefined);
  const names = [...new Set(trades.map((t) => t.politician).filter(Boolean))];
  const { lookup } = await getBioguideIndex();
  const members = new Map(); // bioguide -> { name, chamber }
  for (const name of names) {
    const r = lookup(name);
    if (r) members.set(r.bioguide, { name, chamber: r.chamber });
  }
  const ids = [...members.keys()].sort();
  if (!ids.length) {
    console.error('[votes] no trade members mapped to a bioguide — falling back to sample');
    return fromSampleVotes();
  }

  const cache = await readState(CACHE, { version: 1, cursor: 0, members: {}, billArea: {}, houseVotes: [] });
  cache.members = cache.members || {};
  cache.billArea = cache.billArea || {};
  cache.houseVotes = cache.houseVotes || [];

  // Round-robin a bounded batch of not-yet-fresh members this run.
  const now = Date.now();
  const start = (cache.cursor || 0) % ids.length;
  const batch = [];
  let i = start;
  for (let steps = 0; steps < ids.length && batch.length < Math.min(config.congressMemberMax, ids.length); steps++) {
    const id = ids[i];
    const have = cache.members[id];
    const stale = !have || !have.fetchedAt || now - Date.parse(have.fetchedAt) > REFRESH_DAYS * 864e5;
    if (stale) batch.push(id);
    i = (i + 1) % ids.length;
  }
  cache.cursor = i;

  for (const id of batch) {
    const meta = members.get(id);
    try {
      const [sp, co] = await Promise.all([cg.fetchSponsored(id), cg.fetchCosponsored(id)]);
      const recs = [
        ...sp.map((x) => ({ ...x, action: 'sponsor' })),
        ...co.map((x) => ({ ...x, action: 'cosponsor' })),
      ];
      cache.members[id] = { name: meta.name, chamber: meta.chamber, fetchedAt: new Date().toISOString(), recs };
      console.log(`[votes] ${meta.name}: ${sp.length} sponsored, ${co.length} cosponsored`);
    } catch (e) {
      console.error(`[votes] ${meta.name} (${id}) failed: ${e.message}`);
    }
  }

  // Recent House roll-call positions for our members (beta endpoint, best-effort).
  try {
    const wanted = new Set(ids);
    const hv = await cg.fetchHouseVotes(config.congressVoteMax, wanted, cache.billArea);
    const seen = new Set(cache.houseVotes.map((v) => `${v.bioguide}|${v.billId}|${v.action}`));
    for (const v of hv) {
      const k = `${v.bioguide}|${v.billId}|${v.action}`;
      if (!seen.has(k)) {
        seen.add(k);
        cache.houseVotes.push(v);
      }
    }
    cache.houseVotes = cache.houseVotes.slice(-2000); // cap the rolling window
    console.log(`[votes] house votes: +${hv.length} (total ${cache.houseVotes.length})`);
  } catch (e) {
    console.error(`[votes] house votes failed: ${e.message}`);
  }

  await writeState(CACHE, cache);

  // Flatten the cache into raw records; fetchAllVotes() tags + filters them.
  const out = [];
  for (const m of Object.values(cache.members)) {
    for (const r of m.recs || []) {
      out.push({
        chamber: cg.chamberOfBillType(r.type) || m.chamber || '',
        politician: m.name,
        billId: `${r.type || ''}${r.number || ''}`,
        title: r.title,
        policyArea: r.policyArea,
        action: r.action,
        date: r.date,
        source: 'Congress.gov',
      });
    }
  }
  for (const v of cache.houseVotes) {
    const m = cache.members[v.bioguide];
    if (!m) continue; // member not in our set anymore
    out.push({
      chamber: 'house',
      politician: m.name,
      billId: v.billId,
      title: v.title,
      policyArea: v.policyArea,
      action: v.action,
      date: v.date,
      source: 'Congress.gov',
    });
  }
  return out;
}

export async function fetchAllVotes() {
  let raw;
  switch (config.votesProvider) {
    case 'congressgov':
      raw = await fromCongressGov();
      break;
    case 'sample':
    default:
      raw = await fromSampleVotes();
  }
  const out = [];
  for (const r of raw || []) {
    const rec = ensureTagged({
      chamber: (r.chamber || '').toLowerCase(),
      politician: r.politician || '',
      billId: r.billId || '',
      title: r.title || '',
      policyArea: r.policyArea || '',
      sector: r.sector || '',
      billStance: r.billStance,
      action: normAction(r.action),
      date: r.date || '',
      source: r.source || config.votesProvider,
    });
    if (!rec || !rec.politician || !rec.sector) continue; // untaggable / unattributed
    if (rec.billStance !== 1 && rec.billStance !== -1) continue; // no usable stance
    out.push(rec);
  }
  return out;
}
