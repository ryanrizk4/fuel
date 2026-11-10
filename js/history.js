/* history.js — "History & stats": every logged day from both modes, over any range.
   UI only; numbers come from engine.js (dailyHistory, historyStats, weeklySummary, topFoods, historyCsv). */

import * as E from "./engine.js";

let ctx = null;
let range = 30;        // days: 7 | 30 | 90 | 365
let showAllDays = false;

const st = () => ctx.state();
const esc = (s) => ctx.esc(s);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const short = (key) => E.parseKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function initHistory(context) { ctx = context; }

function rangeKeys() {
  const to = ctx.todayKey();
  const from = E.dateKey(E.addDays(E.parseKey(to), -(range - 1)));
  return { from, to };
}

function firstLoggedKey() {
  const keys = [
    ...Object.entries(st().foodLog || {}).filter(([, d]) => d.entries?.length).map(([k]) => k),
    ...Object.entries(st().plan?.days || {}).filter(([, d]) => d.status && d.status !== "planned").map(([k]) => k),
  ].sort();
  return keys[0] || null;
}

// ---------- charts (single axis, direct labels, tabular numerals) ----------

function caloriesChart(rows) {
  const weekly = rows.length > 60;
  const pts = weekly ? weeklyPoints(rows) : rows.map((r) => ({ key: r.key, value: r.source ? r.calories : null, budget: r.budget, over: r.source && r.calories > r.budget, label: short(r.key) }));
  const W = 340, H = 150, mL = 32, mR = 6, mT = 14, mB = 20;
  const vals = pts.flatMap((p) => [p.value ?? 0, p.budget]);
  const maxY = Math.ceil(Math.max(...vals, 1000) * 1.1 / 250) * 250;
  const Y = (v) => mT + (1 - v / maxY) * (H - mT - mB);
  const slot = (W - mL - mR) / pts.length;
  const bw = Math.max(2, Math.min(22, slot * 0.7));
  const budget = pts.length ? pts[pts.length - 1].budget : 0;
  const bars = pts.map((p, i) => {
    const x = mL + i * slot + (slot - bw) / 2;
    if (p.value === null) return `<rect x="${x}" y="${H - mB - 2}" width="${bw}" height="2" fill="var(--hairline)"/>`;
    return `<rect x="${x.toFixed(1)}" y="${Y(p.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - mB - Y(p.value)).toFixed(1)}" rx="${Math.min(3, bw / 3)}" fill="${p.over ? "var(--critical)" : "var(--accent)"}" data-hist-day="${p.key}"><title>${p.label}: ${fmt(p.value)} kcal</title></rect>`;
  }).join("");
  const grid = [0, maxY / 2, maxY].map((v) => `<line x1="${mL}" x2="${W - mR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--hairline)"/>
    <text x="${mL - 4}" y="${Y(v) + 3}" text-anchor="end" font-size="9" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${weekly ? "Average calories per week" : "Calories per day"}">
    ${grid}${bars}
    <line x1="${mL}" x2="${W - mR}" y1="${Y(budget)}" y2="${Y(budget)}" stroke="var(--ink-2)" stroke-dasharray="4 4" stroke-width="1.5"/>
    <text x="${W - mR}" y="${Y(budget) - 4}" text-anchor="end" font-size="9.5" fill="var(--ink-2)">budget ${fmt(budget)}</text>
    <text x="${mL}" y="${H - 5}" font-size="9" fill="var(--muted)">${pts[0]?.label || ""}</text>
    <text x="${W - mR}" y="${H - 5}" text-anchor="end" font-size="9" fill="var(--muted)">${pts[pts.length - 1]?.label || ""}</text>
  </svg>${weekly ? `<div class="small muted">Each bar is one week's average.</div>` : ""}`;
}

function weeklyPoints(rows) {
  const by = new Map();
  for (const r of rows) {
    const wk = E.dateKey(E.weekStart(E.parseKey(r.key)));
    if (!by.has(wk)) by.set(wk, []);
    by.get(wk).push(r);
  }
  return [...by.entries()].map(([wk, rs]) => {
    const logged = rs.filter((r) => r.source);
    const avg = logged.length ? logged.reduce((s, r) => s + r.calories, 0) / logged.length : null;
    const budget = rs[rs.length - 1].budget;
    return { key: wk, value: avg, budget, over: avg !== null && avg > budget, label: short(wk) };
  });
}

function proteinChart(rows, target) {
  const pts = rows.map((r, i) => ({ i, v: r.source && !r.approx ? r.protein : null, key: r.key }));
  const known = pts.filter((p) => p.v !== null);
  if (known.length < 2) return `<div class="small muted">Log at least two days to see a protein trend.</div>`;
  const W = 340, H = 110, mL = 32, mR = 6, mT = 12, mB = 18;
  const maxY = Math.ceil(Math.max(...known.map((p) => p.v), target) * 1.15 / 25) * 25;
  const X = (i) => mL + (rows.length === 1 ? 0 : (i / (rows.length - 1)) * (W - mL - mR));
  const Y = (v) => mT + (1 - v / maxY) * (H - mT - mB);
  // break the line across unlogged days rather than drawing through them
  let d = "", prev = false;
  for (const p of pts) {
    if (p.v === null) { prev = false; continue; }
    d += `${prev ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)} `;
    prev = true;
  }
  const last = known[known.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Protein per day">
    <line x1="${mL}" x2="${W - mR}" y1="${Y(target)}" y2="${Y(target)}" stroke="var(--ink-2)" stroke-dasharray="4 4" stroke-width="1.5"/>
    <text x="${mL - 4}" y="${Y(target) + 3}" text-anchor="end" font-size="9" fill="var(--ink-2)">${target}g</text>
    <path d="${d}" fill="none" stroke="var(--protein)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${known.length <= 40 ? known.map((p) => `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.6" fill="var(--protein)"/>`).join("") : ""}
    <text x="${Math.min(X(last.i), W - mR - 14)}" y="${Y(last.v) - 7}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--protein)">${Math.round(last.v)}g</text>
    <text x="${mL}" y="${H - 4}" font-size="9" fill="var(--muted)">${short(rows[0].key)}</text>
    <text x="${W - mR}" y="${H - 4}" text-anchor="end" font-size="9" fill="var(--muted)">${short(rows[rows.length - 1].key)}</text>
  </svg>`;
}

// ---------- section ----------

export function historySection() {
  const s = st();
  const p = s.profile;
  const { from, to } = rangeKeys();
  const rows = E.dailyHistory(ctx.data(), s, from, to);
  const maintenance = E.tdee({ ...p, weightLb: E.latestWeight(s) ?? p.weightLb });
  const pTarget = E.proteinTarget(p);
  const stats = E.historyStats(rows, { maintenance, proteinTarget: pTarget, todayKey: to });
  const first = firstLoggedKey();
  const ranges = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];
  const head = `
    <div class="list-title-row" style="margin-top:6px"><div class="ob-section" style="margin:12px 0 8px">📊 History & stats</div>
      <button class="btn small ghost" data-action="h-export">⬇︎ Export</button></div>
    <div class="chips">${ranges.map(([d, l]) => `<button class="chip ${range === d ? "on" : ""}" data-action="h-range" data-days="${d}" aria-pressed="${range === d}">${l}</button>`).join("")}</div>`;

  if (!stats.logged) {
    return `${head}<div class="card empty">Nothing logged in this range yet.<br>Days you log in <b>Just count</b> or mark on the <b>Plan</b> both show up here, and they stay here when you switch modes.${first ? `<br><br>Your first logged day: ${short(first)}.` : ""}</div>`;
  }

  const weeks = E.weeklySummary(rows, s, maintenance).filter((w) => w.logged);
  const foods = E.topFoods(s, from, to, 6);
  const loggedRows = rows.filter((r) => r.source).reverse();
  const dayRows = (showAllDays ? loggedRows : loggedRows.slice(0, 10)).map((r) => {
    const over = r.calories > r.budget;
    return `<button class="option-row" data-action="h-day" data-date="${r.key}">
      <div class="o-main"><div class="o-name">${E.fmtDay(E.parseKey(r.key))}${r.key === to ? ' <span class="badge freezer">today</span>' : ""}</div>
        <div class="o-sub">${r.source === "count" ? `${r.items} item${r.items === 1 ? "" : "s"} logged` : "from your plan"}${r.approx ? " · estimated" : ""}${r.walked ? ` · 🚶 ${r.walked} kcal walked` : ""}</div></div>
      <div class="o-kcal"><b style="color:${over ? "var(--critical)" : "var(--ink)"}">${fmt(r.calories)}</b> / ${fmt(r.budget)}<br>${Math.round(r.protein)}g protein</div>
    </button>`;
  }).join("");

  return `${head}
    <div class="tiles">
      <div class="tile"><div class="t-label">Avg calories</div><div class="t-value">${fmt(stats.avgCalories)}</div><div class="t-sub">per logged day · budget ${fmt(E.dailyBudget(p))}</div></div>
      <div class="tile"><div class="t-label">Avg protein</div><div class="t-value">${stats.avgProtein}g</div><div class="t-sub">target ${pTarget}g · hit ${stats.proteinDays}/${stats.closed} days</div></div>
      <div class="tile"><div class="t-label">On budget</div><div class="t-value ${stats.adherence >= 80 ? "good" : stats.adherence < 50 ? "bad" : ""}">${stats.adherence}%</div><div class="t-sub">${stats.underBudget}/${stats.closed} finished days · streak ${stats.streak} (best ${stats.bestStreak})</div></div>
      <div class="tile"><div class="t-label">Est. fat lost</div><div class="t-value ${stats.deficit > 0 ? "good" : "bad"}">${stats.estLb > 0 ? "−" : "+"}${Math.abs(stats.estLb)} lb</div><div class="t-sub">${fmt(Math.abs(stats.deficit))} kcal ${stats.deficit >= 0 ? "deficit" : "surplus"} vs maintenance</div></div>
    </div>
    <div class="small muted" style="margin:-4px 2px 10px">${stats.logged} of ${stats.days} days logged.${stats.overDays ? ` ${stats.overDays} day${stats.overDays === 1 ? "" : "s"} over budget, ${fmt(stats.overTotal)} kcal in total${stats.biggestDay && stats.biggestDay.calories > stats.biggestDay.budget ? ` (biggest: ${short(stats.biggestDay.key)}, ${fmt(stats.biggestDay.calories)})` : ""}.` : " No days over budget."}</div>

    <div class="card"><h3>Calories</h3><div class="chart-box mt8">${caloriesChart(rows)}</div></div>
    <div class="card"><h3>Protein</h3><div class="chart-box mt8">${proteinChart(rows, pTarget)}</div></div>

    ${weeks.length ? `<div class="card">
      <h3>Week by week</h3>
      <div class="small muted" style="margin:4px 0 6px">Estimated loss from your logs next to what the scale actually did. If the scale keeps lagging, your logs are missing something or maintenance is lower than Fuel thinks.</div>
      <div class="week-table" role="table">
        <div class="wt-row wt-head" role="row"><span>Week of</span><span>Avg kcal</span><span>Logs say</span><span>Scale</span></div>
        ${weeks.map((w) => `<div class="wt-row" role="row"><span>${short(w.week)} <span class="muted">(${w.logged}d)</span></span><span>${fmt(w.avgCalories)}${w.overDays ? ` <span class="fit over">${w.overDays} over</span>` : ""}</span>
          <span class="${w.deficit >= 0 ? "good-text" : "bad-text"}">${w.estLb > 0 ? "−" : "+"}${Math.abs(w.estLb)} lb</span><span>${w.weightChange === null ? "—" : `${w.weightChange > 0 ? "+" : ""}${w.weightChange} lb`}</span></div>`).join("")}
      </div>
    </div>` : ""}

    ${foods.length ? `<div class="card">
      <h3>What you eat most</h3>
      ${foods.map((f) => `<div class="freezer-row"><div class="meal-emoji" style="width:32px;height:32px;font-size:1.1rem">${esc(f.emoji)}</div>
        <div style="flex:1;min-width:0"><div class="small" style="font-weight:650">${esc(f.name)}</div><div class="small muted">${f.count}× · ${fmt(f.calories)} kcal total</div></div></div>`).join("")}
    </div>` : ""}

    <div class="card">
      <div class="list-title-row"><h3>Every day</h3><span class="small muted">tap to see or edit</span></div>
      ${dayRows}
      ${loggedRows.length > 10 ? `<div class="btn-row"><button class="btn ghost" data-action="h-more">${showAllDays ? "Show fewer" : `Show all ${loggedRows.length} days`}</button></div>` : ""}
    </div>`;
}

// ---------- day detail ----------

function sheetHistoryDay(key) {
  const s = st();
  const log = s.foodLog?.[key];
  const plan = s.plan?.days?.[key];
  const [row] = E.dailyHistory(ctx.data(), s, key, key);
  let body = "";
  if (log?.entries?.length) {
    body = log.entries.map((e) => `<div class="freezer-row"><span>${esc(e.emoji || "🍽")}</span><div style="flex:1;min-width:0"><div class="small" style="font-weight:650">${esc(e.name)}</div>
      <div class="small muted">${fmt(e.calories * (e.qty ?? 1))} kcal · ${Math.round(e.protein * (e.qty ?? 1))}g${(e.qty ?? 1) !== 1 ? ` · ×${e.qty}` : ""}</div></div></div>`).join("")
      + (log.walks || []).map((w) => `<div class="small muted mt8">🚶 ${w.minutes} min extra walk · −${w.kcal} kcal</div>`).join("");
  } else if (plan) {
    body = (plan.meals || []).map((m) => {
      const t = E.templateById(ctx.data(), m.templateId);
      return `<div class="small" style="padding:6px 0">${t?.emoji || "🍽"} ${esc(t?.name || "?")}</div>`;
    }).join("") + (plan.overage ? `<div class="small muted mt8">Logged overage: +${plan.overage} kcal</div>` : "");
  }
  const canEdit = log?.entries?.length || s.trackMode === "count";
  ctx.openSheet(`
    <h3>${E.fmtDay(E.parseKey(key))}</h3>
    <div class="sub">${fmt(row.calories)} / ${fmt(row.budget)} kcal · ${Math.round(row.protein)}g protein${row.approx ? " · estimated" : ""}${log?.settled?.over ? ` · ${fmt(log.settled.over)} went to payback` : ""}</div>
    ${body || '<div class="empty">Nothing logged.</div>'}
    <div class="btn-row">${canEdit ? `<button class="btn primary" data-action="h-edit" data-date="${key}">Edit this day</button>` : ""}
      ${!log?.entries?.length && plan ? `<button class="btn" data-action="sheet-day" data-date="${key}">Change plan status</button>` : ""}</div>
  `);
}

// ---------- export ----------

async function exportCsv() {
  const s = st();
  const first = firstLoggedKey() || ctx.todayKey();
  const csv = E.historyCsv(ctx.data(), s, first, ctx.todayKey());
  const name = `fuel-history-${ctx.todayKey()}.csv`;
  const blob = new Blob([csv], { type: "text/csv" });
  try {
    const file = new File([blob], name, { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Fuel history" });
      return;
    }
  } catch (err) {
    if (err?.name === "AbortError") return; // the owner closed the share sheet
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  ctx.toast("⬇︎ History downloaded — opens in Google Sheets or Excel");
}

/** Returns true when the action was ours. */
export function handleHistory(el) {
  const a = el.dataset.action;
  if (!a?.startsWith("h-")) return false;
  switch (a) {
    case "h-range": range = +el.dataset.days; showAllDays = false; ctx.renderProgress(); return true;
    case "h-more": showAllDays = !showAllDays; ctx.renderProgress(); return true;
    case "h-day": sheetHistoryDay(el.dataset.date); return true;
    case "h-edit": ctx.openDayInToday(el.dataset.date); return true;
    case "h-export": exportCsv(); return true;
  }
  return false;
}

/** Bars in the calories chart are tappable too. */
export function handleChartTap(target) {
  const bar = target.closest?.("[data-hist-day]");
  if (!bar) return false;
  const key = bar.dataset.histDay;
  if (range > 60) { range = 30; ctx.renderProgress(); return true; }
  sheetHistoryDay(key);
  return true;
}
