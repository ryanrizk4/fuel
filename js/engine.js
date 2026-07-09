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

// Effective budget today = budget − overage-bank trim + any extra-activity credit for the day
function effectiveBudget(state, day) {
  const p = state.profile;
  const trim = Math.min(MAX_DAILY_TRIM, Math.max(0, state.overageBank || 0));
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
  if (recentTpls?.has(tpl.id) && !tpl.repeatOk) score -= 14; // planned in an adjacent week already
  score -= Math.max(0, tpl.prepMinutes - 30) * 0.2; // keep overall prep short
  if (data) score += perishUrgency(data, tpl) * (6 - dayIndex) * 0.8;
  if (rng) score += rng() * 7; // seeded variety — each re-plan explores a different plan
  return score;
}

function pickVariant(state, tpl, todayKey) {
  let best = tpl.variants[0], bestAge = -1;
  for (const v of tpl.variants) {
    const age = daysSinceUse(state, `v:${tpl.id}:${v.id}`, todayKey);
    if (age > bestAge) { bestAge = age; best = v; }
  }
  return best.id;
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
      meals.push({ slot: "breakfast", templateId: bTpl.id, variantId: pickVariant(state, bTpl, key) });
    }

    // lunch — weekday lunches respect the work-time cap (he cooks at/for work)
    const lLocked = keepLocked("lunch");
    if (lLocked) meals.push(lLocked);
    else {
      let pool = lunches;
      const dowL = addDays(start, i).getDay();
      const isWorkday = dowL >= 1 && dowL <= 5;
      const lunchCap = mode === "easy" ? 15 : isWorkday ? (p.maxLunchMinutes || 60) : 60;
      const quick = pool.filter((t) => t.prepMinutes <= lunchCap);
      if (quick.length) pool = quick;
      const tpl = pool.sort((a, b) =>
        scoreTemplate(state, b, key, usedThisWeek, carryover, data, i, rng, recentTpls) - scoreTemplate(state, a, key, usedThisWeek, carryover, data, i, rng, recentTpls))[0];
      meals.push({ slot: "lunch", templateId: tpl.id, variantId: pickVariant(state, tpl, key) });
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
        meals.push({ slot: "dinner", templateId: batchTpl.id, variantId: pickVariant(state, batchTpl, key), batchCook: true });
        usedThisWeek[batchTpl.id + ":batch"] = 1;
        usedThisWeek[batchTpl.id] = (usedThisWeek[batchTpl.id] || 0) + 1;
      } else if (frz && (mode === "easy" || i % 2 === 1)) {
        meals.push({ slot: "dinner", templateId: frz.templateId, variantId: frz.variantId || "classic", fromFreezer: true });
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
        meals.push({ slot: "dinner", templateId: tpl.id, variantId: pickVariant(state, tpl, key) });
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
      while (room > 150 && day.snacks.length < 4 && guard < 6) {
        const s = proteins[(i + guard) % proteins.length];
        guard++;
        if (!s || s.calories > room - 60) continue;
        if (day.snacks.some((x) => x.productId === s.id)) continue;
        day.snacks.push({ productId: s.id, qty: 1 });
        room -= s.calories;
      }
    }
    days[key] = day;
  }
  return days;
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

export {
  ACTIVITY_FACTORS, MAX_DAILY_TRIM, KCAL_PER_LB, ACTIVITY_DISCOUNT, ACTIVITY_CAP,
  dateKey, parseKey, addDays, weekStart, fmtDay,
  bmr, tdee, dailyBudget, budgetIsFloored, proteinTarget, effectiveBudget, activityCreditFromTracker, goalProjection, latestWeight,
  productById, templateById, variantOf, mealIngredients, mealMacros, snackMacros, dayTotals, dayConsumed,
  generateWeek, recordHistory, shoppingList, collectCarryover, perishUrgency,
};
