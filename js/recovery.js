/* recovery.js — the binge eating recovery program, designed to be calm and quick.
   One screen: today's eating timeline, two buttons (Log / Urge), and at most one card that
   matters right now (support, last night's reflection, tonight's plan, evening check-in,
   weekly check-in). Rules live in engine.js; this file only draws and records. Data stays
   in the on-phone state record (state.recovery) and is never sent anywhere. */

import * as E from "./engine.js";
import * as S from "./streak.js";

let ctx = null;
let urge = null;            // { started, timer } while the urge tool is open
let draft = {};             // in-progress sheet answers

const st = () => ctx.state();
const R = () => st().recovery;
const esc = (s) => ctx.esc(s);
const $ = (q) => document.querySelector(q);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today = () => ctx.todayKey();
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const time12 = (t) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`; };
const yesterday = () => E.dateKey(E.addDays(E.parseKey(today()), -1));

export const RESOURCES = [
  { label: "National Alliance for Eating Disorders helpline", sub: "Free, weekdays · also runs free weekly therapist-led support groups", tel: "8666621235", shown: "866-662-1235" },
  { label: "Dr. Eleni Marcantonis, PsyD (CBT, in-network)", sub: "Book a consult", tel: "2127243530", shown: "212-724-3530" },
  { label: "Your employer's EAP", sub: "Free confidential sessions — ask them to guide you through this program", tel: null, shown: "Number on your benefits site" },
  { label: "988 Suicide & Crisis Lifeline", sub: "Call or text, any time, if things feel unsafe", tel: "988", shown: "988" },
];

const CONTEXTS = ["Hungry", "Bored", "Stressed", "Tired", "Lonely", "Anxious", "Social", "Celebrating", "After drinks", "Delivery app"];
const HELPS = ["Plan dinner ahead", "Afternoon snack on time", "Text Alan", "No delivery apps tonight", "Leave the house", "Gym earlier", "Eat my planned treat", "Go to bed earlier"];
const TREATS = ["Ice cream bar", "Chocolate", "Cookies", "Something from CVS — one item", "Slice of pizza", "Popcorn"];
const DINNERS = ["Pasta night (planned portion)", "Pizza night (planned)", "Chipotle bowl", "Turkey wrap", "Quesadilla", "Fuel meal"];
const EVENINGS = ["Gym at 8", "Walk after dinner", "Plans with friends", "Home + a show", "Call someone"];

export function initRecovery(context) { ctx = context; }
export const active = () => !!st()?.recovery?.enabled;

// ---------- Today ----------

export function renderToday(el) {
  const r = R();
  const key = today();
  E.evaluateStage(st(), key);
  const day = st().foodLog?.[key];
  const tl = E.scheduleStatus(r.schedule, day?.entries || [], nowMin(), true);
  const next = tl.find((x) => x.status === "now") || tl.find((x) => x.status === "next");
  const allDone = tl.every((x) => x.status === "done");
  const week = E.recoveryWeek(st(), E.dateKey(E.weekStart(new Date())), key);
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const stage2 = r.stage === 2;
  const avg = stage2 ? E.weekAverageIntake(st(), key) : null;
  const target = stage2 ? E.recoveryTarget(st()) : null;
  el.innerHTML = `
    <div class="list-title-row"><div class="screen-title">Today</div>
      <button class="btn small ghost" data-action="open-settings" aria-label="Settings">⚙️</button></div>
    <div class="screen-sub">${dateStr}</div>
    ${contextCard()}
    <div class="card rec-hero">
      <div class="list-title-row"><h3>Your eating today</h3><button class="link small" data-action="r-sheet-schedule">edit times</button></div>
      <div class="timeline">${tl.map((x) => `
        <button class="tl-node ${x.status}" data-action="r-log-slot" data-slot="${x.id}" aria-label="${x.label} at ${time12(x.time)}: ${x.status}">
          <span class="tl-dot">${x.status === "done" ? "✓" : ""}</span>
          <b>${time12(x.time)}</b><i>${esc(x.label)}</i>
        </button>`).join("")}</div>
      <div class="rec-next">${allDone ? "Everything on plan today ✓ Nice and steady."
        : next ? `${next.status === "now" ? "Now" : "Next"}: <b>${esc(next.label)}</b> around ${time12(next.time)} — anything you like.`
        : "Missed one? No making up — just eat at the next time."}</div>
      <div class="rec-actions">
        <button class="btn primary big" data-action="r-log">＋ Log what I ate</button>
        <button class="btn big urge" data-action="r-urge">🌊 I have an urge</button>
      </div>
    </div>
    <div class="card rec-week" data-action="go-progress" role="button">
      <div class="list-title-row"><h3>This week</h3><span class="small muted">${stage2 ? "Stage 2 · gentle deficit" : "Stage 1 · eat regularly"} ›</span></div>
      <div class="sdots">${week.days.map((d) => {
        const lbl = E.parseKey(d.key).toLocaleDateString("en-US", { weekday: "narrow" });
        const cls = d.future ? "none" : d.binges ? "binge" : d.checkin || d.logged ? "good" : d.key === key ? "open" : "none";
        return `<span class="sdot r-${cls}"><span>${cls === "good" ? "✓" : ""}</span><i>${lbl}</i></span>`;
      }).join("")}</div>
      <div class="small muted mt8">${week.days.filter((d) => !d.future && !d.binges && (d.checkin || d.logged)).length} binge-free day${week.days.filter((d) => !d.future && !d.binges && (d.checkin || d.logged)).length === 1 ? "" : "s"}${week.ridden ? ` · ${week.ridden} urge${week.ridden === 1 ? "" : "s"} ridden out` : ""}${avg ? ` · avg ${fmt(avg)} / ~${fmt(target)} kcal` : ""}</div>
    </div>`;
}

/** The cards that matter right now, most important first — at most two, so it never piles up. */
function contextCard() {
  const r = R(), key = today(), h = new Date().getHours();
  const cards = [];
  const flags = E.recoveryFlags(st(), key);
  if (flags.length && r.flagSeen !== key) {
    const f = flags[0];
    const msg = f.type === "compensation" ? "You mentioned making up for eating this week (skipping meals, extra exercise, or purging). That's the part of the cycle a professional can help with fastest — please reach out this week."
      : f.type === "mood" ? "Your mood has been low most days this week. You deserve support with that, not just with food."
      : `It's been 4+ weeks and binges are about ${f.recentPerWeek.toFixed(1)}/week (you started around ${f.base}/week). That's the point where adding a person is recommended — it's how this works best, not a failure.`;
    cards.push(`<div class="card r-card support"><h3>💙 Let's add a human</h3><div class="small mt8">${msg}</div>
      <div class="btn-row"><button class="btn primary" data-action="r-support">See options</button><button class="btn ghost" data-action="r-flag-later">Later</button></div></div>`);
  }
  if (E.bingesOn(st(), yesterday()) && !r.reflections[yesterday()] && h < 18) {
    cards.push(`<div class="card r-card"><h3>Last night</h3><div class="small mt8">It happened, and you logged it — that's the program working. Two taps to learn from it, then breakfast as usual. <b>No making up today.</b></div>
      <div class="btn-row"><button class="btn primary" data-action="r-sheet-reflect">Two taps</button><button class="btn ghost" data-action="r-skip-reflect">Skip</button></div></div>`);
  }
  const allPassed = E.scheduleStatus(r.schedule, st().foodLog?.[key]?.entries || [], nowMin()).every((x) => x.status === "done" || x.status === "missed");
  if (!r.checkins[key] && (h >= 20 || allPassed)) {
    cards.push(`<div class="card r-card"><h3>🌙 Evening check-in</h3><div class="small mt8">4 taps, 30 seconds.</div>
      <div class="btn-row"><button class="btn primary" data-action="r-sheet-checkin">Check in</button></div></div>`);
  }
  const risk = E.riskPlanFor(st());
  if (risk && !r.plans[risk.key]) {
    const d = E.parseKey(risk.key).toLocaleDateString("en-US", { weekday: "long" });
    cards.push(`<div class="card r-card plan"><h3>📋 Plan ${risk.when === "today" ? "tonight" : `${d} evening`}</h3><div class="small mt8">${d}s have been tricky. A 1-minute plan now makes ${risk.when === "today" ? "tonight" : "it"} much easier.</div>
      <div class="btn-row"><button class="btn primary" data-action="r-sheet-plan" data-date="${risk.key}">Make the plan</button></div></div>`);
  } else if (risk?.when === "today" && r.plans[key] && !r.checkins[key]) {
    const p = r.plans[key];
    cards.push(`<div class="card r-card plan"><h3>Tonight's plan</h3>
      <div class="plan-lines">${p.dinner ? `<span>🍽 ${esc(p.dinner)}</span>` : ""}${p.treat ? `<span>🍫 ${esc(p.treat)}</span>` : ""}${p.evening ? `<span>🌙 ${esc(p.evening)}</span>` : ""}${(p.ifUrge || []).length ? `<span>🌊 ${esc(p.ifUrge.join(" · "))}</span>` : ""}${p.noDelivery ? "<span>📵 No delivery apps tonight</span>" : ""}</div>
      <div class="btn-row"><button class="btn ghost" data-action="r-sheet-plan" data-date="${key}">Edit</button>${r.contact ? `<a class="btn ghost" href="${smsHref(r.contact, "Hey, tonight's one of my tricky ones — can I text you later if I need to?")}">Text ${esc(r.contact.name)}</a>` : ""}</div></div>`);
  }
  const weekKey = E.dateKey(E.weekStart(new Date()));
  if (new Date().getDay() === (r.weighDay ?? 0) && !Object.keys(r.weekly).some((k) => k >= weekKey)) {
    cards.push(`<div class="card r-card"><h3>🗓 Weekly check-in</h3><div class="small mt8">Weigh-in + 7 quick questions + your week at a glance. About 2 minutes.</div>
      <div class="btn-row"><button class="btn primary" data-action="r-sheet-weekly">Start</button></div></div>`);
  }
  return cards.slice(0, 2).join("");
}

