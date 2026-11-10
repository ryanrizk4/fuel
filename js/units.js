/* units.js — measurements for the typed-meal parser. No DOM.
   Every food has a serving ("1/2 cup", "4 oz raw", "1 patty (4 oz)", "16 oz"); this turns
   whatever amount the owner says ("8 oz", "a cup and a half", "200 g", "3 slices") into a
   number of servings of that food, or says honestly that it can't. */

// canonical unit → [dimension, size in base units (g, ml, or 1 for counts)]
export const UNITS = {
  g: ["mass", 1], kg: ["mass", 1000], oz: ["mass", 28.35], lb: ["mass", 453.6],
  ml: ["vol", 1], l: ["vol", 1000], tsp: ["vol", 4.93], tbsp: ["vol", 14.79], cup: ["vol", 236.6],
  floz: ["vol", 29.57], pint: ["vol", 473], quart: ["vol", 946],
};

// spoken/written forms → canonical. Count units keep their own name.
const ALIAS = {
  g: "g", gr: "g", gram: "g", grams: "g", gm: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  oz: "oz", ozs: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp", teaspoonful: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tablespoonful: "tbsp", spoonful: "tbsp", spoonfuls: "tbsp", spoon: "tbsp",
  cup: "cup", cups: "cup", c: "cup",
  floz: "floz", pint: "pint", pints: "pint", quart: "quart", quarts: "quart",
};

// counts: anything that is "one of" something. Generic ones mean "one serving".
const GENERIC_COUNT = new Set(["serving", "servings", "portion", "portions", "order", "orders", "helping", "helpings", "plate", "plates", "piece", "pieces", "pc", "pcs", "item", "items"]);
const COUNT = new Set([...GENERIC_COUNT, "slice", "slices", "scoop", "scoops", "pump", "pumps", "shot", "shots", "packet", "packets", "stick", "sticks", "link", "links", "strip", "strips", "can", "cans", "bottle", "bottles", "glass", "glasses", "bar", "bars", "handful", "handfuls", "container", "containers", "bag", "bags", "bite", "bites", "square", "squares", "wedge", "wedges", "clove", "cloves", "patty", "patties", "fillet", "fillets", "egg", "eggs", "tortilla", "tortillas", "wing", "wings", "nugget", "nuggets", "meatball", "meatballs", "tender", "tenders", "taco", "tacos", "roll", "rolls", "pack", "packs", "jar", "jars", "pouch", "pouches", "sheet", "sheets", "thin", "thins", "cake", "cakes", "cookie", "cookies", "splash", "dash", "drizzle", "pinch", "sprinkle", "dollop", "pat"]);
const SMALL = { splash: ["tbsp", 2], dash: ["tsp", 1], drizzle: ["tsp", 2], pinch: ["tsp", 0.1], sprinkle: ["tbsp", 1], dollop: ["tbsp", 2], pat: ["tsp", 1] };

export const singular = (w) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("ches") || w.endsWith("shes") || w.endsWith("sses") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** "ounces" → "oz", "slices" → "slice", "cup" → "cup"; null when it isn't a unit. */
export function canonUnit(word) {
  if (!word) return null;
  const w = String(word).toLowerCase();
  if (ALIAS[w]) return ALIAS[w];
  if (COUNT.has(w)) return singular(w);
  return null;
}
export const isMeasure = (u) => !!UNITS[u];
export const isGenericCount = (u) => GENERIC_COUNT.has(u) || GENERIC_COUNT.has(u + "s");

const FRAC = (s) => (s.includes("/") ? s.split("/").reduce((a, b) => +a / +b) : parseFloat(s));

/**
 * Read a serving string: "1/2 cup" → {amount: .5, unit: "cup", dim: "vol", ml: 118};
 * "1 patty (4 oz)" → {amount: 1, unit: "patty", dim: "count", g: 113}; "4 oz raw" →
 * {amount: 4, unit: "oz", dim: "mass", g: 113, prep: "raw"}. Extra known weights
 * (`g`, `ml` per serving from the food record) fill in whatever the string lacks.
 */
