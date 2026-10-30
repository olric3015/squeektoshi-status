// Shared helpers. Everything here reads the public Squeekchain API: no wallet, no keys.
export const API = "https://api.squeekchain.com/v1";

// Where the Claim buttons send people to sign. A plain web page, because a wallet
// like MetaMask can only talk to normal websites, not to extension popups.
export const ACTION_PAGE = "https://olric3015.github.io/squeektoshi-status/act.html";
// Merging goes through the official app (see README for why).
export const OFFICIAL_APP = "https://sepolia.squeekchain.com";

async function getJson(path) {
  const res = await fetch(API + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

export const fetchStatus = () => getJson("/status");
export const fetchSettlements = () => getJson("/settlements?range=24h");
// Follows nextCursor so wallets with more than one page of Squeeks are complete.
// The cursor pins the same chain snapshot, so pages line up.
export async function fetchAccount(addr, maxPages = 20) {
  const base = `/accounts/${addr.toLowerCase()}`;
  const first = await getJson(base);
  if (first.status !== "available") return first;
  const tokens = [...(first.tokens || [])];
  let cursor = first.nextCursor;
  for (let i = 1; cursor && i < maxPages; i++) {
    const page = await getJson(`${base}?cursor=${encodeURIComponent(cursor)}`);
    if (page.status !== "available") return { ...first, status: "unavailable" }; // never summarize a partial holding
    tokens.push(...(page.tokens || []));
    cursor = page.nextCursor;
  }
  if (cursor) return { ...first, status: "unavailable" };
  return { ...first, tokens, nextCursor: null };
}

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test((s || "").trim());
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

// ---------- wheel ----------

// "running" | "idle" | "offline" | "fault" | "unknown"
export function wheelState(status) {
  const m = status && status.measurement;
  if (!m || status.status === "unavailable") return "unknown";
  if (m.freshness !== "online") return "offline";
  if (m.coreStatus === "COUNTER_FAULT") return "fault";
  if (m.coreStatus === "ACTIVE" || m.coreStatus === "SPINNING" || Number(m.speedMmPerSecond) > 0) return "running";
  return "idle";
}

export const STATE_TEXT = {
  running: { title: "Squeektoshi is running!", sub: "the wheel is spinning and blocks are being mined", badge: "RUN" },
  idle: { title: "Squeektoshi is napping", sub: "no running = no blocks. check back later", badge: "" },
  offline: { title: "Wheel is offline", sub: "the sensor hasn't reported in for a bit", badge: "OFF" },
  fault: { title: "Sensor hiccup", sub: "the wheel counter reported a fault", badge: "!" },
  unknown: { title: "Status unknown", sub: "couldn't read the API right now", badge: "?" },
};

export function iconSet(state) {
  const name = state === "running" ? "run" : state === "idle" ? "idle" : "off";
  return { 16: `icons/${name}-16.png`, 32: `icons/${name}-32.png` };
}

// ---------- Squeek holder ----------

const WEI = 10n ** 18n;
export const toSqk = (base) => Number(BigInt(base || "0") / 10n ** 15n) / 1000; // 3 decimals, no float drift on big ints
export const fmtSqk = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });

// Turns the /accounts response into what the popup and alerts need.
export function summarize(acct) {
  if (!acct || acct.status !== "available") return null;
  const height = BigInt(acct.economy?.coreBlockHeight || "0");
  const maxLevel = Number(acct.economy?.maximumLevel || 10);
  const tokens = acct.tokens || [];

  // Pairs of same-level Squeeks whose cooldowns are over: these can merge now.
  const readyByLevel = {};
  for (const t of tokens) {
    if (t.mergeState === "ready" && t.level < maxLevel) (readyByLevel[t.level] ||= []).push(t.tokenId);
  }
  const mergePairs = Object.entries(readyByLevel)
    .filter(([, ids]) => ids.length >= 2)
    .map(([level, ids]) => ({ level: Number(level), ids, pairs: Math.floor(ids.length / 2) }))
    .sort((a, b) => a.level - b.level);

  // Soonest cooldown ending, counted in Squeek blocks.
  const waits = tokens
    .filter((t) => t.mergeState === "cooldown" && t.nextMergeHeight)
    .map((t) => BigInt(t.nextMergeHeight) - height)
    .filter((d) => d > 0n)
    .sort((a, b) => (a < b ? -1 : 1));

  const earnings = (acct.earnings || []).map((e) => ({ date: e.date, sqk: toSqk(e.earnedBaseUnits) }));
  const nftPower = BigInt(acct.power?.nftPower || "0");
  const sqkPower = BigInt(acct.power?.sqkPower || "0");

  return {
    count: tokens.length,
    countTotal: Number(acct.tokenCounts?.staking || 0) + Number(acct.tokenCounts?.wallet || 0) || tokens.length,
    levels: tokens.reduce((m, t) => ((m[t.level] = (m[t.level] || 0) + 1), m), {}),
    claimable: toSqk(acct.rewards?.claimableBaseUnits),
    lifetimePaid: toSqk(acct.rewards?.lifetimePaidBaseUnits),
    power: Number((nftPower + sqkPower) / WEI),
    today: earnings.length ? earnings[earnings.length - 1].sqk : 0,
    earnings,
    mergePairs,
    readyPairs: mergePairs.reduce((s, p) => s + p.pairs, 0),
    nextCooldownBlocks: waits.length ? Number(waits[0]) : null,
    mergesOpen: acct.economy?.mergesOpen !== false,
    blockHeight: Number(height),
  };
}
