// Congress.gov API v3 client (free key at https://api.congress.gov/sign-up/).
// Powers the LIVE legislative feed for the Divergence Score: a member's sponsored +
// cosponsored legislation (both chambers, with CRS policyArea attached) and recent
// House roll-call vote positions (beta endpoint; Senate positions aren't in the API).
//
// Everything is best-effort: any failure throws to the caller which logs + skips, so a
// flaky API never breaks the build. The key is sent as the documented `?api_key=`
// query param (the API's only auth mechanism), to the API that owns it.

import { config } from '../config.js';

const BASE = 'https://api.congress.gov/v3';

async function apiGet(path, params = {}) {
  const key = config.providers.congressKey;
  if (!key) throw new Error('no CONGRESS_API_KEY set');
  const qs = new URLSearchParams({ format: 'json', limit: '250', ...params, api_key: key });
  const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`congress ${r.status} ${path}`);
  return r.json();
}

// HR/HJRES/HRES/HCONRES -> house; S/SJRES/... -> senate.
export function chamberOfBillType(type) {
  const t = String(type || '').toUpperCase();
  if (t.startsWith('H')) return 'house';
  if (t.startsWith('S')) return 'senate';
  return '';
}

function mapLeg(item) {
  return {
    title: item.title || item.latestTitle || '',
    policyArea: (item.policyArea && item.policyArea.name) || '',
    type: item.type || '',
    number: item.number || '',
    congress: item.congress || '',
    date: item.introducedDate || (item.latestAction && item.latestAction.actionDate) || '',
  };
}

export async function fetchSponsored(bioguide) {
  const j = await apiGet(`/member/${bioguide}/sponsored-legislation`);
  return (j.sponsoredLegislation || []).map(mapLeg).filter((x) => x.title);
}

export async function fetchCosponsored(bioguide) {
  const j = await apiGet(`/member/${bioguide}/cosponsored-legislation`);
  return (j.cosponsoredLegislation || []).map(mapLeg).filter((x) => x.title);
}

// A bill's CRS policy area (cached by the caller to avoid refetching the same bill).
export async function fetchBillPolicyArea(congress, type, number) {
  const j = await apiGet(`/bill/${congress}/${String(type).toLowerCase()}/${number}`);
  return (j.bill && j.bill.policyArea && j.bill.policyArea.name) || '';
}

// Recent House roll-call votes with per-member positions. BETA endpoint — shape varies,
// so this is deliberately tolerant and returns [] on any problem.
//   max     = how many recent votes to pull
//   wanted  = Set of bioguide IDs we care about (members with trades)
//   areaCache = { 'congress/type/number' -> policyArea } persisted across runs
// Returns [{ bioguide, action:'yea'|'nay', title, policyArea, billId, date, congress, type, number }]
export async function fetchHouseVotes(max, wanted, areaCache = {}) {
  let list;
  try {
    const j = await apiGet('/house-vote', { limit: String(max) });
    list = j.houseRollCallVotes || j.houseVotes || j.votes || [];
  } catch (e) {
    console.error(`[congress] house-vote list unavailable: ${e.message}`);
    return [];
  }
  const out = [];
  for (const v of list.slice(0, max)) {
    const congress = v.congress;
    const session = v.sessionNumber || v.session;
    const num = v.rollCallNumber || v.voteNumber || v.number;
    if (congress == null || session == null || num == null) continue;
    let members, vinfo;
    try {
      const j = await apiGet(`/house-vote/${congress}/${session}/${num}/members`);
      vinfo = j.houseRollCallVoteMemberVotes || j.houseVote || j || {};
      members = vinfo.results || vinfo.members || [];
    } catch (e) {
      continue; // skip this vote, keep going
    }
    // The voted bill (to look up its policy area).
    const bill = vinfo.legislation || v.legislation || {};
    const type = bill.type || v.legislationType || '';
    const bnum = bill.number || v.legislationNumber || '';
    const billId = type && bnum ? `${type}${bnum}` : '';
    let policyArea = '';
    if (type && bnum) {
      const ck = `${congress}/${type}/${bnum}`;
      if (ck in areaCache) policyArea = areaCache[ck];
      else {
        try {
          policyArea = await fetchBillPolicyArea(congress, type, bnum);
        } catch {
          policyArea = '';
        }
        areaCache[ck] = policyArea;
      }
    }
    const title = bill.title || v.voteQuestion || v.question || billId || 'House vote';
    const date = (v.startDate || v.date || '').slice(0, 10);
    for (const m of members) {
      const bioguide = m.bioguideId || m.bioguideID || (m.member && m.member.bioguideId);
      if (!bioguide || !wanted.has(bioguide)) continue;
      const cast = String(m.voteCast || m.votePosition || m.position || '').toLowerCase();
      const action = cast.startsWith('yea') || cast === 'yes' || cast === 'aye' ? 'yea'
        : cast.startsWith('nay') || cast === 'no' ? 'nay' : '';
      if (!action) continue;
      out.push({ bioguide, action, title, policyArea, billId, date, congress, type, number: bnum });
    }
  }
  return out;
}
