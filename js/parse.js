/* parse.js — typed (or dictated) meals → loggable items, on the phone, no AI. No DOM.
   "chipotle bowl double chicken no rice extra guac and a pret coffee" becomes two items
   with every change spelled out; "8 oz pasta, 1 lb ground turkey, 2 cups marinara, makes 4,
   I had 1" becomes one recipe serving. Anything it can't place comes back "unknown" so the
   UI can ask for numbers once and remember them. Measurements live in units.js. */

import * as E from "./engine.js";
import * as U from "./units.js";

// ---------- text ----------

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const FRACS = { half: 0.5, halves: 0.5, quarter: 0.25, quarters: 0.25, fourth: 0.25, fourths: 0.25, third: 0.33, thirds: 0.33, eighth: 0.125, eighths: 0.125 };
const NUM_WORDS = { a: 1, an: 1, single: 1, couple: 2, pair: 2, few: 3, several: 3, dozen: 12 };
const SIZE_WORDS = { small: 0.7, smaller: 0.7, mini: 0.6, regular: 1, medium: 1, large: 1.4, big: 1.4, huge: 1.8, giant: 1.8, jumbo: 1.8 };
// drink sizes in fluid ounces (coffee-shop names included)
const DRINK_OZ = { short: 8, small: 12, tall: 12, medium: 16, regular: 16, grande: 16, large: 20, venti: 20, big: 20, trenta: 30 };
const MEASURE_WORDS = new Set(["g", "gram", "gr", "kg", "kilo", "kilogram", "oz", "ounce", "lb", "pound", "ml", "milliliter", "l", "liter", "litre", "tsp", "teaspoon", "tbsp", "tbs", "tablespoon", "cup", "floz", "pint", "quart", "spoonful", "teaspoonful", "tablespoonful"]);
const UNIT_WORDS = new Set(["pump", "bag", "box", "tub", "package", "carton", "block", "loaf", "head", "slice", "piece", "serving", "glass", "can", "bottle", "order", "portion", "handful", "scoop", "side", "bite", "helping", "plate", "container", "pack", "packet", "jar", "pouch", ...MEASURE_WORDS]);
const PREP_WORDS = { raw: "raw", uncooked: "raw", dry: "dry", dried_: "dry", cooked: "cooked" };
const COOK_OIL = ["fried", "sauteed", "sauted", "seared", "panfried"];
const STOP = new Set(["i", "id", "ive", "im", "we", "had", "have", "having", "ate", "eat", "eaten", "eating", "got", "get", "grabbed", "grab", "made", "make", "cook", "cooked", "drank", "drink", "drinking", "just", "the", "of", "for", "at", "from", "in", "today", "tonight", "this", "morning", "afternoon", "evening", "lunch", "breakfast", "dinner", "snack", "brunch", "later", "earlier", "then", "also", "like", "about", "around", "approx", "approximately", "roughly", "maybe", "kind", "sort", "some", "it", "was", "were", "that", "which", "there", "home", "homemade", "typical", "normal", "airfried", "tj", "again", "after", "before", "to", "go", "very", "really", "pretty", "so", "up", "out", "and", "or", "is", "are", "be", "on", "its", "too", "as", "well", "each", "all", "whole", "entire", "bit", "little", "piece", "raw", "uncooked", "dry", "sauteed", "sauted", "seared", "panfried", "split", "shared", "share", "most", "rest", "leftover", "leftovers", "second", "helping", "iced", "hot", "fresh", "plain", "big_", "pumps_", "worth", "probably", "think", "guess", "ish", "few", "couple", "half", "quarter", "third", "fourth"]);
// Words that start a change to the item they follow.
const MOD = {
  remove: ["no", "without", "hold", "minus", "skip", "remove", "removed", "nix", "zero", "w/o", "sans"],
  double: ["double", "doubled", "triple"],
  extra: ["extra", "more", "additional", "lots", "heavy", "loaded", "another"],
  add: ["add", "added", "adding", "with", "w", "plus", "topped", "+", "and_"],
  light: ["light", "lite", "less", "easy"],
};
const MOD_OF = Object.fromEntries(Object.entries(MOD).flatMap(([k, ws]) => ws.map((w) => [w, k])));

export function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("oes")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

/** Spoken numbers → digits: "one and a half cups" → "1.5 cups", "twenty five grams" → "25 grams". */
export function spokenNumbers(text) {
  let ws = text.split(" ");
  const isNum = (w) => /^\d+(\.\d+)?$/.test(w);
  const val = (w) => (isNum(w) ? parseFloat(w) : w in ONES ? ONES[w] : w in TENS ? TENS[w] : null);
  // compound integers: "one hundred fifty", "twenty five", "a hundred"
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    let v = val(ws[i]);
    if ((ws[i] === "a" || ws[i] === "one") && ws[i + 1] === "hundred") { v = 1; }
    if (v === null || isNum(ws[i]) && ws[i + 1] !== "hundred" && ws[i + 1] !== "point") { out.push(ws[i]); continue; }
    let n = v, j = i + 1;
    if (ws[j] === "hundred") { n *= 100; j++; if (ws[j] === "and") j++; }
    if (TENS[ws[j]] !== undefined && n % 100 === 0 && n >= 100) { n += TENS[ws[j]]; j++; }
    if (ONES[ws[j]] !== undefined && ONES[ws[j]] < 10 && (n % 10 === 0) && n >= 20) { n += ONES[ws[j]]; j++; }
    if (ws[j] === "point" && (val(ws[j + 1]) !== null)) { n = parseFloat(`${n}.${val(ws[j + 1])}`); j += 2; }
    out.push(String(n));
    i = j - 1;
  }
  ws = out;
  let s = ws.join(" ");
  s = s
    .replace(/\bhalf (?:a )?dozen\b/g, "6").replace(/\ba dozen\b/g, "12")
    .replace(/\b(\d+(?:\.\d+)?) and (?:a|one) half\b/g, (_, n) => String(+n + 0.5))
    .replace(/\b(\d+(?:\.\d+)?) and (?:a|one) quarter\b/g, (_, n) => String(+n + 0.25))
    .replace(/\b(\d+(?:\.\d+)?) and (\d) (quarters|fourths|thirds)\b/g, (_, n, k, f) => String(+n + +k * FRACS[f]))
    .replace(/\b(?:a|an|1) ([a-z]+) and a half\b/g, "1.5 $1")
    .replace(/\b(\d+(?:\.\d+)?) ([a-z]+) and a half\b/g, (_, n, u) => `${+n + 0.5} ${u}`)
    .replace(/\b(\d) (quarters|fourths|thirds|eighths)\b/g, (_, k, f) => String(Math.round(+k * FRACS[f] * 100) / 100))
    .replace(/\b(?:a|one|1) (half|quarter|third|fourth|eighth)(?: of)?\b/g, (_, f) => String(FRACS[f]))
    .replace(/\bhalf (?:a|an|of(?: an?| the| my)?)\b/g, "0.5")
    .replace(/\bquarter (?:of )?(?:a|an|the)\b/g, "0.25")
    .replace(/\b(?:a )?couple(?: of)?\b/g, "2").replace(/\ba few\b/g, "3").replace(/\bseveral\b/g, "3");
  return s;
}

