/* "Type it" parser: free text → items, on the phone, no AI. Each case is a real way of saying it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as PZ from "../js/parse.js";
import * as P from "../js/persistence.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const data = { products: read("../data/products.json").products, templates: read("../data/templates.json").templates };
const eats = read("../data/eats.json");
const foods = read("../data/foods.json").foods;
const baseState = () => ({ ...P.normalizeState(null), profile: { sex: "male", age: 30, heightIn: 69, weightLb: 160, activity: "moderate", deficit: 500, startWeightLb: 160, goalLossLb: 10 } });
const lexFor = (state = baseState()) => PZ.buildLexicon({ eats, data, state, foods });
const parse = (text, state) => PZ.parseMeal(text, lexFor(state)).items;
const total = (it) => Math.round(it.calories * it.qty);
const labels = (it) => it.changes.map((c) => c.label);

test("foods.json: unique ids, sane numbers, aliases present", () => {
  const ids = new Set();
  for (const f of foods) {
    assert.ok(!ids.has(f.id), `duplicate ${f.id}`); ids.add(f.id);
    assert.ok(f.name && f.unit && f.aliases?.length, `${f.id}: basics`);
    assert.ok(f.calories >= 0 && f.calories <= 1500, `${f.id}: calories`);
    assert.ok(f.protein * 4 <= f.calories + 8, `${f.id}: protein kcal exceed total`);
  }
});

test("the owner's own example: chipotle bowl with changes, plus a pret coffee", () => {
  const [bowl, coffee] = parse("chipotle bowl double chicken no rice extra guac and a pret coffee");
  assert.equal(bowl.id, "chipotle-bowl-double-chicken");
  assert.deepEqual(labels(bowl), ["no rice", "+ guac"]);
  assert.equal(bowl.calories, 750 - 210 + 230, "double chicken stays two portions, rice out, guac in");
  assert.equal(coffee.id, "pret-usual-coffee");
  assert.equal(total(coffee), 200);
});

test("quantities: numbers, words, halves, ounces, sizes", () => {
  const [eggs, toast, latte] = parse("2 eggs, toast and a latte");
  assert.equal(eggs.id, "f:egg"); assert.equal(eggs.qty, 2);
  assert.equal(toast.id, "f:toast");
  assert.ok(latte.name.toLowerCase().includes("latte"));
  const [q] = parse("half a pulled pork quesadilla");
  assert.equal(q.id, "home-pulled-pork-quesadilla"); assert.equal(q.qty, 0.5);
  const [ch] = parse("6 oz chicken breast");
  assert.equal(ch.id, "f:chicken-breast"); assert.equal(ch.qty, 1.5);
  const [pz, beer] = parse("3 slices of pizza and 2 beers");
  assert.equal(pz.qty, 3); assert.equal(beer.id, "f:beer"); assert.equal(beer.qty, 2);
  const [big] = parse("large oat latte");
  assert.equal(big.id, "f:latte-oat"); assert.equal(big.qty, 1.25, "large = 20 oz vs a 16 oz standard");
  const [tacos, marg] = parse("two tacos and a margarita");
  assert.equal(tacos.qty, 2); assert.equal(marg.id, "f:cocktail");
});

test("fixed restaurant items take add-ons and removals", () => {
  const [salad] = parse("caesar salad no croutons add avocado");
  assert.equal(salad.id, "js-chicken-caesar-salad");
  assert.deepEqual(labels(salad), ["no croutons", "+ avocado"]);
  assert.equal(salad.calories, 400 - 60 + 120);
  const [bowl] = parse("chopped bowl dressing on the side");
  assert.equal(bowl.id, "js-chopped-chicken-bowl");
  assert.deepEqual(labels(bowl), ["light dressing"]);
});

test("Chipotle builds: protein swap, removals and bare follow-up components", () => {
  const [b] = parse("chipotle burrito with steak, no beans, sour cream");
  assert.equal(b.id, "chipotle-burrito-chicken");
  assert.equal(b.build.picks.steak, 1);
  assert.equal(b.build.picks.chicken, undefined, "steak replaces the default chicken");
  assert.equal(b.build.picks["black-beans"], undefined);
  assert.equal(b.build.picks["sour-cream"], 1);
  const [s] = parse("chipotle salad bowl double chicken extra fajitas");
  assert.equal(s.id, "chipotle-salad-double-chicken");
  assert.equal(s.build.picks.chicken, 2);
  assert.equal(s.build.picks["fajita-veggies"], 1.5);
});

test("home combos: change what's in them", () => {
  const [w] = parse("turkey ham and cheese wrap with extra cheese");
  assert.equal(w.id, "home-turkey-ham-wrap", "'and' inside a dish name doesn't split it");
  assert.equal(w.build.items.find((x) => x.product === "tj-sliced-swiss").qty, 1.5);
  const [q] = parse("pulled chicken and pulled pork quesadilla");
  assert.equal(q.id, "home-pulled-quesadilla");
});

test("splitting: lists, run-ons, and add-ons that belong to the previous item", () => {
  assert.deepEqual(parse("a burger and fries and a diet coke").map((i) => i.id), ["f:burger", "f:fries", "f:diet-soda"]);
  assert.deepEqual(parse("eggs toast coffee").map((i) => i.id), ["f:egg", "f:toast", "f:coffee"], "plain 'coffee' is coffee; 'my coffee' is the Pret usual");
  const [y] = parse("greek yogurt with berries and honey");
  assert.equal(y.id, "f:greek-yogurt");
  assert.deepEqual(labels(y), ["+ berries", "+ honey"]);
  const [o, banana] = parse("oatmeal with peanut butter and banana");
  assert.deepEqual(labels(o), ["+ peanut butter"]);
  assert.equal(o.calories, 160 + 190, "peanut butter, not plain butter");
  assert.equal(banana.id, "f:banana");
  assert.equal(parse("bagel with cream cheese")[0].id, "f:bagel-cream-cheese", "a dish named 'X with Y' stays whole");
});

test("typos, Fuel meals and generic dishes", () => {
  assert.equal(parse("ceasar salad")[0].id, "js-chicken-caesar-salad");
  assert.equal(parse("shawarma bowl")[0].id, "meal:shawarma-bowl");
  assert.equal(parse("big mac bowl")[0].id, "meal:big-mac-bowl");
  const [g] = parse("grilled chicken salad no cheese light dressing");
  assert.equal(g.id, "f:salad-chicken");
  assert.deepEqual(labels(g), ["no cheese", "light dressing"]);
  assert.equal(parse("chicken salad")[0].id, "f:salad-chicken", "'salad' alone is not the Just Salad restaurant");
});

test("unknown phrases come back as unknown, and learned phrases are recognized next time", () => {
  const [u] = parse("some weird thing from the bodega");
  assert.equal(u.status, "unknown");
  assert.equal(u.calories, null);
  const st = baseState();
  st.usuals = [{ id: "x", name: "Bodega egg roll", emoji: "✏️", calories: 410, protein: 12, aliases: ["some weird thing from the bodega"] }];
  const [k] = parse("weird thing from the bodega", st);
  assert.equal(k.name, "Bodega egg roll");
  assert.equal(k.calories, 410);
});

test("usuals and recents win ties over generic foods; alternatives are offered", () => {
  const st = baseState();
  st.usuals = [{ id: "u1", ref: "home-turkey-ham-wrap" }];
  const [w] = parse("my wrap", st);
  assert.equal(w.id, "home-turkey-ham-wrap");
  const [c] = parse("coffee");
  assert.ok(c.alts.length >= 1, "an ambiguous word offers other choices");
  assert.ok([c.id, ...c.alts.map((a) => a.id)].includes("f:coffee"));
});

test("describe() summarizes what was understood", () => {
  const [bowl] = parse("chipotle bowl no rice extra guac");
  assert.match(PZ.describe(bowl), /no rice, \+ guac/);
  const [eggs] = parse("3 eggs");
  assert.equal(PZ.describe(eggs), "3 eggs");
});

// ---------- measurements, spoken numbers, coffee, recipes (the "say anything" battery) ----------

const one = (text, st) => { const items = parse(text, st); assert.equal(items.length, 1, `${text}: expected one item, got ${items.map((i) => i.name).join(" | ")}`); return items[0]; };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("spoken numbers become digits", () => {
  const n = PZ.normalize;
  assert.equal(n("one and a half cups of rice"), "1.5 cups of rice");
  assert.equal(n("a cup and a half of rice"), "1.5 cup of rice");
  assert.equal(n("twenty five grams of almonds"), "25 grams of almonds");
  assert.equal(n("one hundred fifty grams chicken"), "150 grams chicken");
  assert.equal(n("half a cup of oats"), "0.5 cup of oats");
  assert.equal(n("a quarter cup granola"), "0.25 cup granola");
  assert.equal(n("three quarters of a cup"), "0.75 of a cup");
  assert.equal(n("two point five ounces"), "2.5 ounces");
  assert.equal(n("1 1/2 cups"), "1.5 cups");
  assert.equal(n("2% milk"), "2pct milk");
  assert.equal(n("90/10 ground beef"), "lean90 ground beef");
  assert.equal(n("6oz steak"), "6 oz steak");
  assert.equal(n("½ avocado"), "0.5 avocado");
});

test("weights and volumes convert against each food's serving", () => {
  const cases = [
    ["200 grams chicken breast", "f:chicken-breast", 200 / 113],
    ["12 oz steak", "f:steak", 2],
    ["a cup and a half of rice", "f:rice", 1.5],
    ["half a cup of oats", "f:oats-dry", 1],
    ["two tablespoons of olive oil", "f:olive-oil-food", 2],
    ["a quarter cup of granola", "f:granola", 0.5],
    ["one and a half cups of greek yogurt", "f:greek-yogurt", 1.5],
    ["3 oz turkey slices", "f:turkey-slices", 1],
    ["a pound of ground turkey", "f:ground-turkey-raw", 4],
    ["16 oz latte", "f:latte", 1],
    ["8 fl oz of milk", "f:milk", 1],
    ["4 meatballs", "p:turkey-meatballs-frozen", 2],
  ];
  for (const [text, id, qty] of cases) {
    const it = one(text);
    assert.equal(it.id, id, text);
    assert.ok(near(it.qty, qty), `${text}: qty ${it.qty} ≠ ${qty}`);
  }
});

test("an amount never multiplies something with no known size", () => {
  const it = one("16 oz latte");
  assert.ok(total(it) < 400, "a 16 oz latte is one latte, not sixteen");
});

test("coffee orders: sizes, milk swaps, pumps, shots, sugar", () => {
  const a = one("coffee with an extra pump of vanilla");
  assert.equal(a.id, "f:coffee"); assert.equal(total(a), 5 + 20);
  const b = one("grande latte with oat milk and 2 pumps of caramel");
  assert.equal(b.id, "f:latte-oat"); assert.equal(total(b), 190 + 40);
  const c = one("venti iced coffee with milk and 2 sugars");
  assert.equal(c.id, "f:coffee"); assert.equal(total(c), 15 + 20 + 32, "24 oz of coffee, milk and sugar once per drink");
  const d = one("tall almond milk latte");
  assert.equal(d.id, "f:latte-almond"); assert.ok(near(total(d), 75, 0.05));
  const e = one("black coffee with a splash of cream");
  assert.ok(e.calories > 5 && e.calories < 60);
  assert.ok(labels(one("latte with an extra shot")).some((l) => /shot/.test(l)));
  assert.equal(one("my coffee").id, "pret-usual-coffee");
});

test("numbers said outright win: calories, protein, each", () => {
  const a = one("a 250 calorie protein bar");
  assert.equal(a.id, "f:protein-bar"); assert.equal(total(a), 250);
  const b = one("protein shake 160 calories 30g protein");
  assert.equal(total(b), 160); assert.equal(Math.round(b.protein * b.qty), 30);
  const c = one("2 bars 200 calories each");
  assert.equal(c.qty, 2); assert.equal(total(c), 400);
  const d = one("street cart thing 650 calories");
  assert.equal(d.status, "ok"); assert.equal(total(d), 650);
});

test("portions: shared, bites, most of, seconds", () => {
  assert.equal(one("split a pizza").qty, 0.5);
  assert.ok(near(one("a few bites of cake").qty, 0.3));
  assert.equal(one("most of a burrito").qty, 0.75);
  assert.equal(one("seconds of the shawarma bowl").qty, 2);
});

test("cooking method: fried adds oil, air fried doesn't", () => {
  const fried = one("fried chicken breast");
  const air = one("air fried chicken breast");
  assert.equal(air.ignored.length, 0);
  assert.equal(total(fried) - total(air), 60);
  assert.equal(labels(air).length, 0);
});

test("'yesterday' moves the log to yesterday", () => {
  const r = PZ.parseMeal("yesterday I had a burger and fries", lexFor());
  assert.equal(r.dayOffset, -1);
  assert.deepEqual(r.items.map((i) => i.id), ["f:burger", "f:fries"]);
  assert.equal(PZ.parseMeal("2 eggs", lexFor()).dayOffset, 0);
});

test("recipes: totals, servings, what you ate, name, raw/dry weights", () => {
  const chili = one("turkey chili: 1 lb ground turkey, 1 can black beans, 2 cups marinara, 1 onion, makes 4, I had 1");
  assert.equal(chili.kind, "recipe"); assert.equal(chili.name, "Turkey chili");
  assert.equal(chili.servings, 4); assert.equal(chili.qty, 1);
  assert.equal(chili.totalCalories, 680 + 385 + 320 + 64);
  assert.equal(chili.calories, Math.round(1449 / 4));
  const bake = one("pasta bake 12 oz dry penne 1 lb ground beef 24 oz marinara 2 cups shredded mozzarella makes 6 servings ate 2");
  assert.equal(bake.name, "Pasta bake", "a leading phrase with no amount names the dish");
  assert.equal(bake.ingredients.length, 4);
  assert.equal(bake.ingredients[0].id, "f:pasta-dry", "recipe weights are dry/raw");
  assert.equal(bake.qty, 2);
  const stir = one("chicken stir fry: 2 chicken breasts, 1 bag broccoli, 2 tbsp soy sauce, 1 tbsp olive oil, serves 3");
  assert.equal(stir.ingredients[0].id, "f:chicken-breast-raw");
  assert.equal(stir.ingredients[0].qty, 3.5, "a whole chicken breast is ~7 oz raw");
  assert.equal(stir.servings, 3);
  const r = PZ.recomputeRecipe({ ...stir, servings: 2 });
  assert.equal(r.calories, Math.round(stir.totalCalories / 2));
});

test("a recipe with an ingredient Fuel doesn't know flags it instead of guessing", () => {
  const r = one("recipe: 1 lb chicken breast, 2 tbsp zorblax paste, makes 2");
  assert.equal(r.status, "check");
  assert.ok(r.ingredients.some((i) => i.status === "unknown"));
});

test("Trader Joe's products: packs and the items you buy", () => {
  const beans = one("a can of tj black beans");
  assert.ok(near(beans.qty, 3.5, 0.15), `can = whole pack, got ${beans.qty}`);
  assert.ok(one("2 carb balance tortillas").id === "p:mission-carb-balance-tortilla");
  assert.equal(one("2 carb balance tortillas").qty, 2);
});

test("Trader Joe's items by their own names; generic words stay generic", () => {
  assert.equal(one("orange chicken").id, "p:tj-mandarin-orange-chicken");
  assert.equal(one("8 gyoza").id, "p:tj-chicken-gyoza");
  assert.ok(near(one("8 gyoza").qty, 8 / 7));
  assert.equal(one("2 chicken sausages").id, "p:tj-chicken-sausage-apple");
  assert.equal(one("half a bag of cauliflower gnocchi").qty, 1.25);
  assert.equal(one("a third of a margherita pizza").qty, 0.99, "a serving is already a third of the pizza");
  assert.equal(one("fried rice").id, "f:fried-rice");
  assert.equal(one("tj fried rice").id, "p:tj-chicken-fried-rice", "saying TJ's picks their product");
  assert.equal(one("half a pizza").qty, 4, "half a pizza = 4 slices");
  assert.equal(one("greek yogurt").id, "f:greek-yogurt");
  const fr = one("fried chicken breast");
  assert.ok(labels(fr).includes("+ cooking oil (fried)"));
  assert.equal(fr.ignored.length, 0);
});
