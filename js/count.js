/* count.js — "Just count" mode: log what you ate, stay under budget, recover from big days.
   UI only; every number comes from engine.js. app.js owns state, saving and sheets and
   hands them over through `ctx`, so this module never holds its own copy of state. */

import * as E from "./engine.js";
import * as AI from "./ai.js";

let ctx = null;
let viewOffset = 0;          // 0 = today, -1 = yesterday … -6
let build = null;            // builder draft: { kind, place?, picks|items, name, emoji, key }
let aiImage = null;          // { mediaType, data, preview }
let aiResult = null;         // { items, note }
let scanStream = null;
let scanTimer = null;

const st = () => ctx.state();
const esc = (s) => ctx.esc(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const $ = (sel) => document.querySelector(sel);

export function initCount(context) {
  ctx = context;
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
}

// ---------- data helpers ----------

function eats() { return ctx.data().eats || { places: [], home: [], starterUsuals: [] }; }
function catalog() { return E.catalogItems(eats(), ctx.data(), st()); }

function productItems() {
  return ctx.data().products.map((p) => {
    const eff = E.productById(ctx.data(), st(), p.id);
    return { id: `p:${p.id}`, name: eff.name, emoji: "🛒", group: "Single items", calories: eff.calories, protein: eff.protein, estimated: eff.confidence === "estimated", note: eff.unit };
  });
}

function barcodeItems() {
  return Object.entries(st().barcodes || {}).map(([code, b]) => ({ id: `bc:${code}`, name: b.name, emoji: "▦", group: "Scanned", calories: b.calories, protein: b.protein, note: b.serving }));
}

function usualItems() {
  const all = [...catalog(), ...productItems(), ...barcodeItems()];
  return (st().usuals || []).map((u) => {
    if (u.ref) {
      const item = all.find((x) => x.id === u.ref);
      return item ? { ...item, usualId: u.id } : null;
    }
    return { id: `u:${u.id}`, usualId: u.id, name: u.name, emoji: u.emoji || "⭐", group: "Usual", calories: u.calories, protein: u.protein, note: u.detail || "" };
  }).filter(Boolean);
}

function findItem(id) {
  return [...usualItems(), ...catalog(), ...productItems(), ...barcodeItems(), ...recentItems()].find((x) => x.id === id) || null;
}

function recentItems() {
  const log = st().foodLog || {};
  const seen = new Set();
  const out = [];
  for (const k of Object.keys(log).sort().reverse().slice(0, 21)) {
    for (const e of [...(log[k].entries || [])].reverse()) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ id: `r:${e.id}`, name: e.name, emoji: e.emoji || "🍽", group: "Recent", calories: e.calories, protein: e.protein, note: e.detail || "" });
    }
  }
  return out.slice(0, 10);
}

function seedUsuals() {
  const s = st();
  if (s.usualsSeeded) return;
  const ids = new Set(catalog().map((x) => x.id));
  s.usuals = (eats().starterUsuals || []).filter((r) => ids.has(r)).map((ref) => ({ id: uid(), ref }));
  s.usualsSeeded = true;
  ctx.save();
}

function viewKey() { return E.dateKey(E.addDays(new Date(), viewOffset)); }

function logDay(key, create = true) {
  const s = st();
  if (!s.foodLog[key] && create) s.foodLog[key] = { entries: [], walks: [] };
  const d = s.foodLog[key];
  if (d) { d.entries = d.entries || []; d.walks = d.walks || []; }
  return d || null;
}

function dayStatus(key) {
  const day = logDay(key, false);
  const settled = day?.settled;
  const { budget, trim, credit } = settled ? { budget: settled.budget, trim: settled.trim, credit: 0 } : E.effectiveBudget(st(), day);
  const eaten = E.logTotals(day?.entries);
  return { day, budget, trim, credit, eaten, left: budget - eaten.calories, settled };
}

function proteinTarget() { return E.proteinTarget(st().profile); }

function fitTag(item, left) {
  if (left <= 0) return `<span class="fit over">over</span>`;
  if (item.calories > left) return `<span class="fit over">+${fmt(item.calories - left)} over</span>`;
  return `<span class="fit ok">fits</span>`;
}

// ---------- settle finished days ----------

/** Close out finished days. Returns a message worth showing, or "". */
export function settle() {
  const s = st();
  if (!s.profile) return "";
  const done = E.settleCountDays(s, ctx.todayKey());
  if (!done.length) return "";
  ctx.save();
  const over = done.filter((d) => d.over > 0);
  if (!over.length) return "";
  const last = over[over.length - 1];
  const when = E.fmtDay(E.parseKey(last.key));
  return `${when} ended ${fmt(last.over)} over — moved to your payback plan`;
}

// ---------- logging ----------

function addEntry(key, item, qty = 1, extra = {}) {
  const day = logDay(key);
  const entry = {
    id: uid(), name: item.name, emoji: item.emoji || "🍽",
    calories: Math.round(item.calories), protein: Math.round(item.protein * 10) / 10, qty,
    ref: item.id || null, detail: extra.detail ?? item.note ?? "", source: extra.source || item.group || "",
    at: new Date().toISOString(),
  };
  day.entries.push(entry);
  afterLogChange(key);
  const { left } = dayStatus(key);
  ctx.toast(left < 0 ? `⚠️ ${item.name} logged — ${fmt(-left)} over. See “Cancel it out” below.` : `✓ ${item.name} · ${fmt(left)} kcal left`);
  return entry;
}

function afterLogChange(key) {
  const day = logDay(key, false);
  if (day?.settled) {
    const delta = E.resettleDay(st(), key);
    if (delta) ctx.toast(delta > 0 ? `Payback plan +${fmt(delta)} kcal for that day` : `Payback plan −${fmt(-delta)} kcal`);
  }
  ctx.save();
  ctx.renderAll();
}

// ---------- Today (count mode) ----------