/** Lowercase, expand shorthands, split numbers from units ("6oz" → "6 oz"), spoken numbers → digits. */
export function normalize(text) {
  let s = String(text || "").toLowerCase()
    .replace(/[½¼¾⅓⅔]/g, (c) => ({ "½": " 0.5", "¼": " 0.25", "¾": " 0.75", "⅓": " 0.33", "⅔": " 0.67" }[c]))
    .replace(/[’']/g, "")
    .replace(/w\/o\b/g, " without ").replace(/\bw\//g, " with ")
    .replace(/&/g, " and ").replace(/\+/g, " plus ")
    .replace(/(\d+)\s*(?:%|percent)/g, "$1pct")
    .replace(/\bair[\s-]?(?:fried|fryer|fry|crisped)\b/g, " airfried ")
    .replace(/\btrader\s*joe\s*s?\b|\btjs\b|\btj s\b/g, " tj ")
    .replace(/\b(\d{2})\s*\/\s*(\d{1,2})\b(?!\s*(?:cup|tsp|tbsp|teaspoon|tablespoon|oz|lb))/g, (m, a, b) => (+a > +b ? `lean${a}` : m))
    .replace(/\b(\d+)\s+(\d+)\s*\/\s*(\d+)\b/g, (_, w, a, b) => String(+w + Math.round((+a / +b) * 100) / 100))
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (_, a, b) => String(Math.round((+a / +b) * 100) / 100))
    .replace(/\bfl\.?\s*oz\b|\bfluid ounces?\b/g, " floz ")
    .replace(/(\d)\s*x\b/g, "$1 ").replace(/\bx\s*(\d)/g, "$1 ")
    .replace(/(\d)(oz|g|gr|grams?|ounces?|lbs?|ml|kg|tbsp|tsp|cups?|l)\b/g, "$1 $2")
    .replace(/:/g, " : ")
    .replace(/[^a-z0-9.\s,;:\n-]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " , ")
    .replace(/-/g, " ")
    .replace(/[ \t]+/g, " ").trim();
  // keep line breaks as list separators, but read numbers line by line
  return s.split("\n").map((line) => spokenNumbers(line.trim())).join("\n").replace(/\s+,/g, ",");
}

const words = (s) => normalize(s).replace(/[,;:\n]/g, " ").split(" ").filter(Boolean);
export const keyTokens = (s) => words(s).map(stem).filter((t) => !STOP.has(t) && !UNIT_WORDS.has(t) && !/^\d/.test(t) && !(t in NUM_WORDS) && !(t in SIZE_WORDS) && !(t in DRINK_OZ));

// Optimal string alignment distance, capped — typo tolerance for dictation/fat thumbs.
function osa(a, b, cap = 2) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function same(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 6) return false;
  return osa(a, b) <= (n >= 9 ? 2 : 1);
}

// ---------- lexicon ----------

const METHOD = new Set(["air", "fryer", "weekend", "batch", "freezer", "meal", "prep", "sheet", "pan", "quick", "easy", "classic", "homemade", "style"]);

function aliasList(name, extra = []) {
  const base = name.replace(/\(.*?\)/g, " ");
  const lists = [name, base, ...extra].map(keyTokens).filter((a) => a.length);
  // "Air Fryer Shawarma Bowl" is also just "shawarma bowl"
  const core = keyTokens(base).filter((t) => !METHOD.has(t));
  if (core.length && core.length < keyTokens(base).length) lists.push(core);
  return lists;
}

// "chipotle burrito" is also just "burrito" — but only once we know we're at Chipotle.
function placeOnlyAliases(lists, placeWords) {
  const pw = new Set(placeWords.flatMap(keyTokens));
  return lists.map((a) => a.filter((x) => !pw.has(x))).filter((t, i) => t.length && t.length < lists[i].length);
}

const ONE = { amount: 1, unit: "serving", dim: "count", nouns: [], g: null, ml: null, prep: null };

/**
 * Everything the parser can recognize, with its numbers and serving size. Personal things
 * (usuals, my foods, learned phrases, recents) carry a bonus so "my wrap" beats a generic wrap.
 */
export function buildLexicon({ eats, data, state, foods }) {
  const items = [];
  const cat = E.catalogItems(eats, data, state);
  const raw = new Map();
  for (const pl of eats?.places || []) for (const it of pl.items || []) raw.set(it.id, { ...it, place: pl.id });
  for (const h of eats?.home || []) raw.set(h.id, h);
  for (const c of cat) {
    const r = raw.get(c.id);
    const tpl = c.id.startsWith("meal:") ? data.templates.find((t) => `meal:${t.id}` === c.id) : null;
    const pl = c.place ? (eats.places || []).find((p) => p.id === c.place) : null;
    const aliases = aliasList(c.name, [...(r?.aliases || []), ...(tpl?.aliases || [])]);
    items.push({ ...c, kind: c.id.startsWith("meal:") ? "meal" : c.place ? "place" : "home", aliases, placeAliases: pl ? placeOnlyAliases(aliases, [pl.name, ...(pl.aliases || [])]) : [], bonus: 0, serving: ONE });
  }
  for (const f of foods || []) {
    items.push({ id: `f:${f.id}`, name: f.name, emoji: f.emoji, group: "Common foods", kind: f.addon ? "addon" : "food", calories: f.calories, protein: f.protein, unit: f.unit, liquid: !!f.liquid, drink: f.drink || null, serving: U.parseServing(f.unit, f), aliases: aliasList(f.name, f.aliases), bonus: f.addon ? -0.15 : 0 });
  }
  for (const p of data.products || []) {
    const eff = E.productById(data, state, p.id);
    items.push({ id: `p:${p.id}`, name: eff.name, emoji: "🛒", group: "Trader Joe's", kind: "product", calories: eff.calories, protein: eff.protein, unit: eff.unit, liquid: p.section === "Beverages", serving: U.parseServing(eff.unit, { g: p.grams, ml: p.ml, packServings: p.packServings, per: p.per }), aliases: aliasList(eff.name.replace(/^(tj'?s|trader joe'?s)\s+/i, ""), p.aliases || []), curated: new Set((p.aliases || []).map((a) => keyTokens(a).join(" "))), bonus: -0.06 });
  }
  for (const [code, b] of Object.entries(state.barcodes || {})) {
    items.push({ id: `bc:${code}`, name: b.name, emoji: "▦", group: "Scanned", kind: "barcode", calories: b.calories, protein: b.protein, serving: b.serving === "100 g" ? U.parseServing("100 g") : U.parseServing(b.serving || "1 serving", { g: b.servingG }), aliases: aliasList(b.name), bonus: 0.04 });
  }
  for (const m of state.myFoods || []) {
    items.push({ id: `m:${m.id}`, name: m.name, emoji: m.emoji || "🏷", group: "My foods", kind: "mine", calories: m.calories, protein: m.protein, unit: m.unit, liquid: !!m.liquid, serving: U.parseServing(m.unit, { g: m.grams, ml: m.ml, per: m.per }), aliases: aliasList(m.name, m.aliases || []), bonus: 0.12 });
  }
  // a product's short name only counts as its own when no generic food or dish uses it too
  const generic = new Set(items.filter((i) => i.kind !== "product").flatMap((i) => i.aliases.map((a) => a.join(" "))));
  for (const it of items) if (it.curated) for (const a of [...it.curated]) if (generic.has(a)) it.curated.delete(a);
  const seen = new Set(items.map((i) => i.name.toLowerCase()));
  for (const u of state.usuals || []) {
    if (u.ref) { const hit = items.find((i) => i.id === u.ref); if (hit) hit.bonus += 0.12; continue; }
    items.push({ id: `u:${u.id}`, name: u.name, emoji: u.emoji || "⭐", group: "Your usuals", kind: "usual", calories: u.calories, protein: u.protein, aliases: aliasList(u.name, u.aliases || []), bonus: 0.15, serving: ONE, recipe: u.recipe || null });
    seen.add(u.name.toLowerCase());
  }
  for (const d of Object.values(state.foodLog || {})) {
    for (const e of d.entries || []) {
      if (seen.has(e.name.toLowerCase())) continue;
      seen.add(e.name.toLowerCase());
      items.push({ id: `r:${e.name}`, name: e.name, emoji: e.emoji || "🍽", group: "Recent", kind: "recent", calories: e.calories, protein: e.protein, aliases: aliasList(e.name), bonus: 0.05, serving: ONE });
    }
  }
  const rawWords = (s) => words(s).map(stem);
  const places = (eats?.places || []).map((pl) => ({ id: pl.id, name: pl.name, aliases: [pl.name, ...(pl.aliases || [])].map(rawWords), components: (pl.components || []).map((c) => ({ ...c, tokens: aliasList(c.name, c.aliases || []) })) }));
  const addons = items.filter((i) => i.kind === "addon");
  // Every phrase a change can point at, for working out where "double chicken" ends.
  const modVocab = [...places.flatMap((p) => p.components.flatMap((c) => c.tokens)), ...addons.flatMap((a) => a.aliases), ...items.filter((i) => i.kind === "food" || i.kind === "product").flatMap((i) => i.aliases)];
  return { items, places, addons, modVocab, data, state };
}

// ---------- matching ----------

function matchAlias(alias, toks) {
  const used = new Set();
  let m = 0;
  for (const a of alias) {
    const j = toks.findIndex((t, k) => !used.has(k) && same(a, t));
    if (j >= 0) { used.add(j); m++; }
  }
  return { m, used };
}

function scoreItem(item, toks, ctxPlace, want = null) {
  let best = null;
  const all = ctxPlace && item.place === ctxPlace && item.placeAliases?.length ? [...item.aliases, ...item.placeAliases] : item.aliases;
  for (const alias of all) {
    const { m, used } = matchAlias(alias, toks);
    if (!m) continue;
    let precision = m / alias.length;
    const recall = m / toks.length;
    // every word said is in a long store-product name ("carb balance tortilla" → Mission Carb
    // Balance Soft Taco Tortilla). Not for dishes: "pulled pork" isn't a pulled pork quesadilla.
    if (recall === 1 && m >= 2 && ["product", "barcode", "mine"].includes(item.kind)) precision = Math.max(precision, 0.8);
    if (precision < 0.5) continue;
    const kindRank = { usual: 0.006, mine: 0.006, recent: 0.005, home: 0.004, place: 0.004, meal: 0.003, barcode: 0.003, food: 0.002, addon: 0, product: 0 }[item.kind] || 0;
    let s = 0.62 * precision + 0.38 * recall + item.bonus + m * 0.01 + kindRank;
    if (precision === 1 && recall === 1) s += 0.08;
    // a Trader Joe's product's own short name ("orange chicken", "gyoza") said exactly
    if (precision === 1 && recall === 1 && item.curated?.has(alias.join(" "))) s += 0.08;
    if (!best || s > best.score) best = { score: s, used, precision, recall };
  }
  if (!best) return null;
  if (ctxPlace) {
    if (item.place === ctxPlace) best.score += 0.35;
    else if (item.place) best.score -= 0.5;
    else if (item.kind === "food" || item.kind === "product") best.score -= 0.12;
  }
  // raw vs cooked vs dry: what the words (or a recipe) imply
  const prep = item.serving?.prep;
  if (want && prep) best.score += want === prep || (want === "raw" && prep === "dry") || (want === "dry" && prep === "raw") ? 0.09 : -0.09;
  // on a plate (no recipe, no "raw"), food is eaten cooked: raw/dry ingredients step back
  else if (!want && (prep === "raw" || prep === "dry")) best.score -= 0.07;
  return best;
}

function bestMatch(lex, toks, ctxPlace, want = null) {
  let best = null;
  for (const item of lex.items) {
    const s = scoreItem(item, toks, ctxPlace, want);
    if (s && (!best || s.score > best.score)) best = { item, ...s };
  }
  return best && best.score >= 0.5 ? best : null;
}

function alternatives(lex, toks, ctxPlace, chosenId, want, n = 3) {
  const seen = new Set([chosenId]);
  const out = [];
  for (const x of _rank(lex, toks, ctxPlace, want)) {
    if (out.length >= n || x.score < 0.55) break;
    if (seen.has(x.item.id) || x.item.kind === "addon" || x.precision < 1) continue;
    if (out.some((o) => o.name === x.item.name)) continue;
    seen.add(x.item.id);
    out.push({ id: x.item.id, name: x.item.name, emoji: x.item.emoji || "🍽", calories: x.item.calories, protein: x.item.protein, build: x.item.build || null, kind: x.item.kind, serving: x.item.serving, liquid: x.item.liquid });
  }
  return out;
}

function detectPlace(lex, toks) {
  // Place names must appear as written and in order ("just salad", not any "salad").
  for (const p of lex.places) {
    for (const a of p.aliases) {
      for (let i = 0; i + a.length <= toks.length; i++) {
        if (a.every((w, k) => toks[i + k] === w)) return { place: p.id, rest: toks.filter((_, j) => j < i || j >= i + a.length) };
      }
    }
  }
  return { place: null, rest: toks };
}

// place detection needs the words STOP would drop ("just")
const placeToks = (s) => words(s).map(stem);

// ---------- quantities ----------

const isNum = (w) => /^\d+(\.\d+)?$/.test(w);

/**
 * Amounts in a phrase: "2 eggs" → {amount 2}; "8 oz pasta" → {amount 8, unit oz};
 * "a cup of rice" → {amount 1, unit cup}; "venti latte" → {drinkOz 20}; "split a pizza" →
 * {share .5}; "a few bites of cake" → {share .3}. Anything not said stays null.
 */
function readQuantity(ws) {
  let amount = null, unit = null, size = 1, drinkOz = null, share = 1;
  const notes = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], next = ws[i + 1], next2 = ws[i + 2];
    const isA = w === "a" || w === "an" || w === "one";
    if ((isNum(w) || isA) && amount === null) {
      const n = isNum(w) ? parseFloat(w) : 1;
      let u = U.canonUnit(next);
      if (!u && next && /^\d/.test(next) === false && U.canonUnit(next2) && ["of"].includes(next)) u = null;
      if (u === "bite") { share *= n * 0.1; notes.push(`${n === 1 ? "a bite" : `${n} bites`}`); i++; continue; }
      if (u) { amount = n; unit = u; i++; continue; }
      if (isNum(w)) { amount = n; continue; }
    } else if (w in NUM_WORDS && amount === null && !isNum(next || "")) {
      if (w === "few" && (next === "bite" || next === "bites")) { share *= 0.3; notes.push("a few bites"); i++; continue; }
      if (w !== "a" && w !== "an") amount = NUM_WORDS[w];
    } else if (w === "bite" || w === "bites") {
      if (!notes.some((n) => n.includes("bite"))) { share *= 0.1; notes.push("a bite"); }
    } else if (w in DRINK_OZ) {
      drinkOz = (ws.includes("iced") && w === "venti") ? 24 : DRINK_OZ[w];
      if (w in SIZE_WORDS) size = SIZE_WORDS[w];
    } else if (w in SIZE_WORDS) size = SIZE_WORDS[w];
    else if ((w === "split" || w === "shared") && !notes.includes("shared")) { share *= 0.5; notes.push("shared"); }
    else if (w === "most" && next === "of") { share *= 0.75; notes.push("most of it"); }
    else if (w === "seconds" || (w === "second" && (next === "helping" || next === "serving" || next === "plate"))) { share *= 2; notes.push("seconds"); }
  }
  return { amount, unit, size, drinkOz, share, notes };
}

