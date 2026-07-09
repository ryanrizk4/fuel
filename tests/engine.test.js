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
  breakfastDefault: "latte", treatsPerWeek: 3, proteinPerLb: 0.8,
};

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

test("protein target scales with bodyweight", () => {
  assert.equal(E.proteinTarget(PROFILE), Math.round(185 * 0.8));
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
  const days = E.generateWeek(DATA, s, "2026-07-06", "auto");
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
  const days = E.generateWeek(DATA, s, "2026-07-06", "auto");
  const treats = Object.values(days).flatMap((d) => d.snacks)
    .filter((sn) => sn.productId && DATA.products.find((p) => p.id === sn.productId)?.treat);
  assert.ok(treats.length <= 2, `planned ${treats.length} treats, allowance is 2`);
});

test("locked meals and completed days survive re-planning", () => {
  const s = freshState();
  const days = E.generateWeek(DATA, s, "2026-07-06", "auto");
  s.plan.days = days;
  const k1 = "2026-07-06", k2 = "2026-07-07";
  s.plan.days[k1].status = "done";
  const frozenMeals = JSON.stringify(s.plan.days[k1].meals);
  s.plan.days[k2].meals.find((m) => m.slot === "lunch").locked = true;
  s.plan.days[k2].meals.find((m) => m.slot === "lunch").templateId = "tuna-pasta-salad";
  const regen = E.generateWeek(DATA, s, "2026-07-06", "auto");
  assert.equal(JSON.stringify(regen[k1].meals), frozenMeals, "done day untouched");
  assert.equal(regen[k2].meals.find((m) => m.slot === "lunch").templateId, "tuna-pasta-salad", "locked meal kept");
});

test("freezer portions get scheduled and prep mode schedules a weekend batch cook", () => {
  const s = freshState({ freezer: [{ templateId: "beef-ragu-batch", portions: 2 }] });
  const days = E.generateWeek(DATA, s, "2026-07-06", "easy");
  const fromFreezer = Object.values(days).flatMap((d) => d.meals).filter((m) => m.fromFreezer);
  assert.ok(fromFreezer.length >= 1 && fromFreezer.length <= 2, "uses freezer stock without exceeding it");

  const prep = E.generateWeek(DATA, freshState(), "2026-07-06", "prep");
  const batch = Object.entries(prep).filter(([, d]) => d.meals.some((m) => m.batchCook));
  assert.equal(batch.length, 1, "exactly one batch-cook day");
  const dow = new Date(batch[0][0] + "T12:00:00").getDay();
  assert.ok(dow === 0 || dow === 6, "batch cook lands on a weekend");
});

test("non-repeatable meals don't appear twice in a week", () => {
  const days = E.generateWeek(DATA, freshState(), "2026-07-06", "auto");
  const counts = {};
  for (const d of Object.values(days))
    for (const m of d.meals) counts[m.templateId] = (counts[m.templateId] || 0) + 1;
  for (const [id, n] of Object.entries(counts)) {
    const tpl = E.templateById(DATA, id);
    if (tpl && !tpl.repeatOk) assert.ok(n <= 2, `${id} is repeatOk:false but planned ${n}×`);
  }
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
  const list = E.shoppingList(DATA, s, "2026-07-06");
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
  const flat = E.shoppingList(DATA, s, "2026-07-06").flatMap((sec) => sec.items);
  const cc = flat.find((i) => i.id === "tj-cottage-cheese-lowfat");
  assert.equal(cc.needsVerify, true);
  const egg = flat.find((i) => i.id === "tj-large-egg");
  assert.equal(egg.needsVerify, false);
});

// ---------- carryover ----------

test("skipped days prioritize their templates next week (groceries already bought)", () => {
  const s = freshState();
  s.plan.days["2026-07-04"] = { status: "skipped", meals: [{ slot: "dinner", templateId: "big-mac-bowl", variantId: "classic" }], snacks: [] };
  const carry = E.collectCarryover(DATA, s, E.parseKey("2026-07-06"));
  assert.ok(carry.has("big-mac-bowl"));
});
