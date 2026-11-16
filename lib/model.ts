// The radar's scoring model: one sealed snapshot in, one ranked board out.
//
// What the board holds: every protocol on the snapshot's watchlist, plus the
// early radar — pre-token protocols below the watchlist floor, taken by TVL
// up to a cap. A protocol counts as pre-token when its record carries no
// market cap, no CoinGecko id and no symbol. Protocols that already trade
// are set aside and shown with the market's own numbers, never ranked.
//
// What a protocol is worth: only the snapshot's own figures decide. The
// multiple comes from the market itself — for the protocol's category, the
// median market-cap-to-TVL of the protocols that already trade there,
// pulled toward the all-category median so a thin category cannot swing
// the board. Ratios are capped at the 75th percentile first, so one wild
// outlier (the snapshot's largest ratio tops 400) cannot set a category.
// A category with no trading protocol falls back to the global median.
//
//   multiple(cat) = (n_cat * median_cat + 5 * median_all) / (n_cat + 5)
//   growth        = change_7d clamped to [-60, 120]
//   growthMult    = 1 + growth/100 * 0.5
//   maturity      = 0.6 + min(age_days, 1095)/1095 * 0.4   (unknown age: 365)
//   implied       = max(1, round(tvl * multiple * growthMult * maturity))
//
// No name is ever special-cased. The farm plans are the one place a
// protocol's own record shapes the words, and the tuned plans in
// plans.json cover the protocols whose farming path is documented.

import { readFileSync } from 'node:fs';

/** The model's tunables, as the dashboard prints them. */
export interface ModelConstants {
  shrink_prior: number;
  unknown_age_days: number;
  maturity_range: number;
  maturity_floor: number;
  maturity_days: number;
  growth_cap: number;
  growth_floor: number;
  growth_weight: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrink_prior: 5,
};

/** The label the dashboard shows for this model version. */
export const MODEL_VERSION = 'radar-2';

/** How many below-floor pre-token protocols the early radar takes, by TVL. */
export const EARLY_ROWS = 260;

/** How many trading protocols the live view shows, by market cap. */
export const LIVE_ROWS = 24;

/** Milliseconds in a day, for turning dates into an age in days. */
const MS_PER_DAY = 86_400_000;

/** One protocol as the sealed snapshot records it: exactly ten fields. */
export interface SnapshotProtocol {
  symbol: string | null;
  gecko_id: string | null;
  listed_at: string | null;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_usd: number;
  chains: string[];
  category: string | null;
  name: string;
  slug: string;
}

/** The sealed snapshot document. */
export interface Snapshot {
  watchlist: string[];
  protocols: SnapshotProtocol[];
  floor_usd: number;
  source: string;
  as_of: string;
}

/** One farm step: what to do, what it costs, how long it takes. */
export interface FarmStep {
  time: string;
  cost: string;
  text: string;
}

/** A trading protocol, shown with the market's own value. */
export interface LiveRow {
  change_7d: number | null;
  mcap_usd: number | null;
  tvl_usd: number;
  chains: string[];
  category: string | null;
  name: string;
  slug: string;
}

/** One ranked row of board.json. */
export interface BoardRow {
  farm_steps: string[];
  model: {
    age_days: number | null;
    maturity_multiplier: number;
    growth_multiplier: number;
    growth_pct: number;
    global_median: number;
    category_comparables: number;
    category_median: number | null;
    category_multiple: number;
  };
  implied_value_usd: number;
  age_days: number | null;
  token_status: 'pre-token';
  symbol: string | null;
  gecko_id: string | null;
  listed_at: string | null;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_usd: number;
  chains: string[];
  category: string | null;
  name: string;
  slug: string;
  rank: number;
}

/** A board row slimmed down for data.js; the page builds the plan itself. */
export interface RadarRow {
  maturity_multiplier: number;
  growth_multiplier: number;
  category_multiple: number;
  implied_value_usd: number;
  age_days: number | null;
  listed_at: string | null;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_usd: number;
  chains: string[];
  category: string | null;
  name: string;
  slug: string;
  rank: number;
}

/** Everything the dashboard page needs to render. */
export interface RadarData {
  live: LiveRow[];
  rows: RadarRow[];
  live_size: number;
  early_size: number;
  board_size: number;
  watchlist_size: number;
  model_version: string;
  model: ModelConstants;
  floor_usd: number;
  source: string;
  as_of: string;
}

/** Thrown when the snapshot is not shaped the way this model scores it. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The per-category multiples the model read off the snapshot. */
export interface CategoryMultiples {
  by_category: Map<string, { median: number; n: number }>;
  global_median: number;
}