/** "300 calories", "a 250 cal bar", "30g protein", "protein 20" — numbers said outright. */
function statedNumbers(seg) {
  let s = ` ${seg} `;
  let calories = null, protein = null, each = false;
  s = s.replace(/\s(\d+(?:\.\d+)?)\s*(?:k?cals?|kcals?|calories|calorie)\b/g, (_, n) => { calories = +n; return " "; });
  s = s.replace(/\s(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:of\s+)?protein\b/g, (_, n) => { protein = +n; return " "; });
  s = s.replace(/\sprotein\s+(\d+(?:\.\d+)?)\s*(?:g|grams?)?\b/g, (_, n) => { protein = +n; return " "; });
  if (/\beach\b/.test(s) && (calories !== null || protein !== null)) { each = true; s = s.replace(/\beach\b/, " "); }
  s = s.replace(/\s(?:with|and|has|at|about|around)\s*$/, " ");
  return { rest: s.replace(/\s+/g, " ").trim(), calories, protein, each };
}

// ---------- modifiers ----------

const ARTICLES = new Set(["the", "on", "of", "a", "an", "some", "my", "it"]);

/** Split "bowl double chicken no rice extra 2 pumps of vanilla" into base words + changes. */
function splitMods(ws, lex) {
  const base = [];
  const mods = [];
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    let op = MOD_OF[w];
    if (w === "hold" && ws[i + 1] === "the") i++;
    if (!op) { base.push(w); i++; continue; }
    // stacked change words and articles: "with an extra", "add a double", "with no"
    let j = i + 1;
    for (let guard = 0; guard < 4; guard++) {
      if (MOD_OF[ws[j]]) { if (MOD_OF[ws[j]] !== "add") op = MOD_OF[ws[j]]; j++; continue; }
      if (ARTICLES.has(ws[j]) && !(ws[j] === "a" && U.canonUnit(ws[j + 1]))) { j++; continue; }
      break;
    }
    // optional amount: "2 pumps", "3 oz", "a tablespoon of", "half"
    let amount = null, unit = null;
    if (isNum(ws[j]) || ((ws[j] === "a" || ws[j] === "an") && U.canonUnit(ws[j + 1]))) {
      amount = isNum(ws[j]) ? parseFloat(ws[j]) : 1;
      const u = U.canonUnit(ws[j + 1]);
      if (u) { unit = u; j += 2; } else j += 1;
      if (ws[j] === "of") j++;
    } else if (U.canonUnit(ws[j]) && !U.isGenericCount(U.canonUnit(ws[j])) && (ws[j + 1] === "of" || lex.modVocab.some((a) => a.length > 0 && a[0] === stem(ws[j + 1] || "")))) {
      amount = 1; unit = U.canonUnit(ws[j]); j += 1; if (ws[j] === "of") j++;
    }
    // take the longest run of following words that names something changeable
    let take = 0;
    for (let len = Math.min(3, ws.length - j); len >= 1; len--) {
      const t = ws.slice(j, j + len).map(stem).filter((x) => !STOP.has(x) && !MEASURE_WORDS.has(x));
      if (!t.length) continue;
      if (lex.modVocab.some((a) => a.length === t.length && a.every((x, k) => same(x, t[k])))) { take = len; break; }
    }
    if (!take && unit && ["pump", "shot", "scoop"].includes(unit)) {
      // "extra pump", "an extra shot" — the unit itself names the add-on
      mods.push({ op, target: unit, tokens: [unit === "shot" ? "espresso" : unit === "scoop" ? "protein" : "pump"], amount, unit });
      i = j; continue;
    }
    if (!take) {
      // "with a coke" style: not a change, keep words for a possible second item
      if (op === "add") { base.push(...ws.slice(i, j + 1)); i = j + 1; continue; }
      take = ws[j] ? 1 : 0;
    }
    if (take) mods.push({ op, target: ws.slice(j, j + take).join(" "), tokens: ws.slice(j, j + take).map(stem).filter((x) => !STOP.has(x)), amount, unit });
    i = j + take;
    // "no rice or beans" / "extra guac and cheese": the change carries over a conjunction
    while ((ws[i] === "or" || ws[i] === "and") && ws[i + 1] && !MOD_OF[ws[i + 1]]) {
      const t = [stem(ws[i + 1])];
      if (!lex.modVocab.some((a) => a.length === 1 && same(a[0], t[0]))) break;
      mods.push({ op, target: ws[i + 1], tokens: t, amount: null, unit: null });
      i += 2;
    }
  }
  const joined = base.join(" ");
  const sideIdx = joined.indexOf("on the side");
  if (sideIdx >= 0) {
    const before = joined.slice(0, sideIdx).trim().split(" ");
    const target = before.pop();
    if (target) { mods.push({ op: "light", target, tokens: [stem(target)], amount: null, unit: null }); base.length = 0; base.push(...before); }
  }
  return { base, mods };
}