export function renderCountToday(el) {
  const s = st();
  const p = s.profile;
  seedUsuals();
  const key = viewKey();
  const isToday = viewOffset === 0;
  const { day, budget, trim, credit, eaten, left } = dayStatus(key);
  const pTarget = proteinTarget();
  const over = left < 0;
  const pct = Math.min(1, eaten.calories / Math.max(1, budget));
  const R = 52, C = 2 * Math.PI * R;
  const dateStr = E.parseKey(key).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const usuals = usualItems();
  const usualChips = usuals.map((u) => `
    <button class="quick-chip" data-action="c-log" data-item="${esc(u.id)}" data-date="${key}">
      <span class="qc-emoji">${esc(u.emoji)}</span><span class="qc-name">${esc(u.name)}</span><span class="qc-kcal">${fmt(u.calories)}</span>
    </button>`).join("");

  const entries = (day?.entries || []).map((e) => {
    const t = new Date(e.at || Date.now()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const q = (e.qty ?? 1) !== 1 ? ` · ×${e.qty}` : "";
    return `
      <div class="meal-row" data-action="c-entry" data-date="${key}" data-id="${e.id}">
        <div class="meal-emoji">${esc(e.emoji || "🍽")}</div>
        <div class="meal-info">
          <div class="meal-name">${esc(e.name)}</div>
          <div class="meal-meta">${fmt(e.calories * (e.qty ?? 1))} kcal · ${Math.round(e.protein * (e.qty ?? 1))}g protein${q} · ${t}</div>
        </div>
        <span class="muted">›</span>
      </div>`;
  }).join("");

  const walks = (day?.walks || []).map((w) => `
    <div class="freezer-row"><div style="flex:1" class="small">🚶 ${w.minutes} min extra walk · −${w.kcal} kcal ${w.applied === "bank" ? "off your payback plan" : "today"}</div>
    <button class="btn small ghost danger" data-action="c-walk-del" data-date="${key}" data-id="${w.id}" aria-label="Remove walk">✕</button></div>`).join("");

  const fits = isToday && left > 120 ? E.suggestFits(dedupe([...usuals, ...catalog()]), left, Math.max(0, pTarget - eaten.protein), 3) : [];

  el.innerHTML = `
    <div class="list-title-row"><div class="screen-title">${isToday ? "Today" : viewOffset === -1 ? "Yesterday" : E.fmtDay(E.parseKey(key))}</div>
      <button class="btn small ghost" data-action="open-settings" aria-label="Settings">⚙️</button></div>
    <div class="day-nav">
      <button class="btn small ghost" data-action="c-day" data-delta="-1" ${viewOffset <= -6 ? "disabled" : ""} aria-label="Previous day">‹</button>
      <span class="screen-sub" style="margin:0">${dateStr}</span>
      <button class="btn small ghost" data-action="c-day" data-delta="1" ${isToday ? "disabled" : ""} aria-label="Next day">›</button>
    </div>
    ${modeSwitch()}
    ${ctx.backupReminder()}

    <div class="card">
      <div class="today-hero">
        <div class="ring-wrap">
          <svg width="118" height="118" viewBox="0 0 118 118" aria-hidden="true">
            <circle cx="59" cy="59" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="10"/>
            <circle cx="59" cy="59" r="${R}" fill="none" stroke="${over ? "var(--critical)" : "var(--accent)"}" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
          </svg>
          <div class="ring-center">
            <div class="big">${over ? `+${fmt(-left)}` : fmt(left)}</div>
            <div class="small">${over ? "kcal over" : "kcal left"}</div>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat">
            <div class="stat-label"><span>Calories</span><b>${fmt(eaten.calories)} / ${fmt(budget)}</b></div>
            <div class="bar cal"><i style="width:${Math.min(100, pct * 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Protein</span><b>${Math.round(eaten.protein)} / ${pTarget}g</b></div>
            <div class="bar"><i style="width:${Math.min(100, (eaten.protein / pTarget) * 100)}%"></i></div>
          </div>
          <div class="small muted">${(day?.entries || []).length} item${(day?.entries || []).length === 1 ? "" : "s"} logged${day?.settled ? " · day closed" : ""}</div>
        </div>
      </div>
      ${trim > 0 ? `<div class="trim-note">💪 Paying back a big day: −${trim} kcal today. ${fmt(s.overageBank)} kcal left on the plan.</div>` : ""}
      ${credit > 0 ? `<div class="trim-note">🚶 +${credit} kcal from extra activity${day?.activityCredit ? ` (${esc(day.activityCredit.label)}) <button class="btn small ghost" data-action="remove-activity" data-date="${key}" style="margin-left:6px">Remove</button>` : ""}.</div>` : ""}
    </div>

    <div class="log-actions">
      <button class="btn primary" data-action="c-sheet-log" data-date="${key}">＋ Log food</button>
      <button class="btn" data-action="c-sheet-ai" data-date="${key}">✨ Describe / photo</button>
      <button class="btn" data-action="c-sheet-scan" data-date="${key}">▦ Scan</button>
    </div>

    ${usualChips ? `<div class="ob-section" style="margin-top:14px">One tap · your usuals</div><div class="quick-row">${usualChips}</div>` : ""}

    <div class="card">
      <div class="list-title-row"><h3>${isToday ? "Today's log" : "Log"}</h3><span class="small muted">tap to edit</span></div>
      ${entries || `<div class="small muted">Nothing logged yet. Tap a usual above or “Log food”.</div>`}
      ${walks}
    </div>

    ${fits.length ? `
    <div class="card">
      <h3>🎯 What still fits</h3>
      <div class="small muted" style="margin-bottom:4px">${fmt(left)} kcal and ${Math.max(0, Math.round(pTarget - eaten.protein))}g protein to go — best protein for the room you have.</div>
      ${fits.map((f) => `
        <button class="option-row" data-action="c-log" data-item="${esc(f.id)}" data-date="${key}">
          <div class="meal-emoji" style="width:34px;height:34px;font-size:1.2rem">${esc(f.emoji)}</div>
          <div class="o-main"><div class="o-name">${esc(f.name)}</div><div class="o-sub">${esc(f.group)}</div></div>
          <div class="o-kcal">${fmt(f.calories)} · ${Math.round(f.protein)}g</div>
        </button>`).join("")}
    </div>` : ""}

    ${recoveryCard(key)}
    ${weekCard()}
    ${goalCard()}

    <div class="btn-row"><button class="btn ghost" data-action="sheet-activity" data-date="${key}">🥾 Unusually active day?</button></div>
  `;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => (seen.has(i.name) ? false : seen.add(i.name)));
}

export function modeSwitch() {
  const m = st().trackMode;
  return `<div class="seg mode-seg" role="group" aria-label="How to use Fuel">
    <button class="${m === "count" ? "on" : ""}" data-action="c-mode" data-mode="count" aria-pressed="${m === "count"}">Just count</button>
    <button class="${m === "plan" ? "on" : ""}" data-action="c-mode" data-mode="plan" aria-pressed="${m === "plan"}">Full plan</button>
  </div>`;
}

// ---------- recovery: cancel out a big day ----------

export function recoveryCard(key = ctx.todayKey()) {
  const s = st();
  const bank = s.overageBank || 0;
  const isCount = s.trackMode === "count";
  const todayOver = isCount ? Math.max(0, -dayStatus(key).left) : 0;
  if (!bank && !todayOver) return "";
  const p = s.profile;
  const lb = latestWeight();
  const dailyDef = Math.max(1, E.tdee({ ...p, weightLb: lb }) - E.dailyBudget(p));
  const total = bank + todayOver;
  const daysOfProgress = Math.round((total / dailyDef) * 10) / 10;
  const opts = E.paybackOptions(s, total);
  const rate = E.paybackRate(s);
  const walkMin = E.walkMinutesFor(Math.min(total, E.ACTIVITY_CAP), lb);
  return `
    <div class="card recovery">
      <h3>🧯 Cancel it out</h3>
      <div class="small mt8">${todayOver ? `Today is <b>${fmt(todayOver)} over</b>.` : ""} ${bank ? `Payback plan: <b>${fmt(bank)} kcal</b> left.` : ""}
        That's about <b>${daysOfProgress} day${daysOfProgress === 1 ? "" : "s"}</b> of your normal deficit — not a lost week, as long as it gets paid back.</div>
      <div class="ob-section" style="margin:14px 0 6px">Trim the next few days</div>
      <div class="seg" style="margin-bottom:6px">
        ${opts.map((o) => `<button class="${rate === o.rate ? "on" : ""}" data-action="c-payback" data-rate="${o.rate}" aria-pressed="${rate === o.rate}">−${o.perDay}/day<br><span class="small">${Number.isFinite(o.days) ? `${o.days} day${o.days === 1 ? "" : "s"}` : "—"}</span></button>`).join("")}
      </div>
      <div class="small muted">Budget while paying back: ${fmt(opts.find((o) => o.rate === rate)?.budget || E.dailyBudget(p))} kcal. It never drops below the ${E.BUDGET_FLOOR[p.sex] || 1200} kcal floor.</div>
      <div class="ob-section" style="margin:14px 0 6px">Or walk some of it off</div>
      <button class="btn" style="width:100%" data-action="c-sheet-walk" data-date="${key}">🚶 Log an extra walk · ~${walkMin} min cancels ${fmt(Math.min(total, E.ACTIVITY_CAP))}</button>
      <div class="small muted mt8">Only walking beyond your usual ~10k steps counts, at a conservative ${Math.round((E.walkCredit(60, lb)))} kcal per hour. Skipping meals doesn't pay it back — that's how the binge loop starts.</div>
    </div>`;
}

