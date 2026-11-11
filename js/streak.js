/* streak.js — "day passed" celebrations, the streak calendar, and closing today early.
   Designed to reward the moment of success and to forgive: a 50 kcal grace, shields earned
   every 7 good days, and a calm note (never an alarm) when a day runs over. Numbers come
   from engine.js (streakCalendar, dailyHistory); this file only draws and animates. */

import * as E from "./engine.js";

let ctx = null;
let monthOffset = 0;

const st = () => ctx.state();
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const $ = (s) => document.querySelector(s);
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function initStreak(context) { ctx = context; }

// ---------- data ----------

function firstLoggedKey() {
  const s = st();
  const keys = [
    ...Object.entries(s.foodLog || {}).filter(([, d]) => d.entries?.length).map(([k]) => k),
    ...Object.entries(s.plan?.days || {}).filter(([, d]) => d.status && d.status !== "planned").map(([k]) => k),
  ].sort();
  return keys[0] || null;
}

function todayClosed() {
  const s = st(), t = ctx.todayKey();
  return s.trackMode === "count" ? !!s.foodLog?.[t]?.closed : !!(s.plan?.days?.[t] && s.plan.days[t].status !== "planned");
}

export function streak() {
  const s = st();
  if (!s.profile) return null;
  const today = ctx.todayKey();
  const first = firstLoggedKey();
  const from = first && first < today ? first : today;
  const rows = E.dailyHistory(ctx.data(), s, from, today);
  return E.streakCalendar(rows, { todayKey: today, todayClosed: todayClosed() });
}

// ---------- Today: compact streak row + "done eating" ----------

const DOT = { success: "✓", shielded: "🛡", missed: "", open: "", none: "" };

export function streakRow({ showDone = true } = {}) {
  const s = st();
  const k = streak();
  if (!k) return "";
  const today = ctx.todayKey();
  const week = [...Array(7)].map((_, i) => E.dateKey(E.addDays(E.parseKey(today), i - 6)));
  const dots = week.map((d) => {
    const x = k.days[d] || { status: "none" };
    const cls = x.status === "missed" ? `missed ${x.reason}` : x.status;
    const label = E.parseKey(d).toLocaleDateString("en-US", { weekday: "narrow" });
    return `<button class="sdot ${cls}" data-action="s-open-day" data-date="${d}" aria-label="${E.fmtDay(E.parseKey(d))}: ${x.status}"><span>${DOT[x.status] || ""}</span><i>${label}</i></button>`;
  }).join("");
  const log = s.foodLog?.[today];
  const counting = s.trackMode === "count";
  const done = counting && showDone && (log?.closed
    ? `<button class="btn small ghost" data-action="s-reopen">Today closed ✓ · reopen</button>`
    : log?.entries?.length ? `<button class="btn small primary" data-action="s-close">✓ Done eating today</button>` : "");
  return `
    <div class="streak-row">
      <div class="streak-head">
        <span class="flame ${k.current ? "lit" : ""}">🔥 <b>${k.current}</b> day${k.current === 1 ? "" : "s"}</span>
        <span class="small muted">best ${k.best}${k.shields ? ` · 🛡×${k.shields}` : ""}${k.toNextShield ? ` · shield in ${k.toNextShield}` : ""}</span>
        ${done}
      </div>
      <div class="sdots">${dots}</div>
    </div>`;
}

// ---------- Progress: month calendar ----------

