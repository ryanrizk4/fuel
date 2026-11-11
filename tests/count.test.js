/* Count mode: logging math, binge payback, goal pacing, catalog integrity, AI + barcode parsing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../js/engine.js";
import * as AI from "../js/ai.js";
import * as P from "../js/persistence.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const products = read("../data/products.json").products;
const templates = read("../data/templates.json").templates;
const eats = read("../data/eats.json");
const DATA = { products, templates };
const productIds = new Set(products.map((p) => p.id));

const profile = { sex: "male", age: 30, heightIn: 69, weightLb: 160, activity: "moderate", deficit: 500, startWeightLb: 160, goalLossLb: 10, proteinPerLb: 1 };
function mkState(extra = {}) {
  return { ...P.normalizeState(null), profile: { ...profile }, ...extra };
}
const entry = (calories, protein = 0, qty = 1) => ({ id: Math.random().toString(36), name: `x${calories}`, calories, protein, qty });

// ---------- catalog data rules ----------

test("eats.json: every place item resolves and every home combo uses real products", () => {
  const ids = new Set();
  for (const place of eats.places) {
    const comps = new Set((place.components || []).map((c) => c.id));
    for (const c of place.components || []) {
      assert.ok(["published", "estimated"].includes(c.confidence), `${place.id}/${c.id}: confidence`);
      assert.ok(c.protein * 4 <= c.calories + 8, `${place.id}/${c.id}: protein kcal exceed total`);
    }
    for (const it of place.items) {
      assert.ok(!ids.has(it.id), `duplicate id ${it.id}`); ids.add(it.id);
      if (it.picks) for (const k of Object.keys(it.picks)) assert.ok(comps.has(k), `${it.id}: unknown component ${k}`);
      else {
        assert.ok(Number.isFinite(it.calories) && Number.isFinite(it.protein), `${it.id}: needs calories & protein`);
        assert.ok(["published", "estimated"].includes(it.confidence), `${it.id}: confidence`);
      }
    }
  }
  for (const h of eats.home) {
    assert.ok(!ids.has(h.id), `duplicate id ${h.id}`); ids.add(h.id);
    for (const i of h.items) assert.ok(productIds.has(i.product), `${h.id}: unknown product ${i.product}`);
  }
  const all = new Set(E.catalogItems(eats, DATA, mkState()).map((x) => x.id));
  for (const s of eats.starterUsuals) assert.ok(all.has(s), `starter usual ${s} doesn't resolve`);
});

test("catalog macros: Chipotle double-chicken bowl is computed from its ingredients", () => {
  const bowl = E.catalogItems(eats, DATA, mkState()).find((x) => x.id === "chipotle-bowl-double-chicken");
  assert.equal(bowl.calories, 2 * 180 + 210 + 130 + 20 + 25 + 5);
  assert.equal(bowl.protein, 2 * 32 + 4 + 8 + 1);
  assert.equal(bowl.build.kind, "components");
});

test("catalog includes every Fuel meal and respects label overrides on home combos", () => {
  const st = mkState({ productOverrides: { "tj-sliced-swiss": { calories: 110, protein: 8 } } });
  const items = E.catalogItems(eats, DATA, st);
  for (const t of templates) assert.ok(items.some((i) => i.id === `meal:${t.id}`), t.id);
  const plain = E.catalogItems(eats, DATA, mkState()).find((i) => i.id === "home-turkey-ham-sandwich");
  const fixed = items.find((i) => i.id === "home-turkey-ham-sandwich");
  assert.equal(fixed.calories - plain.calories, 30);
});

// ---------- logging + settlement ----------

test("logTotals multiplies by quantity", () => {
  assert.deepEqual(E.logTotals([entry(200, 10), entry(300, 20, 1.5)]), { calories: 650, protein: 40 });
});

test("a finished day that went over moves the excess into the payback plan", () => {
  const st = mkState();
  const budget = E.dailyBudget(st.profile);
  st.foodLog["2026-11-08"] = { entries: [entry(budget + 900)], walks: [] };
  const done = E.settleCountDays(st, "2026-11-10");
  assert.equal(done.length, 1);
  assert.equal(st.overageBank, 900);
  assert.equal(st.foodLog["2026-11-08"].settled.over, 900);
  // idempotent
  E.settleCountDays(st, "2026-11-10");
  assert.equal(st.overageBank, 900);
});

test("payback days trim the budget and pay the plan down; eating under budget earns nothing", () => {
  const st = mkState({ overageBank: 400 });
  const base = E.dailyBudget(st.profile);
  assert.equal(E.effectiveBudget(st, null).budget, base - 150);
  st.foodLog["2026-11-08"] = { entries: [entry(1000)], walks: [] }; // way under
  E.settleCountDays(st, "2026-11-10");
  assert.equal(st.overageBank, 250, "only the day's trim is paid, not the unused budget");
});

test("unlogged days are not settled — no data is not the same as eating zero", () => {
  const st = mkState({ overageBank: 400 });
  st.foodLog["2026-11-08"] = { entries: [], walks: [] };
  assert.equal(E.settleCountDays(st, "2026-11-10").length, 0);
  assert.equal(st.overageBank, 400);
});

test("editing a settled day moves the bank by exactly the change", () => {
  const st = mkState();
  const budget = E.dailyBudget(st.profile);
  st.foodLog["2026-11-08"] = { entries: [entry(budget - 100)], walks: [] };
  E.settleCountDays(st, "2026-11-10");
  assert.equal(st.overageBank, 0);
  st.foodLog["2026-11-08"].entries.push(entry(600)); // forgot dinner
  assert.equal(E.resettleDay(st, "2026-11-08"), 500);
  assert.equal(st.overageBank, 500);
  st.foodLog["2026-11-08"].entries.pop();
  assert.equal(E.resettleDay(st, "2026-11-08"), -500);
  assert.equal(st.overageBank, 0);
});

test("payback speed is selectable but never pushes the budget under the floor", () => {
  const st = mkState({ overageBank: 2000, paybackPerDay: 350 });
  assert.equal(E.dailyTrim(st), 350);
  st.paybackPerDay = 999; // not an offered speed → default
  assert.equal(E.dailyTrim(st), E.MAX_DAILY_TRIM);
  const tiny = mkState({ overageBank: 2000, paybackPerDay: 350, profile: { ...profile, age: 60, heightIn: 62, weightLb: 120, activity: "sedentary", deficit: 500 } });
  const b = E.dailyBudget(tiny.profile);
  assert.ok(E.effectiveBudget(tiny, null).budget >= E.BUDGET_FLOOR.male, `trimmed budget ${b} stays at or above floor`);
  const opts = E.paybackOptions(mkState({ overageBank: 1000 }));
  assert.deepEqual(opts.map((o) => o.days), [7, 4, 3]);
});

test("walks: conservative net estimate, capped, and applied to today's budget", () => {
  assert.equal(E.walkCredit(60, 160), 144); // 3 mi × 0.3 × 160
  assert.equal(E.walkCredit(600, 160), E.ACTIVITY_CAP);
  assert.equal(E.walkMinutesFor(144, 160), 60);
  const st = mkState();
  const day = { entries: [], walks: [{ kcal: 144, applied: "today" }, { kcal: 500, applied: "bank" }] };
  assert.equal(E.effectiveBudget(st, day).credit, 144, "bank walks don't raise today's budget");
});

test("week balance: one big day shows as erased progress, today counts as eaten-to-budget", () => {
  const st = mkState();
  const maint = E.tdee(st.profile), budget = E.dailyBudget(st.profile);
  // Mon 2026-11-09 under budget, Tue (today) partly logged
  st.foodLog["2026-11-09"] = { entries: [entry(budget)], walks: [] };
  st.foodLog["2026-11-10"] = { entries: [entry(300)], walks: [] };
  let wb = E.weekBalance(st, "2026-11-10");
  assert.equal(wb.deficit, 2 * (maint - budget));
  st.foodLog["2026-11-09"].entries.push(entry(2000)); // binge
  wb = E.weekBalance(st, "2026-11-10");
  assert.equal(wb.deficit, 2 * (maint - budget) - 2000);
});

// ---------- goal pacing ----------

test("goal plan: 160 → 150 in 12 weeks is a moderate deficit", () => {
  const g = E.goalPlan(profile, { currentLb: 160, goalLb: 150, goalDate: "2027-02-02", today: "2026-11-10" });
  assert.equal(g.toLose, 10);
  assert.equal(g.deficit, 425);
  assert.equal(g.limitedBy, null);
  assert.equal(g.budget, g.maintenance - 425);
});

test("goal plan: an aggressive date is capped at 1% bodyweight per week, with a realistic date", () => {
  const g = E.goalPlan(profile, { currentLb: 160, goalLb: 146, goalDate: "2026-12-20", today: "2026-11-10" });
  assert.equal(g.limitedBy, "pace");
  assert.equal(g.deficit, 800);
  assert.equal(g.lbPerWeek, 1.6);
  assert.ok(g.eta > "2026-12-20");
});

test("goal plan never goes below the budget floor", () => {
  const small = { ...profile, age: 55, heightIn: 62, weightLb: 130, activity: "sedentary" };
  const g = E.goalPlan(small, { currentLb: 130, goalLb: 115, goalDate: "2027-01-01", today: "2026-11-10" });
  assert.ok(g.budget >= E.BUDGET_FLOOR.male);
  assert.equal(g.limitedBy, "floor");
});

// ---------- suggestions ----------

test("what-fits suggestions only include things that fit, best protein density first", () => {
  const items = [
    { id: "a", name: "Burrito", calories: 975, protein: 58 },
    { id: "b", name: "Caesar salad", calories: 400, protein: 37 },
    { id: "c", name: "Cookie", calories: 300, protein: 3 },
  ];
  const fits = E.suggestFits(items, 600, 60);
  assert.deepEqual(fits.map((f) => f.id), ["b", "c"]);
  assert.deepEqual(E.suggestFits(items, 50, 60), []);
});

// ---------- barcode ----------

test("Open Food Facts: prefers per-serving numbers", () => {
  const food = E.parseOpenFoodFacts({ status: 1, product: { product_name: "Protein Bar", brands: "Acme, Other", serving_size: "1 bar (60 g)", serving_quantity: 60,
    nutriments: { "energy-kcal_serving": 210, proteins_serving: 20, "energy-kcal_100g": 350, proteins_100g: 33.3 } } });
  assert.equal(food.name, "Acme Protein Bar");
  assert.equal(food.calories, 210);
  assert.equal(food.protein, 20);
});

test("Open Food Facts: derives a serving from per-100 g, or falls back to 100 g", () => {
  const derived = E.parseOpenFoodFacts({ product: { product_name: "Yogurt", serving_quantity: 150, nutriments: { "energy-kcal_100g": 60, proteins_100g: 10 } } });
  assert.equal(derived.calories, 90);
  assert.equal(derived.protein, 15);
  const per100 = E.parseOpenFoodFacts({ product: { product_name: "Rice", nutriments: { "energy-kcal_100g": 130, proteins_100g: 2.7 } } });
  assert.equal(per100.serving, "100 g");
  assert.equal(per100.calories, 130);
  assert.equal(E.parseOpenFoodFacts({ status: 0 }), null);
  assert.equal(E.parseOpenFoodFacts({ product: { product_name: "Water", nutriments: {} } }), null);
});

// ---------- AI ----------

test("AI request: structured JSON output, image before text, known foods included", () => {
  const body = AI.buildRequest({ text: "2 eggs", image: { mediaType: "image/jpeg", data: "AAAA" }, known: [{ name: "Pret coffee", calories: 200, protein: 10 }] });
  assert.equal(body.model, AI.MODEL);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.messages[0].content[0].type, "image");
  assert.equal(body.messages[0].content[1].text, "2 eggs");
  assert.match(body.system, /Pret coffee: 200 kcal/);
  assert.equal(body.temperature, undefined);
  const h = AI.headers("sk-test");
  assert.equal(h["x-api-key"], "sk-test");
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
});

test("AI response parsing: clean items, refusals and garbage handled", () => {
  const ok = AI.parseResponse({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ items: [{ name: "Eggs", emoji: "🍳", portion: "2 large", calories: 143.6, protein: 12, confidence: "high" }], note: "" }) }] });
  assert.deepEqual(ok.items[0], { name: "Eggs", emoji: "🍳", portion: "2 large", calories: 144, protein: 12, confidence: "high" });
  assert.throws(() => AI.parseResponse({ stop_reason: "refusal", content: [] }), /declined/);
  assert.throws(() => AI.parseResponse({ content: [{ type: "text", text: "nope" }] }), /garbled/);
  assert.throws(() => AI.parseResponse({ content: [{ type: "text", text: '{"items":[],"note":""}' }] }), /Couldn't find/);
});

test("AI errors become plain-English messages", async () => {
  const res = (status, body = {}) => async () => ({ status, ok: status < 300, json: async () => body });
  await assert.rejects(AI.estimateFood({ key: "k", text: "x", known: [], fetchImpl: res(401) }), /rejected/);
  await assert.rejects(AI.estimateFood({ key: "k", text: "x", known: [], fetchImpl: res(429) }), /Rate limited/);
  await assert.rejects(AI.estimateFood({ key: "k", text: "x", known: [], fetchImpl: async () => { throw new Error("net"); } }), /connection/);
});

test("the AI key is never part of the saved state or a backup", () => {
  assert.ok(!Object.keys(P.defaultState()).some((k) => /key|api/i.test(k)));
  assert.notEqual(AI.KEY_SLOT, P.STORE_KEY);
});

// ---------- history & stats ----------

function historyState() {
  const st = mkState();
  const budget = E.dailyBudget(st.profile);
  st.foodLog["2026-11-02"] = { entries: [entry(budget - 200, 150)], walks: [] };
  st.foodLog["2026-11-03"] = { entries: [entry(budget + 800, 90)], walks: [{ minutes: 60, kcal: 144, applied: "today" }] };
  st.foodLog["2026-11-05"] = { entries: [entry(budget - 100, 140)], walks: [], settled: { budget: budget - 150, trim: 150, over: 50, eaten: budget - 100 } };
  // a plan-mode day marked done, and one "ate out"
  const meals = [{ slot: "lunch", templateId: templates[0].id, variantId: "classic" }];
  st.plan.days["2026-11-06"] = { meals, snacks: [], status: "done", eaten: [0] };
  st.plan.days["2026-11-07"] = { meals, snacks: [], status: "skipped", eaten: [], overage: 500 };
  return { st, budget };
}

test("history merges both modes and keeps unlogged days as gaps", () => {
  const { st, budget } = historyState();
  const rows = E.dailyHistory(DATA, st, "2026-11-01", "2026-11-08");
  assert.equal(rows.length, 8);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by["2026-11-01"].source, null);
  assert.equal(by["2026-11-02"].source, "count");
  assert.equal(by["2026-11-03"].walked, 144);
  assert.equal(by["2026-11-05"].budget, budget - 150, "a settled day keeps the budget it actually had");
  assert.equal(by["2026-11-06"].source, "plan");
  assert.equal(by["2026-11-06"].calories, E.mealMacros(DATA, st, templates[0].id, "classic").calories);
  assert.equal(by["2026-11-07"].calories, budget + 500);
  assert.equal(by["2026-11-07"].approx, true);
});

test("history stats: averages, adherence, streaks and estimated loss", () => {
  const { st, budget } = historyState();
  const rows = E.dailyHistory(DATA, st, "2026-11-01", "2026-11-08");
  const maint = E.tdee(st.profile);
  const s = E.historyStats(rows, { maintenance: maint, proteinTarget: 150, todayKey: "2026-11-08" });
  assert.equal(s.logged, 5);
  assert.equal(s.overDays, 3, "the binge day, the slightly-over payback day and the ate-out day");
  assert.equal(s.underBudget, 2);
  assert.equal(s.adherence, 40);
  assert.equal(s.streak, 0, "the most recent finished logged day was over budget");
  assert.equal(s.bestStreak, 1);
  const expectedDef = rows.filter((r) => r.source).reduce((n, r) => n + maint - r.calories + r.walked, 0);
  assert.equal(s.deficit, expectedDef);
  assert.equal(s.biggestDay.key, "2026-11-03");
});

test("weekly summary lines up logged deficit with the scale", () => {
  const { st } = historyState();
  st.weighIns = [{ date: "2026-11-01", lb: 160 }, { date: "2026-11-08", lb: 159 }];
  const rows = E.dailyHistory(DATA, st, "2026-11-02", "2026-11-08");
  const [wk] = E.weeklySummary(rows, st, E.tdee(st.profile));
  assert.equal(wk.week, "2026-11-02");
  assert.equal(wk.logged, 5);
  assert.equal(wk.weightChange, -1);
});

test("top foods counts repeats; CSV export is spreadsheet-safe", () => {
  const st = mkState();
  st.foodLog["2026-11-02"] = { entries: [{ name: "Pret coffee", calories: 200, protein: 10, qty: 1 }, { name: 'Bowl, "double"', calories: 750, protein: 77, qty: 1, detail: "chicken, rice" }], walks: [{ minutes: 30, kcal: 72, applied: "bank" }] };
  st.foodLog["2026-11-03"] = { entries: [{ name: "Pret coffee", calories: 200, protein: 10, qty: 2 }], walks: [] };
  st.weighIns = [{ date: "2026-11-03", lb: 159.4 }];
  const top = E.topFoods(st, "2026-11-01", "2026-11-03");
  assert.deepEqual(top[0], { name: "Pret coffee", emoji: "🍽", count: 2, calories: 600, protein: 30 });
  const csv = E.historyCsv(DATA, st, "2026-11-01", "2026-11-03").trim().split("\n");
  assert.equal(csv[0], "date,source,item,quantity,calories,protein_g,day_budget,note");
  assert.ok(csv.some((l) => l.startsWith('2026-11-02,count,"Bowl, ""double""",1,750,77,') && l.endsWith('"chicken, rice"')));
  assert.ok(csv.some((l) => l.startsWith("2026-11-03,count,Pret coffee,2,400,20,")));
  assert.ok(csv.some((l) => l.startsWith("2026-11-02,walk,Extra walk 30 min,1,-72,")));
  assert.ok(csv.some((l) => l === "2026-11-03,weigh-in,Weight (lb),1,,,,159.4"));
});

// ---------- maintenance calibration: real results beat the formula ----------

test("'what worked before' sets maintenance: 1,800/day losing 1 lb/week → 2,300", () => {
  assert.equal(E.maintenanceFromHistory(1800, 1), 2300);
  assert.equal(E.maintenanceFromHistory(1800, 0), 1800);
  assert.equal(E.maintenanceFromHistory(0, 1), null);
  const p = { ...profile, maintenanceKcal: 2300, maintenanceFrom: "what worked before", deficit: 500 };
  assert.equal(E.tdee(p), 2300, "a calibrated number beats the formula");
  assert.equal(E.dailyBudget(p), 1800);
  assert.equal(E.maintenanceSource(p), "what worked before");
  assert.equal(E.maintenanceSource(profile), "formula");
  assert.ok(E.formulaTdee(p) > 2300, "the formula alone would have said more");
});

test("a budget set directly wins, but never under the safety floor", () => {
  assert.equal(E.dailyBudget({ ...profile, budgetKcal: 1800 }), 1800);
  assert.equal(E.dailyBudget({ ...profile, budgetKcal: 1100 }), E.BUDGET_FLOOR.male);
  assert.equal(E.maintenanceSource({ ...profile, budgetKcal: 1800 }), "budget");
  assert.equal(E.budgetIsFloored({ ...profile, budgetKcal: 1100 }), true);
});

test("the desk-job + daily walking + lifting factor sits between light and moderate", () => {
  const w = E.formulaTdee({ ...profile, activity: "walker" });
  assert.ok(w > E.formulaTdee({ ...profile, activity: "light" }) && w < E.formulaTdee({ ...profile, activity: "moderate" }));
});

test("goal pacing runs on the calibrated maintenance", () => {
  const p = { ...profile, maintenanceKcal: 2300 };
  const g = E.goalPlan(p, { currentLb: 160, goalLb: 150, goalDate: "2027-02-02", today: "2026-11-10" });
  assert.equal(g.maintenance, 2300);
  assert.equal(g.budget, 2300 - 425);
});

test("measured maintenance from logs + weigh-ins", () => {
  // 21 days eating 1,900 while losing 0.75 lb/week → burns ≈ 1,900 + 375 = 2,275
  const rows = Array.from({ length: 21 }, (_, i) => ({ key: E.dateKey(E.addDays(E.parseKey("2026-10-01"), i)), source: "count", calories: 1900, approx: false }));
  const weighIns = [0, 7, 14, 20].map((d) => ({ date: E.dateKey(E.addDays(E.parseKey("2026-10-01"), d)), lb: Math.round((165 - (0.75 / 7) * d) * 10) / 10 }));
  const a = E.adaptiveMaintenance(rows, weighIns);
  assert.ok(Math.abs(a.maintenance - 2275) <= 30, `got ${a.maintenance}`);
  assert.equal(a.avgIntake, 1900);
  assert.ok(Math.abs(a.lbPerWeek - 0.75) <= 0.1);
  // not enough to go on → no guess
  assert.equal(E.adaptiveMaintenance(rows.slice(0, 6), weighIns), null, "too few logged days");
  assert.equal(E.adaptiveMaintenance(rows, weighIns.slice(0, 1)), null, "one weigh-in");
  assert.equal(E.adaptiveMaintenance(rows, [weighIns[0], { date: "2026-10-05", lb: 164.5 }]), null, "weigh-ins too close together");
});

test("the trend check compares against the calibrated plan, not the old deficit field", () => {
  const st = mkState({ profile: { ...profile, budgetKcal: 1800, maintenanceKcal: 2300, deficit: 0 } });
  st.weighIns = [{ date: "2026-10-01", lb: 165 }, { date: "2026-10-08", lb: 164 }, { date: "2026-10-15", lb: 163 }];
  const c = E.calibration(st);
  assert.equal(c.plannedPerWeek, 1, "planned pace = (2300 − 1800) × 7 / 3500");
  assert.equal(c.status, "on-track");
});

// ---------- streaks: forgiving by design ----------

const rowsFor = (pattern, start = "2026-11-01", budget = 1800) => [...pattern].map((c, i) => ({
  key: E.dateKey(E.addDays(E.parseKey(start), i)),
  source: c === "." ? null : "count",
  calories: c === "o" ? budget + 400 : c === "g" ? budget + 40 : c === "." ? 0 : budget - 100,
  budget,
}));

test("streak: successes count, 50 kcal grace counts, a miss without a shield resets", () => {
  const r = E.streakCalendar(rowsFor("✓✓g✓o✓✓"), { todayKey: "2026-11-20" });
  assert.equal(r.days["2026-11-03"].status, "success", "within 50 kcal still counts");
  assert.equal(r.days["2026-11-05"].status, "missed");
  assert.equal(r.current, 2);
  assert.equal(r.best, 4);
});

test("streak: 7 good days earn a shield that absorbs the next miss (max 2 banked)", () => {
  const r = E.streakCalendar(rowsFor("✓✓✓✓✓✓✓o✓"), { todayKey: "2026-11-20" });
  assert.equal(r.days["2026-11-07"].earned, true);
  assert.equal(r.days["2026-11-08"].status, "shielded");
  assert.equal(r.current, 8, "the shield held the streak");
  assert.equal(r.shields, 0);
  const many = E.streakCalendar(rowsFor("✓".repeat(30)), { todayKey: "2026-12-31" });
  assert.equal(many.shields, E.MAX_SHIELDS);
  assert.equal(many.toNextShield, null);
});

test("streak: an unlogged day is a miss (or uses a shield); days before the first log don't count", () => {
  const r = E.streakCalendar(rowsFor("..✓✓.✓"), { todayKey: "2026-11-20" });
  assert.equal(r.days["2026-11-01"].status, "none");
  assert.equal(r.days["2026-11-05"].status, "missed");
  assert.equal(r.days["2026-11-05"].reason, "unlogged");
  assert.equal(r.current, 1);
});

test("streak: today stays open until it's closed", () => {
  const rows = rowsFor("✓✓✓", "2026-11-09");
  const open = E.streakCalendar(rows, { todayKey: "2026-11-11" });
  assert.equal(open.days["2026-11-11"].status, "open");
  assert.equal(open.current, 2);
  const closed = E.streakCalendar(rows, { todayKey: "2026-11-11", todayClosed: true });
  assert.equal(closed.days["2026-11-11"].status, "success");
  assert.equal(closed.current, 3);
});

test("closing today early settles it now; reopening undoes exactly that", () => {
  const st = mkState({ overageBank: 300 });
  const budget = E.dailyBudget(st.profile);
  st.foodLog["2026-11-11"] = { entries: [entry(budget + 200)], walks: [], closed: true };
  E.settleCountDays(st, "2026-11-11");
  assert.ok(st.foodLog["2026-11-11"].settled, "a closed today is settled");
  const after = st.overageBank;
  assert.equal(after, 300 - 150 + 350, "trim paid, overage (vs trimmed budget) added");
  E.unsettleDay(st, "2026-11-11");
  assert.equal(st.overageBank, 300);
  assert.equal(st.foodLog["2026-11-11"].settled, undefined);
  assert.equal(E.settleCountDays(st, "2026-11-11").length, 0, "an open today isn't settled");
});
