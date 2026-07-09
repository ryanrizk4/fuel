/* Data integrity tests — every template must reference real products with sane macros. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../js/engine.js";

const products = JSON.parse(readFileSync(new URL("../data/products.json", import.meta.url))).products;
const templates = JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url))).templates;
const DATA = { products, templates };
const ids = new Set(products.map((p) => p.id));

test("no duplicate product ids", () => {
  assert.equal(ids.size, products.length);
});

test("every product has the required fields and sane values", () => {
  const sections = new Set(["Produce", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Pantry", "Bread & Bakery", "Snacks", "Condiments & Sauces", "Beverages"]);
  for (const p of products) {
    assert.ok(p.id && p.name && p.unit, `${p.id || "?"} missing basics`);
    assert.ok(sections.has(p.section), `${p.id}: unknown section "${p.section}"`);
    assert.ok(["verified", "estimated"].includes(p.confidence), `${p.id}: bad confidence`);
    assert.ok(p.calories >= 0 && p.calories <= 700, `${p.id}: calories ${p.calories} out of range for a single serving`);
    assert.ok(p.protein >= 0 && p.protein <= 60, `${p.id}: protein ${p.protein} out of range`);
    assert.ok(p.protein * 4 <= p.calories + 8, `${p.id}: protein kcal exceed total kcal`);
  }
});

test("every template ingredient reference resolves", () => {
  for (const t of templates) {
    for (const i of t.base) assert.ok(ids.has(i.product), `${t.id}: unknown base product ${i.product}`);
    for (const v of t.variants) {
      for (const i of v.add || []) assert.ok(ids.has(i.product), `${t.id}/${v.id}: unknown add ${i.product}`);
      for (const r of v.remove || []) assert.ok(ids.has(r), `${t.id}/${v.id}: unknown remove ${r}`);
      for (const r of v.remove || []) {
        assert.ok(t.base.some((b) => b.product === r), `${t.id}/${v.id}: removes ${r} which isn't in base`);
      }
    }
  }
});

test("every template has required fields, a classic variant, and terse steps", () => {
  const mealTypes = new Set(["breakfast", "lunch", "dinner"]);
  for (const t of templates) {
    assert.ok(t.id && t.name && t.emoji, `${t.id || "?"} missing basics`);
    assert.ok(t.mealType.length && t.mealType.every((m) => mealTypes.has(m)), `${t.id}: bad mealType`);
    assert.ok(t.variants.length >= 1 && t.variants.length <= 5, `${t.id}: ${t.variants.length} variants`);
    assert.equal(t.variants[0].id, "classic", `${t.id}: first variant must be 'classic' (the app's fallback)`);
    assert.ok(t.steps.length >= 1 && t.steps.length <= 5, `${t.id}: steps must be 1-5, got ${t.steps.length}`);
    assert.ok(t.prepMinutes > 0 && t.prepMinutes <= 45, `${t.id}: prepMinutes ${t.prepMinutes}`);
    assert.ok(typeof t.freezerFriendly === "boolean" && typeof t.repeatOk === "boolean", `${t.id}: flags`);
    if (t.source === "trending") assert.ok(t.origin, `${t.id}: trending template needs an origin line`);
  }
});

test("main-meal macros hit the house targets (≤700 kcal, ≥25g protein per serving)", () => {
  for (const t of templates) {
    const isMain = t.mealType.includes("lunch") || t.mealType.includes("dinner");
    if (!isMain) continue;
    for (const v of t.variants) {
      const mm = E.mealMacros(DATA, { productOverrides: {} }, t.id, v.id);
      assert.ok(mm.calories > 0, `${t.id}/${v.id}: zero calories — broken refs?`);
      assert.ok(mm.calories <= 700, `${t.id}/${v.id}: ${mm.calories} kcal exceeds the 700 kcal ceiling for mains`);
      assert.ok(mm.protein >= 25, `${t.id}/${v.id}: only ${mm.protein}g protein — below the 25g floor for mains`);
    }
  }
});

test("breakfast templates stay light (≤400 kcal)", () => {
  for (const t of templates) {
    if (!t.mealType.includes("breakfast") || t.mealType.includes("lunch")) continue;
    for (const v of t.variants) {
      const mm = E.mealMacros(DATA, { productOverrides: {} }, t.id, v.id);
      assert.ok(mm.calories <= 400, `${t.id}/${v.id}: ${mm.calories} kcal is heavy for a breakfast slot`);
    }
  }
});

test("snack products exist for the auto-planner (protein snacks + at least one treat)", () => {
  const snacks = products.filter((p) => p.snack);
  assert.ok(snacks.filter((s) => !s.treat).length >= 3, "need ≥3 protein snacks for variety");
  assert.ok(snacks.some((s) => s.treat), "need at least one treat");
});

test("packServings present for anything the shopping list needs to count into packs", () => {
  for (const p of products) {
    if (p.packServings !== null) {
      assert.ok(Number.isFinite(p.packServings) && p.packServings > 0, `${p.id}: bad packServings`);
    }
  }
});