export function calendarCard() {
  const k = streak();
  if (!k) return "";
  const today = E.parseKey(ctx.todayKey());
  const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday first
  let good = 0, closed = 0;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<span class="cal-cell blank"></span>`);
  for (let d = 1; d <= days; d++) {
    const key = E.dateKey(new Date(first.getFullYear(), first.getMonth(), d));
    const x = k.days[key] || { status: key > ctx.todayKey() ? "future" : "none" };
    if (x.status === "success") good++;
    if (["success", "shielded", "missed"].includes(x.status)) closed++;
    const cls = x.status === "missed" ? `missed ${x.reason}` : x.status;
    const tip = x.calories != null && x.status !== "none" ? `${fmt(x.calories)} / ${fmt(x.budget)} kcal` : "";
    cells.push(`<button class="cal-cell ${cls}${key === ctx.todayKey() ? " today" : ""}" ${x.status === "future" ? "disabled" : `data-action="s-open-day" data-date="${key}"`} aria-label="${E.fmtDay(E.parseKey(key))} ${x.status} ${tip}"><b>${d}</b>${x.status === "success" ? "<i>✓</i>" : x.status === "shielded" ? "<i>🛡</i>" : ""}</button>`);
  }
  const title = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return `
    <div class="card">
      <div class="list-title-row"><h3>🔥 Streak ${k.current} · best ${k.best}</h3><span class="small muted">${k.shields ? `🛡×${k.shields} banked` : k.toNextShield ? `shield in ${k.toNextShield} days` : ""}</span></div>
      <div class="cal-nav"><button class="btn small ghost" data-action="s-month" data-delta="-1" aria-label="Previous month">‹</button><b>${title}</b><button class="btn small ghost" data-action="s-month" data-delta="1" ${monthOffset >= 0 ? "disabled" : ""} aria-label="Next month">›</button></div>
      <div class="cal-grid">${["M", "T", "W", "T", "F", "S", "S"].map((w) => `<span class="cal-wd">${w}</span>`).join("")}${cells.join("")}</div>
      <div class="cal-legend small muted"><span><i class="lg success"></i>on budget</span><span><i class="lg shielded"></i>shield used</span><span><i class="lg missed"></i>over</span><span><i class="lg unlogged"></i>not logged</span></div>
      <div class="small muted mt8">${closed ? `${good} of ${closed} days on budget this month.` : "Close out a day on budget to start the calendar."} Within 50 kcal still counts. Every 7 good days earns a 🛡 (up to 2) that saves the streak on an off day.</div>
    </div>`;
}

// ---------- celebration ----------

const MILESTONE_TITLE = { 3: "Three in a row", 7: "One full week!", 14: "Two weeks strong", 21: "Three weeks — it's a habit", 30: "A whole month!", 50: "Fifty days", 75: "Seventy-five days", 100: "Triple digits!", 150: "150 days", 200: "200 days", 365: "One year!" };

/** After render: celebrate (or calmly note) the most recent day that closed since last time. */
export function maybeCelebrate() {
  const s = st();
  if (!s.profile || document.querySelector("#celebrate")) return;
  if (s.recovery?.enabled) return; // recovery celebrates behaviors, from recovery.js — never calorie days
  const k = streak();
  if (!k) return;
  const today = ctx.todayKey();
  const oldest = E.dateKey(E.addDays(E.parseKey(today), -2)); // never replay old history
  const seen = s.celebratedThrough || "";
  const closedKeys = Object.keys(k.days).filter((d) => ["success", "shielded", "missed"].includes(k.days[d].status) && d > seen && d >= oldest).sort();
  if (!closedKeys.length) return;
  const key = closedKeys[closedKeys.length - 1];
  s.celebratedThrough = key;
  ctx.save();
  const x = k.days[key];
  if (x.status === "missed" && x.reason === "unlogged") return; // nothing to celebrate, nothing to scold
  show(key, x, k);
}

function show(key, x, k) {
  const d = E.parseKey(key);
  const isToday = key === ctx.todayKey();
  const when = isToday ? "Today" : key === E.dateKey(E.addDays(E.parseKey(ctx.todayKey()), -1)) ? "Yesterday" : E.fmtDay(d);
  const success = x.status === "success";
  const shielded = x.status === "shielded";
  const milestone = success && E.STREAK_MILESTONES.includes(x.streak) ? MILESTONE_TITLE[x.streak] : null;
  const maint = E.tdee(st().profile);
  const banked = success ? Math.max(0, maint - x.calories) : 0;
  const week = [...Array(7)].map((_, i) => E.dateKey(E.addDays(d, i - 6)));
  const dots = week.map((w, i) => {
    const y = k.days[w] || { status: "none" };
    return `<span class="cdot ${y.status === "missed" ? "missed" : y.status}" style="--i:${i}">${y.status === "success" ? "✓" : y.status === "shielded" ? "🛡" : ""}</span>`;
  }).join("");
  const el = document.createElement("div");
  el.id = "celebrate";
  el.className = success ? "win" : shielded ? "shield" : "calm";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", success ? `${when} passed — streak ${x.streak}` : `${when} summary`);
  el.innerHTML = `
    <div class="cel-card">
      ${success && !reduceMotion() ? `<div class="confetti">${confetti(milestone ? 90 : 48)}</div>` : ""}
      <div class="cal-page">
        <div class="cal-page-top">${d.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</div>
        <div class="cal-page-day">${d.getDate()}</div>
        <div class="cal-page-wd">${d.toLocaleDateString("en-US", { weekday: "long" })}</div>
        ${success ? `<div class="stamp">✓</div>` : shielded ? `<div class="stamp shield">🛡</div>` : ""}
      </div>
      ${success ? `
        <div class="cel-title">${milestone ? `🏆 ${milestone}` : `${when} passed`}</div>
        <div class="cel-streak">🔥 <b data-count-to="${x.streak}">${Math.max(0, x.streak - 1)}</b>-day streak</div>
        <div class="cel-line">${fmt(x.calories)} / ${fmt(x.budget)} kcal${banked ? ` · banked ≈ ${(banked / E.KCAL_PER_LB).toFixed(2)} lb of fat loss` : ""}</div>
        ${x.earned ? `<div class="cel-line">🛡 You earned a shield — it'll save your streak on an off day.</div>` : ""}`
      : shielded ? `
        <div class="cel-title">Streak saved</div>
        <div class="cel-streak">🔥 <b>${x.streak}</b> days — a 🛡 shield covered ${when.toLowerCase()}</div>
        <div class="cel-line">${x.reason === "over" ? `${fmt(x.calories - x.budget)} over is in your payback plan.` : "Nothing was logged — the shield covered it."} Back at it.</div>`
      : `
        <div class="cel-title">Fresh tile today</div>
        <div class="cel-line">${when} ran ${fmt(Math.max(0, x.calories - x.budget))} over. It's already in your payback plan, so the week still works. One day doesn't undo the trend — the next good day starts a new streak.</div>`}
      ${success || shielded ? `<div class="cel-week">${dots}</div>` : `<div style="height:14px"></div>`}
      <button class="btn primary" data-action="s-dismiss" style="width:100%">${success ? "Keep going" : "Got it"}</button>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  if (success) {
    navigator.vibrate?.(milestone ? [30, 60, 30, 60, 80] : [25, 50, 25]);
    const counter = el.querySelector("[data-count-to]");
    if (counter) setTimeout(() => { counter.textContent = counter.dataset.countTo; counter.classList.add("bump"); }, reduceMotion() ? 0 : 650);
  }
}

function confetti(n) {
  const colors = ["#2a78d6", "#1baf7a", "#fab219", "#e87ba4", "#ec835a", "#3987e5"];
  return [...Array(n)].map((_, i) => {
    const x = Math.round((Math.random() * 2 - 1) * 170), y = Math.round(-120 - Math.random() * 220);
    const r = Math.round(Math.random() * 720 - 360), dl = (Math.random() * 0.18).toFixed(2), sz = 5 + Math.round(Math.random() * 6);
    return `<i style="--x:${x}px;--y:${y}px;--r:${r}deg;--d:${dl}s;--s:${sz}px;background:${colors[i % colors.length]}"></i>`;
  }).join("");
}

/**
 * A generic "moment" with the same calendar-page visuals, for recovery: celebrate behaviors
 * (rode out an urge, checked in, binge-free day) or note a hard day calmly.
 * opts: { kind: "win"|"calm", date?, title, big?, lines?: [], button? }
 */
export function celebrate({ kind = "win", date = null, title, big = "", lines = [], button = "Keep going" }) {
  if (document.querySelector("#celebrate")) return;
  const d = date ? E.parseKey(date) : new Date();
  const win = kind === "win";
  const el = document.createElement("div");
  el.id = "celebrate";
  el.className = win ? "win" : "calm";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", title);
  el.innerHTML = `
    <div class="cel-card">
      ${win && !reduceMotion() ? `<div class="confetti">${confetti(48)}</div>` : ""}
      <div class="cal-page">
        <div class="cal-page-top">${d.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</div>
        <div class="cal-page-day">${d.getDate()}</div>
        <div class="cal-page-wd">${d.toLocaleDateString("en-US", { weekday: "long" })}</div>
        ${win ? `<div class="stamp">✓</div>` : ""}
      </div>
      <div class="cel-title">${title}</div>
      ${big ? `<div class="cel-streak">${big}</div>` : ""}
      ${lines.map((l) => `<div class="cel-line">${l}</div>`).join("")}
      <div style="height:14px"></div>
      <button class="btn primary" data-action="s-dismiss" style="width:100%">${button}</button>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  if (win) navigator.vibrate?.([25, 50, 25]);
}

function dismiss() {
  const el = $("#celebrate");
  if (!el) return;
  el.classList.remove("show");
  setTimeout(() => el.remove(), 250);
}

// ---------- actions ----------

export function handleStreak(el) {
  const a = el.dataset.action;
  if (!a?.startsWith("s-")) return false;
  const s = st();
  const today = ctx.todayKey();
  switch (a) {
    case "s-dismiss": dismiss(); return true;
    case "s-month": monthOffset = Math.min(0, monthOffset + +el.dataset.delta); ctx.renderProgress(); return true;
    case "s-open-day": dismiss(); ctx.openDayInToday(el.dataset.date); return true;
    case "s-close": {
      const day = s.foodLog?.[today];
      if (!day?.entries?.length) return true;
      day.closed = true;
      E.settleCountDays(s, today);
      ctx.save(); ctx.renderAll();
      return true; // renderAll → maybeCelebrate shows today's result right away
    }
    case "s-reopen": {
      E.unsettleDay(s, today);
      if (s.celebratedThrough === today) s.celebratedThrough = E.dateKey(E.addDays(E.parseKey(today), -1));
      ctx.save(); ctx.renderAll();
      ctx.toast("Today reopened — log away");
      return true;
    }
  }
  return false;
}

/** Click on the dim backdrop closes the celebration too. */
export function handleBackdrop(target) {
  if (target?.id === "celebrate") { dismiss(); return true; }
  return false;
}
