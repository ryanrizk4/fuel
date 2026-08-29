/* engine.js — pure logic: no DOM. Everything takes (state, data) and returns values. */

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
};

const KCAL_PER_LB = 3500;
const MAX_DAILY_TRIM = 150; // never trim more than this off the daily budget to absorb an overage
const BUDGET_FLOOR = { male: 1500, female: 1200 };

// Extra-activity credits. The TDEE activity multiplier already covers routine
// training and daily steps; trackers overestimate burn by 27-93% (Stanford 2017,
// 2025 meta-analyses). So: only genuinely unusual activity earns a credit, at a
// 50% discount, capped so a bad estimate can never zero out the deficit.
const ACTIVITY_DISCOUNT = 0.5;
const ACTIVITY_CAP = 300;

// ---------- dates ----------

function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

// Monday-start week
function weekStart(d) {
  const c = new Date(d);
  const day = (c.getDay() + 6) % 7; // Mon=0
  c.setDate(c.getDate() - day);
  c.setHours(0, 0, 0, 0);
  return c;
}

function fmtDay(d) {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ---------- profile math ----------

function bmr(p) {
  const kg = p.weightLb * 0.4536;
  const cm = p.heightIn * 2.54;
  const base = 10 * kg + 6.25 * cm - 5 * p.age;
  return Math.round(base + (p.sex === "male" ? 5 : -161));
}

function tdee(p) {
  return Math.round(bmr(p) * (ACTIVITY_FACTORS[p.activity] || 1.375));
}

function dailyBudget(p) {
  const floor = BUDGET_FLOOR[p.sex] || 1200;
  return Math.max(floor, tdee(p) - p.deficit);
}

function budgetIsFloored(p) {
  return tdee(p) - p.deficit < (BUDGET_FLOOR[p.sex] || 1200);
}

function proteinTarget(p) {
  const ideal = (p.startWeightLb && p.goalLossLb) ? p.startWeightLb - p.goalLossLb : p.weightLb;
  return Math.round(ideal * (p.proteinPerLb || 1.0));
}

/* Stabilization mode. While it runs, Fuel stops doing the one thing it used to do
   automatically after a heavy night: quietly shave the next days' budgets until the
   calories are "paid back". That trim is post-binge undereating with a progress bar —
   the restriction with the clearest link to loading the next episode, implemented in
   software. The deficit itself stays exactly where the owner set it; only the
   compensation comes off, so that if episodes drop we know which change did it. */
function stabilizationOn(state) {
  return state?.cbt?.mode === "stabilization";
}

/** Whether a heavy day may be banked and repaid out of later budgets. */
function compensationActive(state) {
  return !stabilizationOn(state);
}

// Effective budget today = budget − overage-bank trim + any extra-activity credit for the day
function effectiveBudget(state, day) {
  const p = state.profile;
  const trim = compensationActive(state) ? Math.min(MAX_DAILY_TRIM, Math.max(0, state.overageBank || 0)) : 0;
  const credit = day?.activityCredit?.kcal || 0;
  return { budget: dailyBudget(p) - trim + credit, trim, credit };
}

// Convert a tracker-reported "calories burned" into an edible credit
function activityCreditFromTracker(reportedKcal) {
  return Math.min(ACTIVITY_CAP, Math.round(Math.max(0, reportedKcal) * ACTIVITY_DISCOUNT));
}

// How the bank shifts the goal date if it were never trimmed away
function goalProjection(state) {
  const p = state.profile;
  const current = latestWeight(state) ?? p.weightLb;
  const target = p.startWeightLb - p.goalLossLb;
  const remainingLb = Math.max(0, current - target);
  const dailyDef = Math.max(1, tdee({ ...p, weightLb: current }) - dailyBudget(p));
  const bankDays = (state.overageBank || 0) / dailyDef;
  const daysLeft = Math.ceil((remainingLb * KCAL_PER_LB) / dailyDef + bankDays);
  const eta = addDays(new Date(), daysLeft);
  return { remainingLb, daysLeft, eta, dailyDef, bankDays: Math.round(bankDays * 10) / 10 };
}

function latestWeight(state) {
  const w = [...(state.weighIns || [])].sort((a, b) => a.date.localeCompare(b.date));
  return w.length ? w[w.length - 1].lb : null;
}

// ---------- products & macros ----------

function productById(data, state, id) {
  const p = data.products.find((x) => x.id === id);
  if (!p) return null;
  const ov = state.productOverrides?.[id];
  return ov ? { ...p, calories: ov.calories, protein: ov.protein, confidence: "verified", userVerified: true } : p;
}

function templateById(data, id) {
  return data.templates.find((t) => t.id === id) || null;
}

function variantOf(tpl, variantId) {
  return tpl.variants.find((v) => v.id === variantId) || tpl.variants[0];
}

// Resolve final ingredient list for one serving of a template+variant
function mealIngredients(tpl, variantId) {
  const v = variantOf(tpl, variantId);
  const removed = new Set(v.remove || []);
  const list = tpl.base.filter((i) => !removed.has(i.product)).map((i) => ({ ...i }));
  for (const add of v.add || []) {
    const existing = list.find((i) => i.product === add.product);
    if (existing) existing.qty += add.qty;
    else list.push({ ...add });
  }
  const perServing = tpl.servings > 1 ? 1 / tpl.servings : 1;
  return list.map((i) => ({ ...i, qty: i.qty * perServing }));
}

function mealMacros(data, state, templateId, variantId, portions = 1) {
  const tpl = templateById(data, templateId);
  if (!tpl) return { calories: 0, protein: 0, estimated: false };
  let calories = 0, protein = 0, estimated = false;
  for (const ing of mealIngredients(tpl, variantId)) {
    const prod = productById(data, state, ing.product);
    if (!prod) continue;
    calories += prod.calories * ing.qty;
    protein += prod.protein * ing.qty;
    if (prod.confidence === "estimated") estimated = true;
  }
  return { calories: Math.round(calories * portions), protein: Math.round(protein * portions), estimated };
}

function snackMacros(data, state, snacks) {
  let calories = 0, protein = 0;
  for (const s of snacks || []) {
    if (s.custom) {
      calories += s.custom.calories || 0;
      protein += s.custom.protein || 0;
      continue;
    }
    const prod = productById(data, state, s.productId);
    if (!prod) continue;
    calories += prod.calories * (s.qty || 1);
    protein += prod.protein * (s.qty || 1);
  }
  return { calories: Math.round(calories), protein: Math.round(protein) };
}

function dayTotals(data, state, day) {
  let calories = 0, protein = 0;
  for (const m of day.meals || []) {
    const mm = mealMacros(data, state, m.templateId, m.variantId, m.portions || 1);
    calories += mm.calories;
    protein += mm.protein;
  }
  const sm = snackMacros(data, state, day.snacks);
  return { calories: calories + sm.calories, protein: protein + sm.protein };
}

// Consumed so far today (only checked-off meals + snacks count)
function dayConsumed(data, state, day) {
  let calories = 0, protein = 0;
  (day.meals || []).forEach((m, i) => {
    if (!day.eaten?.includes(i)) return;
    const mm = mealMacros(data, state, m.templateId, m.variantId, m.portions || 1);
    calories += mm.calories;
    protein += mm.protein;
  });
  const sm = snackMacros(data, state, (day.snacks || []).filter((s) => s.eaten));
  return { calories: calories + sm.calories, protein: protein + sm.protein };
}

// ---------- rotation / auto-plan ----------

// deterministic rng so each "re-plan" press explores a different valid plan
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysSinceUse(state, key, today) {
  const last = state.history?.[key];
  if (!last) return 999;
  return Math.round((parseKey(today) - parseKey(last)) / 86400000);
}

// How urgently a template's fresh ingredients need to be cooked (0 = shelf-stable)
function perishUrgency(data, tpl) {
  let worst = 0;
  for (const ing of tpl.base) {
    const prod = data.products.find((x) => x.id === ing.product);
    if (prod?.perishDays) worst = Math.max(worst, 6 - Math.min(prod.perishDays, 6));
  }
  return worst;
}

function scoreTemplate(state, tpl, todayKey, usedThisWeek, carryover, data, dayIndex = 3, rng = null, recentTpls = null) {
  let score = Math.min(daysSinceUse(state, `t:${tpl.id}`, todayKey), 30);
  const uses = usedThisWeek[tpl.id] || 0;
  if (tpl.repeatOk) score += 6 - uses * 2; // favorites can repeat, with decay
  else score -= uses * 25; // non-repeat meals strongly resist repeating in-week
  if (carryover?.has(tpl.id)) score += 15; // groceries already bought from a skipped day
  if (state.favorites?.[tpl.id]) score += 10; // "add to rotation" boost
  if (state.opened) { // an opened tub/pack should get used before it turns
    for (const ing of tpl.base) {
      const od = state.opened[ing.product];
      if (od && Math.abs(Math.round((parseKey(todayKey) - parseKey(od)) / 86400000)) <= 3) { score += 9; break; }
    }
  }
  if (recentTpls?.has(tpl.id) && !tpl.repeatOk) score -= 14; // planned in an adjacent week already
  score -= Math.max(0, tpl.prepMinutes - 30) * 0.2; // keep overall prep short
  if (data) score += perishUrgency(data, tpl) * (6 - dayIndex) * 0.8;
  if (rng) score += rng() * 7; // seeded variety — each re-plan explores a different plan
  return score;
}

function pickVariant(state, tpl, todayKey, rng) {
  let bestAge = -1;
  for (const v of tpl.variants) {
    const age = daysSinceUse(state, `v:${tpl.id}:${v.id}`, todayKey);
    if (age > bestAge) bestAge = age;
  }
  const candidates = tpl.variants.filter((v) => daysSinceUse(state, `v:${tpl.id}:${v.id}`, todayKey) === bestAge);
  const idx = rng ? Math.floor(rng() * candidates.length) : 0;
  return candidates[Math.min(idx, candidates.length - 1)].id;
}

/**
 * Generate a week's plan.
 * mode: 'auto' (balanced) | 'prep' (weekend batch + freezer through week) | 'easy' (quick + freezer only)
 * Preserves days that already have status !== 'planned' and meals the user locked.
 */
function generateWeek(data, state, startKey, mode, seed = 1) {
  const rng = mulberry32(seed * 2654435761 + 97);
  const recentTpls = new Set();
  for (const [k, d] of Object.entries(state.plan.days)) {
    const diff = Math.round((parseKey(k) - parseKey(startKey)) / 86400000);
    if ((diff >= -7 && diff < 0) || (diff >= 7 && diff < 14))
      for (const m of d.meals || []) recentTpls.add(m.templateId);
  }
  const nowKey = dateKey(new Date());
  const p = state.profile;
  const budget = dailyBudget(p);
  const pTarget = proteinTarget(p);
  const start = parseKey(startKey);
  const usedThisWeek = {};
  const carryover = collectCarryover(data, state, start);
  let freezer = (state.freezer || []).map((f) => ({ ...f }));
  let treatsLeft = p.treatsPerWeek ?? 3;

  const lunches = data.templates.filter((t) => t.mealType.includes("lunch"));
  const dinners = data.templates.filter((t) => t.mealType.includes("dinner"));

  // In prep mode, choose one batch recipe for the weekend cook
  let batchTpl = null;
  if (mode === "prep") {
    const batchables = dinners.filter((t) => t.freezerFriendly && t.servings > 1);
    batchTpl = batchables.sort((a, b) =>
      scoreTemplate(state, b, startKey, {}, carryover, data, 5, rng, recentTpls) - scoreTemplate(state, a, startKey, {}, carryover, data, 5, rng, recentTpls))[0] || null;
  }

  const days = {};
  for (let i = 0; i < 7; i++) {
    const key = dateKey(addDays(start, i));
    const existing = state.plan.days[key];
    if (existing && (existing.status !== "planned" || key < nowKey)) { days[key] = existing; continue; }
    if (key < nowKey) continue; // never plan days already in the past

    const meals = [];
    const keepLocked = (slot) => existing?.meals?.find((m) => m.slot === slot && m.locked);

    // breakfast
    const bLocked = keepLocked("breakfast");
    if (bLocked) meals.push(bLocked);
    else {
      const bTpl = templateById(data, p.breakfastDefault) || templateById(data, "latte");
      meals.push({ slot: "breakfast", templateId: bTpl.id, variantId: pickVariant(state, bTpl, key, rng) });
    }

    // lunch — weekday lunches respect the work-time cap (he cooks at/for work)
    const lLocked = keepLocked("lunch");
    if (lLocked) meals.push(lLocked);
    else {
      let pool = lunches;
      const dowL = addDays(start, i).getDay();
      const isWorkday = dowL >= 1 && dowL <= 5;
      // At work: no cooking raw protein — only assemble/reheat lunches (or a freezer portion).
      if (isWorkday) {
        const workLunch = pool.filter((t) => t.lunchAtWork);
        if (workLunch.length) pool = workLunch;
      }
      const lunchCap = mode === "easy" ? 15 : isWorkday ? (p.maxLunchMinutes || 60) : 60;
      const quick = pool.filter((t) => t.prepMinutes <= lunchCap);
      if (quick.length) pool = quick;
      const tpl = pool.sort((a, b) =>
        scoreTemplate(state, b, key, usedThisWeek, carryover, data, i, rng, recentTpls) - scoreTemplate(state, a, key, usedThisWeek, carryover, data, i, rng, recentTpls))[0];
      meals.push({ slot: "lunch", templateId: tpl.id, variantId: pickVariant(state, tpl, key, rng), why: mealWhy(data, state, tpl, key, i, carryover) });
      usedThisWeek[tpl.id] = (usedThisWeek[tpl.id] || 0) + 1;
    }

    // dinner
    const dLocked = keepLocked("dinner");
    if (dLocked) meals.push(dLocked);
    else {
      const frz = freezer.find((f) => f.portions > 0 && templateById(data, f.templateId));
      const dow = addDays(start, i).getDay();
      const isWeekend = dow === 0 || dow === 6;
      if (mode === "prep" && batchTpl && isWeekend && !Object.keys(usedThisWeek).includes(batchTpl.id + ":batch")) {
        meals.push({ slot: "dinner", templateId: batchTpl.id, variantId: pickVariant(state, batchTpl, key, rng), batchCook: true, why: "Weekend batch cook — one session, portions for the freezer" });
        usedThisWeek[batchTpl.id + ":batch"] = 1;
        usedThisWeek[batchTpl.id] = (usedThisWeek[batchTpl.id] || 0) + 1;
      } else if (frz && (mode === "easy" || i % 2 === 1)) {
        meals.push({ slot: "dinner", templateId: frz.templateId, variantId: frz.variantId || "classic", fromFreezer: true, why: "From your freezer stock — zero cooking, just reheat" });
        frz.portions -= 1;
        usedThisWeek[frz.templateId] = (usedThisWeek[frz.templateId] || 0) + 1;
      } else {
        let pool = dinners;
        if (mode === "easy") {
          const quick = pool.filter((t) => t.prepMinutes <= 15 || t.freezerFriendly);
          if (quick.length) pool = quick;
        }
        const tpl = pool.sort((a, b) =>
          scoreTemplate(state, b, key, usedThisWeek, carryover, data, i, rng, recentTpls) - scoreTemplate(state, a, key, usedThisWeek, carryover, data, i, rng, recentTpls))[0];
        meals.push({ slot: "dinner", templateId: tpl.id, variantId: pickVariant(state, tpl, key, rng), why: mealWhy(data, state, tpl, key, i, carryover) });
        usedThisWeek[tpl.id] = (usedThisWeek[tpl.id] || 0) + 1;
      }
    }

    // scale portions toward the budget (like eating 2 patties instead of 1 —
    // same cooking, bigger serving) before topping up with snacks
    const day = { meals, snacks: existing?.snacks?.length && existing.meals?.some(m=>m.locked) ? existing.snacks : [], status: "planned", eaten: existing?.eaten || [] };
    for (const slot of ["dinner", "lunch"]) {
      const m = meals.find((x) => x.slot === slot && !x.locked && !x.fromFreezer && !x.batchCook);
      if (!m) continue;
      const per = mealMacros(data, state, m.templateId, m.variantId, 1).calories;
      if (!per) continue;
      while ((m.portions || 1) < 2 && budget - dayTotals(data, state, day).calories >= per * 0.5 + 260) {
        m.portions = (m.portions || 1) + 0.5;
      }
    }

    // snacks: fill remaining budget, protein first, treats within weekly allowance
    if (!day.snacks.length) {
      const snackProducts = data.products.filter((x) => x.snack);
      const treats = snackProducts.filter((x) => x.treat);
      const proteins = snackProducts.filter((x) => !x.treat).sort((a, b) => b.protein / Math.max(1, b.calories) - a.protein / Math.max(1, a.calories));
      let room = budget - dayTotals(data, state, day).calories;
      // occasional treat first so it never gets crowded out
      if (treatsLeft > 0 && i % 2 === 0) {
        const t = treats[0];
        if (t && t.calories <= room - 100) { day.snacks.push({ productId: t.id, qty: 1 }); room -= t.calories; treatsLeft--; }
      }
      // protein snacks to close the gap (max 3)
      let guard = 0;
      while ((room > 150 || (room > 70 && dayTotals(data, state, day).protein < pTarget)) && day.snacks.length < 4 && guard < 8) {
        const s = proteins[(i + guard) % proteins.length];
        guard++;
        if (!s || s.calories > room - 40) continue;
        if (day.snacks.some((x) => x.productId === s.id)) continue;
        day.snacks.push({ productId: s.id, qty: 1 });
        room -= s.calories;
      }
    }
    days[key] = day;
  }
  return days;
}

// Human explanation for why the planner picked this meal
function mealWhy(data, state, tpl, key, dayIndex, carryover) {
  if (state.favorites?.[tpl.id]) return "One of your ❤️ favorites — boosted in the rotation";
  if (carryover?.has(tpl.id)) return "Uses groceries already bought for a day you skipped";
  if (state.opened) {
    for (const ing of tpl.base) {
      const od = state.opened[ing.product];
      if (od && Math.abs(Math.round((parseKey(key) - parseKey(od)) / 86400000)) <= 3) {
        const prod = data.products.find((x) => x.id === ing.product);
        return `Uses the ${prod?.name || "item"} you already opened`;
      }
    }
  }
  if (perishUrgency(data, tpl) >= 4 && dayIndex <= 2) return "Fresh ingredients — scheduled early so nothing turns";
  const age = daysSinceUse(state, `t:${tpl.id}`, key);
  if (age >= 14 && age < 999) return `Haven't had this in ${age} days — variety pick`;
  if (tpl.prepMinutes <= 15) return `Quick (${tpl.prepMinutes} min) — fits a busy day`;
  return "Rotation pick — variety without relearning anything";
}

// Plan quality: how good is this week at a glance?
function weekQuality(data, state, days) {
  const target = proteinTarget(state.profile);
  let proteinDays = 0, prep = 0, freshLate = 0;
  const uniq = new Set();
  const keys = Object.keys(days).sort();
  keys.forEach((k, i) => {
    const d = days[k];
    if (dayTotals(data, state, d).protein >= target * 0.9) proteinDays++; // within 10% counts — planner floor is 85%
    for (const m of d.meals || []) {
      uniq.add(m.templateId + ":" + m.variantId);
      const tpl = templateById(data, m.templateId);
      if (!tpl) continue;
      prep += m.fromFreezer ? 5 : tpl.prepMinutes;
      if (perishUrgency(data, tpl) >= 4 && i > 3 && !m.fromFreezer) freshLate++;
    }
  });
  return { proteinDays, totalDays: keys.length, uniqueMeals: uniq.size, prepMinutes: prep, freshnessOk: freshLate === 0 };
}

// Weight-trend calibration: the weekly weigh-in is the real referee
function calibration(state) {
  const ws = [...(state.weighIns || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (ws.length < 3) return null;
  const first = ws[0], last = ws[ws.length - 1];
  const span = Math.round((parseKey(last.date) - parseKey(first.date)) / 86400000);
  if (span < 10) return null;
  const actual = ((first.lb - last.lb) / span) * 7;
  const planned = (state.profile.deficit * 7) / KCAL_PER_LB;
  const ratio = planned ? actual / planned : 1;
  let status = "on-track", note = "Your weight trend matches the plan — the math is working. Keep going.";
  if (ratio < 0.5) { status = "behind"; note = `Trend: losing ${actual.toFixed(1)} lb/wk vs ${planned.toFixed(1)} planned over ${span} days. If this holds another week, re-check portions and snacks, or raise the deficit a notch in Settings.`; }
  else if (ratio > 1.7 && actual > 1.4) { status = "fast"; note = `Trend: losing ${actual.toFixed(1)} lb/wk — faster than the ${planned.toFixed(1)} planned. Consider easing the deficit to protect muscle while lifting.`; }
  return { actualPerWeek: Math.round(actual * 10) / 10, plannedPerWeek: Math.round(planned * 10) / 10, days: span, status, note };
}

// Templates from skipped days in the prior 10 days → their groceries are likely sitting unused
function collectCarryover(data, state, start) {
  const set = new Set();
  for (let i = 1; i <= 10; i++) {
    const key = dateKey(addDays(start, -i));
    const d = state.plan.days[key];
    if (d?.status === "skipped") for (const m of d.meals || []) set.add(m.templateId);
  }
  return set;
}

// Record usage history when a day is completed
function recordHistory(state, day, key) {
  for (const m of day.meals || []) {
    state.history[`t:${m.templateId}`] = key;
    state.history[`v:${m.templateId}:${m.variantId}`] = key;
  }
}

// ---------- shopping list ----------

/**
 * Aggregate ingredients for all still-planned days in [startKey, startKey+7).
 * Freezer meals and batch double-counting handled: batchCook counts full batch, fromFreezer counts nothing.
 */
function shoppingList(data, state, startKey) {
  const start = parseKey(startKey);
  const need = {}; // productId -> qty
  for (let i = 0; i < 7; i++) {
    const key = dateKey(addDays(start, i));
    const day = state.plan.days[key];
    if (!day || day.status === "skipped") continue;
    if (day.status === "done" && key !== dateKey(new Date())) continue; // already eaten, already bought
    for (const m of day.meals || []) {
      if (m.fromFreezer) continue;
      const tpl = templateById(data, m.templateId);
      if (!tpl) continue;
      const perServing = mealIngredients(tpl, m.variantId);
      const mult = m.batchCook ? tpl.servings : (m.portions || 1);
      for (const ing of perServing) need[ing.product] = (need[ing.product] || 0) + ing.qty * mult;
    }
    for (const s of day.snacks || []) need[s.productId] = (need[s.productId] || 0) + (s.qty || 1);
  }

  const sections = {};
  const stocked = [];
  for (const [pid, qty] of Object.entries(need)) {
    const prod = productById(data, state, pid);
    if (!prod) continue;
    const packs = prod.packServings ? Math.ceil(qty / prod.packServings) : null;
    const item = {
      id: pid, name: prod.name, unit: prod.unit, qty: Math.round(qty * 10) / 10,
      packs, packLabel: prod.packLabel || "", note: prod.note || "",
      needsVerify: prod.confidence === "estimated", staple: !!prod.staple,
      calories: prod.calories, protein: prod.protein,
    };
    if (prod.staple && state.pantry?.[pid]) { stocked.push(item); continue; }
    (sections[prod.section] = sections[prod.section] || []).push(item);
  }
  const order = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Bread & Bakery", "Pantry", "Snacks", "Condiments & Sauces", "Beverages"];
  const buy = order.filter((s) => sections[s]).map((s) => ({ section: s, items: sections[s].sort((a, b) => a.name.localeCompare(b.name)) }));
  return { sections: buy, stocked: stocked.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---------- self-monitoring: urges (CBT-E) ----------

/* The binge side of the app. CBT-E works three levers — regular eating, real-time
   self-monitoring, and finding the moment an ordinary evening becomes an inevitable
   one — so everything here reads two things only: the urge log, and whether the day's
   planned eating occasions actually happened.

   What this section never touches, on purpose: calories, weight, compensation, and
   streaks. A "days since" counter turns one lapse into a total loss, which is the
   same all-or-nothing move that drives the binge in the first place. The unit here
   is always "the last several weeks", never "days since". */

const NIGHT_ROLLOVER_HOUR = 4;   // 1am Saturday is still Friday night, and the pattern says so
const PATTERN_WEEKS = 6;         // the window the app speaks in
const MIN_PATTERN_N = 4;         // fewer entries than this is noise, and gets reported as noise
const HOUR_BAND = 3;             // width of the high-risk window we report, in hours
const REGULAR_EATING_DAYS = 14;
const PRIOR_DAYS = 3;            // days of eating before an urge that a restraint signal reads
const URGE_TEXT_MAX = 280;       // phone storage is small and a log entry is not an essay
const OPEN_URGE_HOURS = 36;      // how long an unanswered "how did it go?" stays on screen

const SEEKING = [
  { id: "comfort", label: "Comfort" },
  { id: "stimulation", label: "Stimulation" },
  { id: "escape", label: "Escape" },
  { id: "reward", label: "A reward" },
  { id: "release", label: "Permission to stop controlling" },
  { id: "sensory", label: "Sensory pleasure" },
];

const CANNABIS_PROXIMITY = [
  { id: "none", label: "Not today" },
  { id: "earlier", label: "Earlier today" },
  { id: "hour", label: "Within the hour" },
  { id: "now", label: "Right now / about to" },
];

const COMPANY = [
  { id: "alone", label: "Alone" },
  { id: "with-people", label: "With people" },
];

// "Acted on?" and, if so, the question that separates a decision from an escalation.
const URGE_OUTCOMES = [
  { id: "rode-out", label: "Rode it out" },
  { id: "as-planned", label: "Ate the amount I meant to" },
  { id: "escalated", label: "Started, then it escalated" },
];

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SEEKING_IDS = new Set(SEEKING.map((s) => s.id));
const COUNTED_EATING = new Set(["complete", "partial", "missed"]);

/** Monday-indexed day of week, matching weekStart(). */
function dowIndex(key) {
  return (parseKey(key).getDay() + 6) % 7;
}

function fmtHour(h) {
  const n = ((Math.round(h) % 24) + 24) % 24;
  const ampm = n < 12 ? "am" : "pm";
  const h12 = n % 12 === 0 ? 12 : n % 12;
  return `${h12}${ampm}`;
}

const clampText = (v) => String(v ?? "").trim().slice(0, URGE_TEXT_MAX);

/**
 * Build a log entry. Timestamped by the caller's clock so an entry can be replayed
 * in a test, and identified by that timestamp — logging twice in the same
 * millisecond is not a thing a person does by hand.
 */
function newUrge(fields = {}, now = new Date()) {
  const hunger = Number(fields.hunger);
  const seeking = Array.isArray(fields.seeking) ? fields.seeking.filter((s) => SEEKING_IDS.has(s)) : [];
  return {
    id: now.toISOString(),
    at: now.toISOString(),
    date: dateKey(now),
    hour: now.getHours(),
    seeking,
    hunger: Number.isFinite(hunger) ? Math.min(10, Math.max(1, Math.round(hunger))) : null,
    cannabis: CANNABIS_PROXIMITY.some((c) => c.id === fields.cannabis) ? fields.cannabis : null,
    company: COMPANY.some((c) => c.id === fields.company) ? fields.company : null,
    before: clampText(fields.before),
    thought: clampText(fields.thought),
    outcome: null,
    outcomeAt: null,
  };
}

/** Close an entry with what actually happened. Late is fine; never is the only loss. */
function closeUrge(urge, outcome, now = new Date()) {
  if (!URGE_OUTCOMES.some((o) => o.id === outcome)) return urge;
  return { ...urge, outcome, outcomeAt: now.toISOString() };
}

/** The night an urge belongs to: before 4am it belongs to the evening before. */
function urgeNightKey(urge) {
  const h = Number(urge?.hour);
  if (!urge?.date) return null;
  return Number.isFinite(h) && h < NIGHT_ROLLOVER_HOUR ? dateKey(addDays(parseKey(urge.date), -1)) : urge.date;
}

function urgesInWindow(state, endKey, weeks = PATTERN_WEEKS) {
  const startKey = dateKey(addDays(parseKey(endKey), -(weeks * 7 - 1)));
  return (state.urges || [])
    .filter((u) => u && typeof u.date === "string" && u.date >= startKey && u.date <= endKey)
    .sort((a, b) => String(a.at || a.date).localeCompare(String(b.at || b.date)));
}

/** Entries still waiting on "how did it go?" — the outcome is asked later, not in the moment. */
function openUrges(state, now = new Date()) {
  const cutoff = now.getTime() - OPEN_URGE_HOURS * 3600000;
  return (state.urges || [])
    .filter((u) => u && !u.outcome && Date.parse(u.at) >= cutoff)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * The shape of the last `weeks`: when urges land, what they're reaching for, what
 * was around them, and how they ended. Counts only — no rate is asked to carry more
 * weight than its n, which is why `n` is reported next to everything.
 */
function urgePattern(state, { endKey = dateKey(new Date()), weeks = PATTERN_WEEKS } = {}) {
  const entries = urgesInWindow(state, endKey, weeks);
  const byDow = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  const seeking = Object.fromEntries(SEEKING.map((s) => [s.id, 0]));
  const cannabis = Object.fromEntries(CANNABIS_PROXIMITY.map((c) => [c.id, 0]));
  const company = Object.fromEntries(COMPANY.map((c) => [c.id, 0]));
  const outcomes = { "rode-out": 0, "as-planned": 0, escalated: 0, open: 0 };
  const hungers = [];

  for (const u of entries) {
    const night = urgeNightKey(u);
    if (night) byDow[dowIndex(night)]++;
    if (Number.isFinite(u.hour)) byHour[((u.hour % 24) + 24) % 24]++;
    for (const s of u.seeking || []) if (s in seeking) seeking[s]++;
    if (u.cannabis in cannabis) cannabis[u.cannabis]++;
    if (u.company in company) company[u.company]++;
    outcomes[u.outcome && u.outcome in outcomes ? u.outcome : "open"]++;
    if (Number.isFinite(u.hunger)) hungers.push(u.hunger);
  }

  const sortedHunger = [...hungers].sort((a, b) => a - b);
  const closed = outcomes["rode-out"] + outcomes["as-planned"] + outcomes.escalated;
  return {
    weeks, endKey, n: entries.length, entries,
    byDow, byHour, cannabis, company, outcomes, closed,
    seeking: SEEKING.map((s) => ({ ...s, count: seeking[s.id] })).sort((a, b) => b.count - a.count),
    medianHunger: sortedHunger.length ? sortedHunger[Math.floor((sortedHunger.length - 1) / 2)] : null,
    rodeOutShare: closed ? outcomes["rode-out"] / closed : null,
  };
}

/**
 * The decision point: the night and the hours where an ordinary evening turns.
 * Returns null below MIN_PATTERN_N rather than dressing three entries up as a pattern.
 * The hour band is scanned around the clock so a 10pm–1am window reads as one window.
 */
function decisionPoint(pattern) {
  if (!pattern || pattern.n < MIN_PATTERN_N) return null;
  const peak = Math.max(...pattern.byDow);
  const nights = pattern.byDow.map((c, i) => (c === peak ? i : -1)).filter((i) => i >= 0);
  let best = { from: 0, count: -1 };
  for (let h = 0; h < 24; h++) {
    let count = 0;
    for (let k = 0; k < HOUR_BAND; k++) count += pattern.byHour[(h + k) % 24];
    if (count > best.count) best = { from: h, count };
  }
  return {
    nights, nightLabels: nights.map((i) => DOW_LABELS[i]), nightCount: peak,
    nightShare: peak / pattern.n,
    hourFrom: best.from, hourTo: (best.from + HOUR_BAND) % 24,
    hourCount: best.count, hourShare: best.count / pattern.n,
    label: `${nights.map((i) => DOW_LABELS[i]).join("/")} · ${fmtHour(best.from)}–${fmtHour(best.from + HOUR_BAND)}`,
  };
}

/**
 * Did the day's planned eating occasions happen? Yes/no per day, never amounts —
 * regular eating is the lever, and counting calories here would import the exact
 * thing this side of the app is built to stay out of.
 *   complete/partial/missed  countable
 *   untracked                ate out, so nothing to read
 *   today/ahead/none         not answerable yet
 */
function regularEatingDay(state, key, todayKey) {
  const day = state.plan?.days?.[key];
  const planned = (day?.meals || []).length;
  if (!day || !planned) return { key, status: "none", planned: 0, eaten: 0 };
  const eaten = (day.eaten || []).filter((i) => i >= 0 && i < planned).length;
  if (key > todayKey) return { key, status: "ahead", planned, eaten };
  if (day.status === "skipped") return { key, status: "untracked", planned, eaten };
  if (day.status === "done" || day.status === "over") return { key, status: "complete", planned, eaten: planned };
  if (key === todayKey) return { key, status: "today", planned, eaten };
  if (eaten >= planned) return { key, status: "complete", planned, eaten };
  return { key, status: eaten > 0 ? "partial" : "missed", planned, eaten };
}

function regularEating(state, endKey = dateKey(new Date()), days = REGULAR_EATING_DAYS) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(regularEatingDay(state, dateKey(addDays(parseKey(endKey), -i)), endKey));
  const counted = out.filter((d) => COUNTED_EATING.has(d.status));
  const complete = counted.filter((d) => d.status === "complete").length;
  return {
    days: out, counted: counted.length, complete,
    partial: counted.filter((d) => d.status === "partial").length,
    missed: counted.filter((d) => d.status === "missed").length,
    rate: counted.length ? complete / counted.length : null,
  };
}

/**
 * How regular eating looked in the days BEFORE each logged urge, against the same
 * measure across the whole window.
 *
 * This is an association in one person's log, not proof of anything — but it is not
 * neutral either. Dietary restraint driving later binges is one of the better-supported
 * findings in this literature, and it works cumulatively rather than same-day, which is
 * exactly why it doesn't feel connected from the inside. The felt disconnection is what
 * the mechanism predicts, so it is weak evidence against it. This function exists to
 * show where the pattern lands in his own weeks, not to re-open whether it is real.
 */
function restraintSignal(state, { endKey = dateKey(new Date()), weeks = PATTERN_WEEKS } = {}) {
  const nights = [...new Set(urgesInWindow(state, endKey, weeks).map(urgeNightKey).filter(Boolean))];
  let priorDays = 0, priorComplete = 0;
  for (const night of nights) {
    for (let i = 1; i <= PRIOR_DAYS; i++) {
      const d = regularEatingDay(state, dateKey(addDays(parseKey(night), -i)), endKey);
      if (!COUNTED_EATING.has(d.status)) continue;
      priorDays++;
      if (d.status === "complete") priorComplete++;
    }
  }
  const base = regularEating(state, endKey, weeks * 7);
  const priorRate = priorDays ? priorComplete / priorDays : null;
  return {
    nights: nights.length, priorDays, priorRate, baseRate: base.rate,
    baseDays: base.counted, lookback: PRIOR_DAYS,
    enough: nights.length >= MIN_PATTERN_N && priorDays >= MIN_PATTERN_N && base.counted >= MIN_PATTERN_N,
    direction: priorRate === null || base.rate === null ? null
      : priorRate < base.rate - 0.05 ? "less-regular"
      : priorRate > base.rate + 0.05 ? "more-regular" : "no-difference",
  };
}

// ---------- stage 1: regular eating, the risk window, and recovery ----------

/* Regular eating is the intervention, not a metric: planned occasions, roughly four
   hours apart, eaten at their time whether or not he's hungry and whether or not
   last night happened. Fuel already knew what he'd eat; this is the part that says
   when, and refuses to let the day after an episode be a lighter day. */

const MAX_OCCASION_GAP_HOURS = 4;
const EPISODE_RESUME_LIMIT = 6;   // how many days out we'll look for eating to resume
const RISK_WINDOW_LEAD_HOURS = 2; // how early the sober plan surfaces before the window

const DEFAULT_OCCASIONS = [
  { id: "breakfast", label: "Breakfast", time: "08:30" },
  { id: "lunch", label: "Lunch", time: "12:30" },
  { id: "snack-pm", label: "Afternoon snack", time: "16:00" },
  { id: "dinner", label: "Dinner", time: "19:30" },
  { id: "snack-eve", label: "Evening snack", time: "21:30" },
];

const parseClock = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
};

function fmtClock(hhmm) {
  const mins = parseClock(hhmm);
  if (mins === null) return "";
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

const sortedOccasions = (occasions) =>
  (occasions || []).filter((o) => parseClock(o?.time) !== null).sort((a, b) => parseClock(a.time) - parseClock(b.time));

/**
 * The gaps between planned occasions, and whether any of them is long enough to be
 * doing the priming itself. The evening gap is measured to the first occasion of the
 * next day, because that is the stretch an 11pm urge lives in.
 */
function occasionGaps(occasions) {
  const list = sortedOccasions(occasions);
  if (list.length < 2) return { gaps: [], longestHours: null, tooLong: [], ok: list.length > 0 };
  const gaps = [];
  for (let i = 1; i < list.length; i++)
    gaps.push({ from: list[i - 1], to: list[i], hours: (parseClock(list[i].time) - parseClock(list[i - 1].time)) / 60 });
  const tooLong = gaps.filter((g) => g.hours > MAX_OCCASION_GAP_HOURS);
  return { gaps, longestHours: Math.max(...gaps.map((g) => g.hours)), tooLong, ok: tooLong.length === 0 };
}

/** The next planned occasion due, wrapping to tomorrow's first once the day is done. */
function nextOccasion(occasions, now = new Date()) {
  const list = sortedOccasions(occasions);
  if (!list.length) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  const upcoming = list.find((o) => parseClock(o.time) >= mins);
  return upcoming ? { ...upcoming, tomorrow: false } : { ...list[0], tomorrow: true };
}

/* The risk window is self-reported to begin with — he already knows it's Thursday and
   Friday around 11pm, and an algorithm needs entries it doesn't have yet. decisionPoint()
   refines it later, once the log can outvote the guess. */

function windowNightKey(riskWindow, now = new Date()) {
  // Inside a window that has run past midnight, the night still belongs to yesterday.
  const from = Number(riskWindow?.from);
  const to = Number(riskWindow?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const wraps = to <= from;
  return wraps && now.getHours() < to ? dateKey(addDays(now, -1)) : dateKey(now);
}

// Hour ranges here run around the clock, so "9pm to 1am" is one range, not two.
const inHourRing = (h, from, to) => (from <= to ? h >= from && h < to : h >= from || h < to);

/**
 * Is tonight one of his nights, and where in it are we?
 * `approaching` is the one that matters: it fires before the window opens, while the
 * version of him that makes plans is still the one holding the phone.
 */
function riskWindowState(riskWindow, now = new Date()) {
  const from = Number(riskWindow?.from), to = Number(riskWindow?.to);
  const nights = Array.isArray(riskWindow?.nights) ? riskWindow.nights : [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || !nights.length) return { known: false };
  const nightKey = windowNightKey(riskWindow, now);
  const tonight = nights.includes(dowIndex(nightKey));
  const h = now.getHours() + now.getMinutes() / 60;
  const inside = inHourRing(h, from, to);
  const approaching = !inside && inHourRing(h, (from - RISK_WINDOW_LEAD_HOURS + 24) % 24, from);
  return { known: true, nightKey, tonight, inside: tonight && inside, approaching: tonight && approaching, from, to };
}

/* Recovery quality: the measure that can improve while the episode count hasn't.
   "Binge, then restrict for three days" becoming "binge, then eat breakfast" is real
   therapeutic change, and it is the thing this app is actually trying to move. */

function episodeNights(state, { endKey = dateKey(new Date()), weeks = PATTERN_WEEKS } = {}) {
  const nights = urgesInWindow(state, endKey, weeks)
    .filter((u) => u.outcome === "escalated")
    .map(urgeNightKey)
    .filter(Boolean);
  return [...new Set(nights)].sort();
}

/**
 * For each episode: how many days until planned eating was complete again, and how
 * many of the days straight after it were short. Days still in the future, or on a
 * day he ate out, can't answer the question and say so rather than guessing.
 */
function recoveryAfterEpisode(state, nightKey, todayKey = dateKey(new Date())) {
  let daysToResume = null, shortDays = 0, resolved = false;
  for (let i = 1; i <= EPISODE_RESUME_LIMIT; i++) {
    const day = regularEatingDay(state, dateKey(addDays(parseKey(nightKey), i)), todayKey);
    if (day.status === "complete") { daysToResume = i; resolved = true; break; }
    if (day.status === "partial" || day.status === "missed") { shortDays++; continue; }
    break; // today, ahead, untracked or unplanned — the question isn't answerable yet
  }
  return { nightKey, daysToResume, shortDays, resolved };
}

function recoveryQuality(state, { endKey = dateKey(new Date()), weeks = PATTERN_WEEKS } = {}) {
  const episodes = episodeNights(state, { endKey, weeks }).map((n) => recoveryAfterEpisode(state, n, endKey));
  const resolved = episodes.filter((e) => e.resolved);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    episodes, n: episodes.length, resolved: resolved.length,
    meanDaysToResume: mean(resolved.map((e) => e.daysToResume)),
    meanShortDays: mean(resolved.map((e) => e.shortDays)),
    // The headline the weekly review reads out: did he go straight back to the schedule?
    resumedNextDay: resolved.filter((e) => e.daysToResume === 1).length,
  };
}

/** Where the programme is, in the terms it set for itself on day one. */
function stabilizationProgress(state, { endKey = dateKey(new Date()), weeks = PATTERN_WEEKS } = {}) {
  const pattern = urgePattern(state, { endKey, weeks });
  const eating = regularEating(state, endKey, REGULAR_EATING_DAYS);
  const recovery = recoveryQuality(state, { endKey, weeks });
  const started = state?.cbt?.startedAt || "";
  const daysIn = started ? Math.max(0, Math.round((parseKey(endKey) - parseKey(started)) / 86400000)) : null;
  return {
    daysIn, weeks,
    urges: pattern.n, episodes: pattern.outcomes.escalated,
    asPlanned: pattern.outcomes["as-planned"], rodeOut: pattern.outcomes["rode-out"],
    eatingComplete: eating.complete, eatingCounted: eating.counted,
    meanDaysToResume: recovery.meanDaysToResume, resumedNextDay: recovery.resumedNextDay,
  };
}

export {
  ACTIVITY_FACTORS, MAX_DAILY_TRIM, KCAL_PER_LB, ACTIVITY_DISCOUNT, ACTIVITY_CAP,
  dateKey, parseKey, addDays, weekStart, fmtDay,
  bmr, tdee, dailyBudget, budgetIsFloored, proteinTarget, effectiveBudget, activityCreditFromTracker, goalProjection, latestWeight,
  productById, templateById, variantOf, mealIngredients, mealMacros, snackMacros, dayTotals, dayConsumed,
  generateWeek, recordHistory, shoppingList, collectCarryover, perishUrgency, weekQuality, calibration,
  PATTERN_WEEKS, MIN_PATTERN_N, REGULAR_EATING_DAYS, PRIOR_DAYS, HOUR_BAND, NIGHT_ROLLOVER_HOUR,
  SEEKING, CANNABIS_PROXIMITY, COMPANY, URGE_OUTCOMES, DOW_LABELS,
  dowIndex, fmtHour, newUrge, closeUrge, urgeNightKey, urgesInWindow, openUrges,
  urgePattern, decisionPoint, regularEatingDay, regularEating, restraintSignal,
  MAX_OCCASION_GAP_HOURS, EPISODE_RESUME_LIMIT, RISK_WINDOW_LEAD_HOURS, DEFAULT_OCCASIONS,
  stabilizationOn, compensationActive, fmtClock, sortedOccasions, occasionGaps, nextOccasion,
  windowNightKey, riskWindowState, episodeNights, recoveryAfterEpisode, recoveryQuality,
  stabilizationProgress,
};
