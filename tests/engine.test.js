/* Engine math tests — the numbers the whole app hangs on. Run: node --test tests/ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../js/engine.js";

const DATA = {
  products: JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url))).products,
  templates: JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url))).templates,
};

const PROFILE = {
  sex: "male", age: 28, heightIn: 70, weightLb: 185,
  activity: "moderate", deficit: 500, goalLossLb: 10,
  startWeightLb: 185, startDate: "2026-07-01",
  breakfastDefault: "latte", treatsPerWeek: 3, proteinPerLb: 1.0,
};

const START = E.dateKey(E.weekStart(E.addDays(new Date(), 7))); // next Monday
const DAY2 = E.dateKey(E.addDays(E.parseKey(START), 1));

function freshState(extra = {}) {
  return {
    profile: { ...PROFILE },
    plan: { days: {} },
    weighIns: [], freezer: [], history: {}, productOverrides: {},
    shopChecks: {}, overageBank: 0, planMode: "auto",
    ...extra,
  };
}

// ---------- profile math ----------

test("BMR matches Mifflin-St Jeor by hand", () => {
  // 185lb=83.916kg, 70in=177.8cm → 10*83.916 + 6.25*177.8 - 5*28 + 5 = 1815.4
  assert.equal(E.bmr(PROFILE), 1815);
});

test("TDEE = BMR × activity factor", () => {
  assert.equal(E.tdee(PROFILE), Math.round(E.bmr(PROFILE) * 1.55)); // 2813
});

test("daily budget = TDEE − deficit, floored for safety", () => {
  assert.equal(E.dailyBudget(PROFILE), E.tdee(PROFILE) - 500);
  const tiny = { ...PROFILE, weightLb: 100, heightIn: 60, age: 60, activity: "sedentary", deficit: 750 };
  assert.equal(E.dailyBudget(tiny), 1500, "male floor is 1500");
  assert.ok(E.budgetIsFloored(tiny));
});

test("protein target: 1g per lb of IDEAL body weight", () => {
  assert.equal(E.proteinTarget(PROFILE), 175, "185 start − 10 goal = 175 lb ideal → 175g");
});

test("re-planning with a new seed produces a different week; same seed is stable", () => {
  const s = freshState();
  const a = E.generateWeek(DATA, s, START, "auto", 1);
  const b = E.generateWeek(DATA, s, START, "auto", 2);
  const c = E.generateWeek(DATA, s, START, "auto", 1);
  const sig = (w) => JSON.stringify(Object.values(w).map((d) => d.meals.map((m) => m.templateId + ":" + m.variantId)));
  assert.notEqual(sig(a), sig(b), "different seeds must explore different plans");
  assert.equal(sig(a), sig(c), "same seed reproduces the same plan");
});

test("next week avoids repeating this week's non-repeatable meals", () => {
  const s = freshState();
  s.plan.days = E.generateWeek(DATA, s, START, "auto", 1);
  const week2Start = E.dateKey(E.addDays(E.parseKey(START), 7));
  const week2 = E.generateWeek(DATA, s, week2Start, "auto", 1);
  const w1 = new Set(Object.values(s.plan.days).flatMap((d) => d.meals.map((m) => m.templateId)));
  const repeats = Object.values(week2).flatMap((d) => d.meals)
    .filter((m) => { const tpl = E.templateById(DATA, m.templateId); return tpl && !tpl.repeatOk && w1.has(m.templateId); });
  assert.ok(repeats.length <= 2, `${repeats.length} non-repeatable meals repeated across weeks`);
});

test("past days are never rewritten by re-planning", () => {
  const s = freshState();
  const thisWeek = E.dateKey(E.weekStart(new Date()));
  const yesterdayish = thisWeek; // Monday of the current week is today-or-past
  s.plan.days[yesterdayish] = { status: "planned", meals: [{ slot: "dinner", templateId: "turkey-burgers", variantId: "classic" }], snacks: [] };
  const regen = E.generateWeek(DATA, s, thisWeek, "auto", 99);
  if (yesterdayish < E.dateKey(new Date()))
    assert.equal(regen[yesterdayish].meals[0].templateId, "turkey-burgers", "past day untouched");
});

test("effective budget trims at most MAX_DAILY_TRIM for the overage bank", () => {
  const s = freshState({ overageBank: 1000 });
  const { budget, trim } = E.effectiveBudget(s);
  assert.equal(trim, E.MAX_DAILY_TRIM);
  assert.equal(budget, E.dailyBudget(PROFILE) - E.MAX_DAILY_TRIM);
  const s2 = freshState({ overageBank: 80 });
  assert.equal(E.effectiveBudget(s2).trim, 80, "small banks trim only what's owed");
});

test("activity credits: 50% discount, hard cap, only applied to the specific day", () => {
  assert.equal(E.activityCreditFromTracker(400), 200, "tracker 400 → eat 200");
  assert.equal(E.activityCreditFromTracker(2000), E.ACTIVITY_CAP, "capped — a wild estimate can't erase the deficit");
  assert.equal(E.activityCreditFromTracker(-50), 0);
  const s = freshState();
  const hikeDay = { activityCredit: { kcal: 250, label: "hike" } };
  assert.equal(E.effectiveBudget(s, hikeDay).budget, E.dailyBudget(PROFILE) + 250);
  assert.equal(E.effectiveBudget(s, {}).budget, E.dailyBudget(PROFILE), "other days unaffected");
});

test("activity credit and overage trim compose", () => {
  const s = freshState({ overageBank: 1000 });
  const day = { activityCredit: { kcal: 200, label: "hike" } };
  assert.equal(E.effectiveBudget(s, day).budget, E.dailyBudget(PROFILE) - E.MAX_DAILY_TRIM + 200);
});

test("goal projection: 10 lb at 500/day deficit ≈ 70 days, overage pushes it out", () => {
  const clean = E.goalProjection(freshState());
  assert.ok(Math.abs(clean.daysLeft - 70) <= 3, `expected ~70 days, got ${clean.daysLeft}`);
  const withBank = E.goalProjection(freshState({ overageBank: 1500 }));
  assert.ok(withBank.daysLeft > clean.daysLeft, "overage bank must push the goal date out");
});

// ---------- meals & macros ----------

test("variant add/remove changes the ingredient list correctly", () => {
  const tpl = E.templateById(DATA, "tortilla-melt");
  const classic = E.mealIngredients(tpl, "classic").map((i) => i.product);
  assert.ok(classic.includes("zaatar"));
  const salsa = E.mealIngredients(tpl, "salsa").map((i) => i.product);
  assert.ok(!salsa.includes("zaatar"), "salsa variant removes za'atar");
  assert.ok(salsa.includes("tj-salsa"));
});

test("batch templates report per-serving macros", () => {
  const perServing = E.mealMacros(DATA, {}, "beef-ragu-batch", "classic");
  // 1lb beef(4×200) + 4×90 marinara + 4×355 pasta = 2580 / 4 servings = 645
  assert.equal(perServing.calories, 645);
});

test("portions scale macros linearly", () => {
  const one = E.mealMacros(DATA, {}, "turkey-burgers", "classic", 1);
  const two = E.mealMacros(DATA, {}, "turkey-burgers", "classic", 2);
  assert.equal(two.calories, one.calories * 2);
  assert.equal(two.protein, one.protein * 2);
});

test("product overrides (label verification) win over shipped estimates", () => {
  const s = freshState({ productOverrides: { "tj-cottage-cheese-lowfat": { calories: 100, protein: 14 } } });
  const p = E.productById(DATA, s, "tj-cottage-cheese-lowfat");
  assert.equal(p.calories, 100);
  assert.equal(p.confidence, "verified");
});

test("custom snacks count their own macros; uneaten snacks don't count as consumed", () => {
  const s = freshState();
  const day = {
    meals: [], eaten: [],
    snacks: [{ custom: { name: "shawarma", calories: 700, protein: 40 }, eaten: true }, { productId: "apple", qty: 1, eaten: false }],
  };
  assert.equal(E.dayConsumed(DATA, s, day).calories, 700, "apple not eaten yet");
  assert.equal(E.dayTotals(DATA, s, day).calories, 795, "planned total counts both");
});

// ---------- auto-plan ----------

test("generateWeek plans 7 days near budget, protein at/above target", () => {
  const s = freshState();
  const days = E.generateWeek(DATA, s, START, "auto");
  const keys = Object.keys(days);
  assert.equal(keys.length, 7);
  const budget = E.dailyBudget(PROFILE);
  for (const k of keys) {
    const t = E.dayTotals(DATA, s, days[k]);
    assert.ok(t.calories <= budget, `${k} over budget: ${t.calories} > ${budget}`);
    assert.ok(t.calories >= budget - 600, `${k} badly under budget: ${t.calories} vs ${budget}`);
    assert.ok(t.protein >= E.proteinTarget(PROFILE) * 0.85, `${k} protein too low: ${t.protein}g`);
    assert.equal(days[k].meals.length, 3, "breakfast + lunch + dinner");
  }
});

test("treats respect the weekly allowance", () => {
  const s = freshState();
  s.profile.treatsPerWeek = 2;
  const days = E.generateWeek(DATA, s, START, "auto");
  const treats = Object.values(days).flatMap((d) => d.snacks)
    .filter((sn) => sn.productId && DATA.products.find((p) => p.id === sn.productId)?.treat);
  assert.ok(treats.length <= 2, `planned ${treats.length} treats, allowance is 2`);
});

test("locked meals and completed days survive re-planning", () => {
  const s = freshState();
  const days = E.generateWeek(DATA, s, START, "auto");
  s.plan.days = days;
  const k1 = START, k2 = DAY2;
  s.plan.days[k1].status = "done";
  const frozenMeals = JSON.stringify(s.plan.days[k1].meals);
  s.plan.days[k2].meals.find((m) => m.slot === "lunch").locked = true;
  s.plan.days[k2].meals.find((m) => m.slot === "lunch").templateId = "tuna-pasta-salad";
  const regen = E.generateWeek(DATA, s, START, "auto");
  assert.equal(JSON.stringify(regen[k1].meals), frozenMeals, "done day untouched");
  assert.equal(regen[k2].meals.find((m) => m.slot === "lunch").templateId, "tuna-pasta-salad", "locked meal kept");
});

test("freezer portions get scheduled and prep mode schedules a weekend batch cook", () => {
  const s = freshState({ freezer: [{ templateId: "beef-ragu-batch", portions: 2 }] });
  const days = E.generateWeek(DATA, s, START, "easy");
  const fromFreezer = Object.values(days).flatMap((d) => d.meals).filter((m) => m.fromFreezer);
  assert.ok(fromFreezer.length >= 1 && fromFreezer.length <= 2, "uses freezer stock without exceeding it");

  const prep = E.generateWeek(DATA, freshState(), START, "prep");
  const batch = Object.entries(prep).filter(([, d]) => d.meals.some((m) => m.batchCook));
  assert.equal(batch.length, 1, "exactly one batch-cook day");
  const dow = new Date(batch[0][0] + "T12:00:00").getDay();
  assert.ok(dow === 0 || dow === 6, "batch cook lands on a weekend");
});

test("weekday lunches respect the work-time cap; weekends are free", () => {
  const s = freshState();
  s.profile.maxLunchMinutes = 15;
  const days = E.generateWeek(DATA, s, START, "auto"); // Mon start
  const keys = Object.keys(days).sort();
  for (let i = 0; i < 5; i++) { // Mon-Fri
    const lunch = days[keys[i]].meals.find((m) => m.slot === "lunch");
    const tpl = E.templateById(DATA, lunch.templateId);
    assert.ok(tpl.prepMinutes <= 15, `${keys[i]} weekday lunch ${tpl.id} takes ${tpl.prepMinutes} min`);
  }
});

test("weekday lunches never require cooking raw protein at work", () => {
  const days = E.generateWeek(DATA, freshState(), START, "auto"); // Mon start
  const keys = Object.keys(days).sort();
  for (let i = 0; i < 5; i++) { // Mon-Fri
    const lunch = days[keys[i]].meals.find((m) => m.slot === "lunch");
    const tpl = E.templateById(DATA, lunch.templateId);
    assert.ok(tpl.lunchAtWork || lunch.fromFreezer, `${keys[i]} weekday lunch ${tpl.id} isn't work-friendly (no cooking raw meat at the office)`);
  }
});

test("non-repeatable meals don't appear twice in a week", () => {
  const days = E.generateWeek(DATA, freshState(), START, "auto");
  const counts = {};
  for (const d of Object.values(days))
    for (const m of d.meals) counts[m.templateId] = (counts[m.templateId] || 0) + 1;
  for (const [id, n] of Object.entries(counts)) {
    const tpl = E.templateById(DATA, id);
    if (tpl && !tpl.repeatOk) assert.ok(n <= 2, `${id} is repeatOk:false but planned ${n}×`);
  }
});

test("generated meals carry a why explanation; quality score reflects the week", () => {
  const s = freshState();
  const days = E.generateWeek(DATA, s, START, "auto", 1);
  for (const d of Object.values(days))
    for (const m of d.meals)
      if (m.slot !== "breakfast") assert.ok(m.why?.length > 8, `${m.templateId} missing why`);
  const q = E.weekQuality(DATA, s, days);
  assert.equal(q.totalDays, 7);
  assert.ok(q.proteinDays >= 6, `only ${q.proteinDays}/7 protein days`);
  assert.ok(q.uniqueMeals >= 8, `only ${q.uniqueMeals} distinct meals`);
  assert.ok(q.prepMinutes > 0 && q.prepMinutes < 7 * 90);
});

test("calibration: flags a stalled trend, stays quiet when on track or data is thin", () => {
  const mk = (pairs) => freshState({ weighIns: pairs.map(([d, lb]) => ({ date: d, lb })) });
  assert.equal(E.calibration(mk([["2026-06-01", 185]])), null, "needs 3+ points");
  const behind = E.calibration(mk([["2026-06-01", 185], ["2026-06-08", 184.9], ["2026-06-15", 184.8]]));
  assert.equal(behind.status, "behind", "losing 0.05 lb/wk vs 1.0 planned must flag");
  const good = E.calibration(mk([["2026-06-01", 185], ["2026-06-08", 184], ["2026-06-15", 183]]));
  assert.equal(good.status, "on-track");
  const fast = E.calibration(mk([["2026-06-01", 185], ["2026-06-08", 182.8], ["2026-06-15", 180.6]]));
  assert.equal(fast.status, "fast", "2.2 lb/wk should warn");
});

test("opened items boost meals that use them within 3 days", () => {
  const s = freshState({ opened: { "tj-cottage-cheese-lowfat": START } });
  const days = E.generateWeek(DATA, s, START, "auto", 1);
  const keys = Object.keys(days).sort();
  const early = keys.slice(0, 3).flatMap((k) => days[k].meals.map((m) => m.templateId));
  const usesOpened = early.some((id) => {
    const tpl = E.templateById(DATA, id);
    return tpl?.base.some((i) => i.product === "tj-cottage-cheese-lowfat");
  });
  assert.ok(usesOpened, "an early meal should use the opened cottage cheese");
});

// ---------- shopping list ----------

test("shopping list aggregates the week, skips freezer meals, multiplies batch + portions", () => {
  const s = freshState();
  s.plan.days = {
    "2026-07-06": { status: "planned", meals: [{ slot: "dinner", templateId: "turkey-burgers", variantId: "classic", portions: 2 }], snacks: [] },
    "2026-07-07": { status: "planned", meals: [{ slot: "dinner", templateId: "beef-ragu-batch", variantId: "classic", batchCook: true }], snacks: [] },
    "2026-07-08": { status: "planned", meals: [{ slot: "dinner", templateId: "beef-ragu-batch", variantId: "classic", fromFreezer: true }], snacks: [] },
    "2026-07-09": { status: "skipped", meals: [{ slot: "dinner", templateId: "shawarma-bowl", variantId: "classic" }], snacks: [] },
  };
  const { sections: list } = E.shoppingList(DATA, s, "2026-07-06");
  const flat = list.flatMap((sec) => sec.items);
  const patties = flat.find((i) => i.id === "tj-turkey-patty");
  assert.equal(patties.qty, 4, "2 patties × 2 portions");
  assert.equal(patties.packs, 1, "4 patties = one 4-pack");
  const beef = flat.find((i) => i.id === "tj-ground-beef-90");
  assert.equal(beef.qty, 4, "batch cook buys the full 4 servings (1 lb)");
  assert.ok(!flat.find((i) => i.id === "tj-shawarma-thighs"), "skipped day excluded");
  // freezer day contributes nothing beyond the batch (already counted)
  const pasta = flat.find((i) => i.id === "tj-pasta-dry");
  assert.equal(pasta.qty, 4, "freezer meal doesn't re-buy ingredients");
});

test("estimated products are flagged for label verification", () => {
  const s = freshState();
  s.plan.days = {
    "2026-07-06": { status: "planned", meals: [{ slot: "lunch", templateId: "tortilla-melt", variantId: "classic" }], snacks: [] },
  };
  const flat = E.shoppingList(DATA, s, "2026-07-06").sections.flatMap((sec) => sec.items);
  // use a product that is still label-unverified as the fixture
  const est = DATA.products.find((p) => p.confidence === "estimated");
  assert.ok(est, "at least one estimated product should exist for this test");
  const cc = flat.find((i) => i.id === "tj-cottage-cheese-lowfat");
  assert.equal(cc.needsVerify, false, "cottage cheese is now label-verified");
  const egg = flat.find((i) => i.id === "tj-large-egg");
  assert.equal(egg.needsVerify, false);
});

test("stocked staples move off the buy list; marking one 'out' brings it back", () => {
  const s = freshState();
  s.plan.days = {
    "2026-07-06": { status: "planned", meals: [{ slot: "dinner", templateId: "turkey-burgers", variantId: "classic" }], snacks: [] },
  };
  const before = E.shoppingList(DATA, s, "2026-07-06");
  assert.ok(before.sections.flatMap((x) => x.items).some((i) => i.id === "mustard-yellow"), "mustard on first-ever list");
  s.pantry = { "mustard-yellow": true, "ketchup": true, "hot-sauce": true };
  const after = E.shoppingList(DATA, s, "2026-07-06");
  const buyIds = after.sections.flatMap((x) => x.items).map((i) => i.id);
  assert.ok(!buyIds.includes("mustard-yellow"), "stocked staple not re-listed");
  assert.ok(after.stocked.some((i) => i.id === "mustard-yellow"), "shown on the staples shelf instead");
  assert.ok(buyIds.includes("tj-turkey-patty"), "non-staples unaffected");
});

test("perishable meals score urgent and get scheduled early in the week", () => {
  const salmon = E.templateById(DATA, "zaatar-salmon-bowl");
  const burgers = E.templateById(DATA, "turkey-burgers"); // frozen patties, shelf-stable
  assert.ok(E.perishUrgency(DATA, salmon) > E.perishUrgency(DATA, burgers), "fresh salmon more urgent than frozen patties");
  const s = freshState();
  const days = E.generateWeek(DATA, s, START, "auto");
  const keys = Object.keys(days).sort();
  const idxOfUrgent = keys.findIndex((k) =>
    days[k].meals.some((m) => E.perishUrgency(DATA, E.templateById(DATA, m.templateId)) >= 4));
  if (idxOfUrgent !== -1) assert.ok(idxOfUrgent <= 3, `most-perishable meal lands day ${idxOfUrgent + 1}, expected in first 4`);
});

test("legacy state (pre-pantry/favorites/opened fields) still works everywhere", () => {
  const legacy = { profile: { ...PROFILE }, plan: { days: {} }, weighIns: [], history: {} };
  const days = E.generateWeek(DATA, legacy, START, "auto", 1);
  assert.equal(Object.keys(days).length, 7, "generateWeek tolerates missing fields");
  legacy.plan.days = days;
  const list = E.shoppingList(DATA, legacy, START);
  assert.ok(list.sections.length > 0, "shoppingList tolerates missing pantry");
  assert.ok(E.effectiveBudget(legacy).budget > 0, "effectiveBudget tolerates missing overageBank");
  assert.equal(E.calibration(legacy), null, "calibration quiet without weigh-ins");
});

// ---------- carryover ----------

test("skipped days prioritize their templates next week (groceries already bought)", () => {
  const s = freshState();
  s.plan.days["2026-07-04"] = { status: "skipped", meals: [{ slot: "dinner", templateId: "big-mac-bowl", variantId: "classic" }], snacks: [] };
  const carry = E.collectCarryover(DATA, s, E.parseKey("2026-07-06"));
  assert.ok(carry.has("big-mac-bowl"));
});

// ---------- self-monitoring: urges (CBT-E) ----------
// The rules these tests exist to hold: an urge belongs to the night it happened on
// (not the calendar day), a pattern is never claimed from too few entries, regular
// eating is read as yes/no per day, and nothing on this side of the app ever reads
// a calorie or a weight.

const END = "2026-08-29"; // a Saturday — the window these tests all end on

// hour is local-clock hour at logging time, exactly as newUrge records it
function urge(date, hour, extra = {}) {
  const at = `${date}T${String(hour).padStart(2, "0")}:30:00.000Z`;
  return { id: at, at, date, hour, seeking: [], hunger: null, cannabis: null, company: null, before: "", thought: "", outcome: null, outcomeAt: null, ...extra };
}

// A day the planner filled in: `eaten` is the indices actually checked off.
function planDay(meals = 3, eaten = meals, status = "planned") {
  return {
    status,
    meals: Array.from({ length: meals }, (_, i) => ({ slot: ["breakfast", "lunch", "dinner"][i] || "dinner", templateId: "latte", variantId: "classic" })),
    eaten: Array.from({ length: eaten }, (_, i) => i),
    snacks: [],
  };
}

function urgeState(urges = [], days = {}) {
  return { profile: { ...PROFILE }, plan: { days }, urges, weighIns: [], overageBank: 0 };
}

test("an urge before 4am belongs to the night before, not the calendar day", () => {
  assert.equal(E.urgeNightKey(urge("2026-08-29", 1)), "2026-08-28", "1am Saturday is Friday night");
  assert.equal(E.urgeNightKey(urge("2026-08-29", 4)), "2026-08-29", "4am is its own morning");
  assert.equal(E.urgeNightKey(urge("2026-08-28", 23)), "2026-08-28");
});

test("urgePattern counts nights, hours, seeking, cannabis and outcomes", () => {
  const s = urgeState([
    urge("2026-08-28", 23, { seeking: ["escape", "reward"], hunger: 3, cannabis: "hour", company: "alone", outcome: "escalated" }),
    urge("2026-08-29", 1, { seeking: ["reward"], hunger: 2, cannabis: "hour", company: "alone", outcome: "rode-out" }),
    urge("2026-08-22", 22, { seeking: ["comfort"], hunger: 7, cannabis: "none", company: "with-people" }),
  ]);
  const p = E.urgePattern(s, { endKey: END });

  assert.equal(p.n, 3);
  assert.equal(p.byDow[4], 2, "both late-Friday entries land on Friday, including the 1am one");
  assert.equal(p.byHour[23], 1);
  assert.equal(p.byHour[1], 1);
  assert.equal(p.seeking[0].id, "reward", "seeking is ranked by count");
  assert.equal(p.seeking[0].count, 2);
  assert.equal(p.cannabis.hour, 2);
  assert.equal(p.company.alone, 2);
  assert.deepEqual(p.outcomes, { "rode-out": 1, "as-planned": 0, escalated: 1, open: 1 });
  assert.equal(p.medianHunger, 3);
  assert.equal(p.rodeOutShare, 0.5, "share is of closed entries — an open one can't be an outcome");
});

test("urgePattern only looks inside its window", () => {
  const s = urgeState([urge("2026-08-28", 23), urge("2026-06-01", 23)]);
  assert.equal(E.urgePattern(s, { endKey: END, weeks: 6 }).n, 1);
  assert.equal(E.urgePattern(s, { endKey: END, weeks: 26 }).n, 2);
});

test("decisionPoint refuses to call a pattern from too few entries", () => {
  const few = urgeState(Array.from({ length: E.MIN_PATTERN_N - 1 }, (_, i) => urge("2026-08-2" + (1 + i), 23)));
  assert.equal(E.decisionPoint(E.urgePattern(few, { endKey: END })), null);
});

test("decisionPoint finds the night and an hour band that wraps midnight", () => {
  const s = urgeState([
    urge("2026-08-28", 23), urge("2026-08-29", 0), urge("2026-08-29", 1),
    urge("2026-08-21", 23), urge("2026-08-25", 14),
  ]);
  const dp = E.decisionPoint(E.urgePattern(s, { endKey: END }));
  assert.deepEqual(dp.nightLabels, ["Fri"], "four of five entries are Friday nights");
  assert.equal(dp.nightCount, 4);
  assert.equal(dp.hourFrom, 23);
  assert.equal(dp.hourTo, 2, "the band is scanned around the clock, so 11pm–2am is one window");
  assert.equal(dp.hourCount, 4);
  assert.match(dp.label, /Fri · 11pm–2am/);
});

test("regular eating is read per day as yes/no, never as amounts", () => {
  const days = {
    "2026-08-24": planDay(3, 3),
    "2026-08-25": planDay(3, 1),
    "2026-08-26": planDay(3, 0),
    "2026-08-27": planDay(3, 0, "skipped"),  // ate out — nothing to read
    "2026-08-28": planDay(3, 0, "over"),     // went over: he ate, and then some
    "2026-08-29": planDay(3, 1),             // today, still in progress
  };
  const s = urgeState([], days);
  const status = (k) => E.regularEatingDay(s, k, END).status;

  assert.equal(status("2026-08-24"), "complete");
  assert.equal(status("2026-08-25"), "partial");
  assert.equal(status("2026-08-26"), "missed");
  assert.equal(status("2026-08-27"), "untracked");
  assert.equal(status("2026-08-28"), "complete");
  assert.equal(status("2026-08-29"), "today");
  assert.equal(status("2026-08-30"), "none", "no plan is not the same as a missed day");

  const summary = E.regularEating(s, END, 7);
  assert.equal(summary.counted, 4, "today, ate-out and unplanned days stay out of the denominator");
  assert.equal(summary.complete, 2);
  assert.equal(summary.rate, 0.5);
});

test("restraintSignal compares the days before an urge against the same window's baseline", () => {
  const days = {};
  // A steady baseline of complete days...
  for (let i = 1; i <= 40; i++) days[E.dateKey(E.addDays(E.parseKey(END), -i))] = planDay(3, 3);
  // ...except the three days before each of four Friday-night urges.
  const nights = ["2026-08-28", "2026-08-21", "2026-08-14", "2026-08-07"];
  for (const night of nights) {
    for (let i = 1; i <= 3; i++) days[E.dateKey(E.addDays(E.parseKey(night), -i))] = planDay(3, 0);
  }
  const s = urgeState(nights.map((n) => urge(n, 23)), days);
  const sig = E.restraintSignal(s, { endKey: END, weeks: 6 });

  assert.equal(sig.nights, 4);
  assert.equal(sig.priorDays, 12);
  assert.equal(sig.priorRate, 0, "eating fell apart in the run-up to every logged urge");
  assert.ok(sig.baseRate > sig.priorRate);
  assert.equal(sig.direction, "less-regular");
  assert.ok(sig.enough, "four nights and twelve prior days clears the floor for saying anything");
});

test("restraintSignal says it doesn't know rather than reading a trend off two entries", () => {
  const s = urgeState([urge("2026-08-28", 23)], { "2026-08-27": planDay(3, 3) });
  const sig = E.restraintSignal(s, { endKey: END });
  assert.equal(sig.enough, false);
});

test("the pattern side never reads a calorie or a weight", () => {
  const urges = [
    urge("2026-08-28", 23, { seeking: ["escape"], hunger: 4, cannabis: "hour", company: "alone", outcome: "escalated" }),
    urge("2026-08-21", 23, { seeking: ["reward"], hunger: 2, outcome: "rode-out" }),
  ];
  const days = { "2026-08-27": planDay(3, 3), "2026-08-26": planDay(3, 0) };
  const bare = { profile: { ...PROFILE }, plan: { days }, urges };
  const loaded = {
    ...bare,
    weighIns: [{ date: "2026-08-01", lb: 157 }, { date: "2026-08-28", lb: 161 }],
    overageBank: 2400,
    plan: { days: Object.fromEntries(Object.entries(days).map(([k, d]) => [k, { ...d, overage: 1800 }])) },
  };

  assert.deepEqual(E.urgePattern(loaded, { endKey: END }), E.urgePattern(bare, { endKey: END }));
  assert.deepEqual(E.restraintSignal(loaded, { endKey: END }), E.restraintSignal(bare, { endKey: END }));
  assert.deepEqual(E.regularEating(loaded, END), E.regularEating(bare, END));
});

test("nothing in the pattern output is a streak", () => {
  // A lapse must cost the record nothing: "days since" is the all-or-nothing move
  // that drives the binge, so the window is the only unit this side of the app has.
  const s = urgeState([urge("2026-08-28", 23, { outcome: "escalated" })]);
  const p = E.urgePattern(s, { endKey: END });
  for (const key of Object.keys(p))
    assert.ok(!/streak|daysSince|since|clean|record/i.test(key), `pattern must not expose "${key}"`);
  assert.equal(p.weeks, E.PATTERN_WEEKS, "the unit is weeks of pattern, not days since the last one");
});

test("newUrge records the clock itself and refuses junk in the fields", () => {
  const now = new Date(2026, 7, 28, 23, 14, 0);
  const u = E.newUrge({
    seeking: ["escape", "not-a-thing"], hunger: 99, cannabis: "hour",
    company: "solo", before: "x".repeat(400), thought: "  it's friday  ",
  }, now);

  assert.equal(u.date, "2026-08-28");
  assert.equal(u.hour, 23);
  assert.equal(u.at, u.id, "an entry is identified by the moment it was logged");
  assert.deepEqual(u.seeking, ["escape"], "unknown seeking ids are dropped");
  assert.equal(u.hunger, 10, "hunger is clamped to the 1–10 scale");
  assert.equal(u.cannabis, "hour");
  assert.equal(u.company, null, "an unknown company value is stored as unknown, not guessed");
  assert.equal(u.before.length, 280);
  assert.equal(u.thought, "it's friday");
  assert.equal(u.outcome, null, "the outcome is asked later, not in the moment");
});

test("an urge closes with a real outcome, and only a real outcome", () => {
  const now = new Date(2026, 7, 29, 9, 0, 0);
  const u = E.newUrge({}, new Date(2026, 7, 28, 23, 14, 0));
  assert.equal(E.closeUrge(u, "escalated", now).outcome, "escalated");
  assert.equal(E.closeUrge(u, "escalated", now).outcomeAt, now.toISOString());
  assert.equal(E.closeUrge(u, "gave-up", now).outcome, null, "an unrecognized outcome leaves the entry open");
});

test("openUrges surfaces what still needs an outcome, and lets old ones go", () => {
  const now = new Date(2026, 7, 29, 9, 0, 0);
  const recent = E.newUrge({}, new Date(2026, 7, 28, 23, 14, 0));
  const stale = E.newUrge({}, new Date(2026, 7, 20, 23, 14, 0));
  const closed = E.closeUrge(E.newUrge({}, new Date(2026, 7, 29, 1, 0, 0)), "rode-out", now);
  const open = E.openUrges({ urges: [recent, stale, closed] }, now);

  assert.deepEqual(open.map((u) => u.id), [recent.id], "only the one still worth answering");
});