export function parseServing(str, known = {}) {
  const s = String(str || "1 serving").toLowerCase().replace(/[½¼¾⅓⅔]/g, (c) => ({ "½": ".5", "¼": ".25", "¾": ".75", "⅓": ".33", "⅔": ".67" }[c]));
  const out = { amount: 1, unit: "serving", dim: "count", nouns: [], g: known.g || null, ml: known.ml || null, prep: known.prep || null, per: { ...(known.per || {}) } };
  // a purchasable pack: "1 can", "a jar", "the whole bag" = all its servings
  if (known.packServings > 1) for (const k of ["can", "jar", "pack", "package", "bag", "box", "container", "tub", "bottle", "carton", "block", "loaf", "pouch"]) if (!out.per[k]) out.per[k] = known.packServings;
  const paren = s.match(/\((\d+(?:\.\d+)?)\s*(g|oz|ml)\b/);
  if (paren) {
    const n = parseFloat(paren[1]);
    if (paren[2] === "g") out.g = out.g || n;
    if (paren[2] === "oz") out.g = out.g || n * 28.35;
    if (paren[2] === "ml") out.ml = out.ml || n;
  }
  const main = s.replace(/\(.*?\)/g, " ").replace(/\bfl\.?\s*oz\b/g, "floz");
  const m = main.match(/^\s*(\d+(?:\.\d+)?(?:\/\d+)?|few|a)?\s*([a-z]+)?/);
  if (m) {
    if (m[1] && /\d/.test(m[1])) out.amount = FRAC(m[1]);
    const u = canonUnit(m[2]);
    if (u && UNITS[u]) {
      out.unit = u; out.dim = UNITS[u][0];
      const base = out.amount * UNITS[u][1];
      if (out.dim === "mass") out.g = base; else out.ml = base;
    } else if (u) { out.unit = u; out.nouns.push(u); }
    else if (m[2]) out.nouns.push(singular(m[2]));
  }
  for (const w of main.split(/[^a-z]+/)) {
    if (["raw", "uncooked"].includes(w)) out.prep = out.prep || "raw";
    if (w === "dry") out.prep = out.prep || "dry";
    if (w === "cooked") out.prep = out.prep || "cooked";
    const cu = canonUnit(w);
    if (cu && !UNITS[cu] && !out.nouns.includes(cu)) out.nouns.push(cu);
    else if (w.length > 2 && !cu && !["raw", "dry", "cooked", "large", "medium", "small", "whole", "diced", "chopped", "drained"].includes(w) && !out.nouns.includes(singular(w))) out.nouns.push(singular(w));
  }
  return out;
}

/**
 * How many servings is `amount` `unit` of a food with this serving?
 * Returns { servings, ok, how } — ok:false means the units didn't line up (e.g. grams of a
 * Chipotle bowl) and the caller should treat the number as a count and flag it.
 * `liquid` makes a bare "oz" mean fluid ounces (a 16 oz latte is volume, not weight).
 */
export function toServings(serving, amount, unit, { liquid = false } = {}) {
  // "8 gyoza" of a 7-piece serving; "a third of a pizza" when a serving is already ⅓ pizza
  if (!unit) return { servings: amount / (serving.dim === "count" && serving.amount > 0 ? serving.amount : 1), ok: true, how: "count" };
  let u = unit;
  if (u === "oz" && liquid) u = "floz";
  if (SMALL[u]) { const [su, n] = SMALL[u]; return toServings(serving, amount * n, su, { liquid }); }
  const spec = UNITS[u];
  if (spec) {
    const [dim, size] = spec;
    const qty = amount * size;
    if (dim === "mass") {
      if (serving.g) return { servings: qty / serving.g, ok: true, how: "weight" };
      // a liquid by weight ≈ by volume (1 g ≈ 1 ml) — close enough for drinks and sauces
      if (serving.ml && liquid) return { servings: qty / serving.ml, ok: true, how: "weight≈volume" };
    } else {
      if (serving.ml) return { servings: qty / serving.ml, ok: true, how: "volume" };
      if (serving.g && liquid) return { servings: qty / serving.g, ok: true, how: "volume≈weight" };
    }
    return { servings: amount, ok: false, how: "unconverted" };
  }
  // whole things with a known size: a can of beans, a jar of sauce, a whole onion, a pack
  if (serving.per?.[u]) return { servings: amount * serving.per[u], ok: true, how: `per ${u}` };
  // count units: "3 slices" of a 1-slice serving, "4 meatballs" of a 2-meatball serving
  if (isGenericCount(u)) return { servings: amount, ok: true, how: "servings" };
  if (serving.nouns.includes(u)) return { servings: amount / (serving.dim === "count" ? serving.amount : 1), ok: true, how: "count" };
  if (serving.dim === "count") return { servings: amount / serving.amount, ok: true, how: "count" };
  return { servings: amount, ok: true, how: "count?" };
}

export function fmtAmount(amount, unit) {
  const n = Math.round(amount * 100) / 100;
  const nice = { 0.25: "¼", 0.33: "⅓", 0.5: "½", 0.67: "⅔", 0.75: "¾", 1.5: "1½", 2.5: "2½" }[n] || String(n);
  if (!unit) return nice;
  const label = { floz: "fl oz" }[unit] || unit;
  const plural = n > 1 && !label.endsWith("s") && (!UNITS[unit] || ["cup", "pint", "quart"].includes(unit));
  return `${nice} ${label}${plural ? "s" : ""}`;
}