function findComponent(components, tokens) {
  let best = null;
  for (const c of components) {
    for (const a of c.tokens) {
      const { m } = matchAlias(a, tokens);
      if (m === a.length && m === tokens.length && (!best || a.length > best.len)) best = { c, len: a.length };
    }
  }
  if (best) return best.c;
  for (const c of components) for (const a of c.tokens) if (matchAlias(a, tokens).m === tokens.length) return c;
  return null;
}

function findAddon(lex, tokens) {
  // An add-on portion if one fits the words exactly; otherwise a common food or Trader Joe's
  // product ("peanut butter", not "butter"). Full coverage of the words beats a partial match.
  let best = null;
  for (const a of lex.items) {
    if (a.kind !== "addon" && a.kind !== "food" && a.kind !== "product" && a.kind !== "mine") continue;
    const s = scoreItem(a, tokens, null);
    if (!s || s.precision < 1) continue;
    const rank = s.recall * 10 + (a.kind === "addon" ? 0.5 : a.kind === "product" ? -0.2 : 0) + s.score;
    if (!best || rank > best.rank) best = { item: a, rank };
  }
  return best ? best.item : null;
}

const fmtQ = (q) => { const n = Math.round(q * 100) / 100; return { 0.25: "¼", 0.33: "⅓", 0.5: "½", 0.67: "⅔", 0.75: "¾", 1.5: "1½", 2.5: "2½" }[n] || String(n); };

