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

// Overage payback speeds the owner can choose (kcal trimmed per day). The default
// stays at MAX_DAILY_TRIM; faster speeds are offered but the trim can never push the
// budget under the safety floor.
const PAYBACK_RATES = [150, 250, 350];

// Goal pacing: never plan to lose faster than 1% of bodyweight per week (muscle
// retention guidance for people who lift). Slower goals are fine.
const MAX_WEEKLY_LOSS_PCT = 0.01;

// Extra walking, net of the resting burn the TDEE already counts. Net walking cost is
// roughly 0.3 kcal per lb per mile at an easy 3 mph — deliberately the low end, so a
// logged walk can't be over-credited the way tracker numbers are.
const WALK_MPH = 3;
const WALK_NET_KCAL_PER_LB_MILE = 0.3;

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

function paybackRate(state) {
  const r = Number(state?.paybackPerDay);
  return PAYBACK_RATES.includes(r) ? r : MAX_DAILY_TRIM;
}

// Today's trim toward the overage bank: the chosen speed, never more than what's owed,
// never enough to push the budget under the safety floor.
function dailyTrim(state) {
  const p = state.profile;
  const room = Math.max(0, dailyBudget(p) - (BUDGET_FLOOR[p.sex] || 1200));
  return Math.min(paybackRate(state), Math.max(0, state.overageBank || 0), room);
}

// Effective budget today = budget − overage-bank trim + any extra-activity credit for the day.
// `day` may be a plan day or a count-mode log day; walks that were applied to the day count too.
function effectiveBudget(state, day) {
  const p = state.profile;
  const trim = dailyTrim(state);
  const walked = (day?.walks || []).filter((w) => w.applied === "today").reduce((n, w) => n + (w.kcal || 0), 0);
  const credit = Math.min(ACTIVITY_CAP, (day?.activityCredit?.kcal || 0) + walked);
  return { budget: dailyBudget(p) - trim + credit, trim, credit };
}

// Net kcal for an extra walk beyond the routine the activity multiplier already covers.
function walkCredit(minutes, weightLb) {
  const miles = (Math.max(0, minutes) / 60) * WALK_MPH;
  return Math.min(ACTIVITY_CAP, Math.round(miles * WALK_NET_KCAL_PER_LB_MILE * Math.max(0, weightLb || 0)));
}

// Minutes of extra walking needed to cancel `kcal` (uncapped, for honest messaging).
function walkMinutesFor(kcal, weightLb) {
  const perMin = (WALK_MPH / 60) * WALK_NET_KCAL_PER_LB_MILE * Math.max(1, weightLb || 0);
  return Math.ceil(Math.max(0, kcal) / perMin);
}

// How long a given bank takes to clear at each payback speed.
function paybackOptions(state, bank = state.overageBank || 0) {
  const p = state.profile;
  const room = Math.max(0, dailyBudget(p) - (BUDGET_FLOOR[p.sex] || 1200));
  return PAYBACK_RATES.map((rate) => {
    const perDay = Math.min(rate, room);
    return { rate, perDay, days: perDay > 0 ? Math.ceil(bank / perDay) : Infinity, budget: dailyBudget(p) - perDay };
  });
}

/**
 * Goal pacing. Given current weight, goal weight and a target date, work out the daily
 * deficit that gets there — capped at 1%/week of bodyweight and at the budget floor —
 * and say honestly when the date isn't reachable at a safe pace.
 */