const smsHref = (c, body) => `sms:${c.phone || ""}?&body=${encodeURIComponent(body)}`;

// ---------- urge tool ----------

function sheetUrge() {
  const r = R();
  if (!urge) urge = { started: Date.now(), id: uid() };
  ctx.openSheet(`
    <div class="urge-wrap">
      <h3>🌊 Ride it out</h3>
      <div class="sub">Urges rise, peak and fall — usually within 20 minutes. You don't have to act on it. Breathe with the circle.</div>
      <div class="breath"><div class="breath-ring"></div><div class="breath-text" id="urge-left">20:00</div></div>
      <div class="ob-section">Pick one to do now</div>
      <div class="chips wrap">${(r.alternatives || []).map((a) => `<button class="chip" data-action="r-alt" data-alt="${esc(a)}">${esc(a)}</button>`).join("")}</div>
      ${r.contact ? `<a class="btn" style="width:100%;margin-top:6px" href="${smsHref(r.contact, "Having a rough moment with food, can you talk for a few min?")}">💬 Text ${esc(r.contact.name)}</a>` : ""}
      <button class="btn ghost" style="width:100%;margin-top:8px" data-action="r-log-slot" data-slot="${nextSlot()?.id || ""}">🍽 Eat my planned ${esc((nextSlot()?.label || "snack").toLowerCase())} instead</button>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" data-action="r-urge-end" data-outcome="passed">It passed 🎉</button>
        <button class="btn ghost" data-action="r-urge-end" data-outcome="binge">It happened</button>
      </div>
      <div class="small muted mt8" style="text-align:center"><button class="link small" data-action="r-support">I'm struggling — get support</button></div>
    </div>`);
  tickUrge();
}

