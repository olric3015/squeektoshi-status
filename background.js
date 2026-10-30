import { fetchStatus, fetchAccount, summarize, wheelState, STATE_TEXT, iconSet, fmtSqk } from "./shared.js";

const ALARM = "squeek-poll";
const ACCOUNT_EVERY = 5; // check the watched wallet every 5 minutes, the wheel every minute
const DEFAULTS = { notify: true, notifyMerge: true, notifyClaim: true, claimThreshold: 100 };

function ping(id, title, message, icon = "icons/run-128.png") {
  chrome.notifications.create(`${id}-${Date.now()}`, { type: "basic", iconUrl: icon, title, message, priority: 1 });
}

async function checkWheel(store) {
  let state = "unknown";
  try {
    state = wheelState(await fetchStatus());
  } catch (e) {
    state = "unknown";
  }
  await chrome.action.setIcon({ path: iconSet(state) });
  await chrome.action.setTitle({ title: `Squeek Keeper: ${STATE_TEXT[state].title}` });

  // Ping only at the moment he starts running, not on every poll.
  if (store.notify && state === "running" && store.lastState && store.lastState !== "running") {
    ping("wake", "Squeektoshi woke up! 🐹", "The wheel is spinning. Blocks are being mined right now.");
  }
  return { lastState: state };
}

async function checkWallet(store) {
  if (!store.watch) return { badgeNote: "" };
  let s;
  try {
    s = summarize(await fetchAccount(store.watch));
  } catch (e) {
    return {};
  }
  if (!s) return {};
  const out = { lastSummary: { ...s, checkedAt: Date.now() } };

  // Merge alert: fire when the number of ready pairs goes up.
  const prevPairs = store.lastSummary?.readyPairs ?? 0;
  if (store.notifyMerge && s.mergesOpen && s.readyPairs > prevPairs) {
    const top = s.mergePairs[s.mergePairs.length - 1];
    ping(
      "merge",
      `Your Squeeks can merge 🔀`,
      `${s.readyPairs} pair${s.readyPairs > 1 ? "s" : ""} ready (e.g. Lv${top.level} #${top.ids[0]} + #${top.ids[1]}). Merging levels one up.`
    );
  }

  // Claim alert: fire once when claimable crosses the threshold, re-arm when it drops back.
  const th = Number(store.claimThreshold) || DEFAULTS.claimThreshold;
  const wasAbove = (store.lastSummary?.claimable ?? 0) >= th;
  if (store.notifyClaim && s.claimable >= th && !wasAbove) {
    ping("claim", `${fmtSqk(s.claimable)} SQK ready to claim 💰`, `Your Squeeks earned past your ${fmtSqk(th)} SQK alert. Open Squeek Keeper to claim.`);
  }
  return out;
}

async function refresh({ wallet = false } = {}) {
  const store = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  const tick = (store.tick || 0) + 1;
  const updates = { tick, ...(await checkWheel(store)) };
  if (wallet || tick % ACCOUNT_EVERY === 1) Object.assign(updates, await checkWallet(store));

  // Badge: a number when something needs you, otherwise RUN while he runs.
  const s = updates.lastSummary || store.lastSummary;
  const todo = store.watch && s ? s.readyPairs + (s.claimable >= Number(store.claimThreshold) ? 1 : 0) : 0;
  const running = updates.lastState === "running";
  await chrome.action.setBadgeText({ text: todo ? String(todo) : STATE_TEXT[updates.lastState].badge });
  await chrome.action.setBadgeBackgroundColor({ color: todo ? "#E8B84A" : running ? "#2FA866" : "#6B6875" });
  await chrome.storage.local.set({ ...updates, checkedAt: Date.now() });
}

function start() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  refresh({ wallet: true });
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && refresh());
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "refresh") refresh({ wallet: !!msg.wallet });
});
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("wake")) chrome.tabs.create({ url: "https://sepolia.squeekchain.com/#live" });
  chrome.notifications.clear(id);
});