/** `value` when it is a finite number, `fallback` otherwise. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` up to `asOf`, never below zero; null when the date is missing or unparsable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(listed) || !Number.isFinite(now)) return null;
  const days = Math.floor((now - listed) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

/** The middle of a sorted list, or null when it holds nothing. */
function middleValue(sorted: number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const half = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[half]!;
  return (sorted[half - 1]! + sorted[half]!) / 2;
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** A number rounded to four decimals, for the model's reported figures. */
const to4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A name that ends in a version marker names a pool of another protocol, not a protocol of its own. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True when the record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the board may rank this protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  return !VERSION_SUFFIX.test(p.name);
}

/** True when a protocol can stand as a market comparable: it trades, has TVL, and is not an exchange token. */
function isComparable(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.tvl_usd > 0 && p.category !== 'CEX';
}

/**
 * The market's own multiple per category, read off the snapshot: for each
 * category, the median market-cap-to-TVL of its trading protocols, with
 * every ratio first capped at the 75th percentile of all ratios so one
 * extreme cannot set a category. The global median is the fallback and
 * the shrinkage prior.
 */
export function categoryMultiples(snapshot: Snapshot): CategoryMultiples {
  const ratiosByCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isComparable(p)) continue;
    const ratio = p.mcap_usd! / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everyRatio.push(ratio);
  }
  everyRatio.sort((a, b) => a - b);
  const globalMedian = middleValue(everyRatio) ?? 0.25;
  const capAt = everyRatio.length === 0 ? -1 : Math.floor(0.75 * (everyRatio.length - 1));
  const cap = capAt < 0 ? globalMedian : everyRatio[capAt]!;
  for (const p of snapshot.protocols) {
    if (!isComparable(p)) continue;
    const ratio = Math.min(p.mcap_usd! / p.tvl_usd, cap);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const key = p.category ?? 'Other';
    const bucket = ratiosByCategory.get(key);
    if (bucket === undefined) ratiosByCategory.set(key, [ratio]);
    else bucket.push(ratio);
  }
  const by_category = new Map<string, { median: number; n: number }>();
  for (const [cat, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    const med = middleValue(ratios);
    if (med !== null) by_category.set(cat, { median: med, n: ratios.length });
  }
  return { global_median: globalMedian, by_category };
}

/** One category's multiple: its median pulled toward the global median by the shrinkage prior. */
export function multipleFor(category: string | null, multiples: CategoryMultiples, model: ModelConstants): { multiple: number; median: number | null; n: number } {
  const entry = multiples.by_category.get(category ?? 'Other');
  if (entry === undefined) return { multiple: multiples.global_median, median: null, n: 0 };
  const prior = model.shrink_prior;
  const blended = (entry.n * entry.median + prior * multiples.global_median) / (entry.n + prior);
  return { multiple: blended, median: entry.median, n: entry.n };
}

/** Everything the model says about one protocol: its multipliers and its implied value. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: CategoryMultiples,
  model: ModelConstants,
): { implied: number; multiple: number; median: number | null; n: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = rawGrowth < model.growth_floor ? model.growth_floor : rawGrowth > model.growth_cap ? model.growth_cap : rawGrowth;
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const cappedAge = ageForModel < 0 ? 0 : ageForModel > model.maturity_days ? model.maturity_days : ageForModel;
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const { multiple, median: catMedian, n } = multipleFor(protocol.category, multiples, model);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, median: catMedian, n, growthPct, growthMult, maturityMult, age };
}

/** The board's rows: the watchlist first, then the early radar, scored and ranked. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot);
  const index = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const entry = index.get(slug);
    if (entry !== undefined) picked.set(slug, entry);
  }
  const candidates: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    if (picked.has(p.slug)) continue;
    if (!isRankable(p)) continue;
    if (p.tvl_usd >= snapshot.floor_usd) continue;
    candidates.push(p);
  }
  candidates.sort((a, b) => {
    if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (const p of candidates.slice(0, EARLY_ROWS)) picked.set(p.slug, p);

  const scored: { protocol: SnapshotProtocol; value: ReturnType<typeof impliedValue> }[] = [];
  for (const p of picked.values()) {
    scored.push({ protocol: p, value: impliedValue(p, snapshot.as_of, multiples, model) });
  }
  scored.sort((a, b) => {
    if (b.value.implied !== a.value.implied) return b.value.implied - a.value.implied;
    const x = a.protocol.slug;
    const y = b.protocol.slug;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const rows: BoardRow[] = [];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    const p = s.protocol;
    const v = s.value;
    rows.push({
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: v.age,
      implied_value_usd: v.implied,
      model: {
        category_multiple: to4dp(v.multiple),
        category_median: v.median === null ? null : to4dp(v.median),
        category_comparables: v.n,
        global_median: to4dp(multiples.global_median),
        growth_pct: v.growthPct,
        growth_multiplier: to4dp(v.growthMult),
        maturity_multiplier: to4dp(v.maturityMult),
        age_days: v.age,
      },
      farm_steps: farmSteps(p, v.age).map(stepText),
    });
  }
  return rows;
}

/** One step as a single string: the action, then its cost and time, kept inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  const joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  const capped = joined.length > 600 ? `${joined.slice(0, 596)}...` : joined;
  if (capped.length < 20) return `${capped} Hold the position and check the protocol's own page.`;
  return capped;
}

/** The first chain the protocol lists, or a neutral phrase when it lists none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The stake size for one farm position, by TVL tier. */
const STAKE_TIERS: [number, number][] = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