function nextSlot() {
  const tl = E.scheduleStatus(R().schedule, st().foodLog?.[today()]?.entries || [], nowMin());
  return tl.find((x) => x.status === "now") || tl.find((x) => x.status === "next") || tl.find((x) => x.status !== "done");
}

function tickUrge() {
  clearInterval(urge?.timer);
  if (!urge) return;
  const draw = () => {
    const el = $("#urge-left");
    if (!el) { clearInterval(urge?.timer); return; }
    const left = Math.max(0, 20 * 60 - Math.floor((Date.now() - urge.started) / 1000));
    el.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "You made it";
  };
  draw();
  urge.timer = setInterval(draw, 1000);
}

function endUrge(outcome) {
  const r = R();
  r.urges.push({ id: urge?.id || uid(), date: today(), at: new Date().toISOString(), outcome, minutes: urge ? Math.round((Date.now() - urge.started) / 60000) : 0 });
  clearInterval(urge?.timer); urge = null;
  ctx.save(); ctx.closeSheet(); ctx.renderAll();
  if (outcome === "passed") {
    const month = r.urges.filter((u) => u.outcome === "passed" && u.date.slice(0, 7) === today().slice(0, 7)).length;
    S.celebrate({ kind: "win", title: "You rode it out", big: `🌊 <b>${month}</b> urge${month === 1 ? "" : "s"} ridden out this month`, lines: ["That's the skill that ends binges. It gets easier every time."], button: "Back to my day" });
  } else {
    ctx.openSheet(`
      <h3>Thank you for logging it</h3>
      <div class="sub">This is data, not failure. Most people in recovery have slips — what matters is what happens next.</div>
      <div class="trim-note">Next: eat your <b>${esc((nextSlot()?.label || "next meal").toLowerCase())}</b> at its normal time. No skipping, no making up, no extra workout. That's how the cycle breaks.</div>
      <div class="btn-row"><button class="btn primary" data-action="r-log-binge">Log what I ate (optional)</button></div>
      <div class="btn-row"><button class="btn ghost" data-action="close-sheet">Done</button></div>`);
  }
}

// ---------- evening check-in ----------

function sheetCheckin() {
  const key = today();
  const c = R().checkins[key] || {};
  draft = { schedule: c.schedule || null, binge: c.binge ?? (E.bingesOn(st(), key) > 0), urges: c.urges || null, mood: c.mood || null };
  ctx.openSheet(checkinHTML());
}