function latestWeight() { return E.latestWeight(st()) ?? st().profile.weightLb; }

// ---------- week balance ----------

function weekCard() {
  const s = st();
  const wb = E.weekBalance(s, ctx.todayKey());
  const logged = wb.days.filter((d) => d.logged);
  if (!logged.length) return "";
  const maxV = Math.max(...wb.days.map((d) => Math.max(d.eaten || 0, d.budget || 0)), E.dailyBudget(s.profile)) * 1.08;
  const W = 300, H = 92, bw = 28, gap = (W - 7 * bw) / 6;
  const budgetY = H - 16 - ((E.dailyBudget(s.profile) / maxV) * (H - 24));
  const bars = wb.days.map((d, i) => {
    const x = i * (bw + gap);
    const label = "MTWTFSS"[i];
    if (!d.logged) return `<rect x="${x}" y="${H - 18}" width="${bw}" height="2" fill="var(--hairline)"/><text x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${label}</text>`;
    const h = (d.eaten / maxV) * (H - 24);
    const color = d.over > 0 ? "var(--critical)" : "var(--accent)";
    return `<rect x="${x}" y="${H - 16 - h}" width="${bw}" height="${h}" rx="4" fill="${color}" opacity="${d.isToday ? 0.55 : 1}"><title>${d.eaten} kcal</title></rect>
      <text x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" font-size="10" fill="var(--muted)" font-weight="${d.isToday ? 800 : 400}">${label}</text>`;
  }).join("");
  const surplus = wb.deficit < 0;
  const pctOfGoal = wb.target ? Math.round((wb.deficit / wb.target) * 100) : 0;
  return `
    <div class="card">
      <div class="list-title-row"><h3>📆 This week's balance</h3><span class="small muted">${logged.length}/7 days logged</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Calories eaten each day this week">
        <line x1="0" x2="${W}" y1="${budgetY}" y2="${budgetY}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1"/>
        <text x="${W}" y="${budgetY - 3}" text-anchor="end" font-size="9" fill="var(--muted)">budget</text>
        ${bars}
      </svg>
      <div class="small mt8">${surplus
        ? `This week is in a <b style="color:var(--critical)">surplus of ${fmt(-wb.deficit)} kcal</b> so far. The payback plan above turns it back into a deficit.`
        : `Deficit so far: <b>${fmt(wb.deficit)} kcal</b> (≈ ${wb.lb} lb)${wb.target ? ` · ${pctOfGoal}% of goal pace for the days logged` : ""}.`}</div>
      <div class="small muted mt8">Today counts as if you eat to budget, so this never looks better than it is.${wb.walked ? ` Includes ${fmt(wb.walked)} kcal of extra walking.` : ""}</div>
    </div>`;
}

// ---------- goal ----------

