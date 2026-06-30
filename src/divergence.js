// Divergence Score (the "Hypocrisy Score"): merges the FINANCIAL dataset (stock
// trades) with the LEGISLATIVE dataset (votes + sponsorships) and scores, per
// member, how far their public legislative stance on a sector diverges from where
// their private money actually sits.
//
//   DS = 0   perfect alignment  — votes to help a sector AND is long it (or votes to
//                                 hurt a sector AND has divested it).
//   DS = 100 maximum hypocrisy  — votes/sponsors to tax or restrict a sector while
//                                 holding a large LONG position in that exact sector.
//
// Per (member, sector):
//   voteStance      in [-1,1] = action-weighted mean of (billStance * memberSupport)
//   portfolioStance in [-1,1] = (sum of signed dollars) / (sum of |dollars|), buy=+ sell=-
//   d               in [0,1]  = max(0, -voteStance * portfolioStance)   (opposite signs)
// Member DS = 100 * sum(exposure * d) / sum(exposure) over sectors with BOTH a vote
// and a position; alignmentRate = share of those sectors where the signs agree.
//
// Output: docs/divergence.json (frontend), data/divergence.json (state) and a
// human-readable data/divergence.md. Trades come from the SAME corpus as the
// performance index (sample-only when DATA_PROVIDER=sample, so the demo is
// deterministic offline). Votes come from src/votes.js (sample by default).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { readState, writeState, writeText } from './stateStore.js';
import { loadTrades } from './performance.js';
import { fetchAllVotes } from './votes.js';
import { getServingIndex } from './legislators.js';
import { normName, getProfiles, profile } from './enrich.js';

// Action -> how strongly it signals the member backs the bill, and the sign of that
// backing. (co)sponsoring weighs more than a single floor vote.
const ACTION_WEIGHT = { sponsor: 2.0, cosponsor: 1.5, yea: 1.0, nay: 1.0 };
const ACTION_SUPPORT = { sponsor: 1, cosponsor: 1, yea: 1, nay: -1 };

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// Resolve each trade's sector string from the cache, warming missing tickers from
// FMP when a key is available (bounded; sample tickers are pre-seeded so no key needed).
async function sectorMap(trades) {
  let sectors = await readState('sectors.json', {});
  if (config.providers.fmpKey) {
    const need = [...new Set(trades.map((t) => t.ticker))].filter((t) => t && !(t in sectors)).slice(0, 40);
    if (need.length) {
      await getProfiles(need);
      sectors = await readState('sectors.json', {});
    }
  }
  return (ticker) => profile(sectors[ticker]).s || '';
}