function checkinHTML() {
  const seg = (field, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${draft[field] === v ? "on" : ""}" data-action="r-ci" data-f="${field}" data-v="${v}" aria-pressed="${draft[field] === v}">${l}</button>`).join("")}</div>`;
  return `
    <h3>🌙 Evening check-in</h3>
    <div class="sub">Four taps. Honest beats perfect.</div>
    <div class="ci-q">Ate roughly on schedule?</div>${seg("schedule", [["yes", "Yes"], ["mostly", "Mostly"], ["no", "Not really"]])}
    <div class="ci-q">Any binge today?</div>${seg("binge", [[false, "No"], [true, "Yes"]])}
    <div class="ci-q">Urges?</div>${seg("urges", [["none", "None"], ["mild", "Mild"], ["strong", "Strong"]])}
    <div class="ci-q">Mood?</div>${seg("mood", [[1, "😣"], [2, "🙁"], [3, "😐"], [4, "🙂"], [5, "😄"]])}
    <button class="btn primary mt16" style="width:100%" data-action="r-ci-save" ${draft.schedule && draft.urges && draft.mood ? "" : "disabled"}>Done</button>`;
}

function saveCheckin() {
  const r = R(), key = today();
  r.checkins[key] = { ...draft, at: new Date().toISOString() };
  ctx.save(); ctx.closeSheet(); ctx.renderAll();
  const month = Object.keys(r.checkins).filter((k) => k.slice(0, 7) === key.slice(0, 7) && !E.bingesOn(st(), k)).length;
  const sched = Object.entries(r.checkins).filter(([k, c]) => k.slice(0, 7) === key.slice(0, 7) && c.schedule === "yes").length;
  if (!draft.binge) {
    S.celebrate({ kind: "win", date: key, title: "Day done", big: `💙 <b>${month}</b> binge-free day${month === 1 ? "" : "s"} this month`, lines: [`${sched} day${sched === 1 ? "" : "s"} on your eating schedule · these counts never reset`], button: "Good night" });
  } else {
    S.celebrate({ kind: "calm", date: key, title: "Checked in", lines: ["Logging a hard day honestly is the hardest part — you did it.", `Tomorrow: breakfast around ${time12(r.schedule[0].time)}, like any other day.`], button: "Good night" });
  }
}

// ---------- plan for a risky evening ----------

function sheetPlan(key) {
  const r = R();
  const p = r.plans[key] || {};
  draft = { key, dinner: p.dinner || "", treat: p.treat || "", evening: p.evening || "", ifUrge: p.ifUrge || r.alternatives.slice(0, 3), noDelivery: p.noDelivery ?? true };
  ctx.openSheet(planHTML());
}

function planHTML() {
  const d = E.parseKey(draft.key).toLocaleDateString("en-US", { weekday: "long" });
  const pick = (field, opts) => `<div class="chips wrap">${opts.map((o) => `<button class="chip ${draft[field] === o ? "on" : ""}" data-action="r-plan-pick" data-f="${field}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
  return `
    <h3>📋 ${d} evening plan</h3>
    <div class="sub">Decide now, while it's easy. A planned treat is part of the plan — it takes the "now or never" out of tonight.</div>
    <div class="ci-q">Dinner</div>${pick("dinner", DINNERS)}
    <div class="ci-q">Evening treat (planned, normal portion)</div>${pick("treat", TREATS)}
    <div class="ci-q">The evening</div>${pick("evening", EVENINGS)}
    <div class="ci-q">If an urge hits, I'll…</div>
    <div class="chips wrap">${R().alternatives.map((a) => `<button class="chip ${draft.ifUrge.includes(a) ? "on" : ""}" data-action="r-plan-alt" data-v="${esc(a)}">${esc(a)}</button>`).join("")}</div>
    <label class="ti-remember"><input type="checkbox" id="plan-nodelivery" ${draft.noDelivery ? "checked" : ""} /> No delivery apps tonight (log out now)</label>
    <button class="btn primary mt16" style="width:100%" data-action="r-plan-save">Save my plan</button>`;
}

// ---------- reflection after a binge ----------

function sheetReflect() {
  draft = { before: [], help: [] };
  ctx.openSheet(reflectHTML());
}

function reflectHTML() {
  const chips = (field, opts) => `<div class="chips wrap">${opts.map((o) => `<button class="chip ${draft[field].includes(o) ? "on" : ""}" data-action="r-ref-pick" data-f="${field}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
  return `
    <h3>Learning from last night</h3>
    <div class="sub">No judgment — just patterns. Tap any that fit.</div>
    <div class="ci-q">What was going on before?</div>${chips("before", [...CONTEXTS, "Skipped a meal", "Long gap without eating"])}
    <div class="ci-q">What might help next time?</div>${chips("help", HELPS)}
    <button class="btn primary mt16" style="width:100%" data-action="r-ref-save">Save</button>
    <div class="small muted mt8">Then breakfast as usual. Skipping it would set up the next one.</div>`;
}

// ---------- weekly check-in ----------

// Fuel's own weekly questions (not a validated questionnaire). Covers loss of control,
// restriction, making up for eating, preoccupation and body worry; lower is better.
const WEEKLY_QS = [
  ["loc", "felt you'd lost control over your eating"],
  ["gap", "gone 6+ waking hours without eating"],
  ["restrict", "deliberately eaten less to change your weight or shape"],
  ["compensate", "skipped meals or exercised extra to make up for eating"],
  ["preocc", "found thinking about food or weight made it hard to focus"],
  ["body", "felt bad about your body"],
];
const DAYS_OPTS = [[0, "0 days"], [1, "1–2"], [2, "3–5"], [3, "6–7"]];

function sheetWeekly(step = 0) {
  if (step === 0) draft = { step: 0, weight: "", answers: {}, purge: null };
  draft.step = step;
  const r = R();
  // the week that's ending (Mon–today) vs the one before it
  const lastWeek = E.recoveryWeek(st(), E.dateKey(E.weekStart(new Date())), today());
  const prevWeek = E.recoveryWeek(st(), E.dateKey(E.addDays(E.weekStart(new Date()), -7)), today());
  let body = "";
  if (step === 0) {
    body = `<div class="ci-q">This morning's weight (optional)</div>
      <div class="field"><input id="wk-weight" type="number" inputmode="decimal" placeholder="lb" value="${esc(draft.weight)}" /></div>
      <div class="small muted">Once a week is all the program uses — day-to-day numbers swing with water and salt and mislead.</div>
      <button class="btn primary mt16" style="width:100%" data-action="r-wk-next" data-step="1">Next</button>`;
  } else if (step === 1) {
    body = `<div class="sub">Over the past 7 days, on how many days have you…</div>
      ${WEEKLY_QS.map(([id, q]) => `<div class="ci-q">…${q}?</div><div class="seg">${DAYS_OPTS.map(([v, l]) => `<button class="${draft.answers[id] === v ? "on" : ""}" data-action="r-wk-a" data-q="${id}" data-v="${v}">${l}</button>`).join("")}</div>`).join("")}
      <div class="ci-q">Made yourself sick or used laxatives to control weight?</div>
      <div class="seg">${[[0, "No"], [1, "Yes"]].map(([v, l]) => `<button class="${draft.purge === v ? "on" : ""}" data-action="r-wk-p" data-v="${v}">${l}</button>`).join("")}</div>
      <button class="btn primary mt16" style="width:100%" data-action="r-wk-next" data-step="2" ${WEEKLY_QS.every(([id]) => draft.answers[id] != null) && draft.purge != null ? "" : "disabled"}>Next</button>`;
  } else {
    const d = lastWeek.bingeDays - prevWeek.bingeDays;
    body = `<div class="wk-sum">
        <div><b>${lastWeek.bingeDays}</b><span>binge days</span><i class="${d < 0 ? "good" : ""}">${prevWeek.checkins || prevWeek.bingeDays ? (d === 0 ? "same as before" : d < 0 ? `${-d} fewer` : `${d} more`) : ""}</i></div>
        <div><b>${lastWeek.ridden}</b><span>urges ridden out</span></div>
        <div><b>${lastWeek.onSchedule}</b><span>days on schedule</span></div>
      </div>
      <div class="ci-q">One focus for this week</div>
      <div class="chips wrap">${["Eat breakfast every day", "Afternoon snack on time", "Plan every tricky evening", "Use the urge button once", "Log in the moment", "Keep the evening treat"].map((g) => `<button class="chip ${draft.goal === g ? "on" : ""}" data-action="r-wk-goal" data-v="${esc(g)}">${esc(g)}</button>`).join("")}</div>
      <button class="btn primary mt16" style="width:100%" data-action="r-wk-save">Finish</button>`;
  }
  ctx.openSheet(`<h3>🗓 Weekly check-in</h3><div class="wk-steps">${[0, 1, 2].map((i) => `<i class="${i <= step ? "on" : ""}"></i>`).join("")}</div>${body}`);
}

function saveWeekly() {
  const r = R(), key = today();
  const score = WEEKLY_QS.reduce((n, [id]) => n + (draft.answers[id] || 0), 0);
  r.weekly[key] = { ...draft.answers, purge: draft.purge, score, goal: draft.goal || "", at: new Date().toISOString() };
  const w = parseFloat(draft.weight);
  if (w > 50 && w < 700) {
    const s = st();
    s.weighIns = s.weighIns.filter((x) => x.date !== key);
    s.weighIns.push({ date: key, lb: w });
    s.profile.weightLb = w;
  }
  ctx.save(); ctx.closeSheet(); ctx.renderAll();
  if (draft.purge || draft.answers.compensate > 0) sheetSupport("You mentioned making up for eating or purging this week. That part of the cycle is exactly what a professional can help with — please reach out this week.");
  else S.celebrate({ kind: "win", title: "Week reviewed", big: draft.goal ? `🎯 ${esc(draft.goal)}` : "🗓 Done", lines: ["Small, steady changes are how this works."], button: "Got it" });
}

// ---------- schedule, setup, support ----------

function sheetSchedule() {
  const r = R();
  ctx.openSheet(`
    <h3>Your eating times</h3>
    <div class="sub">Regular eating is the single most powerful step: something every 3–4 hours, so evenings don't start empty.</div>
    ${r.schedule.map((s, i) => `<div class="field-row" style="align-items:center"><div class="field" style="margin:0 0 8px"><input value="${esc(s.label)}" data-sched-label="${i}" aria-label="Name" /></div>
      <div class="field" style="margin:0 0 8px;max-width:130px"><input type="time" value="${s.time}" data-sched-time="${i}" aria-label="${esc(s.label)} time" /></div></div>`).join("")}
    <button class="btn primary mt8" style="width:100%" data-action="r-sched-save">Save</button>
    <button class="btn ghost mt8" style="width:100%" data-action="r-ics">📅 Add these as phone calendar reminders</button>`);
}

export function sheetSetup() {
  draft = { wake: "09:00", dinner: "19:00", riskDays: [4, 5, 0], contact: "Alan", phone: "", baseline: 2 };
  ctx.openSheet(setupHTML());
}

function setupHTML() {
  const sch = E.defaultSchedule({ wake: draft.wake, dinner: draft.dinner });
  const days = [[1, "M"], [2, "T"], [3, "W"], [4, "Th"], [5, "F"], [6, "Sa"], [0, "Su"]];
  return `
    <h3>💙 Start your recovery plan</h3>
    <div class="sub">Fuel switches from counting to recovery: regular meals, tools for tricky evenings, short check-ins. No calorie countdown, nothing to "make up." Weight loss comes back later, gently, once binges settle.</div>
    <div class="field-row">
      <div class="field"><label for="su-wake">I wake up around</label><input id="su-wake" type="time" value="${draft.wake}" /></div>
      <div class="field"><label for="su-dinner">Dinner around</label><input id="su-dinner" type="time" value="${draft.dinner}" /></div>
    </div>
    <div class="small muted" style="margin:-6px 0 6px">Your eating times: ${sch.map((x) => `${esc(x.label.toLowerCase())} ${time12(x.time)}`).join(" · ")}</div>
    <div class="ci-q">Tricky days</div>
    <div class="seg">${days.map(([v, l]) => `<button class="${draft.riskDays.includes(v) ? "on" : ""}" data-action="r-su-day" data-v="${v}" aria-pressed="${draft.riskDays.includes(v)}">${l}</button>`).join("")}</div>
    <div class="field-row">
      <div class="field"><label for="su-contact">Someone to text</label><input id="su-contact" value="${esc(draft.contact)}" /></div>
      <div class="field"><label for="su-phone">Their number (optional)</label><input id="su-phone" type="tel" inputmode="tel" value="${esc(draft.phone)}" /></div>
    </div>
    <div class="ci-q">Binges in a typical week lately</div>
    <div class="seg">${[1, 2, 3, 4].map((n) => `<button class="${draft.baseline === n ? "on" : ""}" data-action="r-su-base" data-v="${n}">${n}${n === 4 ? "+" : ""}</button>`).join("")}</div>
    <button class="btn primary mt16" style="width:100%" data-action="r-start">Start</button>
    <div class="small muted mt8">Everything stays on this phone. You can turn this off any time in Settings.</div>`;
}

function readSetup() {
  draft.wake = $("#su-wake")?.value || draft.wake; draft.dinner = $("#su-dinner")?.value || draft.dinner;
  draft.contact = $("#su-contact")?.value.trim() ?? draft.contact; draft.phone = $("#su-phone")?.value.trim() ?? draft.phone;
}

export function sheetSupport(note = "") {
  ctx.openSheet(`
    <h3>💙 Support</h3>
    <div class="sub">${note || "An app can carry the structure. People carry the rest — and the best results in the research came with a person involved."}</div>
    ${RESOURCES.map((x) => `<div class="option-row"><div class="o-main"><div class="o-name">${esc(x.label)}</div><div class="o-sub">${esc(x.sub)}</div></div>
      ${x.tel ? `<a class="btn small" href="tel:${x.tel}">${esc(x.shown)}</a>` : `<span class="small muted">${esc(x.shown)}</span>`}</div>`).join("")}
    ${R()?.contact ? `<a class="btn mt16" style="width:100%" href="${smsHref(R().contact, "Hey, having a hard time with food lately — free to talk?")}">💬 Text ${esc(R().contact.name)}</a>` : ""}
    <div class="small muted mt16">Medication (lisdexamfetamine) is FDA-approved for binge eating disorder — worth asking a doctor about if self-help isn't enough.</div>`);
}

function downloadIcs() {
  const r = R();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const startDay = E.dateKey(E.addDays(new Date(), 1)).replace(/-/g, "");
  const ev = (uidPart, title, time, rrule, desc) => [
    "BEGIN:VEVENT", `UID:fuel-${uidPart}@fuel`, `DTSTAMP:${stamp}`, `DTSTART:${startDay}T${time.replace(":", "")}00`, "DURATION:PT10M",
    `RRULE:${rrule}`, `SUMMARY:${title}`, `DESCRIPTION:${desc}`, "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT"];
  const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const eve = (r.riskDays || []).map((d) => dayCodes[(d + 6) % 7]).join(",");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fuel//Recovery//EN", "CALSCALE:GREGORIAN",
    ...r.schedule.flatMap((s) => ev(`meal-${s.id}`, `🍽 ${s.label}`, s.time, "FREQ=DAILY", "Regular eating — anything you like.")),
    ...(eve ? ev("plan", "📋 Plan tomorrow evening (1 min in Fuel)", "18:30", `FREQ=WEEKLY;BYDAY=${eve}`, "Open Fuel → Make the plan.") : []),
    ...ev("checkin", "🌙 Fuel evening check-in", "21:45", "FREQ=DAILY", "4 taps in Fuel."),
    ...ev("weekly", "🗓 Fuel weekly check-in", "11:00", `FREQ=WEEKLY;BYDAY=${dayCodes[r.weighDay ?? 0]}`, "Weigh-in + quick questions."),
    "END:VCALENDAR"];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "fuel-reminders.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  ctx.toast("📅 Open the downloaded file to add the reminders to your calendar");
}

