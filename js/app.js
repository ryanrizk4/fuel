/* app.js — UI layer. All logic lives in engine.js; this renders state and handles taps. */

import * as E from "./engine.js";

const STORE_KEY = "fuel.state.v1";
let DATA = null;
let state = null;
let currentTab = "today";
let planWeekOffset = 0;
let shopWeekOffset = 0;
let sheetCtx = null;

// ---------- state ----------

function defaultState() {
  return {
    profile: null,
    plan: { days: {} },
    weighIns: [],
    freezer: [],
    history: {},
    productOverrides: {},
    shopChecks: {},
    overageBank: 0,
    planMode: "auto",
    theme: "auto",
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? { ...defaultState(), ...JSON.parse(raw) } : defaultState();
  } catch {
    state = defaultState();
  }
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayKey = () => E.dateKey(new Date());

function slotLabel(slot) {
  return { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" }[slot] || slot;
}

function mealTitle(m) {
  const tpl = E.templateById(DATA, m.templateId);
  if (!tpl) return { name: "?", variant: "", emoji: "🍽" };
  const v = E.variantOf(tpl, m.variantId);
  return { name: tpl.name, variant: v.id === "classic" ? "" : v.name, emoji: tpl.emoji || "🍽" };
}

// ---------- boot ----------

async function boot() {
  const [p, t] = await Promise.all([
    fetch("data/products.json").then((r) => r.json()),
    fetch("data/templates.json").then((r) => r.json()),
  ]);
  DATA = { products: p.products, templates: t.templates };
  load();
  applyTheme();
  if (!state.profile) {
    $("#onboarding").hidden = false;
    bindOnboardingPreview();
  } else {
    renderAll();
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function applyTheme() {
  if (state.theme === "light" || state.theme === "dark") document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
}

// ---------- onboarding ----------

function readOnboarding() {
  const ft = +($("#ob-ft").value || 0), inch = +($("#ob-in").value || 0);
  return {
    sex: $("#ob-sex").value,
    age: +($("#ob-age").value || 0),
    heightIn: ft * 12 + inch,
    weightLb: +($("#ob-weight").value || 0),
    activity: $("#ob-activity").value,
    deficit: +$("#ob-deficit").value,
    goalLossLb: +($("#ob-loss").value || 10),
    breakfastDefault: $("#ob-breakfast").value,
    treatsPerWeek: +$("#ob-treats").value,
    proteinPerLb: 0.8,
  };
}

function bindOnboardingPreview() {
  const update = () => {
    const p = readOnboarding();
    if (!p.age || !p.heightIn || !p.weightLb) { $("#ob-preview").hidden = true; return; }
    const budget = E.dailyBudget(p);
    const weeks = Math.ceil((p.goalLossLb * E.KCAL_PER_LB) / p.deficit / 7);
    $("#ob-preview").hidden = false;
    $("#ob-preview").innerHTML =
      `Your daily budget: <b>${budget} kcal</b> · protein target <b>${E.proteinTarget(p)}g</b><br>` +
      `<span class="small">Maintenance ≈ ${E.tdee(p)} kcal. At −${p.deficit}/day you lose ${p.goalLossLb} lb in about ${weeks} weeks.</span>` +
      (E.budgetIsFloored(p) ? `<br><span class="small">⚠️ Budget floored for safety — deficit slightly smaller than selected.</span>` : "");
  };
  $("#onboarding").addEventListener("input", update);
}

function finishOnboarding() {
  const p = readOnboarding();
  if (!p.age || !p.heightIn || !p.weightLb) { alert("Fill in age, height and weight first."); return; }
  p.startWeightLb = p.weightLb;
  p.startDate = todayKey();
  state.profile = p;
  state.weighIns.push({ date: todayKey(), lb: p.weightLb });
  const days = E.generateWeek(DATA, state, E.dateKey(E.weekStart(new Date())), state.planMode);
  Object.assign(state.plan.days, days);
  save();
  $("#onboarding").hidden = true;
  renderAll();
}

// ---------- rendering ----------

function renderAll() {
  renderToday();
  renderPlan();
  renderShop();
  renderProgress();
  renderMore();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${tab}`).classList.add("active");
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  window.scrollTo(0, 0);
}

// ----- Today -----

function renderToday() {
  const el = $("#view-today");
  const key = todayKey();
  const day = state.plan.days[key];
  const p = state.profile;
  if (!p) return;
  const { budget: effBudget, trim, credit } = E.effectiveBudget(state, day);
  const pTarget = E.proteinTarget(p);
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  if (!day) {
    el.innerHTML = `
      <div class="screen-title">Today</div>
      <div class="screen-sub">${dateStr}</div>
      <div class="card empty">Nothing planned for today yet.<br><br>
        <button class="btn primary" data-action="plan-this-week">Auto-plan this week</button>
      </div>`;
    return;
  }

  const consumed = E.dayConsumed(DATA, state, day);
  const planned = E.dayTotals(DATA, state, day);
  const remaining = Math.max(0, effBudget - consumed.calories);
  const pct = Math.min(1, consumed.calories / effBudget);
  const over = consumed.calories > effBudget;
  const R = 52, C = 2 * Math.PI * R;

  const mealRows = (day.meals || []).map((m, i) => {
    const t = mealTitle(m);
    const mm = E.mealMacros(DATA, state, m.templateId, m.variantId, m.portions || 1);
    const eaten = (day.eaten || []).includes(i);
    const por = (m.portions || 1) !== 1 ? ` · ×${m.portions}` : "";
    return `
      <div class="meal-row">
        <div class="meal-emoji">${t.emoji}</div>
        <div class="meal-info" data-action="open-meal" data-date="${key}" data-idx="${i}">
          <div class="meal-slot">${slotLabel(m.slot)}${m.fromFreezer ? ' <span class="badge freezer">freezer</span>' : ""}${m.batchCook ? ' <span class="badge batch">batch cook</span>' : ""}</div>
          <div class="meal-name">${esc(t.name)}</div>
          <div class="meal-meta">${mm.calories} kcal · ${mm.protein}g protein${por}${t.variant ? ` · <span class="variant">${esc(t.variant)}</span>` : ""}${mm.estimated ? ' · <span class="badge est">est.</span>' : ""}</div>
        </div>
        <button class="eat-check ${eaten ? "on" : ""}" data-action="toggle-eat" data-date="${key}" data-idx="${i}" aria-label="mark eaten">✓</button>
      </div>`;
  }).join("");

  const snackRows = (day.snacks || []).map((s, i) => {
    const prod = s.custom ? null : E.productById(DATA, state, s.productId);
    const name = s.custom ? s.custom.name : prod?.name || "?";
    const cal = s.custom ? s.custom.calories : Math.round((prod?.calories || 0) * (s.qty || 1));
    const pro = s.custom ? s.custom.protein : Math.round((prod?.protein || 0) * (s.qty || 1));
    const treat = prod?.treat;
    return `
      <div class="meal-row">
        <div class="meal-emoji">${treat ? "🍫" : "🥨"}</div>
        <div class="meal-info">
          <div class="meal-name">${esc(name)} ${treat ? '<span class="badge treat">treat</span>' : ""}</div>
          <div class="meal-meta">${cal} kcal · ${pro}g protein</div>
        </div>
        <button class="eat-check ${s.eaten ? "on" : ""}" data-action="toggle-snack" data-date="${key}" data-idx="${i}" aria-label="mark eaten">✓</button>
      </div>`;
  }).join("");

  const statusCard = day.status === "planned" ? `
    <div class="card">
      <h3>How did today go?</h3>
      <div class="btn-row">
        <button class="btn" data-action="mark-done" data-date="${key}">✓ On plan</button>
        <button class="btn" data-action="sheet-ate-out" data-date="${key}">🍽 Ate out</button>
        <button class="btn" data-action="sheet-over" data-date="${key}">⚠️ Went over</button>
      </div>
      <div class="btn-row"><button class="btn ghost" data-action="sheet-activity" data-date="${key}">🥾 Unusually active today?</button></div>
    </div>` : `
    <div class="card">
      <h3>Day logged: ${{ done: "on plan ✓", skipped: "ate out", over: "went over" }[day.status] || day.status}</h3>
      ${day.overage ? `<div class="small muted mt8">Logged overage: ${day.overage} kcal — being absorbed into next days.</div>` : ""}
      <div class="btn-row"><button class="btn ghost" data-action="undo-status" data-date="${key}">Undo</button></div>
    </div>`;

  el.innerHTML = `
    <div class="screen-title">Today</div>
    <div class="screen-sub">${dateStr}</div>

    <div class="card">
      <div class="today-hero">
        <div class="ring-wrap">
          <svg width="118" height="118" viewBox="0 0 118 118">
            <circle cx="59" cy="59" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="10"/>
            <circle cx="59" cy="59" r="${R}" fill="none" stroke="${over ? "var(--critical)" : "var(--accent)"}" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
          </svg>
          <div class="ring-center">
            <div class="big">${over ? `+${consumed.calories - effBudget}` : remaining}</div>
            <div class="small">${over ? "kcal over" : "kcal left"}</div>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat">
            <div class="stat-label"><span>Calories</span><b>${consumed.calories} / ${effBudget}</b></div>
            <div class="bar cal"><i style="width:${Math.min(100, pct * 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Protein</span><b>${consumed.protein} / ${pTarget}g</b></div>
            <div class="bar"><i style="width:${Math.min(100, (consumed.protein / pTarget) * 100)}%"></i></div>
          </div>
          <div class="small muted">Planned total: ${planned.calories} kcal · ${planned.protein}g</div>
        </div>
      </div>
      ${trim > 0 ? `<div class="trim-note">💪 Absorbing a past overage: budget trimmed by ${trim} kcal/day until ${state.overageBank} kcal is paid off.</div>` : ""}
      ${credit > 0 ? `<div class="trim-note">🥾 ${esc(day.activityCredit.label)}: +${credit} kcal credited today. <button class="btn small ghost" data-action="remove-activity" data-date="${key}" style="margin-left:6px">Remove</button></div>` : ""}
    </div>

    <div class="card">
      <div class="list-title-row"><h3>Meals</h3><span class="small muted">tap name to swap · tap ✓ when eaten</span></div>
      ${mealRows || '<div class="empty">No meals planned</div>'}
    </div>

    <div class="card">
      <div class="list-title-row"><h3>Snacks</h3>
        <button class="btn small ghost" data-action="sheet-add-snack" data-date="${key}">+ Add</button>
      </div>
      ${snackRows || '<div class="small muted">No snacks planned — add one if you\'re hungry, it counts against today\'s budget.</div>'}
    </div>

    ${statusCard}`;
}

// ----- Plan -----

function renderPlan() {
  const el = $("#view-plan");
  if (!state.profile) return;
  const start = E.addDays(E.weekStart(new Date()), planWeekOffset * 7);
  const startK = E.dateKey(start);
  const budget = E.dailyBudget(state.profile);
  const weekLabels = ["This week", "Next week", "+2 weeks", "+3 weeks"];
  const hasAny = [...Array(7)].some((_, i) => state.plan.days[E.dateKey(E.addDays(start, i))]);

  const dayCards = [...Array(7)].map((_, i) => {
    const d = E.addDays(start, i);
    const key = E.dateKey(d);
    const day = state.plan.days[key];
    const isToday = key === todayKey();
    if (!day) return "";
    const totals = E.dayTotals(DATA, state, day);
    const statusChip = isToday && day.status === "planned"
      ? '<span class="status-chip today-dot">today</span>'
      : `<span class="status-chip ${day.status}">${{ planned: "planned", done: "done ✓", skipped: "ate out", over: "over" }[day.status]}</span>`;
    const rows = (day.meals || []).map((m, mi) => {
      const t = mealTitle(m);
      const mm = E.mealMacros(DATA, state, m.templateId, m.variantId, m.portions || 1);
      const por = (m.portions || 1) !== 1 ? ` · ×${m.portions}` : "";
      return `
        <div class="meal-row" data-action="open-meal" data-date="${key}" data-idx="${mi}">
          <div class="meal-emoji">${t.emoji}</div>
          <div class="meal-info">
            <div class="meal-slot">${slotLabel(m.slot)}${m.fromFreezer ? ' <span class="badge freezer">freezer</span>' : ""}${m.batchCook ? ' <span class="badge batch">batch cook</span>' : ""}${m.locked ? " 🔒" : ""}</div>
            <div class="meal-name">${esc(t.name)}</div>
            <div class="meal-meta">${mm.calories} kcal · ${mm.protein}g${por}${t.variant ? ` · <span class="variant">${esc(t.variant)}</span>` : ""}</div>
          </div>
        </div>`;
    }).join("");
    const snackSummary = (day.snacks || []).length
      ? `<div class="small muted" style="padding:8px 0 10px">🥨 ${(day.snacks || []).map((s) => esc(s.custom ? s.custom.name : E.productById(DATA, state, s.productId)?.name || "?")).join(" · ")}</div>` : "";
    return `
      <div class="card day-card">
        <div class="day-head" data-action="sheet-day" data-date="${key}">
          <div>
            <div class="d-name">${E.fmtDay(d)}</div>
            <div class="d-kcal">${totals.calories} / ${budget} kcal · ${totals.protein}g protein</div>
          </div>
          ${statusChip}
        </div>
        <div class="day-body">${rows}${snackSummary}</div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="screen-title">Plan</div>
    <div class="screen-sub">Auto-plan decides for you. Tap any meal to overrule it.</div>

    <div class="chips">
      ${weekLabels.map((l, i) => `<button class="chip ${i === planWeekOffset ? "on" : ""}" data-action="plan-week" data-offset="${i}">${l}</button>`).join("")}
    </div>

    <div class="seg">
      ${[["auto", "Balanced"], ["prep", "Prep Sunday"], ["easy", "Low energy"]].map(([v, l]) =>
        `<button class="${state.planMode === v ? "on" : ""}" data-action="plan-mode" data-mode="${v}">${l}</button>`).join("")}
    </div>

    <button class="btn primary" style="width:100%" data-action="generate-week" data-start="${startK}">
      ${hasAny ? "↻ Re-plan remaining days" : "✨ Auto-plan this week"}
    </button>
    <div class="small muted mt8" style="margin-bottom:12px">
      ${{ auto: "Balanced rotation — variety without relearning anything.", prep: "Batch-cook on the weekend, freezer portions through the week.", easy: "Quick meals and freezer stock only — for low-energy weeks." }[state.planMode]}
    </div>

    ${dayCards || '<div class="card empty">No plan for this week yet — hit Auto-plan.</div>'}`;
}

// ----- Shop -----

function renderShop() {
  const el = $("#view-shop");
  if (!state.profile) return;
  const start = E.addDays(E.weekStart(new Date()), shopWeekOffset * 7);
  const startK = E.dateKey(start);
  const list = E.shoppingList(DATA, state, startK);
  const estCount = list.flatMap((s) => s.items).filter((i) => i.needsVerify).length;
  let total = 0, checked = 0;

  const sections = list.map((sec) => {
    const items = sec.items.map((item) => {
      const ck = state.shopChecks[`${startK}:${item.id}`];
      total++; if (ck) checked++;
      const qtyStr = item.packs
        ? `${item.packs} × ${item.packLabel || "pack"} — needs ${item.qty} × ${item.unit}`
        : `needs ${item.qty} × ${item.unit}`;
      return `
        <div class="shop-item ${ck ? "checked" : ""}">
          <button class="shop-check ${ck ? "on" : ""}" data-action="shop-check" data-key="${startK}:${item.id}">✓</button>
          <div style="flex:1;min-width:0">
            <div class="shop-name">${esc(item.name)}</div>
            <div class="shop-qty">${esc(qtyStr)}${item.note ? ` · ${esc(item.note)}` : ""}</div>
          </div>
          ${item.needsVerify ? `<button class="verify-chip" data-action="sheet-verify" data-product="${item.id}">Check label</button>` : ""}
        </div>`;
    }).join("");
    return `<div class="shop-section"><h4>${esc(sec.section)}</h4><div class="card" style="padding:4px 16px">${items}</div></div>`;
  }).join("");

  el.innerHTML = `
    <div class="screen-title">Shop</div>
    <div class="screen-sub">Trader Joe's list for the planned week — grouped the way the store flows.</div>
    <div class="chips">
      <button class="chip ${shopWeekOffset === 0 ? "on" : ""}" data-action="shop-week" data-offset="0">This week</button>
      <button class="chip ${shopWeekOffset === 1 ? "on" : ""}" data-action="shop-week" data-offset="1">Next week</button>
    </div>
    ${total ? `<div class="small muted" style="margin-bottom:4px">${checked}/${total} picked up</div>` : ""}
    ${estCount ? `<div class="trim-note" style="margin-bottom:10px">🏷 ${estCount} item${estCount > 1 ? "s have" : " has"} <b>estimated</b> macros. Tap “Check label” at the store and Fuel remembers the real numbers forever.</div>` : ""}
    ${sections || '<div class="card empty">Nothing to buy — plan a week first on the Plan tab.</div>'}`;
}

// ----- Progress -----

function renderProgress() {
  const el = $("#view-progress");
  const p = state.profile;
  if (!p) return;
  const current = E.latestWeight(state) ?? p.weightLb;
  const lost = Math.round((p.startWeightLb - current) * 10) / 10;
  const proj = E.goalProjection(state);
  const target = p.startWeightLb - p.goalLossLb;
  const etaStr = proj.eta.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const bank = state.overageBank || 0;

  const entries = [...state.weighIns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map((w, i) =>
    `<div class="freezer-row">
      <div style="flex:1"><b>${w.lb} lb</b> <span class="small muted">· ${w.date}</span></div>
      <button class="btn small ghost danger" data-action="del-weight" data-date="${w.date}">✕</button>
    </div>`).join("");

  el.innerHTML = `
    <div class="screen-title">Progress</div>
    <div class="screen-sub">Goal: ${target} lb (−${p.goalLossLb} from ${p.startWeightLb})</div>

    <div class="tiles">
      <div class="tile"><div class="t-label">Current</div><div class="t-value">${current} lb</div><div class="t-sub">last weigh-in</div></div>
      <div class="tile"><div class="t-label">Lost so far</div><div class="t-value ${lost > 0 ? "good" : ""}">${lost > 0 ? "−" : ""}${Math.abs(lost)} lb</div><div class="t-sub">${proj.remainingLb.toFixed(1)} lb to go</div></div>
      <div class="tile"><div class="t-label">Goal date</div><div class="t-value">${etaStr}</div><div class="t-sub">≈ ${proj.daysLeft} days at −${p.deficit}/day</div></div>
      <div class="tile"><div class="t-label">Overage bank</div><div class="t-value ${bank > 0 ? "bad" : "good"}">${bank}</div><div class="t-sub">${bank > 0 ? `kcal to absorb · pushes goal ~${Math.ceil(proj.bankDays)} day${Math.ceil(proj.bankDays) !== 1 ? "s" : ""}` : "kcal — all clear ✓"}</div></div>
    </div>

    <div class="card">
      <h3>Weight trend</h3>
      <div class="chart-box" id="chart-box">${weightChartSVG()}</div>
      <div class="chart-tip" id="chart-tip"></div>
      <div class="field-row mt16">
        <div class="field" style="margin:0"><input id="weight-input" type="number" inputmode="decimal" placeholder="Today's weight (lb)" /></div>
        <button class="btn primary" data-action="add-weight">Log</button>
      </div>
    </div>

    <div class="card">
      <h3>Recent weigh-ins</h3>
      ${entries || '<div class="small muted mt8">No entries yet.</div>'}
    </div>

    <div class="card">
      <h3>How the binge math works</h3>
      <div class="small muted mt8">
        Log a heavy day on the Today tab (“Went over”). The extra calories go into your overage bank.
        Fuel trims up to ${E.MAX_DAILY_TRIM} kcal/day off your budget until it's paid back — never more,
        so you don't starve and rebound. Whatever trimming can't cover just moves your goal date. The math
        is stark but honest: one big weekend ≈ a few extra days, not a failed plan.
      </div>
    </div>

    <div class="card">
      <h3>Why "calories burned" ≠ calories to eat</h3>
      <div class="small muted mt8">
        Your budget already includes your daily ~10k steps and gym sessions — that's the activity multiplier.
        Watches overestimate burn by 27–93% (Stanford wearables study), and a lifting session actually costs
        ~150–300 kcal, not 500+. Eating back tracker calories double-counts and erases the deficit. Only log
        genuinely unusual days (long hike, double your normal steps) via “Unusually active?” on the Today tab —
        Fuel credits 50%, capped at ${E.ACTIVITY_CAP} kcal. Your weekly weigh-in trend is the real referee.
      </div>
    </div>`;
}

function weightChartSVG() {
  const pts = [...state.weighIns].sort((a, b) => a.date.localeCompare(b.date));
  const p = state.profile;
  const target = p.startWeightLb - p.goalLossLb;
  if (pts.length < 2) return '<div class="empty">Log at least two weigh-ins to see your trend.</div>';

  const W = 340, H = 170, mL = 34, mR = 12, mT = 14, mB = 22;
  const xs = pts.map((w) => E.parseKey(w.date).getTime());
  const minX = Math.min(...xs), maxX = Math.max(...xs, minX + 86400000 * 7);
  const ys = pts.map((w) => w.lb).concat([target]);
  const minY = Math.floor(Math.min(...ys) - 1), maxY = Math.ceil(Math.max(...ys) + 1);
  const X = (t) => mL + ((t - minX) / (maxX - minX)) * (W - mL - mR);
  const Y = (v) => mT + ((maxY - v) / (maxY - minY)) * (H - mT - mB);

  const gridVals = [minY, Math.round((minY + maxY) / 2), maxY];
  const grid = gridVals.map((v) =>
    `<line x1="${mL}" y1="${Y(v)}" x2="${W - mR}" y2="${Y(v)}" stroke="var(--hairline)" stroke-width="1"/>
     <text x="${mL - 5}" y="${Y(v) + 3.5}" text-anchor="end" font-size="9.5" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${v}</text>`).join("");

  const path = pts.map((w, i) => `${i ? "L" : "M"}${X(E.parseKey(w.date).getTime()).toFixed(1)},${Y(w.lb).toFixed(1)}`).join(" ");
  const dots = pts.map((w, i) =>
    `<circle cx="${X(E.parseKey(w.date).getTime()).toFixed(1)}" cy="${Y(w.lb).toFixed(1)}" r="4"
      fill="var(--accent)" stroke="var(--surface)" stroke-width="2" data-chart-pt="${i}"/>`).join("");

  const first = pts[0], last = pts[pts.length - 1];
  const labels = `
    <text x="${X(E.parseKey(first.date).getTime())}" y="${Y(first.lb) - 9}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--ink-2)">${first.lb}</text>
    <text x="${Math.min(X(E.parseKey(last.date).getTime()), W - mR - 12)}" y="${Y(last.lb) - 9}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--ink-2)">${last.lb}</text>`;

  const fmtD = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weight trend chart">
      ${grid}
      <line x1="${mL}" y1="${Y(target)}" x2="${W - mR}" y2="${Y(target)}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4"/>
      <text x="${W - mR}" y="${Y(target) - 5}" text-anchor="end" font-size="9.5" fill="var(--muted)">goal ${target}</text>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
      ${dots}${labels}
      <text x="${mL}" y="${H - 6}" font-size="9.5" fill="var(--muted)">${fmtD(minX)}</text>
      <text x="${W - mR}" y="${H - 6}" text-anchor="end" font-size="9.5" fill="var(--muted)">${fmtD(Math.max(...xs))}</text>
    </svg>`;
}

// ----- More -----

function renderMore() {
  const el = $("#view-more");
  const p = state.profile;
  if (!p) return;
  const budget = E.dailyBudget(p);
  const freezerTpls = DATA.templates.filter((t) => t.freezerFriendly);

  const freezerRows = (state.freezer || []).map((f, i) => {
    const tpl = E.templateById(DATA, f.templateId);
    return `
      <div class="freezer-row">
        <div style="flex:1"><b>${esc(tpl?.name || f.label || "?")}</b></div>
        <div class="stepper">
          <button data-action="freezer-dec" data-idx="${i}">−</button>
          <span>${f.portions}</span>
          <button data-action="freezer-inc" data-idx="${i}">+</button>
        </div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="screen-title">More</div>
    <div class="screen-sub">Profile, freezer, data.</div>

    <div class="card">
      <h3>Your numbers</h3>
      <div class="small muted" style="margin-bottom:12px">Maintenance ≈ ${E.tdee(p)} kcal · budget <b>${budget}</b> kcal · protein ${E.proteinTarget(p)}g</div>
      <div class="field-row">
        <div class="field"><label>Weight (lb)</label><input id="s-weight" type="number" inputmode="decimal" value="${p.weightLb}" /></div>
        <div class="field"><label>Age</label><input id="s-age" type="number" inputmode="numeric" value="${p.age}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Activity</label>
          <select id="s-activity">
            ${["sedentary", "light", "moderate", "very"].map((a) => `<option value="${a}" ${p.activity === a ? "selected" : ""}>${a}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Deficit</label>
          <select id="s-deficit">
            ${[250, 500, 750].map((d) => `<option value="${d}" ${p.deficit === d ? "selected" : ""}>−${d}/day</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Default breakfast</label>
          <select id="s-breakfast">
            ${DATA.templates.filter((t) => t.mealType.includes("breakfast")).map((t) => `<option value="${t.id}" ${p.breakfastDefault === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Treats / week</label>
          <select id="s-treats">
            ${[0, 2, 3, 5].map((n) => `<option value="${n}" ${p.treatsPerWeek === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </div>
      </div>
      <button class="btn primary" data-action="save-profile" style="width:100%">Save</button>
    </div>

    <div class="card">
      <div class="list-title-row"><h3>Freezer stock</h3>
        <button class="btn small ghost" data-action="sheet-add-freezer">+ Add</button>
      </div>
      <div class="small muted" style="margin-bottom:6px">Auto-plan uses these before scheduling new cooking. Batch-cook days add portions automatically when you mark the day done.</div>
      ${freezerRows || '<div class="small muted">Freezer empty.</div>'}
    </div>

    <div class="card">
      <h3>Appearance</h3>
      <div class="seg mt8" style="margin-bottom:0">
        ${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `<button class="${state.theme === v ? "on" : ""}" data-action="set-theme" data-theme="${v}">${l}</button>`).join("")}
      </div>
    </div>

    <div class="card">
      <h3>Backup & restore</h3>
      <div class="small muted mt8">Your logs live on this phone. Copy a backup once a week — paste it into a Claude Code session and it can be saved to GitHub too.</div>
      <div class="btn-row">
        <button class="btn" data-action="export-data">Copy backup</button>
        <button class="btn ghost" data-action="sheet-import">Restore</button>
      </div>
      <div class="btn-row"><button class="btn ghost danger" data-action="reset-all">Reset everything</button></div>
    </div>

    <div class="card">
      <h3>Adding recipes from TikTok / IG</h3>
      <div class="small muted mt8">
        See a recipe you like? Open a Claude Code session on the <b>vividscribe</b> repo from your phone and say
        “add this to my rotation” + paste the link or describe it. Claude maps it to Trader Joe's ingredients,
        calculates macros, files it as a template with variants, and the app updates on the next visit.
      </div>
    </div>`;
}

// ---------- sheets ----------

function openSheet(html, ctx) {
  sheetCtx = ctx || null;
  $("#sheet").innerHTML = `<div class="sheet-handle"></div>${html}`;
  $("#sheet").classList.add("open");
  $("#sheet-backdrop").classList.add("open");
}

function closeSheet() {
  $("#sheet").classList.remove("open");
  $("#sheet-backdrop").classList.remove("open");
  sheetCtx = null;
}

function sheetMeal(dateK, idx) {
  const day = state.plan.days[dateK];
  const m = day.meals[idx];
  const tpl = E.templateById(DATA, m.templateId);
  const por = m.portions || 1;
  const variants = tpl.variants.map((v) => {
    const mm = E.mealMacros(DATA, state, tpl.id, v.id, por);
    return `
      <button class="option-row ${v.id === m.variantId ? "selected" : ""}" data-action="set-variant" data-variant="${v.id}">
        <div class="o-main"><div class="o-name">${esc(v.name)}</div>${v.note ? `<div class="o-sub">${esc(v.note)}</div>` : ""}</div>
        <div class="o-kcal">${mm.calories} · ${mm.protein}g</div>
      </button>`;
  }).join("");

  const others = DATA.templates
    .filter((t) => t.mealType.includes(m.slot) && t.id !== tpl.id)
    .map((t) => {
      const mm = E.mealMacros(DATA, state, t.id, "classic");
      return `
        <button class="option-row" data-action="set-template" data-template="${t.id}">
          <div class="o-main"><div class="o-name">${t.emoji || "🍽"} ${esc(t.name)}</div>
          <div class="o-sub">${t.prepMinutes} min${t.freezerFriendly ? " · freezer-friendly" : ""}${t.source === "trending" ? " · 🔥 trending" : ""}</div></div>
          <div class="o-kcal">${mm.calories} · ${mm.protein}g</div>
        </button>`;
    }).join("");

  const steps = tpl.steps?.length ? `<div class="small muted" style="padding:10px 4px 0">👨‍🍳 ${tpl.steps.map(esc).join(" → ")}</div>` : "";

  openSheet(`
    <h3>${tpl.emoji || ""} ${esc(tpl.name)}</h3>
    <div class="sub">${slotLabel(m.slot)} · ${E.fmtDay(E.parseKey(dateK))} · pick a variation (same cooking motions)</div>
    ${!m.batchCook && !m.fromFreezer ? `
    <div class="seg" style="margin-bottom:8px">
      ${[1, 1.5, 2].map((x) => `<button class="${por === x ? "on" : ""}" data-action="set-portions" data-portions="${x}">×${x} portion${x !== 1 ? "s" : ""}</button>`).join("")}
    </div>` : ""}
    ${variants}
    ${steps}
    <div class="ob-section">Switch to a different meal</div>
    ${others || '<div class="small muted">No alternatives for this slot.</div>'}
  `, { type: "meal", dateK, idx });
}

function sheetDay(dateK) {
  const day = state.plan.days[dateK];
  if (!day) return;
  openSheet(`
    <h3>${E.fmtDay(E.parseKey(dateK))}</h3>
    <div class="sub">Log how this day actually went</div>
    <button class="option-row" data-action="mark-done" data-date="${dateK}"><div class="o-main"><div class="o-name">✓ On plan</div><div class="o-sub">Ate what was planned</div></div></button>
    <button class="option-row" data-action="sheet-ate-out" data-date="${dateK}"><div class="o-main"><div class="o-name">🍽 Ate out / skipped the plan</div><div class="o-sub">Out with friends, didn't cook</div></div></button>
    <button class="option-row" data-action="sheet-over" data-date="${dateK}"><div class="o-main"><div class="o-name">⚠️ Went over</div><div class="o-sub">Log roughly how much extra</div></div></button>
    ${day.status !== "planned" ? `<button class="option-row" data-action="undo-status" data-date="${dateK}"><div class="o-main"><div class="o-name">↩ Reset to planned</div></div></button>` : ""}
  `, { type: "day", dateK });
}

function sheetAteOut(dateK) {
  openSheet(`
    <h3>Ate out 🍽</h3>
    <div class="sub">No guilt — just calibrate. How was it, roughly?</div>
    <button class="option-row" data-action="skip-day" data-date="${dateK}" data-adj="same"><div class="o-main"><div class="o-name">About on plan</div><div class="o-sub">Reasonable meal, similar calories</div></div></button>
    <button class="option-row" data-action="skip-day" data-date="${dateK}" data-adj="light"><div class="o-main"><div class="o-name">Lighter than plan</div><div class="o-sub">Credits ~250 kcal back</div></div></button>
    <div class="ob-section">Or heavier — estimate the damage</div>
    <div class="chips">
      ${[500, 1000, 1500, 2500].map((v) => `<button class="chip" data-action="skip-day" data-date="${dateK}" data-adj="over" data-kcal="${v}">+${v}</button>`).join("")}
    </div>
    <div class="field-row">
      <div class="field" style="margin:0"><input id="over-input" type="number" inputmode="numeric" placeholder="Custom kcal over" /></div>
      <button class="btn primary" data-action="skip-day" data-date="${dateK}" data-adj="over" data-kcal="input">Log</button>
    </div>
  `);
}

function sheetOver(dateK) {
  openSheet(`
    <h3>Went over ⚠️</h3>
    <div class="sub">Ate the plan plus extra. Roughly how much extra?</div>
    <div class="chips">
      ${[300, 500, 1000, 2000].map((v) => `<button class="chip" data-action="log-over" data-date="${dateK}" data-kcal="${v}">+${v}</button>`).join("")}
    </div>
    <div class="field-row">
      <div class="field" style="margin:0"><input id="over-input" type="number" inputmode="numeric" placeholder="Custom kcal over" /></div>
      <button class="btn primary" data-action="log-over" data-date="${dateK}" data-kcal="input">Log</button>
    </div>
    <div class="small muted mt16">It goes into the overage bank and gets absorbed at ≤${E.MAX_DAILY_TRIM} kcal/day. Stark but fair.</div>
  `);
}

function sheetAddSnack(dateK) {
  const snacks = DATA.products.filter((x) => x.snack);
  const rows = snacks.map((s) => `
    <button class="option-row" data-action="add-snack" data-date="${dateK}" data-product="${s.id}">
      <div class="o-main"><div class="o-name">${esc(s.name)} ${s.treat ? '<span class="badge treat">treat</span>' : ""}</div>
      <div class="o-sub">${esc(s.unit)}${s.confidence === "estimated" ? " · est. macros" : ""}</div></div>
      <div class="o-kcal">${s.calories} · ${s.protein}g</div>
    </button>`).join("");
  openSheet(`
    <h3>Add a snack</h3>
    <div class="sub">Counts toward today's budget immediately</div>
    ${rows}
    <div class="ob-section">Something else</div>
    <div class="field"><input id="snack-name" placeholder="Name (e.g. shawarma from the spot)" /></div>
    <div class="field-row">
      <div class="field"><input id="snack-cal" type="number" inputmode="numeric" placeholder="kcal" /></div>
      <div class="field"><input id="snack-pro" type="number" inputmode="numeric" placeholder="protein g" /></div>
    </div>
    <button class="btn primary" style="width:100%" data-action="add-custom-snack" data-date="${dateK}">Add custom</button>
  `);
}

function sheetActivity(dateK) {
  openSheet(`
    <h3>🥾 Unusually active?</h3>
    <div class="sub">Your budget already includes your daily ~10k steps and gym sessions — that's what the activity multiplier is. Lifting earns 0 extra: it builds muscle, it doesn't burn much (~150–300 kcal/session, not what the watch says).</div>
    <div class="trim-note" style="margin-bottom:12px">Trackers overestimate burn by 27–93%, so Fuel credits <b>50%</b> of genuinely extra activity, capped at <b>${E.ACTIVITY_CAP} kcal/day</b> — a bad estimate can never erase your deficit. Your weekly weigh-in is the real referee.</div>
    <button class="option-row" data-action="log-activity" data-date="${dateK}" data-kcal="500" data-label="Long hike / big outdoor day">
      <div class="o-main"><div class="o-name">Long hike or multi-hour outdoor day</div><div class="o-sub">90+ min beyond your routine</div></div><div class="o-kcal">+${E.activityCreditFromTracker(500)}</div>
    </button>
    <button class="option-row" data-action="log-activity" data-date="${dateK}" data-kcal="300" data-label="Way more steps than usual">
      <div class="o-main"><div class="o-name">Way more steps than usual</div><div class="o-sub">~18–20k+ vs your normal 10k</div></div><div class="o-kcal">+${E.activityCreditFromTracker(300)}</div>
    </button>
    <button class="option-row" data-action="log-activity" data-date="${dateK}" data-kcal="250" data-label="Extra cardio session">
      <div class="o-main"><div class="o-name">Extra cardio session</div><div class="o-sub">On top of your normal training</div></div><div class="o-kcal">+${E.activityCreditFromTracker(250)}</div>
    </button>
    <div class="ob-section">Or from your watch / Samsung Health</div>
    <div class="field-row">
      <div class="field" style="margin:0"><input id="activity-input" type="number" inputmode="numeric" placeholder="Tracker says I burned…" /></div>
      <button class="btn primary" data-action="log-activity" data-date="${dateK}" data-kcal="input" data-label="Tracker-reported activity">Credit 50%</button>
    </div>
  `);
}

function sheetVerify(productId) {
  const prod = E.productById(DATA, state, productId);
  openSheet(`
    <h3>🏷 Check the label</h3>
    <div class="sub">${esc(prod.name)} — per ${esc(prod.unit)}. Enter what the package says and Fuel remembers it.</div>
    <div class="field-row">
      <div class="field"><label>Calories</label><input id="v-cal" type="number" inputmode="numeric" value="${prod.calories}" /></div>
      <div class="field"><label>Protein (g)</label><input id="v-pro" type="number" inputmode="decimal" value="${prod.protein}" /></div>
    </div>
    <button class="btn primary" style="width:100%" data-action="save-verify" data-product="${productId}">Save — verified ✓</button>
    <div class="small muted mt8">Current numbers are estimates${prod.note ? ` (${esc(prod.note)})` : ""}.</div>
  `);
}

function sheetAddFreezer() {
  const tpls = DATA.templates.filter((t) => t.freezerFriendly);
  const rows = tpls.map((t) => `
    <button class="option-row" data-action="add-freezer" data-template="${t.id}">
      <div class="o-main"><div class="o-name">${t.emoji || ""} ${esc(t.name)}</div></div>
      <div class="o-kcal">+1 portion</div>
    </button>`).join("");
  openSheet(`<h3>Add freezer portions</h3><div class="sub">What's sitting in the freezer?</div>${rows}`);
}

function sheetImport() {
  openSheet(`
    <h3>Restore backup</h3>
    <div class="sub">Paste a backup JSON below</div>
    <textarea class="io" id="import-box" placeholder='{"profile":...}'></textarea>
    <div class="btn-row"><button class="btn primary" data-action="import-data">Restore</button></div>
  `);
}

// ---------- actions ----------

function markDone(dateK) {
  const day = state.plan.days[dateK];
  if (!day) return;
  day.status = "done";
  day.eaten = (day.meals || []).map((_, i) => i);
  (day.snacks || []).forEach((s) => (s.eaten = true));
  E.recordHistory(state, day, dateK);
  // pay down the overage bank with today's trim
  if (state.overageBank > 0) state.overageBank = Math.max(0, state.overageBank - Math.min(E.MAX_DAILY_TRIM, state.overageBank));
  // freezer bookkeeping
  for (const m of day.meals || []) {
    if (m.fromFreezer) {
      const f = (state.freezer || []).find((x) => x.templateId === m.templateId && x.portions > 0);
      if (f) f.portions--;
    }
    if (m.batchCook) {
      const tpl = E.templateById(DATA, m.templateId);
      const extra = (tpl?.servings || 1) - 1;
      if (extra > 0) {
        const f = (state.freezer || []).find((x) => x.templateId === m.templateId);
        if (f) f.portions += extra;
        else state.freezer.push({ templateId: m.templateId, portions: extra });
      }
    }
  }
  state.freezer = (state.freezer || []).filter((f) => f.portions > 0);
  save(); closeSheet(); renderAll();
}

function skipDay(dateK, adj, kcal) {
  const day = state.plan.days[dateK];
  if (!day) return;
  day.status = "skipped";
  day.overage = 0;
  if (adj === "light") state.overageBank = Math.max(0, (state.overageBank || 0) - 250);
  if (adj === "over") { state.overageBank = (state.overageBank || 0) + kcal; day.overage = kcal; }
  save(); closeSheet(); renderAll();
}

function logOver(dateK, kcal) {
  const day = state.plan.days[dateK];
  if (!day) return;
  day.status = "over";
  day.overage = kcal;
  day.eaten = (day.meals || []).map((_, i) => i);
  (day.snacks || []).forEach((s) => (s.eaten = true));
  state.overageBank = (state.overageBank || 0) + kcal;
  E.recordHistory(state, day, dateK);
  save(); closeSheet(); renderAll();
}

function readKcal(el) {
  const raw = el.dataset.kcal;
  if (raw === "input") {
    const v = +($("#over-input")?.value || 0);
    return v > 0 ? v : null;
  }
  return +raw;
}

function handleAction(el) {
  const a = el.dataset.action;

  switch (a) {
    case "ob-save": return finishOnboarding();

    case "toggle-eat": {
      const day = state.plan.days[el.dataset.date];
      const i = +el.dataset.idx;
      day.eaten = day.eaten || [];
      day.eaten = day.eaten.includes(i) ? day.eaten.filter((x) => x !== i) : [...day.eaten, i];
      save(); renderToday(); return;
    }
    case "toggle-snack": {
      const day = state.plan.days[el.dataset.date];
      const s = day.snacks[+el.dataset.idx];
      s.eaten = !s.eaten;
      save(); renderToday(); return;
    }
    case "open-meal": return sheetMeal(el.dataset.date, +el.dataset.idx);
    case "sheet-day": return sheetDay(el.dataset.date);
    case "sheet-ate-out": closeSheet(); return sheetAteOut(el.dataset.date);
    case "sheet-over": closeSheet(); return sheetOver(el.dataset.date);
    case "sheet-add-snack": return sheetAddSnack(el.dataset.date);
    case "sheet-activity": return sheetActivity(el.dataset.date);
    case "log-activity": {
      const raw = el.dataset.kcal === "input" ? +($("#activity-input")?.value || 0) : +el.dataset.kcal;
      if (!raw || raw < 0) return;
      const day = state.plan.days[el.dataset.date];
      if (!day) return;
      day.activityCredit = { kcal: E.activityCreditFromTracker(raw), label: el.dataset.label, reported: raw };
      save(); closeSheet(); renderAll(); return;
    }
    case "remove-activity": {
      const day = state.plan.days[el.dataset.date];
      if (day) delete day.activityCredit;
      save(); renderAll(); return;
    }
    case "sheet-verify": return sheetVerify(el.dataset.product);
    case "sheet-add-freezer": return sheetAddFreezer();
    case "sheet-import": return sheetImport();

    case "mark-done": return markDone(el.dataset.date);
    case "undo-status": {
      const day = state.plan.days[el.dataset.date];
      if (day.overage) state.overageBank = Math.max(0, (state.overageBank || 0) - day.overage);
      day.status = "planned"; day.overage = 0;
      save(); closeSheet(); renderAll(); return;
    }
    case "skip-day": {
      const kcal = el.dataset.adj === "over" ? readKcal(el) : 0;
      if (el.dataset.adj === "over" && !kcal) return;
      return skipDay(el.dataset.date, el.dataset.adj, kcal);
    }
    case "log-over": {
      const kcal = readKcal(el);
      if (!kcal) return;
      return logOver(el.dataset.date, kcal);
    }

    case "set-variant": {
      const { dateK, idx } = sheetCtx;
      const m = state.plan.days[dateK].meals[idx];
      m.variantId = el.dataset.variant; m.locked = true;
      save(); closeSheet(); renderAll(); return;
    }
    case "set-portions": {
      const { dateK, idx } = sheetCtx;
      const m = state.plan.days[dateK].meals[idx];
      m.portions = +el.dataset.portions; m.locked = true;
      save(); sheetMeal(dateK, idx); renderAll(); return;
    }
    case "set-template": {
      const { dateK, idx } = sheetCtx;
      const m = state.plan.days[dateK].meals[idx];
      m.templateId = el.dataset.template; m.variantId = "classic"; m.locked = true;
      delete m.fromFreezer; delete m.batchCook;
      save(); closeSheet(); renderAll(); return;
    }

    case "add-snack": {
      const day = state.plan.days[el.dataset.date];
      if (!day) return;
      day.snacks = day.snacks || [];
      day.snacks.push({ productId: el.dataset.product, qty: 1, eaten: true });
      save(); closeSheet(); renderAll(); return;
    }
    case "add-custom-snack": {
      const name = $("#snack-name").value.trim();
      const cal = +($("#snack-cal").value || 0);
      const pro = +($("#snack-pro").value || 0);
      if (!name || !cal) return;
      const day = state.plan.days[el.dataset.date];
      day.snacks = day.snacks || [];
      day.snacks.push({ custom: { name, calories: cal, protein: pro }, eaten: true });
      save(); closeSheet(); renderAll(); return;
    }

    case "plan-week": planWeekOffset = +el.dataset.offset; return renderPlan();
    case "shop-week": shopWeekOffset = +el.dataset.offset; return renderShop();
    case "plan-mode": state.planMode = el.dataset.mode; save(); return renderPlan();
    case "plan-this-week": {
      const days = E.generateWeek(DATA, state, E.dateKey(E.weekStart(new Date())), state.planMode);
      Object.assign(state.plan.days, days);
      save(); renderAll(); return;
    }
    case "generate-week": {
      const days = E.generateWeek(DATA, state, el.dataset.start, state.planMode);
      Object.assign(state.plan.days, days);
      save(); renderAll(); return;
    }

    case "shop-check": {
      const k = el.dataset.key;
      state.shopChecks[k] = !state.shopChecks[k];
      save(); return renderShop();
    }
    case "save-verify": {
      const cal = +($("#v-cal").value || 0), pro = +($("#v-pro").value || 0);
      if (!cal && cal !== 0) return;
      state.productOverrides[el.dataset.product] = { calories: cal, protein: pro, verifiedAt: todayKey() };
      save(); closeSheet(); renderAll(); return;
    }

    case "add-weight": {
      const v = +($("#weight-input").value || 0);
      if (!v || v < 50 || v > 700) return;
      state.weighIns = state.weighIns.filter((w) => w.date !== todayKey());
      state.weighIns.push({ date: todayKey(), lb: v });
      state.profile.weightLb = v;
      save(); return renderAll();
    }
    case "del-weight": {
      state.weighIns = state.weighIns.filter((w) => w.date !== el.dataset.date);
      save(); return renderProgress();
    }

    case "save-profile": {
      const p = state.profile;
      p.weightLb = +($("#s-weight").value || p.weightLb);
      p.age = +($("#s-age").value || p.age);
      p.activity = $("#s-activity").value;
      p.deficit = +$("#s-deficit").value;
      p.breakfastDefault = $("#s-breakfast").value;
      p.treatsPerWeek = +$("#s-treats").value;
      save(); renderAll(); return;
    }
    case "set-theme": {
      state.theme = el.dataset.theme;
      applyTheme(); save(); return renderMore();
    }

    case "freezer-inc": { state.freezer[+el.dataset.idx].portions++; save(); return renderMore(); }
    case "freezer-dec": {
      const f = state.freezer[+el.dataset.idx];
      f.portions--; if (f.portions <= 0) state.freezer.splice(+el.dataset.idx, 1);
      save(); return renderMore();
    }
    case "add-freezer": {
      const f = (state.freezer || []).find((x) => x.templateId === el.dataset.template);
      if (f) f.portions++;
      else state.freezer.push({ templateId: el.dataset.template, portions: 1 });
      save(); closeSheet(); return renderMore();
    }

    case "export-data": {
      const json = JSON.stringify(state);
      (navigator.clipboard?.writeText(json) || Promise.reject())
        .then(() => alert("Backup copied to clipboard ✓"))
        .catch(() => { const t = document.createElement("textarea"); t.value = json; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); alert("Backup copied ✓"); });
      return;
    }
    case "import-data": {
      try {
        const parsed = JSON.parse($("#import-box").value);
        if (!parsed.profile) throw new Error("no profile");
        state = { ...defaultState(), ...parsed };
        save(); applyTheme(); closeSheet(); renderAll();
      } catch { alert("That doesn't look like a valid backup."); }
      return;
    }
    case "reset-all": {
      if (confirm("Delete ALL data — plan, logs, weigh-ins? This can't be undone.")) {
        localStorage.removeItem(STORE_KEY);
        location.reload();
      }
      return;
    }
  }
}

// ---------- events ----------

document.addEventListener("click", (e) => {
  const pt = e.target.closest("[data-chart-pt]");
  if (pt) {
    const pts = [...state.weighIns].sort((a, b) => a.date.localeCompare(b.date));
    const w = pts[+pt.dataset.chartPt];
    const tip = $("#chart-tip");
    const box = $("#chart-box").getBoundingClientRect();
    const r = pt.getBoundingClientRect();
    tip.textContent = `${w.lb} lb · ${w.date}`;
    tip.style.left = `${r.left - box.left + r.width / 2}px`;
    tip.style.top = `${r.top - box.top}px`;
    tip.style.display = "block";
    setTimeout(() => (tip.style.display = "none"), 2200);
    return;
  }
  const nav = e.target.closest(".nav button");
  if (nav) return switchTab(nav.dataset.tab);
  if (e.target.closest("#sheet-backdrop")) return closeSheet();
  const el = e.target.closest("[data-action]");
  if (el) handleAction(el);
});

boot();