// how many servings of an add-on a change means: amount if said, else by the change word
function addonServings(add, md) {
  if (md.amount !== null && md.amount !== undefined) {
    const conv = U.toServings(add.serving || ONE, md.amount, md.unit, { liquid: add.liquid });
    return conv.servings;
  }
  return 1;
}

function applyMods(lex, match, mods) {
  const item = match.item;
  const changes = [];
  const unplaced = [];
  // Chipotle-style builds: change the actual ingredient list
  if (item.build?.kind === "components") {
    const pl = lex.places.find((p) => p.id === item.build.place);
    const picks = { ...item.build.picks };
    const protein = (id) => pl.components.find((c) => c.id === id)?.group === "Protein";
    const namedProteins = mods.map((m) => findComponent(pl.components, m.tokens)).filter((c) => c && c.group === "Protein" && mods.find((m) => findComponent(pl.components, m.tokens) === c).op !== "remove");
    for (const md of mods) {
      const c = findComponent(pl.components, md.tokens);
      if (!c) { unplaced.push(md); continue; }
      const had = picks[c.id] || 0;
      let now;
      if (md.op === "remove") now = 0;
      else if (md.amount && !md.unit) now = md.amount;                            // "2 scoops of chicken"
      else if (md.op === "double") now = Math.max(2, had);                       // "double chicken" = two portions
      else if (md.op === "extra") now = c.group === "Protein" ? Math.max(2, had + 1) : had ? had + 0.5 : 1;
      else if (md.op === "light") now = 0.5;
      else now = had || 1;
      // "burrito with steak": the named protein replaces the default one, keeping the portion count
      if (c.group === "Protein" && !had && md.op !== "remove") {
        const current = Object.keys(picks).filter((id) => protein(id) && !namedProteins.some((n) => n.id === id));
        const portions = current.reduce((n, id) => n + picks[id], 0);
        if (current.length && namedProteins.length === 1) {
          for (const id of current) {
            const old = pl.components.find((x) => x.id === id);
            changes.push({ label: `swap ${old.name.toLowerCase()}`, kcal: -Math.round(old.calories * picks[id]) });
            delete picks[id];
          }
          if (md.op === "add" && !md.amount) now = portions;
        }
      }
      if (now === had) continue;
      if (now) picks[c.id] = now; else delete picks[c.id];
      changes.push({ label: now === 0 ? `no ${md.target}` : had === 0 ? `+ ${md.target}${now !== 1 ? ` ×${fmtQ(now)}` : ""}` : `${md.op === "light" ? "light" : md.op === "add" ? "×" + fmtQ(now) : md.op} ${md.target}`, kcal: Math.round(c.calories * (now - had)) });
    }
    const t = E.componentTotals(pl.components, picks);
    return { calories: t.calories, protein: t.protein, changes, unplaced, build: { ...item.build, picks } };
  }
  // Home combos: change product quantities, or add a product/food
  if (item.build?.kind === "products") {
    const rows = item.build.items.map((x) => ({ ...x }));
    let extraCal = 0, extraPro = 0;
    for (const md of mods) {
      const row = rows.find((r) => { const p = E.productById(lex.data, lex.state, r.product); return p && md.tokens.every((t) => keyTokens(p.name).some((n) => same(n, t))); });
      if (row) {
        const p = E.productById(lex.data, lex.state, row.product);
        const had = row.qty;
        const now = md.op === "remove" ? 0 : md.op === "double" ? had * 2 : md.op === "extra" ? had + Math.max(0.5, had * 0.5) : md.op === "light" ? had / 2 : had;
        if (now === had) continue;
        row.qty = now;
        changes.push({ label: now === 0 ? `no ${md.target}` : `${md.target} ×${fmtQ(Math.round((now / had) * 10) / 10)}`, kcal: Math.round(p.calories * (now - had)) });
        continue;
      }
      if (md.op === "remove") { unplaced.push(md); continue; }
      const add = findAddon(lex, md.tokens);
      if (!add) { unplaced.push(md); continue; }
      const mult = addonServings(add, md) * (md.op === "light" ? 0.5 : md.op === "double" && md.amount == null ? 2 : 1);
      extraCal += add.calories * mult; extraPro += add.protein * mult;
      changes.push({ label: `+ ${md.amount != null ? U.fmtAmount(md.amount, md.unit) + " " : ""}${md.target}`, kcal: Math.round(add.calories * mult) });
    }
    const t = E.productTotals(lex.data, lex.state, rows.filter((r) => r.qty > 0));
    return { calories: Math.round(t.calories + extraCal), protein: Math.round(t.protein + extraPro), changes, unplaced, build: { kind: "products", items: rows.filter((r) => r.qty > 0) } };
  }
  // Fixed-number items: add or subtract typical add-on portions (or the amount said)
  let cal = item.calories, pro = item.protein;
  for (const md of mods) {
    const add = findAddon(lex, md.tokens);
    if (!add) { unplaced.push(md); continue; }
    // "with chicken" on something that already says chicken changes nothing
    if (md.op === "add" && md.amount == null && keyTokens(item.name).some((n) => md.tokens.some((t) => same(n, t)))) continue;
    const portions = addonServings(add, md);
    const mult = md.op === "remove" ? -1 : md.op === "light" ? -0.5 : portions;
    cal += add.calories * mult; pro += add.protein * mult;
    const amt = md.amount != null ? `${U.fmtAmount(md.amount, md.unit)} ` : "";
    changes.push({ label: `${mult < 0 ? (md.op === "light" ? "light" : "no") : md.op === "double" ? "double" : md.op === "extra" ? "extra" : "+"} ${amt}${md.target}`, kcal: Math.round(add.calories * mult) });
  }
  return { calories: Math.max(Math.round(item.calories * 0.35), Math.round(cal)), protein: Math.max(0, Math.round(pro)), changes, unplaced, build: item.build || null };
}

// ---------- segments ----------

const SPLIT_RE = /\s*(?:[,;\n]|\band then\b|\bthen\b|\balso\b|\bplus\b(?=\s+(?:a|an|one|two|\d|some|my)\b)|\balong with\b)\s*/;

