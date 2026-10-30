import {
  fetchStatus, fetchSettlements, fetchAccount, summarize, wheelState, STATE_TEXT,
  isAddress, shortAddr, fmtSqk, toSqk, ACTION_PAGE, OFFICIAL_APP,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;
const DEFAULTS = { notify: true, notifyMerge: true, notifyClaim: true, claimThreshold: 100 };

// Storage that also works when the popup is opened as a plain page (for testing).
const store = {
  async get() {
    if (hasChrome) return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("sk") || "{}") }; } catch { return { ...DEFAULTS }; }
  },
  async set(o) {
    if (hasChrome) return chrome.storage.local.set(o);
    try { localStorage.setItem("sk", JSON.stringify({ ...(await store.get()), ...o })); } catch {}
  },
};
const openTab = (url) => (hasChrome && chrome.tabs ? chrome.tabs.create({ url }) : window.open(url, "_blank"));
const fmtInt = (n) => Number(n).toLocaleString("en-US");

function ago(iso) {
  if (!iso) return "–";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function bars(el, values, titles) {
  const max = Math.max(1, ...values);
  el.replaceChildren(
    ...values.map((v, i) => {
      const b = document.createElement("i");
      b.style.height = `${Math.max(4, (v / max) * 100)}%`;
      if (v > 0) b.className = "on";
      b.title = titles[i];
      return b;
    })
  );
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- My Squeeks ----------
let watched = null;

function showWatchForm(prefill = "") {
  $("holder").classList.add("hidden");
  $("watchForm").classList.remove("hidden");
  $("addr").value = prefill;
  $("addr").focus();
}

$("watchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("addr").value.trim();
  if (!isAddress(a)) return ($("addrErr").textContent = "That doesn't look like a wallet address (0x + 40 characters).");
  $("addrErr").textContent = "";
  watched = a.toLowerCase();
  await store.set({ watch: watched, lastSummary: null });
  $("watchForm").classList.add("hidden");
  if (hasChrome) chrome.runtime.sendMessage({ type: "refresh", wallet: true }).catch(() => {});
  loadHolder();
});
$("changeAddr").addEventListener("click", () => showWatchForm(watched || ""));

document.querySelectorAll("[data-act]").forEach((b) =>
  b.addEventListener("click", () => openTab(`${ACTION_PAGE}?action=${b.dataset.act}&account=${watched}`))
);
$("mergeBtn").addEventListener("click", () => openTab(OFFICIAL_APP));

function renderHolder(s, settings) {
  $("whoAddr").textContent = shortAddr(watched);
  $("claimable").textContent = fmtSqk(s.claimable);
  $("today").textContent = `+${fmtSqk(s.today)} today`;
  document.querySelectorAll("[data-act]").forEach((b) => (b.disabled = s.claimable <= 0));
  $("count").textContent = fmtInt(s.countTotal);
  $("power").textContent = fmtInt(s.power);

  const list = $("pairs");
  list.replaceChildren();
  if (!s.count) {
    list.innerHTML = `<li class="none">No Squeeks in this wallet yet.</li>`;
  } else if (!s.mergesOpen) {
    list.innerHTML = `<li class="none">Merging is closed right now.</li>`;
  } else if (s.mergePairs.length) {
    for (const p of s.mergePairs) {
      const li = document.createElement("li");
      li.innerHTML = `<span><span class="lv">Lv${p.level}→${p.level + 1}</span>#${p.ids[0]} + #${p.ids[1]}${p.pairs > 1 ? ` <span class="muted">+${p.pairs - 1} more</span>` : ""}</span><span class="ready">ready</span>`;
      list.append(li);
    }
  } else {
    list.innerHTML = `<li class="none">No same-level pair is ready yet.</li>`;
  }
  $("mergeHint").textContent = s.readyPairs
    ? `${s.readyPairs} pair${s.readyPairs > 1 ? "s" : ""} ready`
    : s.nextCooldownBlocks != null ? `next cooldown ends in ${fmtInt(s.nextCooldownBlocks)} blocks` : "";
  $("mergeBtn").classList.toggle("hidden", !s.readyPairs);

  const days = s.earnings.slice(-7);
  bars($("earnBars"), days.map((d) => d.sqk), days.map((d) => `${d.date}: ${fmtSqk(d.sqk)} SQK`));
  $("week").innerHTML = `<b>${fmtSqk(days.reduce((a, d) => a + d.sqk, 0))}</b> SQK`;

  const todo = s.readyPairs + (s.claimable >= Number(settings.claimThreshold) ? 1 : 0);
  document.querySelector('[data-tab="squeeks"]').innerHTML = `My Squeeks${todo ? `<span class="dot">${todo}</span>` : ""}`;
}

async function loadHolder() {
  // Don't yank the address form away while someone is typing in it.
  if (!$("watchForm").classList.contains("hidden") && watched !== null) return;
  if (!$("watchForm").classList.contains("hidden") && $("addr").value) return;
  const settings = await store.get();
  watched = settings.watch || null;
  if (!watched) return showWatchForm();
  $("watchForm").classList.add("hidden");
  $("holder").classList.remove("hidden");
  $("whoAddr").textContent = shortAddr(watched);
  try {
    const s = summarize(await fetchAccount(watched));
    if (!s) throw new Error("unavailable");
    $("holderErr").textContent = "";
    renderHolder(s, settings);
  } catch (e) {
    $("holderErr").textContent = "Couldn't load this wallet right now. Try again in a minute.";
  }
}

// ---------- Hamster ----------
async function loadWheel() {
  try {
    const [status, st] = await Promise.all([fetchStatus(), fetchSettlements()]);
    const state = wheelState(status);
    const t = STATE_TEXT[state];
    document.body.classList.toggle("running", state === "running");
    $("title").textContent = t.title;
    $("sub").textContent = t.sub;
    $("face").src = `icons/${state === "running" ? "run" : state === "idle" ? "idle" : "off"}-128.png`;
    const m = status.measurement || {};
    $("speed").textContent = state === "running" ? `${((Number(m.speedMmPerSecond || 0) / 1000) * 3.6).toFixed(1)} km/h` : "0 km/h";
    $("distance").textContent = `${(Number(m.distanceMm || 0) / 1e6).toFixed(2)} km`;
    const h = status.builder?.projected?.blockHeight ?? status.builder?.anchor?.blockHeight;
    $("height").textContent = h ? fmtInt(h) : "–";

    $("blocks24").textContent = fmtInt(st.summary?.completedBlockCount || 0);
    const buckets = (st.buckets || []).slice(-24);
    const minted = buckets.reduce((a, b) => a + BigInt(b.sqkMintedBaseUnits || "0"), 0n);
    $("sqk24").textContent = fmtSqk(Math.floor(toSqk(minted.toString())));
    bars($("bars"), buckets.map((b) => Number(b.workAdded || 0)),
      buckets.map((b) => `${new Date(b.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${fmtInt(b.workAdded || 0)} work`));
    const last = (st.recentSettlements || []).find((r) => Number(r.workAdded) > 0);
    $("lastRun").textContent = state === "running" ? "right now" : last ? ago(last.blockTimestamp) : "not in 24h";
  } catch (e) {
    $("title").textContent = STATE_TEXT.unknown.title;
    $("sub").textContent = STATE_TEXT.unknown.sub;
  }
}

// ---------- Alerts ----------
async function loadAlerts() {
  const s = await store.get();
  for (const k of ["notify", "notifyMerge", "notifyClaim"]) {
    $(k).checked = !!s[k];
    $(k).onchange = (e) => store.set({ [k]: e.target.checked });
  }
  $("claimThreshold").value = s.claimThreshold;
  $("claimThreshold").onchange = (e) => store.set({ claimThreshold: Math.max(1, Number(e.target.value) || 100) });
}

(async () => {
  const s = await store.get();
  if (!s.watch) showTab("squeeks");
  loadAlerts();
  loadHolder();
  loadWheel();
  if (hasChrome) {
    chrome.runtime.sendMessage({ type: "refresh" }).catch(() => {});
    // Re-render when the background worker saves a fresh wallet check.
    chrome.storage.onChanged.addListener((ch) => { if (ch.lastSummary || ch.watch) loadHolder(); });
  }
  setInterval(loadWheel, 15000);
  setInterval(loadHolder, 60000); // keep claimable SQK, pairs and cooldowns fresh while open
  // Coming back from the claim page or another tab: refresh right away.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadHolder(); loadWheel(); } });
})();