// ---------- Progress ----------

export function progressCard() {
  if (!active()) return "";
  const r = R();
  const key = today();
  const weeks = [...Array(8)].map((_, i) => {
    const start = E.dateKey(E.addDays(E.weekStart(new Date()), -7 * (7 - i)));
    return { start, ...E.recoveryWeek(st(), start, key) };
  }).filter((w) => w.start >= E.dateKey(E.weekStart(E.parseKey(r.startedAt))) || w.bingeDays);
  const maxB = Math.max(3, ...weeks.map((w) => w.bingeDays));
  const W = 320, H = 110, bw = 24, gap = weeks.length > 1 ? (W - 30 - weeks.length * bw) / (weeks.length - 1) : 0;
  const bars = weeks.map((w, i) => {
    const x = 30 + i * (bw + gap), h = (w.bingeDays / maxB) * (H - 30);
    return `<rect x="${x}" y="${H - 18 - h}" width="${bw}" height="${Math.max(2, h)}" rx="4" fill="${w.bingeDays ? "var(--serious)" : "var(--good)"}"/>
      <text x="${x + bw / 2}" y="${H - 18 - h - 4}" text-anchor="middle" font-size="10" fill="var(--ink-2)" style="font-variant-numeric:tabular-nums">${w.bingeDays}</text>
      <text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${E.parseKey(w.start).toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}</text>`;
  }).join("");
  const scores = Object.entries(r.weekly).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  const totalRidden = r.urges.filter((u) => u.outcome === "passed").length;
  const days = Math.max(1, Math.round((E.parseKey(key) - E.parseKey(r.startedAt)) / 86400000) + 1);
  return `
    <div class="card">
      <div class="list-title-row"><h3>💙 Recovery</h3><span class="small muted">day ${days} · ${r.stage === 2 ? "stage 2" : "stage 1"}</span></div>
      <div class="small muted" style="margin-bottom:4px">Binge days per week (started around ${r.baselinePerWeek}/week)</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Binge days per week">${bars}</svg>
      <div class="tiles mt8" style="margin-bottom:0">
        <div class="tile"><div class="t-label">Urges ridden out</div><div class="t-value good">${totalRidden}</div><div class="t-sub">since day 1 · never resets</div></div>
        <div class="tile"><div class="t-label">Weekly check</div><div class="t-value">${scores.length ? scores[scores.length - 1][1].score : "—"}<span class="small muted">/18</span></div><div class="t-sub">${scores.length > 1 ? `was ${scores[0][1].score} · lower is better` : "lower is better"}</div></div>
      </div>
      <div class="small muted mt8">${r.stage === 1 ? "Stage 1: eat regularly at maintenance. Stage 2 (a gentle, weekly-average deficit) starts on its own once binges are down to about 1 every 2 weeks for 4 weeks." : "Stage 2: gentle deficit, judged as a weekly average. Two binge days in two weeks automatically eases back to stage 1 — a speed change, not a reset."}</div>
      <div class="btn-row"><button class="btn ghost" data-action="r-support">💙 Support options</button></div>
    </div>`;
}