// "12 oz dry penne 1 lb ground beef" → two phrases: a number after a food word starts a new one,
// unless it follows a change word ("with 2 tbsp pesto") or an article.
function splitOnAmounts(part) {
  const ws = part.split(" ");
  const out = [];
  let cur = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], prev = ws[i - 1];
    const startsAmount = isNum(w) && prev && !isNum(prev) && !MOD_OF[prev] && !ARTICLES.has(prev) && !["and", "or", "about", "around", "like", "x", "of", "ate", "had", "into", "makes", "serves"].includes(prev) && !U.canonUnit(prev) && !/(cal|calorie|kcal|protein)/.test(ws[i + 1] || "") && !/^(cal|calorie|calories|kcal|g|grams?)$/.test(ws[i + 1] || "") ;
    // only split if what follows the number names a food of its own ("… 6 oz" just sizes this one)
    let k = i + 1;
    while (k < ws.length && !isNum(ws[k])) k++;
    const following = keyTokens(ws.slice(i + 1, k).join(" ")).length > 0;
    if (startsAmount && following && keyTokens(cur.join(" ")).length) { out.push(cur.join(" ")); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

function splitSegments(text, lex) {
  const parts = text.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean).flatMap(splitOnAmounts);
  const out = [];
  for (const part of parts) {
    // "and" separates items — unless the joined phrase is itself one thing ("eggs and toast")
    const bits = part.split(/\s+\band\b\s+/);
    let cur = bits[0];
    for (let k = 1; k < bits.length; k++) {
      const joined = `${cur} and ${bits[k]}`;
      const jp = detectPlace(lex, placeToks(splitMods(joined.split(" "), lex).base.join(" ")));
      const jr = keyTokens(jp.rest.join(" "));
      const whole = jr.length ? bestMatch(lex, jr, jp.place) : null;
      const isMod = MOD_OF[bits[k].split(" ")[0]];
      if (isMod || (whole && whole.precision === 1 && whole.recall === 1)) cur = joined;
      else { out.push(cur); cur = bits[k]; }
    }
    out.push(cur);
  }
  return out;
}

function unknownItem(text, stated = {}) {
  const name = text.replace(/^(a|an|some|my|the|\d+(\.\d+)?)\s+/i, "").trim() || text;
  const known = stated.calories != null;
  return { status: known ? "ok" : "unknown", text, name: name.charAt(0).toUpperCase() + name.slice(1), emoji: known ? "✏️" : "❓", calories: known ? stated.calories : null, protein: known ? stated.protein ?? 0 : null, qty: 1, changes: [], notes: known ? ["your numbers"] : [], ignored: [], alts: [] };
}

// "latte with oat milk" → "oat latte": milk choice changes which drink it is
function rewriteDrinks(seg) {
  return seg
    .replace(/\b(latte|flat white|cortado|macchiato)\s+(?:with|w|made with)\s+(oat|almond|soy|skim|nonfat|2pct|whole)(?:\s+milk)?\b/g, (_, d, m) => `${m === "nonfat" ? "skim" : m} latte`)
    .replace(/\b(oat|almond|soy|skim|nonfat|2pct)\s+milk\s+(latte|flat white|cortado)\b/g, (_, m) => `${m === "nonfat" ? "skim" : m} latte`);
}