function goalCard() {
  const p = st().profile;
  const target = Math.round((p.startWeightLb - p.goalLossLb) * 10) / 10;
  const proj = E.goalProjection(st());
  const eta = proj.eta.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `
    <div class="card" data-action="c-sheet-goal" style="cursor:pointer">
      <div class="list-title-row"><h3>🏁 Goal: ${target} lb</h3><span class="muted">›</span></div>
      <div class="small muted">${fmt(E.dailyBudget(p))} kcal/day · −${p.deficit}/day ≈ ${Math.round((p.deficit * 7 / E.KCAL_PER_LB) * 10) / 10} lb/week · on pace for <b>${eta}</b>${p.goalDate ? ` (target ${E.parseKey(p.goalDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}. Tap to change.</div>
    </div>`;
}

function goalDefaults() {
  const p = st().profile;
  const current = latestWeight();
  const goal = p.startWeightLb - p.goalLossLb < current ? Math.round((p.startWeightLb - p.goalLossLb) * 10) / 10 : Math.round(current - 10);
  const date = p.goalDate && p.goalDate > ctx.todayKey() ? p.goalDate : E.dateKey(E.addDays(new Date(), 84));
  return { current, goal, date };
}

export function sheetGoal() {
  const d = goalDefaults();
  ctx.openSheet(`
    <h3>🏁 Set your goal</h3>
    <div class="sub">Fuel works out the daily budget from your goal, then caps it at a pace that protects muscle.</div>
    <div class="field-row">
      <div class="field"><label for="g-current">Weight now (lb)</label><input id="g-current" type="number" inputmode="decimal" value="${d.current}" /></div>
      <div class="field"><label for="g-goal">Goal weight (lb)</label><input id="g-goal" type="number" inputmode="decimal" value="${d.goal}" /></div>
    </div>
    <div class="field"><label for="g-date">Reach it by</label><input id="g-date" type="date" value="${d.date}" min="${E.dateKey(E.addDays(new Date(), 7))}" /></div>
    <div class="chips" style="margin-top:-4px">
      ${[8, 12, 16].map((w) => `<button class="chip" data-action="c-goal-weeks" data-weeks="${w}">${w} weeks</button>`).join("")}
    </div>
    <div id="goal-preview" class="budget-preview"></div>
    <button class="btn primary" style="width:100%" data-action="c-goal-save">Use this plan</button>
    <div class="small muted mt8">Your weekly weigh-in is the referee: if the scale moves slower than planned for two weeks, Fuel's Trend check on Progress will say so and you can tighten up.</div>
  `);
  updateGoalPreview();
}

function readGoal() {
  return {
    currentLb: +($("#g-current")?.value || 0),
    goalLb: +($("#g-goal")?.value || 0),
    goalDate: $("#g-date")?.value || "",
  };
}

function updateGoalPreview() {
  const box = $("#goal-preview");
  if (!box) return;
  const g = readGoal();
  if (!g.currentLb || !g.goalLb || !g.goalDate || g.goalLb >= g.currentLb) {
    box.innerHTML = g.goalLb >= g.currentLb && g.goalLb ? "Goal weight should be below your current weight." : "Fill in all three to see your numbers.";
    return;
  }
  const plan = E.goalPlan(st().profile, { ...g, today: ctx.todayKey() });
  const eta = plan.eta ? E.parseKey(plan.eta).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const warn = plan.limitedBy === "pace"
    ? `<br><span class="small">⚠️ That date needs −${fmt(plan.required)} kcal/day (${Math.round(plan.required * 7 / E.KCAL_PER_LB * 10) / 10} lb/week). Fuel caps you at 1% of bodyweight per week (−${fmt(plan.maxSafe)}/day) to keep muscle and avoid the crash-and-binge cycle. Realistic date: <b>${eta}</b>.</span>`
    : plan.limitedBy === "floor"
      ? `<br><span class="small">⚠️ That pace would put you under the ${E.BUDGET_FLOOR[st().profile.sex] || 1200} kcal floor. Realistic date: <b>${eta}</b>.</span>`
      : `<br><span class="small">On pace to land around <b>${eta}</b>.</span>`;
  box.innerHTML = `Daily budget: <b>${fmt(plan.budget)} kcal</b> · protein <b>${E.proteinTarget({ ...st().profile, startWeightLb: g.currentLb, goalLossLb: g.currentLb - g.goalLb })}g</b><br>
    <span class="small">Maintenance ≈ ${fmt(plan.maintenance)} kcal (your stats + daily walking and lifting). Deficit −${fmt(plan.deficit)}/day ≈ ${plan.lbPerWeek} lb/week to lose ${plan.toLose} lb.</span>${warn}`;
}

function saveGoal() {
  const g = readGoal();
  if (!g.currentLb || !g.goalLb || !g.goalDate || g.goalLb >= g.currentLb) return ctx.toast("Check the three goal fields first");
  const s = st();
  const plan = E.goalPlan(s.profile, { ...g, today: ctx.todayKey() });
  const p = s.profile;
  p.weightLb = g.currentLb;
  p.startWeightLb = g.currentLb;
  p.startDate = ctx.todayKey();
  p.goalLossLb = Math.round((g.currentLb - g.goalLb) * 10) / 10;
  p.goalDate = g.goalDate;
  p.deficit = plan.deficit;
  s.weighIns = s.weighIns.filter((w) => w.date !== ctx.todayKey());
  s.weighIns.push({ date: ctx.todayKey(), lb: g.currentLb });
  ctx.save(); ctx.closeSheet(); ctx.renderAll();
  ctx.toast(`🏁 Budget set: ${fmt(plan.budget)} kcal/day`);
}

// ---------- log sheet ----------

function row(item, key, left, { removable = false, editable = false } = {}) {
  return `
    <div class="log-row" data-search="${esc((item.name + " " + item.group).toLowerCase())}">
      <button class="option-row" data-action="c-log" data-item="${esc(item.id)}" data-date="${key}">
        <div class="meal-emoji" style="width:34px;height:34px;font-size:1.2rem">${esc(item.emoji)}</div>
        <div class="o-main"><div class="o-name">${esc(item.name)}${item.estimated ? ' <span class="badge est">est.</span>' : ""}</div>
          ${item.note ? `<div class="o-sub">${esc(item.note)}</div>` : ""}</div>
        <div class="o-kcal">${fmt(item.calories)} · ${Math.round(item.protein)}g<br>${fitTag(item, left)}</div>
      </button>
      ${editable ? `<button class="row-side" data-action="c-build-item" data-item="${esc(item.id)}" data-date="${key}" aria-label="Customize ${esc(item.name)}">✎</button>` : ""}
      ${removable ? `<button class="row-side" data-action="c-usual-del" data-usual="${esc(item.usualId)}" data-date="${key}" aria-label="Remove ${esc(item.name)} from usuals">✕</button>` : ""}
    </div>`;
}

function section(title, html, extra = "") {
  return html ? `<div class="log-section"><div class="ob-section">${title}${extra}</div>${html}</div>` : "";
}

export function sheetLog(key) {
  const left = dayStatus(key).left;
  const usuals = usualItems();
  const cat = catalog();
  const places = eats().places.map((pl) => {
    const items = cat.filter((c) => c.place === pl.id);
    const builder = pl.builder ? `
      <div class="log-row" data-search="${esc(pl.name.toLowerCase())} build your own custom">
        <button class="option-row" data-action="c-build-new" data-place="${pl.id}" data-date="${key}">
          <div class="meal-emoji" style="width:34px;height:34px;font-size:1.2rem">🛠</div>
          <div class="o-main"><div class="o-name">Build your own ${esc(pl.name)} order</div><div class="o-sub">Pick every ingredient, double protein, light rice…</div></div>
          <div class="o-kcal">›</div>
        </button></div>` : "";
    return section(`${pl.emoji} ${esc(pl.name)}`, builder + items.map((i) => row(i, key, left, { editable: !!i.build })).join(""));
  }).join("");
  const home = cat.filter((c) => c.group === "Home");
  const meals = cat.filter((c) => c.group === "Fuel meals");
  const singles = productItems();
  const scanned = barcodeItems();
  const recents = recentItems().filter((r) => !usuals.some((u) => u.name === r.name));

  ctx.openSheet(`
    <h3>Log food</h3>
    <div class="sub">${left >= 0 ? `${fmt(left)} kcal left` : `${fmt(-left)} kcal over`} · ${E.fmtDay(E.parseKey(key))}</div>
    <div class="field" style="position:sticky;top:42px;z-index:2;background:var(--surface);padding-bottom:6px;margin-bottom:6px">
      <input id="log-search" type="search" placeholder="Search everything… (chipotle, wrap, egg)" autocomplete="off" aria-label="Search foods" />
    </div>
    <div class="card quick-add" data-search="custom quick add">
      <div class="small" style="font-weight:700;margin-bottom:6px">Quick add</div>
      <div class="field" style="margin-bottom:8px"><input id="qa-name" placeholder="What was it? (e.g. bagel from the cart)" aria-label="Food name" /></div>
      <div class="field-row">
        <div class="field" style="margin-bottom:8px"><input id="qa-cal" type="number" inputmode="numeric" placeholder="kcal" aria-label="Calories" /></div>
        <div class="field" style="margin-bottom:8px"><input id="qa-pro" type="number" inputmode="decimal" placeholder="protein g" aria-label="Protein grams" /></div>
      </div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn primary" data-action="c-quick-add" data-date="${key}">Log it</button>
        <button class="btn ghost" data-action="c-quick-add" data-date="${key}" data-save="1">Log + ⭐ usual</button>
      </div>
    </div>
    <div id="log-results">
      ${section("⭐ Your usuals", usuals.map((u) => row(u, key, left, { removable: true, editable: !!u.build })).join(""))}
      ${section("🕘 Recent", recents.map((r) => row(r, key, left)).join(""))}
      ${places}
      ${section("🏠 Home combos", home.map((i) => row(i, key, left, { editable: true })).join(""), ' <button class="btn small ghost" style="float:right;margin-top:-6px" data-action="c-build-new" data-place="home" data-date="' + key + '">＋ Build</button>')}
      ${section("🍽 Fuel meals (1 serving)", meals.map((i) => row(i, key, left)).join(""))}
      ${section("▦ Scanned", scanned.map((i) => row(i, key, left)).join(""))}
      ${section("🛒 Single ingredients", singles.map((i) => row(i, key, left)).join(""))}
      <div class="empty" id="log-empty" hidden>Nothing matches. Add it with Quick add above, or let ✨ Describe / photo estimate it.</div>
    </div>
  `);
}

function filterLog(q) {
  const term = q.trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  let any = false;
  document.querySelectorAll("#log-results .log-section").forEach((sec) => {
    let shown = 0;
    sec.querySelectorAll(".log-row").forEach((r) => {
      const hit = !words.length || words.every((w) => r.dataset.search.includes(w));
      r.hidden = !hit;
      if (hit) shown++;
    });
    sec.hidden = !shown;
    if (shown) any = true;
  });
  const empty = $("#log-empty");
  if (empty) empty.hidden = any;
  // While results match, keep them above the keyboard; when nothing matches, offer
  // Quick add with what was typed already filled in.
  const qa = document.querySelector(".quick-add");
  if (qa) qa.hidden = !!words.length && any;
  const qaName = $("#qa-name");
  if (qaName && words.length && !any && !qaName.dataset.touched) qaName.value = q.trim();
}

// ---------- builder (Chipotle-style or home combos from ingredients) ----------

function startBuild(item, key) {
  if (item?.build?.kind === "components") {
    build = { kind: "components", place: item.build.place, picks: { ...item.build.picks }, name: item.name, emoji: item.emoji, key };
  } else if (item?.build?.kind === "products") {
    build = { kind: "products", items: item.build.items.map((x) => ({ ...x })), name: item.name, emoji: item.emoji, key };
  }
  sheetBuild();
}

function buildTotals() {
  if (build.kind === "components") {
    const pl = eats().places.find((p) => p.id === build.place);
    return E.componentTotals(pl?.components || [], build.picks);
  }
  return E.productTotals(ctx.data(), st(), build.items);
}

function sheetBuild() {
  ctx.openSheet(`
    <h3>${esc(build.emoji || "🛠")} Build it</h3>
    <div class="field" style="margin:8px 0"><label for="b-name">Name</label><input id="b-name" value="${esc(build.name)}" /></div>
    <div class="build-body"></div>
  `);
  renderBuildBody();
}

function stepper(action, id, qty) {
  return `<div class="stepper">
    <button data-action="${action}" data-id="${esc(id)}" data-step="-0.5" aria-label="less">−</button>
    <span>${qty === 0.5 ? "½" : qty % 1 ? `${Math.floor(qty)}½` : qty}</span>
    <button data-action="${action}" data-id="${esc(id)}" data-step="0.5" aria-label="more">+</button>
  </div>`;
}

function renderBuildBody() {
  const body = document.querySelector("#sheet .build-body");
  if (!body || !build) return;
  const t = buildTotals();
  const left = dayStatus(build.key).left;
  let list = "";
  if (build.kind === "components") {
    const pl = eats().places.find((p) => p.id === build.place);
    const groups = {};
    for (const c of pl.components) (groups[c.group] = groups[c.group] || []).push(c);
    list = Object.entries(groups).map(([g, cs]) => `
      <div class="ob-section" style="margin:14px 0 4px">${esc(g)}</div>
      ${cs.map((c) => `<div class="freezer-row ${build.picks[c.id] ? "" : "dim"}">
        <div style="flex:1;min-width:0"><div class="small" style="font-weight:650">${esc(c.name)}</div><div class="small muted">${c.calories} kcal · ${c.protein}g</div></div>
        ${stepper("c-build-step", c.id, build.picks[c.id] || 0)}</div>`).join("")}`).join("");
  } else {
    const prods = ctx.data().products;
    list = `<div class="ob-section" style="margin:14px 0 4px">In it</div>` + build.items.map((it) => {
      const p = E.productById(ctx.data(), st(), it.product);
      if (!p) return "";
      return `<div class="freezer-row"><div style="flex:1;min-width:0"><div class="small" style="font-weight:650">${esc(p.name)}</div>
        <div class="small muted">${esc(p.unit)} · ${p.calories} kcal · ${p.protein}g</div></div>${stepper("c-build-pstep", it.product, it.qty)}</div>`;
    }).join("") + `
      <div class="ob-section" style="margin:14px 0 4px">Add an ingredient</div>
      <div class="field"><input id="b-search" type="search" placeholder="Search Trader Joe's items…" aria-label="Search ingredients" /></div>
      <div id="b-results">${prods.slice(0, 0).join("")}</div>`;
  }
  body.innerHTML = `
    ${list}
    <div class="build-total">
      <div><b>${fmt(t.calories)} kcal</b> · ${t.protein}g protein ${t.estimated ? '<span class="badge est">est.</span>' : ""}<br>
      <span class="small">${t.calories > left ? `<span style="color:var(--critical)">${fmt(t.calories - Math.max(0, left))} over budget</span>` : `${fmt(left - t.calories)} kcal left after this`}</span></div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" data-action="c-build-log">Log it</button>
        <button class="btn ghost" data-action="c-build-log" data-save="1">Log + ⭐ usual</button>
      </div>
    </div>`;
}

function renderBuildSearch(q) {
  const box = $("#b-results");
  if (!box) return;
  const term = q.trim().toLowerCase();
  if (!term) { box.innerHTML = ""; return; }
  const hits = ctx.data().products.filter((p) => p.name.toLowerCase().includes(term)).slice(0, 12);
  box.innerHTML = hits.map((p) => `
    <button class="option-row" data-action="c-build-add" data-product="${p.id}">
      <div class="o-main"><div class="o-name">${esc(p.name)}</div><div class="o-sub">${esc(p.unit)}</div></div>
      <div class="o-kcal">${p.calories} · ${p.protein}g ＋</div>
    </button>`).join("") || `<div class="small muted">No match.</div>`;
}

function buildDetail() {
  if (build.kind === "components") {
    const pl = eats().places.find((p) => p.id === build.place);
    return Object.entries(build.picks).filter(([, q]) => q > 0).map(([id, q]) => {
      const c = pl.components.find((x) => x.id === id);
      return c ? `${q === 2 ? "double " : q === 0.5 ? "light " : ""}${c.name.toLowerCase()}` : "";
    }).filter(Boolean).join(", ");
  }
  return build.items.map((it) => E.productById(ctx.data(), st(), it.product)?.name).filter(Boolean).join(", ");
}

// ---------- entry sheet ----------

function sheetEntry(key, id) {
  const e = logDay(key, false)?.entries.find((x) => x.id === id);
  if (!e) return;
  const q = e.qty ?? 1;
  ctx.openSheet(`
    <div class="recipe-head"><div class="r-emoji">${esc(e.emoji || "🍽")}</div>
      <div><h3>${esc(e.name)}</h3><div class="small muted">${esc(e.detail || e.source || "")}</div></div></div>
    <div class="ob-section" style="margin-top:4px">How much</div>
    <div class="seg">
      ${[0.5, 1, 1.5, 2].map((x) => `<button class="${q === x ? "on" : ""}" data-action="c-entry-qty" data-date="${key}" data-id="${id}" data-qty="${x}" aria-pressed="${q === x}">${x === 0.5 ? "½" : x === 1.5 ? "1½" : x}×</button>`).join("")}
    </div>
    <div class="ob-section">Numbers (per 1×)</div>
    <div class="field-row">
      <div class="field"><label for="e-cal">Calories</label><input id="e-cal" type="number" inputmode="numeric" value="${e.calories}" /></div>
      <div class="field"><label for="e-pro">Protein (g)</label><input id="e-pro" type="number" inputmode="decimal" value="${e.protein}" /></div>
    </div>
    <div class="btn-row"><button class="btn primary" data-action="c-entry-save" data-date="${key}" data-id="${id}">Save</button>
      <button class="btn" data-action="c-entry-usual" data-date="${key}" data-id="${id}">⭐ Save as usual</button></div>
    <div class="btn-row"><button class="btn ghost" data-action="c-entry-again" data-date="${key}" data-id="${id}">Log again</button>
      <button class="btn ghost danger" data-action="c-entry-del" data-date="${key}" data-id="${id}">Delete</button></div>
  `);
}

function saveUsual({ name, emoji, calories, protein, detail, ref }) {
  const s = st();
  if (ref && s.usuals.some((u) => u.ref === ref)) return ctx.toast("Already in your usuals");
  if (!ref && s.usuals.some((u) => !u.ref && u.name === name && u.calories === calories)) return ctx.toast("Already in your usuals");
  s.usuals.push(ref ? { id: uid(), ref } : { id: uid(), name, emoji: emoji || "⭐", calories, protein, detail: detail || "" });
  ctx.save();
  ctx.toast(`⭐ ${name} is now a one-tap usual`);
}

// ---------- walks ----------

function sheetWalk(key) {
  const lb = latestWeight();
  ctx.openSheet(`
    <h3>🚶 Extra walk</h3>
    <div class="sub">Walking <b>beyond</b> your normal day. It cancels today's overage first, then pays down the payback plan.</div>
    <div class="chips">
      ${[20, 30, 45, 60, 90, 120].map((m) => `<button class="chip" data-action="c-walk" data-date="${key}" data-min="${m}">${m} min · −${E.walkCredit(m, lb)}</button>`).join("")}
    </div>
    <div class="field-row">
      <div class="field" style="margin:0"><input id="walk-min" type="number" inputmode="numeric" placeholder="Minutes walked" aria-label="Minutes walked" /></div>
      <button class="btn primary" data-action="c-walk" data-date="${key}" data-min="input">Log</button>
    </div>
    <div class="small muted mt16">Counted at an easy 3 mph and only the calories above resting (~${E.walkCredit(60, lb)} kcal/hour at ${lb} lb), capped at ${E.ACTIVITY_CAP}/day — deliberately conservative so it can't erase the deficit by accident.</div>
  `);
}

function logWalk(key, minutes) {
  const s = st();
  const day = logDay(key);
  const lb = latestWeight();
  const already = day.walks.reduce((n, w) => n + w.kcal, 0);
  const kcal = Math.min(E.walkCredit(minutes, lb), Math.max(0, E.ACTIVITY_CAP - already));
  if (!kcal) return ctx.toast(`Walks are capped at ${E.ACTIVITY_CAP} kcal a day`);
  const overToday = s.trackMode === "count" && !day.settled ? Math.max(0, -dayStatus(key).left) : 0;
  const applied = overToday > 0 || !(s.overageBank > 0) ? "today" : "bank";
  if (applied === "bank") s.overageBank = Math.max(0, s.overageBank - kcal);
  day.walks.push({ id: uid(), minutes, kcal, applied, at: new Date().toISOString() });
  ctx.save(); ctx.closeSheet(); ctx.renderAll();
  ctx.toast(applied === "bank" ? `🚶 −${kcal} kcal off your payback plan` : `🚶 +${kcal} kcal back today`);
}

// ---------- AI: describe it / snap it ----------

function getKey() { try { return localStorage.getItem(AI.KEY_SLOT) || ""; } catch { return ""; } }
export function hasAiKey() { return !!getKey(); }
export function clearAiKey() { try { localStorage.removeItem(AI.KEY_SLOT); } catch { /* nothing to clear */ } }

function sheetAI(key) {
  aiResult = null;
  if (!getKey()) {
    ctx.openSheet(`
      <h3>✨ Describe it or snap it</h3>
      <div class="sub">Type “2 eggs, toast and a Pret latte” or take a photo of your plate — Fuel splits it into items with calories and protein you can adjust before logging.</div>
      <div class="trim-note">This uses the Claude API with <b>your own API key</b>. The key stays on this phone only: it's never in backups or exports. Each estimate costs roughly a cent.</div>
      <div class="field mt16"><label for="ai-key">Claude API key</label><input id="ai-key" type="password" autocomplete="off" placeholder="sk-ant-…" /></div>
      <button class="btn primary" style="width:100%" data-action="c-ai-key" data-date="${key}">Save key on this phone</button>
      <div class="small muted mt8">Get one at console.anthropic.com → API keys. Remove it any time in Settings.</div>
    `);
    return;
  }
  ctx.openSheet(`
    <h3>✨ Describe it or snap it</h3>
    <div class="sub">Logging to ${E.fmtDay(E.parseKey(key))}. Be as loose as you like.</div>
    <div class="field"><textarea id="ai-text" class="io" style="font-family:inherit;font-size:.95rem;min-height:84px" placeholder="e.g. Chipotle bowl double chicken, half rice, fajita veg, plus a Diet Coke"></textarea></div>
    <label class="btn" style="width:100%;display:flex;justify-content:center;gap:8px">📷 ${aiImage ? "Change photo" : "Add a photo"}
      <input id="ai-photo" type="file" accept="image/*" capture="environment" hidden /></label>
    <div id="ai-thumb">${aiImage ? `<img src="${aiImage.preview}" alt="Food photo" class="ai-thumb" />` : ""}</div>
    <button class="btn primary mt16" style="width:100%" data-action="c-ai-run" data-date="${key}">Estimate</button>
    <div id="ai-out"></div>
  `);
}

async function readPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    return { mediaType: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl };
  } finally { URL.revokeObjectURL(url); }
}

async function runAI(key) {
  const out = $("#ai-out");
  const text = $("#ai-text")?.value || "";
  if (!text.trim() && !aiImage) return ctx.toast("Describe the food or add a photo first");
  out.innerHTML = `<div class="empty">Estimating…</div>`;
  const known = dedupe([...usualItems(), ...catalog().filter((c) => c.group !== "Fuel meals")]).map((k) => ({ name: k.name, calories: k.calories, protein: Math.round(k.protein) }));
  try {
    aiResult = await AI.estimateFood({ key: getKey(), text, image: aiImage, known });
    renderAIResult(key);
  } catch (err) {
    out.innerHTML = `<div class="trim-note" role="alert">⚠️ ${esc(err.message)}</div>`;
  }
}

function renderAIResult(key) {
  const out = $("#ai-out");
  if (!out || !aiResult) return;
  const total = aiResult.items.reduce((n, i) => n + i.calories, 0);
  const left = dayStatus(key).left;
  out.innerHTML = `
    <div class="ob-section">Estimate · adjust anything</div>
    <div class="field-row small muted" style="margin-bottom:-4px"><span style="flex:1;padding-left:28px">Each item: kcal · protein (g) below</span></div>
    ${aiResult.items.map((it, i) => `
      <div class="ai-item">
        <label class="ai-check"><input type="checkbox" data-ai-idx="${i}" checked /> <span>${esc(it.emoji)} <b>${esc(it.name)}</b>
          <span class="small muted">${esc(it.portion)}${it.confidence === "low" ? " · rough guess" : ""}</span></span></label>
        <div class="field-row" style="margin-top:6px">
          <div class="field" style="margin:0"><input type="number" inputmode="numeric" data-ai-cal="${i}" value="${it.calories}" title="kcal" aria-label="${esc(it.name)} calories" /></div>
          <div class="field" style="margin:0"><input type="number" inputmode="decimal" data-ai-pro="${i}" value="${it.protein}" aria-label="${esc(it.name)} protein" /></div>
        </div>
      </div>`).join("")}
    ${aiResult.note ? `<div class="small muted mt8">${esc(aiResult.note)}</div>` : ""}
    <div class="build-total"><div><b>${fmt(total)} kcal</b> total · ${total > left ? `<span style="color:var(--critical)">${fmt(total - Math.max(0, left))} over budget</span>` : `${fmt(left - total)} left after`}</div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" data-action="c-ai-log" data-date="${key}">Log selected</button>
        <button class="btn ghost" data-action="c-ai-log" data-date="${key}" data-save="1">Log + ⭐ as one usual</button>
      </div></div>`;
}

function readAISelection() {
  return aiResult.items.map((it, i) => {
    if (!document.querySelector(`[data-ai-idx="${i}"]`)?.checked) return null;
    return { ...it, calories: +(document.querySelector(`[data-ai-cal="${i}"]`)?.value || it.calories), protein: +(document.querySelector(`[data-ai-pro="${i}"]`)?.value || it.protein) };
  }).filter(Boolean);
}

// ---------- barcode ----------

export function stopScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}

function canScan() { return "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia; }

async function sheetScan(key) {
  stopScan();
  ctx.openSheet(`
    <h3>▦ Scan a barcode</h3>
    <div class="sub">Packaged food from anywhere — looked up in Open Food Facts, a free public database. Only the barcode number leaves your phone.</div>
    ${canScan() ? `<div class="scan-box"><video id="scan-video" playsinline muted></video><div class="scan-line"></div></div>
      <div class="small muted" id="scan-status">Starting camera…</div>` : `<div class="trim-note">This browser can't read barcodes from the camera — type the number under the barcode instead.</div>`}
    <div class="field-row mt16">
      <div class="field" style="margin:0"><input id="scan-code" inputmode="numeric" placeholder="Barcode number" aria-label="Barcode number" /></div>
      <button class="btn primary" data-action="c-scan-lookup" data-date="${key}">Look up</button>
    </div>
  `);
  if (!canScan()) return;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("#scan-video");
    if (!video) return stopScan();
    video.srcObject = scanStream;
    await video.play();
    const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    const status = $("#scan-status");
    if (status) status.textContent = "Point at the barcode";
    scanTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes[0]?.rawValue) { const code = codes[0].rawValue; stopScan(); navigator.vibrate?.(30); lookupCode(key, code); }
      } catch { /* frame not ready */ }
    }, 280);
  } catch {
    const status = $("#scan-status");
    if (status) status.textContent = "Camera unavailable — allow camera access, or type the number.";
  }
}

async function lookupCode(key, code) {
  code = String(code).replace(/\D/g, "");
  if (code.length < 8) return ctx.toast("That barcode looks too short");
  const cached = st().barcodes?.[code];
  if (cached) return sheetScanResult(key, code, cached);
  ctx.openSheet(`<h3>▦ ${esc(code)}</h3><div class="empty">Looking it up…</div>`);
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,generic_name,brands,nutriments,serving_size,serving_quantity`);
    const food = res.ok ? E.parseOpenFoodFacts(await res.json()) : null;
    if (!food) {
      ctx.openSheet(`<h3>▦ ${esc(code)}</h3><div class="trim-note">Not in Open Food Facts (or no calorie data). Use Quick add with the label numbers — save it as a usual and you'll never type it again.</div>
        <div class="btn-row"><button class="btn primary" data-action="c-sheet-log" data-date="${key}">Quick add</button></div>`);
      return;
    }
    sheetScanResult(key, code, food);
  } catch {
    ctx.openSheet(`<h3>▦ ${esc(code)}</h3><div class="trim-note">Couldn't reach the barcode database — check your connection, or use Quick add.</div>`);
  }
}

