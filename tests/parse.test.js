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
  assert.equal(big.id, "f:latte-oat"); assert.equal(big.qty, 1.4);
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
  assert.deepEqual(parse("eggs toast coffee").map((i) => i.name.split(" ")[0]), ["Egg", "Toast", "Pret"]);
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
  assert.equal(PZ.describe(eggs), "×3");
});