function parseSegment(seg0, lex, ctxPlace, ctx = {}) {
  const stated = statedNumbers(rewriteDrinks(seg0));
  const seg = stated.rest;
  const ws = seg.split(" ").filter(Boolean);
  const want = ws.some((w) => PREP_WORDS[w] === "raw") ? "raw" : ws.includes("dry") ? "dry" : ws.includes("cooked") ? "cooked" : ctx.recipe ? "raw" : null;
  let oil = ws.some((w) => COOK_OIL.includes(w)) ? 1 : 0;
  const placeHit = detectPlace(lex, placeToks(seg));
  const place = placeHit.place || ctxPlace;
  // whole phrase as one thing first ("bagel with cream cheese", "double chicken bowl")
  const allToks = keyTokens(placeHit.rest.join(" "));
  if (!allToks.length) return place ? [] : [unknownItem(seg0, stated)];
  const whole = bestMatch(lex, allToks, place, want);
  const { base, mods } = splitMods(ws, lex);
  let baseToks = keyTokens(detectPlace(lex, placeToks(base.join(" "))).rest.join(" "));
  let match = baseToks.length ? bestMatch(lex, baseToks, place, want) : null;
  let useMods = mods;
  // a dish whose own name covers every word ("bagel with cream cheese") beats splitting off changes
  if (whole && whole.precision === 1 && whole.recall === 1 && (!match || whole.used.size > match.used.size || whole.score >= match.score + 0.05)) { match = whole; useMods = []; baseToks = allToks; }
  if (!match && whole) { match = whole; useMods = []; baseToks = allToks; }
  if (!match && mods.length && place) {
    // "chipotle double chicken no rice" with nothing else: start from that place's first build
    const pl = lex.items.find((i) => i.place === place && i.build);
    if (pl) match = { item: pl, score: 0.5, used: new Set(), precision: 1, recall: 1 };
  }
  if (!match) {
    const u = unknownItem(seg0, stated);
    return [u];
  }

  if (ws.includes("tj") && match.item.kind !== "product") {
    const tjp = _rank(lex, baseToks, place, want).find((x) => x.item.kind === "product" && x.precision >= 0.5 && x.score >= match.score - 0.3);
    if (tjp) match = tjp;
  }
  // "fried rice" names a food; "fried chicken breast" is chicken breast cooked in oil
  const friedIdx = baseToks.indexOf("fried");
  if (friedIdx >= 0 && match.used.has(friedIdx)) oil = 0;
  if (friedIdx >= 0 && !match.used.has(friedIdx)) match.used.add(friedIdx);
  const q = readQuantity(base.length ? base : ws);
  if (q.unit && U.isMeasure(q.unit) && !(match.item.serving?.g || match.item.serving?.ml)) {
    // "16 oz latte": prefer a version of this food that has a size we can scale
    const sized = _rank(lex, baseToks, place, want).find((x) => x.precision === 1 && (x.item.serving?.g || x.item.serving?.ml) && x.score >= match.score - 0.2 && x.item.kind !== "addon");
    if (sized) match = sized;
  }
  const res = applyMods(lex, match, useMods);
  const item = match.item;
  const notes = [...q.notes];
  let mult = 1, check = false;
  // "1 onion", "2 chicken breasts": the food's own noun can carry a whole-item size
  if (q.amount !== null && !q.unit && item.serving?.per) {
    const noun = baseToks.find((t) => item.serving.per[t]);
    if (noun) q.unit = noun;
  }
  if (q.amount !== null) {
    const conv = U.toServings(item.serving || ONE, q.amount, q.unit, { liquid: item.liquid });
    mult = conv.servings;
    if (q.unit && !(item.serving?.per?.[q.unit] && baseToks.includes(q.unit))) notes.unshift(U.fmtAmount(q.amount, q.unit));
    else if (q.unit) notes.unshift(`${U.fmtAmount(q.amount, null)} whole`);
    if (!conv.ok) { check = true; mult = 1; notes.push(`couldn't size ${U.fmtAmount(q.amount, q.unit)} for this — counted 1 serving, adjust if needed`); }
  }
  if (q.drinkOz && item.liquid && item.serving?.ml && q.unit == null) {
    mult *= (q.drinkOz * 29.57) / item.serving.ml;
    notes.push(`${q.drinkOz} oz`);
  } else if (q.size !== 1 && (item.kind === "food" || item.kind === "addon" || item.kind === "product")) {
    mult *= q.size; notes.push(q.size > 1 ? "large" : "small");
  }
  mult *= q.share;
  let calories = res.calories, protein = res.protein;
  // a 24 oz iced coffee with milk and 2 sugars: the coffee scales with size, the milk and
  // sugar are per drink — fold everything into one drink
  if (item.liquid && mult !== 1 && (q.drinkOz || (q.unit && U.isMeasure(q.unit))) && res.changes.length && !res.build) {
    calories = item.calories * mult + (res.calories - item.calories);
    protein = item.protein * mult + (res.protein - item.protein);
    mult = q.share;
  }
  const changes = [...res.changes];
  if (oil && !/fried|fries|fry|crispy|tempura/i.test(item.name)) {
    const oilItem = lex.items.find((i) => i.id === "f:olive-oil-food");
    if (oilItem) {
      // half a tablespoon of oil per serving, spread over the portion actually eaten
      const add = Math.round(oilItem.calories * 0.5);
      calories += add / Math.max(0.01, mult);
      changes.push({ label: "+ cooking oil (fried)", kcal: add });
    }
  }
  if (stated.calories != null) {
    // the owner's own number wins: "a 250 calorie protein bar"
    const per = stated.each ? stated.calories : stated.calories / Math.max(0.01, mult);
    calories = per;
    if (stated.protein != null) protein = stated.each ? stated.protein : stated.protein / Math.max(0.01, mult);
    notes.push("your numbers");
  } else if (stated.protein != null) {
    protein = stated.each ? stated.protein : stated.protein / Math.max(0.01, mult);
  }
  const alts = alternatives(lex, baseToks, place, item.id, want);
  const close = alts.length && _rank(lex, baseToks, place, want).find((x) => x.item.id === alts[0].id)?.score >= match.score - 0.03;
  const out = [{
    status: match.score >= 0.75 && !res.unplaced.length && !close && !check ? "ok" : "check",
    text: seg0, id: item.id, kind: item.kind, name: item.name, emoji: item.emoji || "🍽", group: item.group,
    qty: Math.round(mult * 1000) / 1000, calories: Math.round(calories), protein: Math.round(protein * 10) / 10,
    changes, notes, build: res.build, unit: item.unit || "", alts, serving: item.serving, liquid: !!item.liquid,
    ignored: res.unplaced.map((m) => `${m.op === "remove" ? "no" : m.op} ${m.target}`),
    order: Math.min(...[...match.used].concat([99])),
  }];
  // leftover words that weren't part of the match → more items ("eggs toast coffee")
  let left = baseToks.map((t, i) => ({ t, i })).filter(({ i }) => !match.used.has(i));
  for (let guard = 0; left.length && useMods === mods && guard < 6; guard++) {
    const lt = left.map((x) => x.t);
    const extra = bestMatch(lex, lt, place, want);
    if (!extra || extra.precision < 1 || extra.score < 0.6) break;
    const r2 = applyMods(lex, extra, []);
    out.push({ status: "check", text: [...extra.used].map((k) => lt[k]).join(" "), id: extra.item.id, kind: extra.item.kind, name: extra.item.name, emoji: extra.item.emoji || "🍽", group: extra.item.group, qty: 1, calories: r2.calories, protein: r2.protein, changes: [], notes: [], build: r2.build, unit: extra.item.unit || "", serving: extra.item.serving, liquid: !!extra.item.liquid, ignored: [], alts: alternatives(lex, [...extra.used].map((k) => lt[k]), place, extra.item.id, want), order: Math.min(...[...extra.used].map((k) => left[k].i)) });
    left = left.filter((_, k) => !extra.used.has(k));
  }
  if (left.some((x) => x.t.length > 2)) { out[0].ignored.push(...left.map((x) => x.t)); out[0].status = "check"; }
  return out.sort((a, b) => a.order - b.order);
}

// ---------- recipes ----------

const SERVINGS_RE = /\b(?:makes|made|serves|yields?|yielded|split (?:it |that )?into|divided (?:it |that )?into|portioned (?:it |that )?(?:out )?into|cut (?:it )?into|(?:it )?(?:was|is) (?:enough for)?)\s*(\d+(?:\.\d+)?)\s*(?:servings?|portions?|meals?|containers?|bowls?|plates?|pieces?|slices?|people)?\b|\b(\d+(?:\.\d+)?)\s*(?:servings?|portions?|meal preps?)\b(?!\s+of)/;
const EATEN_RE = /\b(?:i\s+)?(?:ate|had|eaten|eating|having|took|finished)\s+(\d+(?:\.\d+)?)\s*(?:of\s+(?:them|it|those|that)\s*)?(?:servings?|portions?|bowls?|plates?|pieces?|slices?|containers?)?\b/;

function detectRecipe(text) {
  let s = text;
  let servings = null, eaten = null, name = null;
  const sm = s.match(SERVINGS_RE);
  if (sm) { servings = parseFloat(sm[1] || sm[2]); s = s.replace(sm[0], " , "); }
  const em = s.match(EATEN_RE);
  if (em && servings) { eaten = parseFloat(em[1]); s = s.replace(em[0], " , "); }
  if (servings && /\bi\s+(?:ate|had)\s+(?:all of it|the whole thing)\b/.test(s)) { eaten = servings; s = s.replace(/\bi\s+(?:ate|had)\s+(?:all of it|the whole thing)\b/, " , "); }
  const nm = s.match(/^\s*(?:recipe\s*(?:for)?\s*)?([a-z][a-z ]{2,40}?)\s*(?:recipe)?\s*:\s*/);
  if (nm) { name = nm[1].trim(); s = s.slice(nm[0].length); }
  else if (/^\s*recipe\b/.test(s)) s = s.replace(/^\s*recipe\b/, "");
  const amountItems = (s.match(/\b\d+(?:\.\d+)?\s*(?:g|kg|oz|lb|ml|cup|tbsp|tsp|floz|pint)s?\b/g) || []).length;
  const isRecipe = !!servings || /^\s*recipe\b|\brecipe\s*:/.test(text) || (!!nm && amountItems >= 2) || amountItems >= 3;
  return { isRecipe, servings: servings || 1, eaten: eaten ?? 1, name, text: s.replace(/\s*,\s*(,\s*)+/g, ", ").replace(/^[\s,]+|[\s,]+$/g, "") };
}