function sheetScanResult(key, code, food) {
  const per100 = food.servingG === 100 && food.serving === "100 g";
  ctx.openSheet(`
    <div class="recipe-head"><div class="r-emoji">▦</div><div><h3>${esc(food.name)}</h3><div class="small muted">per ${esc(food.serving)} · ${food.calories} kcal · ${food.protein}g protein</div></div></div>
    <div class="ob-section">${per100 ? "How many grams?" : "How many servings?"}</div>
    ${per100
      ? `<div class="field"><input id="scan-qty" type="number" inputmode="decimal" value="100" aria-label="Grams" /></div>`
      : `<div class="seg">${[0.5, 1, 1.5, 2, 3].map((x) => `<button class="${x === 1 ? "on" : ""}" data-action="c-scan-qty" data-qty="${x}">${x === 0.5 ? "½" : x === 1.5 ? "1½" : x}</button>`).join("")}</div>
         <input id="scan-qty" type="hidden" value="1" />`}
    <div class="btn-row">
      <button class="btn primary" data-action="c-scan-log" data-date="${key}" data-code="${esc(code)}">Log it</button>
      <button class="btn ghost" data-action="c-scan-log" data-date="${key}" data-code="${esc(code)}" data-save="1">Log + ⭐ usual</button>
    </div>
    <div class="small muted mt8">Saved on this phone so it works offline next time. Numbers come from Open Food Facts — tap the entry afterwards to fix anything.</div>
  `);
  st().barcodes[code] = food;
  ctx.save();
}