function goalPlan(profile, { currentLb, goalLb, goalDate, today }) {
  const p = { ...profile, weightLb: currentLb };
  const maintenance = tdee(p);
  const floor = BUDGET_FLOOR[p.sex] || 1200;
  const toLose = Math.max(0, Math.round((currentLb - goalLb) * 10) / 10);
  const days = Math.max(1, Math.round((parseKey(goalDate) - parseKey(today)) / 86400000));
  const required = Math.round((toLose * KCAL_PER_LB) / days);
  const maxSafe = Math.round((currentLb * MAX_WEEKLY_LOSS_PCT * KCAL_PER_LB) / 7);
  const floorRoom = Math.max(0, maintenance - floor);
  const rounded = Math.round(required / 25) * 25;
  const deficit = Math.max(0, Math.min(rounded, maxSafe, floorRoom));
  const limitedBy = required > maxSafe + 12 && maxSafe <= floorRoom ? "pace" : required > floorRoom + 12 ? "floor" : null;
  const daysNeeded = deficit > 0 ? Math.ceil((toLose * KCAL_PER_LB) / deficit) : Infinity;
  return {
    maintenance, toLose, days, required, maxSafe, deficit, limitedBy,
    budget: maintenance - deficit,
    lbPerWeek: Math.round(((deficit * 7) / KCAL_PER_LB) * 10) / 10,
    daysNeeded,
    eta: Number.isFinite(daysNeeded) ? dateKey(addDays(parseKey(today), daysNeeded)) : null,
  };
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

// ---------- quick-log catalog (count mode) ----------

// Totals for a build-your-own pick list against a menu of components ({id: qty}).
function componentTotals(components, picks) {
  let calories = 0, protein = 0, estimated = false;
  for (const [id, qty] of Object.entries(picks || {})) {
    const c = components.find((x) => x.id === id);
    if (!c || !qty) continue;
    calories += c.calories * qty;
    protein += c.protein * qty;
    if (c.confidence === "estimated") estimated = true;
  }
  return { calories: Math.round(calories), protein: Math.round(protein), estimated };
}

// Same idea for home combos made of products.json items ({product, qty}).
function productTotals(data, state, items) {
  let calories = 0, protein = 0, estimated = false;
  for (const it of items || []) {
    const prod = productById(data, state, it.product);
    if (!prod) continue;
    calories += prod.calories * it.qty;
    protein += prod.protein * it.qty;
    if (prod.confidence === "estimated") estimated = true;
  }
  return { calories: Math.round(calories), protein: Math.round(protein), estimated };
}

/**
 * Flatten restaurants, home combos and Fuel's own meal templates into one list of
 * loggable things: { id, name, emoji, group, calories, protein, estimated, build? }.
 * `build` describes how to customize it ({ kind: "components"|"products", place?, picks|items }).
 */
function catalogItems(eats, data, state) {
  const out = [];
  for (const place of eats?.places || []) {
    for (const it of place.items || []) {
      let m;
      if (it.picks) m = componentTotals(place.components || [], it.picks);
      else m = { calories: it.calories, protein: it.protein, estimated: it.confidence === "estimated" };
      out.push({
        id: it.id, name: it.name, emoji: it.emoji || place.emoji || "🍽", group: place.name, place: place.id,
        calories: m.calories, protein: m.protein, estimated: m.estimated, note: it.note || "",
        build: it.picks ? { kind: "components", place: place.id, picks: { ...it.picks } } : null,
      });
    }
  }
  for (const it of eats?.home || []) {
    const m = productTotals(data, state, it.items);
    out.push({
      id: it.id, name: it.name, emoji: it.emoji || "🏠", group: "Home", calories: m.calories, protein: m.protein,
      estimated: m.estimated, note: it.note || "", build: { kind: "products", items: it.items.map((x) => ({ ...x })) },
    });
  }
  for (const t of data?.templates || []) {
    const m = mealMacros(data, state, t.id, "classic");
    out.push({ id: `meal:${t.id}`, name: t.name, emoji: t.emoji || "🍽", group: "Fuel meals", calories: m.calories, protein: m.protein, estimated: m.estimated, note: "", build: null });
  }
  return out;
}

function logTotals(entries) {
  let calories = 0, protein = 0;
  for (const e of entries || []) {
    const q = Number.isFinite(e.qty) ? e.qty : 1;
    calories += (e.calories || 0) * q;
    protein += (e.protein || 0) * q;
  }
  return { calories: Math.round(calories), protein: Math.round(protein) };
}

/**
 * Close out finished count-mode days, oldest first. A day that ended over its budget
 * adds the excess to the overage bank; every logged day pays down that day's trim.
 * Under-eating never earns credit (that's the restrict-then-binge loop). Days with
 * nothing logged are left alone — no data is not the same as eating zero.
 * Mutates state; returns the list of days it settled.
 */
function settleCountDays(state, todayK) {
  const settled = [];
  const keys = Object.keys(state.foodLog || {}).filter((k) => k < todayK).sort();
  for (const k of keys) {
    const day = state.foodLog[k];
    if (!day || day.settled || !(day.entries || []).length) continue;
    const { budget, trim } = effectiveBudget(state, day);
    const eaten = logTotals(day.entries).calories;
    const over = Math.max(0, eaten - budget);
    state.overageBank = Math.max(0, (state.overageBank || 0) - trim) + over;
    day.settled = { budget, trim, over, eaten };
    settled.push({ key: k, ...day.settled });
  }
  return settled;
}

/**
 * A past day was edited after it was settled (forgot to log dinner, fixed a number).
 * Keep the day's original budget and trim, and move the bank by exactly the change
 * in that day's overage — never re-run the whole history.
 */
function resettleDay(state, key) {
  const day = state.foodLog?.[key];
  if (!day?.settled) return 0;
  const eaten = logTotals(day.entries).calories;
  const over = Math.max(0, eaten - day.settled.budget);
  const delta = over - day.settled.over;
  state.overageBank = Math.max(0, (state.overageBank || 0) + delta);
  day.settled = { ...day.settled, over, eaten };
  return delta;
}

/**
 * "What fits right now": things you actually eat that fit the calories left, best
 * protein-per-calorie first, with a nudge toward closing the protein gap.
 */
function suggestFits(items, kcalLeft, proteinLeft, limit = 4) {
  if (kcalLeft < 80) return [];
  return items
    .filter((i) => i.calories > 0 && i.calories <= kcalLeft)
    .map((i) => {
      const density = i.protein / Math.max(1, i.calories); // g per kcal
      const closes = proteinLeft > 0 ? Math.min(1, i.protein / proteinLeft) : 0;
      const usesRoom = i.calories / kcalLeft; // prefer real meals over a stick of gum when there's room
      return { ...i, score: density * 100 + closes * 3 + usesRoom * 2 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Open Food Facts product JSON → a loggable food. Prefers per-serving numbers and
 * falls back to per-100 g, so the caller can scale by grams when there's no serving.
 * Returns null when the product has no calorie data.
 */
function parseOpenFoodFacts(json) {
  const p = json?.product;
  if (!p || json.status === 0) return null;
  const n = p.nutriments || {};
  const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
  const kcal100 = num(n["energy-kcal_100g"]) ?? (num(n["energy_100g"]) !== null ? num(n["energy_100g"]) / 4.184 : null);
  const prot100 = num(n["proteins_100g"]);
  const servingG = num(p.serving_quantity);
  let kcalServ = num(n["energy-kcal_serving"]);
  let protServ = num(n["proteins_serving"]);
  if (kcalServ === null && kcal100 !== null && servingG) kcalServ = (kcal100 * servingG) / 100;
  if (protServ === null && prot100 !== null && servingG) protServ = (prot100 * servingG) / 100;
  if (kcalServ === null && kcal100 === null) return null;
  const name = [p.brands?.split(",")[0]?.trim(), p.product_name || p.generic_name].filter(Boolean).join(" ") || "Scanned item";
  return {
    name,
    serving: kcalServ !== null ? (p.serving_size || (servingG ? `${servingG} g` : "1 serving")) : "100 g",
    servingG: kcalServ !== null ? servingG : 100,
    calories: Math.round(kcalServ ?? kcal100),
    protein: Math.round((protServ ?? prot100 ?? 0) * 10) / 10,
    per100: kcal100 !== null ? { calories: Math.round(kcal100), protein: Math.round((prot100 ?? 0) * 10) / 10 } : null,
  };
}

/**
 * The Mon–Sun deficit picture for count mode: how far under maintenance the logged days
 * landed, versus what the goal deficit would have banked. One big day shows up here as
 * exactly what it is — some days of progress erased, not a failed week.
 */
function weekBalance(state, todayK) {
  const p = state.profile;
  const start = weekStart(parseKey(todayK));
  const maint = tdee(p);
  const days = [];
  let deficit = 0, target = 0, walked = 0;
  for (let i = 0; i < 7; i++) {
    const k = dateKey(addDays(start, i));
    if (k > todayK) break;
    const d = state.foodLog?.[k];
    const w = (d?.walks || []).reduce((n, x) => n + (x.kcal || 0), 0);
    walked += w;
    if (!d || !(d.entries || []).length) { days.push({ key: k, logged: false, walked: w }); continue; }
    const eaten = logTotals(d.entries).calories;
    const { budget } = d.settled ? { budget: d.settled.budget } : effectiveBudget(state, d);
    const isToday = k === todayK;
    // Today isn't over yet: assume the rest of today's budget gets eaten (or what's
    // already eaten, if that's more), so the week number never looks better than it is.
    const dayDef = isToday ? maint - Math.max(eaten, budget) : maint - eaten;
    deficit += dayDef + w;
    target += p.deficit;
    days.push({ key: k, logged: true, eaten, budget, over: Math.max(0, eaten - budget), walked: w, isToday });
  }
  return { days, deficit: Math.round(deficit), target, lb: Math.round((deficit / KCAL_PER_LB) * 10) / 10, maintenance: maint, walked };
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

export {
  ACTIVITY_FACTORS, MAX_DAILY_TRIM, KCAL_PER_LB, ACTIVITY_DISCOUNT, ACTIVITY_CAP, PAYBACK_RATES, MAX_WEEKLY_LOSS_PCT, BUDGET_FLOOR,
  paybackRate, dailyTrim, walkCredit, walkMinutesFor, paybackOptions, goalPlan,
  componentTotals, productTotals, catalogItems, logTotals, settleCountDays, resettleDay, weekBalance, suggestFits, parseOpenFoodFacts,
  dateKey, parseKey, addDays, weekStart, fmtDay,
  bmr, tdee, dailyBudget, budgetIsFloored, proteinTarget, effectiveBudget, activityCreditFromTracker, goalProjection, latestWeight,
  productById, templateById, variantOf, mealIngredients, mealMacros, snackMacros, dayTotals, dayConsumed,
  generateWeek, recordHistory, shoppingList, collectCarryover, perishUrgency, weekQuality, calibration,
};