function combineRecipe(r, ingredients, original) {
  const total = ingredients.reduce((acc, it) => {
    if (it.calories == null) return acc;
    return { calories: acc.calories + it.calories * it.qty, protein: acc.protein + (it.protein || 0) * it.qty };
  }, { calories: 0, protein: 0 });
  const missing = ingredients.filter((i) => i.status === "unknown").length;
  const unsized = ingredients.filter((i) => (i.notes || []).some((n) => n.startsWith("couldn't"))).length;
  const name = r.name ? r.name.charAt(0).toUpperCase() + r.name.slice(1) : "Homemade recipe";
  return {
    status: missing || unsized ? "check" : "ok", kind: "recipe", text: original, id: null, name, emoji: "🍲", group: "Recipe",
    servings: r.servings, qty: r.eaten, ingredients,
    calories: Math.round(total.calories / r.servings), protein: Math.round((total.protein / r.servings) * 10) / 10,
    totalCalories: Math.round(total.calories), totalProtein: Math.round(total.protein),
    changes: [], notes: [`${fmtQ(r.eaten)} of ${fmtQ(r.servings)} serving${r.servings === 1 ? "" : "s"}`], ignored: missing ? [`${missing} ingredient${missing === 1 ? "" : "s"} need numbers`] : [], alts: [], build: null,
  };
}

/** Recompute a recipe item after the owner edits an ingredient, servings, or what they ate. */
export function recomputeRecipe(item) {
  return { ...item, ...combineRecipe({ name: item.name, servings: item.servings, eaten: item.qty }, item.ingredients, item.text), name: item.name };
}

// ---------- entry point ----------

const DAY_RE = /\b(?:the day before yesterday|day before yesterday)\b|\byesterday\b|\blast night\b/;

/**
 * Parse free text into items. Returns { items, dayOffset }:
 *   items: status "ok" | "check" | "unknown", name, emoji, qty (servings), calories/protein per
 *   serving (null when unknown), changes [{label, kcal}], notes [], ignored [], text, and for
 *   recipes kind "recipe" with ingredients/servings.
 *   dayOffset: -1 when the text says "yesterday" / "last night", -2 for the day before.
 */
export function parseMeal(text, lex) {
  let norm = normalize(text);
  let dayOffset = 0;
  const dm = norm.match(DAY_RE);
  if (dm) { dayOffset = /before/.test(dm[0]) ? -2 : -1; norm = norm.replace(DAY_RE, " ").replace(/\s+/g, " ").trim(); }
  const recipe = detectRecipe(norm);
  const items = parseList((recipe.isRecipe ? recipe.text : norm).replace(/\s*:\s*/g, ", "), lex, { recipe: recipe.isRecipe });
  if (recipe.isRecipe && items.length) {
    // "pasta bake 12 oz penne 1 lb beef …": a leading phrase with no amount is the dish's name
    const first = items[0];
    if (!recipe.name && items.length > 2 && !/\d/.test(first.text) && items.slice(1).filter((i) => /\d/.test(i.text)).length >= 2) {
      recipe.name = first.text.replace(/^(recipe|my|a|the)\s+/, "");
      items.shift();
    }
    return { items: [combineRecipe(recipe, items, text.trim())], dayOffset };
  }
  return { items, dayOffset };
}

function parseList(text, lex, ctx) {
  const segs = splitSegments(text, lex);
  const items = [];
  let ctxPlace = null;
  for (const seg of segs) {
    const toks = keyTokens(seg);
    const pl = detectPlace(lex, placeToks(seg)).place;
    const first = seg.split(" ")[0];
    // a bare follow-up like "and extra guac" / "no beans" belongs to the previous item
    if (!ctx.recipe && MOD_OF[first] && MOD_OF[first] !== "add" && items.length && items[items.length - 1].status !== "unknown") {
      const prev = items[items.length - 1];
      const prevItem = lex.items.find((i) => i.id === prev.id);
      if (prevItem) {
        const { mods } = splitMods(seg.split(" "), lex);
        const merged = applyMods(lex, { item: { ...prevItem, build: prev.build || prevItem.build, calories: prev.calories, protein: prev.protein } }, mods);
        prev.calories = merged.calories; prev.protein = merged.protein; prev.build = merged.build;
        prev.changes = [...prev.changes, ...merged.changes];
        prev.ignored.push(...merged.unplaced.map((m) => `${m.op} ${m.target}`));
        continue;
      }
    }
    if (pl) ctxPlace = pl;
    const prev = items[items.length - 1];
    const prevItem = !ctx.recipe && prev && prev.status !== "unknown" ? lex.items.find((i) => i.id === prev.id) : null;
    if (prevItem && !pl) {
      // "chipotle burrito with steak, no beans, sour cream" → sour cream goes in the burrito;
      // "latte, 2 pumps of vanilla" / "yogurt with berries and honey" → onto the item before
      const build = prev.build || prevItem.build;
      const placeObj = build?.kind === "components" ? lex.places.find((p) => p.id === build.place) : null;
      const q = readQuantity(seg.split(" "));
      const bare = !/^\d/.test(first) && !["a", "an", "one", "my"].includes(first);
      const asComponent = placeObj && toks.length && bare && findComponent(placeObj.components, toks);
      const top = !asComponent && toks.length ? bestMatch(lex, toks, null) : null;
      const addonFull = top && lex.addons.some((a) => scoreItem(a, toks, null)?.precision === 1 && scoreItem(a, toks, null)?.recall === 1);
      // "2 pumps of caramel" / "an extra shot" after a drink always goes on the drink
      const attach = asComponent || (addonFull && (top.item.kind === "addon" || (bare && top.item.kind === "product")));
      if (attach) {
        const md = { op: "add", target: seg.replace(/^(and|some|a little|a bit of|\d+(\.\d+)?\s+\S+\s+of|\d+(\.\d+)?)\s+/, ""), tokens: toks, amount: q.amount, unit: q.unit };
        const merged = applyMods(lex, { item: { ...prevItem, build, calories: prev.calories, protein: prev.protein } }, [md]);
        if (merged.changes.length) {
          prev.calories = merged.calories; prev.protein = merged.protein; prev.build = merged.build;
          prev.changes = [...prev.changes, ...merged.changes];
          continue;
        }
      }
    }
    items.push(...parseSegment(seg, lex, pl || null, ctx));
  }
  return items;
}

/** One-line description of what was understood, for the entry's detail field. */
export function describe(item) {
  const bits = [];
  if (item.kind === "recipe") {
    bits.push(...item.notes, ...item.ingredients.map((i) => `${i.notes?.[0] && /\d/.test(i.notes[0]) ? i.notes[0] + " " : i.qty !== 1 ? `×${fmtQ(i.qty)} ` : ""}${i.name}`));
    return bits.join(", ");
  }
  if (item.qty !== 1 && !(item.notes[0] && /\d/.test(item.notes[0]))) bits.push(`×${fmtQ(item.qty)}`);
  bits.push(...item.notes, ...item.changes.map((c) => c.label));
  return bits.join(", ");
}

// test/debug helper: every candidate's score for a token list, best first
export function _rank(lex, toks, ctxPlace = null, want = null) {
  return lex.items.map((item) => ({ item, ...(scoreItem(item, toks, ctxPlace, want) || { score: -1 }) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}