export function settingsCard() {
  const r = R();
  if (!r?.enabled) return `<div class="card"><h3>💙 Recovery program</h3><div class="small muted mt8">A guided self-help program for binge eating: regular meals, tools for tricky evenings, short check-ins. Pauses the calorie countdown and everything that "makes up" for eating.</div>
    <div class="btn-row"><button class="btn primary" data-action="r-setup">Start recovery plan</button></div></div>`;
  return `<div class="card"><h3>💙 Recovery program</h3>
    <div class="small muted mt8">On since ${E.fmtDay(E.parseKey(r.startedAt))} · stage ${r.stage}. Calorie countdown, payback and walk-it-off are paused.</div>
    <div class="btn-row"><button class="btn" data-action="r-sheet-schedule">Eating times</button><button class="btn" data-action="r-ics">📅 Reminders</button></div>
    <div class="btn-row"><button class="btn ghost" data-action="r-support">Support</button><button class="btn ghost danger" data-action="r-stop">Turn off</button></div></div>`;
}

// ---------- Type it hooks (count.js asks these) ----------

export function logExtrasHTML() {
  if (!active()) return "";
  const d = ctx.typedRecovery?.() || {};
  return `<div class="rec-log-extras">
    <div class="seg" style="margin:8px 0 6px"><button class="${!d.binge ? "on" : ""}" data-action="r-lx-binge" data-v="0">As planned</button><button class="${d.binge ? "on" : ""}" data-action="r-lx-binge" data-v="1">Felt like a binge</button></div>
    <div class="chips wrap">${CONTEXTS.map((c) => `<button class="chip ${(d.context || []).includes(c) ? "on" : ""}" data-action="r-lx-ctx" data-v="${esc(c)}">${esc(c)}</button>`).join("")}</div>
  </div>`;
}