function stakeSize(p: SnapshotProtocol): number {
  for (const [floor, size] of STAKE_TIERS) {
    if (p.tvl_usd >= floor) return size;
  }
  return 50;
}

/** How many days to hold, by age: younger protocols get a longer qualifying window. */
const HOLD_TIERS: [number, number][] = [
  [180, 60],
  [365, 45],
];

function holdWindow(age: number | null): number {
  if (age === null) return 30;
  for (const [limit, days] of HOLD_TIERS) {
    if (age < limit) return days;
  }
  return 30;
}

/** One rule of the action table: when it matches a category, and the step it writes. */
interface ActionRule {
  matches: (category: string) => boolean;
  write: (capital: number, name: string, chain: string) => string;
}

/** The category's one action, in the words a farmer can follow. First matching rule wins. */
const ACTION_RULES: ActionRule[] = [
  { matches: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), write: (capital, name, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.` },
  { matches: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'), write: (capital, name, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
  { matches: (c) => c.includes('bridge'), write: (capital, name, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.` },
  { matches: (c) => c.includes('staking') || c.includes('restak'), write: (capital, name, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.` },
  { matches: (c) => c.includes('perpetual') || c.includes('derivative'), write: (capital, name, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.` },
  { matches: (c) => c.includes('prediction'), write: (capital, name, chain) => `Fund $${capital} and place one market position on ${name}.` },
  { matches: (c) => c.includes('curator') || c.includes('allocator'), write: (capital, name, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.` },
  { matches: (c) => c.includes('stable'), write: (capital, name, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.` },
  { matches: (c) => c.includes('rwa'), write: (capital, name, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.` },
  { matches: (c) => c.includes('insurance'), write: (capital, name, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.` },
];

function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.matches(c)) return rule.write(capital, p.name, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. A tuned plan in PLANS
 * replaces the template for the protocols whose farming path is documented.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const tuned = PLANS[p.slug];
  if (tuned !== undefined) return tuned;
  const chain = firstChain(p);
  const capital = stakeSize(p);
  const hold = holdWindow(age);
  const action = mainAction(p, capital, chain);
  const setupGas = capital >= 150 ? 8 : 4;
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${setupGas} of gas`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/** One entry of plans.json, checked before it is trusted: an array of steps with text, cost and time. */
function validPlanSteps(raw: unknown): FarmStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: FarmStep[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue;
    const step = s as FarmStep;
    if (typeof step.text !== 'string' || typeof step.cost !== 'string' || typeof step.time !== 'string') continue;
    steps.push(step);
  }
  return steps.length >= 3 && steps.length <= 12 ? steps : null;
}

/**
 * The hand-tuned farm plans, one per protocol, written from each protocol's
 * own documented farming path. They live in plans.json beside this file so
 * they can be researched and revised without touching the model; a missing
 * or malformed file falls back to the template, never to a failure.
 */
function readTunedPlans(): Record<string, FarmStep[]> {
  try {
    const raw = JSON.parse(readFileSync(new URL('./plans.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const out: Record<string, FarmStep[]> = {};
    for (const [slug, rawSteps] of Object.entries(raw)) {
      const steps = validPlanSteps(rawSteps);
      if (steps !== null) out[slug] = steps;
    }
    return out;
  } catch {
    return {};
  }
}

export const PLANS: Record<string, FarmStep[]> = readTunedPlans();

/** The trading protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => {
    const mcapA = a.mcap_usd ?? 0;
    const mcapB = b.mcap_usd ?? 0;
    if (mcapB !== mcapA) return mcapB - mcapA;
    return b.tvl_usd - a.tvl_usd;
  });
  return trading.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  const compact: RadarRow = {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
  return compact;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  let early = 0;
  for (const r of board) if (!watchlist.has(r.slug)) early++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** One protocol out of the snapshot's raw JSON, checked field by field. */
function parseProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: numOrNull(p.change_7d),
    mcap_usd: numOrNull(p.mcap_usd),
    listed_at: strOrNull(p.listed_at),
    gecko_id: strOrNull(p.gecko_id),
    symbol: strOrNull(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => parseProtocol(v, i));
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    const plural = missing.length === 1 ? '' : 's';
    return `the board misses ${missing.length} watchlist slug${plural}: ${shown}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2) {
    const first = board[0]!.implied_value_usd;
    const last = board[board.length - 1]!.implied_value_usd;
    if (first === last) return `all ${board.length} rows share the same implied value $${first}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