// ---------- events ----------

function onInput(e) {
  if (e.target.id === "log-search") filterLog(e.target.value);
  else if (e.target.id === "qa-name") e.target.dataset.touched = "1";
  else if (e.target.id === "b-search") renderBuildSearch(e.target.value);
  else if (e.target.id === "b-name" && build) build.name = e.target.value;
  else if (["g-current", "g-goal", "g-date"].includes(e.target.id)) updateGoalPreview();
}

async function onChange(e) {
  if (e.target.id !== "ai-photo" || !e.target.files?.[0]) return;
  try {
    aiImage = await readPhoto(e.target.files[0]);
    const thumb = $("#ai-thumb");
    if (thumb) thumb.innerHTML = `<img src="${aiImage.preview}" alt="Food photo" class="ai-thumb" />`;
  } catch { ctx.toast("Couldn't read that photo"); }
}

/** Handle a count-mode action. Returns true when it was ours. */
export function handleCount(el) {
  const a = el.dataset.action;
  if (!a?.startsWith("c-")) return false;
  const key = el.dataset.date || viewKey();
  const s = st();
  switch (a) {
    case "c-mode": {
      s.trackMode = el.dataset.mode;
      viewOffset = 0;
      ctx.save(); ctx.renderAll();
      ctx.toast(s.trackMode === "count" ? "Just counting — Plan and Shop are tucked away until you switch back" : "Full planning mode");
      return true;
    }
    case "c-day": viewOffset = Math.min(0, Math.max(-6, viewOffset + +el.dataset.delta)); ctx.renderAll(); return true;
    case "c-sheet-log": return sheetLog(key), true;
    case "c-sheet-ai": return sheetAI(key), true;
    case "c-sheet-scan": return sheetScan(key), true;
    case "c-sheet-walk": return sheetWalk(key), true;
    case "c-sheet-goal": return sheetGoal(), true;
    case "c-log": {
      const item = findItem(el.dataset.item);
      if (!item) return true;
      addEntry(key, item);
      ctx.closeSheet();
      return true;
    }
    case "c-quick-add": {
      const name = $("#qa-name")?.value.trim();
      const cal = +($("#qa-cal")?.value || 0), pro = +($("#qa-pro")?.value || 0);
      if (!name || !cal) { ctx.toast("Add a name and calories"); return true; }
      addEntry(key, { name, emoji: "✏️", calories: cal, protein: pro, group: "Quick add" });
      if (el.dataset.save) saveUsual({ name, emoji: "✏️", calories: cal, protein: pro });
      ctx.closeSheet();
      return true;
    }
    case "c-usual-del": {
      s.usuals = s.usuals.filter((u) => u.id !== el.dataset.usual);
      ctx.save(); sheetLog(key); ctx.renderAll(); return true;
    }
    case "c-build-item": return startBuild(findItem(el.dataset.item), key), true;
    case "c-build-new": {
      if (el.dataset.place === "home") build = { kind: "products", items: [], name: "My combo", emoji: "🏠", key };
      else {
        const pl = eats().places.find((p) => p.id === el.dataset.place);
        build = { kind: "components", place: pl.id, picks: {}, name: `My ${pl.name} order`, emoji: pl.emoji, key };
      }
      sheetBuild(); return true;
    }
    case "c-build-step": {
      const v = Math.max(0, Math.min(4, (build.picks[el.dataset.id] || 0) + +el.dataset.step));
      if (v) build.picks[el.dataset.id] = v; else delete build.picks[el.dataset.id];
      renderBuildBody(); return true;
    }
    case "c-build-pstep": {
      const it = build.items.find((x) => x.product === el.dataset.id);
      if (it) it.qty = Math.max(0, Math.min(8, it.qty + +el.dataset.step));
      build.items = build.items.filter((x) => x.qty > 0);
      renderBuildBody(); return true;
    }
    case "c-build-add": {
      const it = build.items.find((x) => x.product === el.dataset.product);
      if (it) it.qty += 1; else build.items.push({ product: el.dataset.product, qty: 1 });
      renderBuildBody(); return true;
    }
    case "c-build-log": {
      const t = buildTotals();
      if (!t.calories) { ctx.toast("Add something first"); return true; }
      const name = ($("#b-name")?.value || build.name).trim() || "Custom order";
      const detail = buildDetail();
      addEntry(build.key, { name, emoji: build.emoji, calories: t.calories, protein: t.protein, group: "Built" }, 1, { detail });
      if (el.dataset.save) saveUsual({ name, emoji: build.emoji, calories: t.calories, protein: t.protein, detail });
      build = null; ctx.closeSheet(); return true;
    }
    case "c-entry": return sheetEntry(key, el.dataset.id), true;
    case "c-entry-qty": {
      const e = logDay(key, false)?.entries.find((x) => x.id === el.dataset.id);
      if (e) { e.qty = +el.dataset.qty; afterLogChange(key); sheetEntry(key, e.id); }
      return true;
    }
    case "c-entry-save": {
      const e = logDay(key, false)?.entries.find((x) => x.id === el.dataset.id);
      if (e) { e.calories = Math.max(0, +($("#e-cal").value || 0)); e.protein = Math.max(0, +($("#e-pro").value || 0)); afterLogChange(key); ctx.closeSheet(); }
      return true;
    }
    case "c-entry-usual": {
      const e = logDay(key, false)?.entries.find((x) => x.id === el.dataset.id);
      if (e) saveUsual({ name: e.name, emoji: e.emoji, calories: +($("#e-cal").value || e.calories), protein: +($("#e-pro").value || e.protein), detail: e.detail });
      return true;
    }
    case "c-entry-again": {
      const e = logDay(key, false)?.entries.find((x) => x.id === el.dataset.id);
      if (e) { addEntry(ctx.todayKey(), { ...e, id: e.ref, group: e.source }, e.qty ?? 1, { detail: e.detail }); ctx.closeSheet(); }
      return true;
    }
    case "c-entry-del": {
      const day = logDay(key, false);
      if (day) { day.entries = day.entries.filter((x) => x.id !== el.dataset.id); afterLogChange(key); ctx.closeSheet(); ctx.toast("Deleted"); }
      return true;
    }
    case "c-payback": s.paybackPerDay = +el.dataset.rate; ctx.save(); ctx.renderAll(); return true;
    case "c-walk": {
      const min = el.dataset.min === "input" ? +($("#walk-min")?.value || 0) : +el.dataset.min;
      if (!min || min < 5 || min > 600) { ctx.toast("Enter minutes walked"); return true; }
      logWalk(key, min); return true;
    }
    case "c-walk-del": {
      const day = logDay(key, false);
      const w = day?.walks.find((x) => x.id === el.dataset.id);
      if (w) {
        if (w.applied === "bank") s.overageBank = (s.overageBank || 0) + w.kcal;
        day.walks = day.walks.filter((x) => x.id !== w.id);
        ctx.save(); ctx.renderAll();
      }
      return true;
    }
    case "c-goal-weeks": {
      const d = $("#g-date");
      if (d) { d.value = E.dateKey(E.addDays(new Date(), 7 * +el.dataset.weeks)); updateGoalPreview(); }
      return true;
    }
    case "c-goal-save": return saveGoal(), true;
    case "c-ai-key": {
      const k = $("#ai-key")?.value.trim();
      if (!k || k.length < 20) { ctx.toast("That doesn't look like an API key"); return true; }
      try { localStorage.setItem(AI.KEY_SLOT, k); } catch { ctx.toast("Couldn't store the key on this phone"); return true; }
      sheetAI(key); return true;
    }
    case "c-ai-run": runAI(key); return true;
    case "c-ai-log": {
      if (!aiResult) return true;
      const picked = readAISelection();
      if (!picked.length) { ctx.toast("Nothing selected"); return true; }
      for (const it of picked) logDay(key).entries.push({ id: uid(), name: it.name, emoji: it.emoji, calories: it.calories, protein: it.protein, qty: 1, ref: null, detail: it.portion, source: "AI estimate", at: new Date().toISOString() });
      if (el.dataset.save) {
        const name = picked.length === 1 ? picked[0].name : picked.map((p) => p.name).join(" + ").slice(0, 70);
        saveUsual({ name, emoji: picked[0].emoji, calories: picked.reduce((n, p) => n + p.calories, 0), protein: picked.reduce((n, p) => n + p.protein, 0), detail: picked.map((p) => p.portion).join("; ") });
      }
      aiImage = null; aiResult = null;
      afterLogChange(key); ctx.closeSheet();
      const { left } = dayStatus(key);
      ctx.toast(left < 0 ? `⚠️ Logged — ${fmt(-left)} over today` : `✓ Logged ${picked.length} item${picked.length > 1 ? "s" : ""} · ${fmt(left)} left`);
      return true;
    }
    case "c-scan-lookup": lookupCode(key, $("#scan-code")?.value || ""); return true;
    case "c-scan-qty": {
      document.querySelectorAll('[data-action="c-scan-qty"]').forEach((b) => b.classList.toggle("on", b === el));
      const q = $("#scan-qty"); if (q) q.value = el.dataset.qty;
      return true;
    }
    case "c-scan-log": {
      const food = s.barcodes[el.dataset.code];
      if (!food) return true;
      const q = +($("#scan-qty")?.value || 1);
      const per100 = food.servingG === 100 && food.serving === "100 g";
      const mult = per100 ? q / 100 : q;
      const item = { id: `bc:${el.dataset.code}`, name: food.name, emoji: "▦", calories: Math.round(food.calories * mult), protein: Math.round(food.protein * mult * 10) / 10, group: "Scanned" };
      addEntry(key, item, 1, { detail: per100 ? `${q} g` : `${q} × ${food.serving}` });
      if (el.dataset.save) saveUsual({ name: food.name, emoji: "▦", calories: item.calories, protein: item.protein, detail: per100 ? `${q} g` : `${q} × ${food.serving}` });
      ctx.closeSheet();
      return true;
    }
  }
  return false;
}