// ---------- actions ----------

export function handleRecovery(el) {
  const a = el.dataset.action;
  if (!a?.startsWith("r-") && a !== "go-progress") return false;
  const s = st();
  switch (a) {
    case "go-progress": ctx.switchTab("progress"); return true;
    case "r-setup": sheetSetup(); return true;
    case "r-su-day": { readSetup(); const v = +el.dataset.v; draft.riskDays = draft.riskDays.includes(v) ? draft.riskDays.filter((x) => x !== v) : [...draft.riskDays, v]; ctx.openSheet(setupHTML()); return true; }
    case "r-su-base": readSetup(); draft.baseline = +el.dataset.v; ctx.openSheet(setupHTML()); return true;
    case "r-start": {
      readSetup();
      const schedule = E.defaultSchedule({ wake: draft.wake, dinner: draft.dinner });
      s.recovery = E.newRecovery({ today: today(), schedule, baseline: draft.baseline, riskDays: draft.riskDays, contact: draft.contact ? { name: draft.contact, phone: draft.phone } : null });
      if (draft.contact) s.recovery.alternatives = s.recovery.alternatives.map((x) => x === "Text Alan" ? `Text ${draft.contact}` : x);
      s.trackMode = "count";
      ctx.save(); ctx.closeSheet(); ctx.renderAll(); ctx.switchTab("today");
      ctx.toast("💙 Recovery plan started — one calm screen, nothing to make up");
      return true;
    }
    case "r-stop": {
      if (!confirm("Turn off the recovery program? Your recovery history stays saved.")) return true;
      s.recovery.enabled = false; ctx.save(); ctx.renderAll(); return true;
    }
    case "r-log": ctx.openType(today(), ""); return true;
    case "r-log-slot": ctx.closeSheet(); ctx.openType(today(), "", { slot: el.dataset.slot || null }); return true;
    case "r-log-binge": ctx.openType(today(), "", { binge: true }); return true;
    case "r-urge": sheetUrge(); return true;
    case "r-alt": el.classList.toggle("on"); return true;
    case "r-urge-end": endUrge(el.dataset.outcome); return true;
    case "r-sheet-checkin": sheetCheckin(); return true;
    case "r-ci": {
      const f = el.dataset.f; let v = el.dataset.v;
      v = f === "mood" ? +v : f === "binge" ? v === "true" : v;
      draft[f] = v; ctx.openSheet(checkinHTML()); return true;
    }
    case "r-ci-save": saveCheckin(); return true;
    case "r-sheet-plan": sheetPlan(el.dataset.date); return true;
    case "r-plan-pick": draft[el.dataset.f] = draft[el.dataset.f] === el.dataset.v ? "" : el.dataset.v; draft.noDelivery = $("#plan-nodelivery")?.checked ?? draft.noDelivery; ctx.openSheet(planHTML()); return true;
    case "r-plan-alt": { const v = el.dataset.v; draft.ifUrge = draft.ifUrge.includes(v) ? draft.ifUrge.filter((x) => x !== v) : [...draft.ifUrge, v]; draft.noDelivery = $("#plan-nodelivery")?.checked ?? draft.noDelivery; ctx.openSheet(planHTML()); return true; }
    case "r-plan-save": {
      draft.noDelivery = $("#plan-nodelivery")?.checked ?? draft.noDelivery;
      R().plans[draft.key] = { dinner: draft.dinner, treat: draft.treat, evening: draft.evening, ifUrge: draft.ifUrge, noDelivery: draft.noDelivery, at: new Date().toISOString() };
      ctx.save(); ctx.closeSheet(); ctx.renderAll(); ctx.toast("📋 Plan saved — it'll be right here tomorrow"); return true;
    }
    case "r-sheet-reflect": sheetReflect(); return true;
    case "r-ref-pick": { const f = el.dataset.f, v = el.dataset.v; draft[f] = draft[f].includes(v) ? draft[f].filter((x) => x !== v) : [...draft[f], v]; ctx.openSheet(reflectHTML()); return true; }
    case "r-ref-save": R().reflections[yesterday()] = { ...draft, at: new Date().toISOString() }; ctx.save(); ctx.closeSheet(); ctx.renderAll(); ctx.toast("Saved. Breakfast as usual 💙"); return true;
    case "r-skip-reflect": R().reflections[yesterday()] = { skipped: true }; ctx.save(); ctx.renderAll(); return true;
    case "r-sheet-weekly": sheetWeekly(0); return true;
    case "r-wk-next": if (draft.step === 0) draft.weight = $("#wk-weight")?.value || ""; sheetWeekly(+el.dataset.step); return true;
    case "r-wk-a": draft.answers[el.dataset.q] = +el.dataset.v; sheetWeekly(1); return true;
    case "r-wk-p": draft.purge = +el.dataset.v; sheetWeekly(1); return true;
    case "r-wk-goal": draft.goal = el.dataset.v; sheetWeekly(2); return true;
    case "r-wk-save": saveWeekly(); return true;
    case "r-sheet-schedule": sheetSchedule(); return true;
    case "r-sched-save": {
      const r = R();
      r.schedule = r.schedule.map((x, i) => ({ ...x, label: $(`[data-sched-label="${i}"]`)?.value || x.label, time: $(`[data-sched-time="${i}"]`)?.value || x.time })).sort((p, q) => p.time.localeCompare(q.time));
      ctx.save(); ctx.closeSheet(); ctx.renderAll(); return true;
    }
    case "r-ics": downloadIcs(); return true;
    case "r-support": sheetSupport(); return true;
    case "r-flag-later": R().flagSeen = today(); ctx.save(); ctx.renderAll(); return true;
    case "r-lx-binge": ctx.typedRecovery({ binge: el.dataset.v === "1" }); return true;
    case "r-lx-ctx": { const d = ctx.typedRecovery() || {}; const v = el.dataset.v; const c = d.context || []; ctx.typedRecovery({ context: c.includes(v) ? c.filter((x) => x !== v) : [...c, v] }); return true; }
  }
  return false;
}
