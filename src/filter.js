import { config } from './config.js';

// Does this trade match the user's watchlist + rules?
export function matches(trade) {
  // 1. Watchlist (empty = follow everyone). Partial, case-insensitive match.
  if (config.watch.length) {
    const name = trade.politician.toLowerCase();
    const onList = config.watch.some((w) => name.includes(w));
    if (!onList) return false;
  }

  // 2. Trade type.
  if (config.tradeTypes !== 'both') {
    if (trade.type !== config.tradeTypes) return false;
  } else if (trade.type !== 'buy' && trade.type !== 'sell') {
    // In "both" mode we still ignore exchanges/unknowns.
    return false;
  }

  // 3. Minimum value (uses the low end of the disclosed range).
  if (config.minTradeValue > 0 && trade.amount.low < config.minTradeValue) {
    return false;
  }

  // 4. Skip rows with no identifiable security.
  if (!trade.ticker && !trade.asset) return false;

  return true;
}

export function applyFilters(trades) {
  return trades.filter(matches);
}