export async function buildDivergence() {
  // Safety guard: if the live provider is selected but no API key is present (e.g. CI
  // without the CONGRESS_API_KEY secret), DON'T rebuild — that would replace the real,
  // committed board with the tiny sample fallback. Leave the existing artifact in place.
  if (config.votesProvider === 'congressgov' && !config.providers.congressKey) {
    console.error('[divergence] congressgov selected but no CONGRESS_API_KEY — skipping rebuild to preserve real data');
    return null;
  }

  const files = config.dataProvider === 'sample' ? ['sample_trades.json'] : undefined;
  const [trades, votes] = await Promise.all([loadTrades(files), fetchAllVotes()]);
  const sectorOf = await sectorMap(trades);

  // member key -> { display, port: Map<sector,{signed,abs,tickers:Map<ticker,signed>}>,
  //                          vote: Map<sector,{sum,w,examples:[]}> }
  const members = new Map();
  const get = (name) => {
    const k = normName(name);
    if (!members.has(k)) members.set(k, { display: name, chamber: '', port: new Map(), vote: new Map() });
    return members.get(k);
  };

  // --- financial side ---
  for (const t of trades) {
    const sec = sectorOf(t.ticker);
    if (!sec || (t.type !== 'buy' && t.type !== 'sell')) continue;
    const m = get(t.politician);
    if (!m.chamber && t.chamber) m.chamber = t.chamber;
    if (!m.port.has(sec)) m.port.set(sec, { signed: 0, abs: 0, tickers: new Map() });
    const cell = m.port.get(sec);
    const amt = t.amountLow || 0;
    const s = t.type === 'buy' ? amt : -amt;
    cell.signed += s;
    cell.abs += amt;
    cell.tickers.set(t.ticker, (cell.tickers.get(t.ticker) || 0) + s);
  }

  // --- legislative side ---
  for (const v of votes) {
    const m = get(v.politician);
    if (!m.chamber && v.chamber) m.chamber = v.chamber;
    if (!m.vote.has(v.sector)) m.vote.set(v.sector, { sum: 0, w: 0, examples: [] });
    const cell = m.vote.get(v.sector);
    const w = ACTION_WEIGHT[v.action] ?? 1;
    const recordStance = v.billStance * (ACTION_SUPPORT[v.action] ?? 1);
    cell.sum += recordStance * w;
    cell.w += w;
    cell.examples.push({ title: v.title, action: v.action, billStance: v.billStance, recordStance });
  }

  // --- merge + score ---
  // Only score members who currently hold office — former members' votes-vs-money is
  // historical trivia, not a live conflict of interest.
  const { isServing } = await getServingIndex();
  const out = [];
  for (const m of members.values()) {
    if (!isServing(m.display)) continue; // skip retired/defeated/former members
    const sectors = [];
    let wExp = 0;
    let wDiv = 0;
    let aligned = 0;
    for (const [sec, vc] of m.vote) {
      const pc = m.port.get(sec);
      if (!pc || pc.abs === 0 || vc.w === 0) continue; // need BOTH a vote and a position
      const voteStance = vc.sum / vc.w;
      const portfolioStance = pc.signed / pc.abs;
      const d = Math.max(0, -voteStance * portfolioStance);
      const exposure = pc.abs;
      wExp += exposure;
      wDiv += exposure * d;
      const signsAgree = sign(voteStance) !== 0 && sign(voteStance) === sign(portfolioStance);
      if (signsAgree) aligned++;
      sectors.push({
        sector: sec,
        voteStance: round(voteStance),
        portfolioStance: round(portfolioStance),
        divergence: round(d),
        exposure,
        aligned: signsAgree,
        tickers: [...pc.tickers.keys()],
        example: pickExample(vc.examples),
      });
    }
    if (!sectors.length) continue; // no overlap -> not scorable
    sectors.sort((a, b) => b.divergence - a.divergence || b.exposure - a.exposure);
    out.push({
      member: m.display,
      chamber: m.chamber,
      ds: Math.round((wExp ? (wDiv / wExp) * 100 : 0)),
      alignmentRate: Math.round((aligned / sectors.length) * 100),
      sectorsScored: sectors.length,
      sectors,
    });
  }
  out.sort((a, b) => b.ds - a.ds);

  const report = { generatedAt: new Date().toISOString(), method: 'divergence score (votes vs. money), 0=aligned 100=hypocrisy', members: out };
  await writeState('divergence.json', report);
  await writeText('divergence.md', renderMarkdown(report));
  await writeDocs(report);
  return report;
}

// The most divergent example wins as the headline; ties broken by sponsorship weight.
function pickExample(examples) {
  if (!examples.length) return null;
  const sorted = [...examples].sort((a, b) => (ACTION_WEIGHT[b.action] ?? 1) - (ACTION_WEIGHT[a.action] ?? 1));
  return sorted[0];
}

const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

async function writeDocs(report) {
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, 'divergence.json'), JSON.stringify(report));
}

function renderMarkdown(r) {
  const lines = [
    '# Congressional Divergence Score (Hypocrisy Score)',
    '',
    `_0 = votes match where their money sits · 100 = votes/sponsors against a sector they're long. Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC._`,
    '',
    '| Member | Divergence | Votes match disclosures | Sectors |',
    '| --- | ---: | ---: | ---: |',
    ...r.members.map((m) => `| ${m.member} | ${m.ds} | ${m.alignmentRate}% | ${m.sectorsScored} |`),
    '',
    '_Divergence is dollar-weighted across each member\'s sectors; not financial or legal advice._',
  ];
  return lines.join('\n');
}

function printReport(r) {
  console.log('\n⚖️  Divergence Score — votes vs. money (0 aligned · 100 hypocrisy)');
  console.log('────────────────────────────────────────────────────────');
  for (const m of r.members) {
    console.log(`  DS ${String(m.ds).padStart(3)}  align ${String(m.alignmentRate).padStart(3)}%  ${m.member}`);
    for (const s of m.sectors) {
      const tag = s.aligned ? 'aligned' : 'DIVERGE';
      console.log(`        [${tag}] ${s.sector}: vote ${s.voteStance >= 0 ? '+' : ''}${s.voteStance} · portfolio ${s.portfolioStance >= 0 ? '+' : ''}${s.portfolioStance} (${s.tickers.join(', ')})`);
    }
  }
  console.log(`\n${r.members.length} member(s) scored.`);
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('divergence.js')) {
  buildDivergence()
    .then(printReport)
    .catch((e) => {
      console.error('divergence failed:', e.message);
      process.exit(1);
    });
}
