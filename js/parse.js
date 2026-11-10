/* parse.js — typed (or dictated) meals → loggable items, on the phone, no AI. No DOM.
   "chipotle bowl double chicken no rice extra guac and a pret coffee" becomes two items
   with every change spelled out. Anything it can't place is returned as "unknown" so the
   UI can ask for numbers once and remember them. */

import * as E from "./engine.js";

// ---------- text ----------

const NUM_WORDS = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, pair: 2, few: 3, several: 3, dozen: 12, half: 0.5, quarter: 0.25 };
const SIZE_WORDS = { small: 0.7, smaller: 0.7, mini: 0.6, regular: 1, medium: 1, large: 1.4, big: 1.4, huge: 1.8, giant: 1.8 };
const UNIT_WORDS = new Set(["slice", "piece", "cup", "serving", "glass", "can", "bottle", "order", "portion", "handful", "scoop", "tbsp", "tsp", "spoonful", "side", "bite", "pump"]);
const OZ_WORDS = new Set(["oz", "ounce"]);
const GRAM_WORDS = new Set(["g", "gram"]);
const STOP = new Set(["i", "id", "ive", "im", "had", "have", "having", "ate", "eat", "eaten", "eating", "got", "get", "grabbed", "grab", "made", "make", "cooked", "drank", "drink", "drinking", "just", "the", "my", "of", "for", "at", "from", "in", "today", "tonight", "this", "morning", "afternoon", "evening", "lunch", "breakfast", "dinner", "snack", "brunch", "dessert_", "later", "earlier", "then", "also", "like", "about", "around", "approx", "approximately", "roughly", "maybe", "kind", "sort", "some", "it", "was", "were", "that", "which", "there", "home", "homemade", "usual", "typical", "normal", "again", "after", "before", "to", "go", "very", "really", "pretty", "so", "up", "out", "and", "or", "&", "is", "are", "be", "on", "its", "too", "as", "well", "plus_"]);
// Words that start a change to the item they follow.
const MOD = {
  remove: ["no", "without", "hold", "minus", "skip", "remove", "removed", "nix", "zero", "w/o"],
  double: ["double", "doubled", "two", "2x"],
  extra: ["extra", "more", "additional", "lots", "heavy", "loaded"],
  add: ["add", "added", "adding", "with", "w", "plus", "topped", "+"],
  light: ["light", "lite", "half", "little", "less", "easy", "bit", "splash", "dash"],
};
const MOD_OF = Object.fromEntries(Object.entries(MOD).flatMap(([k, ws]) => ws.map((w) => [w, k])));

export function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("oes")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

/** Lowercase, expand shorthands, split numbers from units ("6oz" → "6 oz"). */
export function normalize(text) {
  return String(text || "").toLowerCase()
    .replace(/[’']/g, "")
    .replace(/w\/o\b/g, " without ").replace(/\bw\//g, " with ")
    .replace(/&/g, " and ").replace(/\+/g, " plus ")
    .replace(/(\d)\s*x\b/g, "$1 ").replace(/\bx\s*(\d)/g, "$1 ")
    .replace(/(\d)(oz|g|grams?|ounces?)\b/g, "$1 $2")
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (_, a, b) => String(Math.round((+a / +b) * 100) / 100))
    .replace(/[^a-z0-9.\s,;\n-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ").trim();
}

const words = (s) => normalize(s).replace(/[,;\n]/g, " ").split(" ").filter(Boolean);
export const keyTokens = (s) => words(s).map(stem).filter((t) => !STOP.has(t) && !UNIT_WORDS.has(t) && !/^\d/.test(t) && !(t in NUM_WORDS) && !(t in SIZE_WORDS));

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
  if (n < 5) return false;
  return osa(a, b) <= (n >= 8 ? 2 : 1);
}

// ---------- lexicon ----------

const METHOD = new Set(["air", "fryer", "weekend", "batch", "freezer", "meal", "prep", "sheet", "pan", "quick", "easy", "classic", "homemade", "style"]);

function aliasList(name, extra = [], placeWords = []) {
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

/**
 * Everything the parser can recognize, with its numbers. Personal things (usuals,
 * learned phrases, recents) carry a bonus so "my wrap" beats a generic wrap.
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
    items.push({ ...c, kind: c.id.startsWith("meal:") ? "meal" : c.place ? "place" : "home", aliases, placeAliases: pl ? placeOnlyAliases(aliases, [pl.name, ...(pl.aliases || [])]) : [], bonus: 0 });
  }
  for (const f of foods || []) {
    items.push({ id: `f:${f.id}`, name: f.name, emoji: f.emoji, group: "Common foods", kind: f.addon ? "addon" : "food", calories: f.calories, protein: f.protein, unit: f.unit, oz: f.oz || null, aliases: aliasList(f.name, f.aliases), bonus: f.addon ? -0.15 : 0 });
  }
  for (const p of data.products || []) {
    const eff = E.productById(data, state, p.id);
    items.push({ id: `p:${p.id}`, name: eff.name, emoji: "🛒", group: "Trader Joe's", kind: "product", calories: eff.calories, protein: eff.protein, unit: eff.unit, aliases: aliasList(eff.name.replace(/^(tj'?s|trader joe'?s)\s+/i, "")), bonus: -0.1 });
  }
  for (const [code, b] of Object.entries(state.barcodes || {})) {
    items.push({ id: `bc:${code}`, name: b.name, emoji: "▦", group: "Scanned", kind: "barcode", calories: b.calories, protein: b.protein, aliases: aliasList(b.name), bonus: 0.04 });
  }
  const seen = new Set(items.map((i) => i.name.toLowerCase()));
  for (const u of state.usuals || []) {
    if (u.ref) { const hit = items.find((i) => i.id === u.ref); if (hit) hit.bonus += 0.12; continue; }
    items.push({ id: `u:${u.id}`, name: u.name, emoji: u.emoji || "⭐", group: "Your usuals", kind: "usual", calories: u.calories, protein: u.protein, aliases: aliasList(u.name, u.aliases || []), bonus: 0.15 });
    seen.add(u.name.toLowerCase());
  }
  for (const d of Object.values(state.foodLog || {})) {
    for (const e of d.entries || []) {
      if (seen.has(e.name.toLowerCase())) continue;
      seen.add(e.name.toLowerCase());
      items.push({ id: `r:${e.name}`, name: e.name, emoji: e.emoji || "🍽", group: "Recent", kind: "recent", calories: e.calories, protein: e.protein, aliases: aliasList(e.name), bonus: 0.05 });
    }
  }
  const rawWords = (s) => words(s).map(stem);
  const places = (eats?.places || []).map((pl) => ({ id: pl.id, name: pl.name, aliases: [pl.name, ...(pl.aliases || [])].map(rawWords), components: (pl.components || []).map((c) => ({ ...c, tokens: aliasList(c.name, c.aliases || []) })) }));
  const addons = items.filter((i) => i.kind === "addon");
  // Every phrase a change can point at, for working out where "double chicken" ends.
  const modVocab = [...places.flatMap((p) => p.components.flatMap((c) => c.tokens)), ...addons.flatMap((a) => a.aliases), ...items.filter((i) => i.kind === "food").flatMap((i) => i.aliases)];
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

function scoreItem(item, toks, ctxPlace) {
  let best = null;
  const all = ctxPlace && item.place === ctxPlace && item.placeAliases?.length ? [...item.aliases, ...item.placeAliases] : item.aliases;
  for (const alias of all) {
    const { m, used } = matchAlias(alias, toks);
    if (!m) continue;
    const precision = m / alias.length, recall = m / toks.length;
    if (precision < 0.5) continue;
    const kindRank = { usual: 0.006, recent: 0.005, home: 0.004, place: 0.004, meal: 0.003, barcode: 0.003, food: 0.002, addon: 0, product: 0 }[item.kind] || 0;
    let s = 0.62 * precision + 0.38 * recall + item.bonus + m * 0.01 + kindRank;
    if (precision === 1 && recall === 1) s += 0.08;
    if (!best || s > best.score) best = { score: s, used, precision, recall };
  }
  if (!best) return null;
  if (ctxPlace) {
    if (item.place === ctxPlace) best.score += 0.35;
    else if (item.place) best.score -= 0.5;
    else if (item.kind === "food" || item.kind === "product") best.score -= 0.12;
  }
  return best;
}

function bestMatch(lex, toks, ctxPlace) {
  let best = null;
  for (const item of lex.items) {
    const s = scoreItem(item, toks, ctxPlace);
    if (s && (!best || s.score > best.score)) best = { item, ...s };
  }
  return best && best.score >= 0.5 ? best : null;
}

function alternatives(lex, toks, ctxPlace, chosenId, n = 3) {
  const seen = new Set([chosenId]);
  const out = [];
  for (const x of _rank(lex, toks, ctxPlace)) {
    if (out.length >= n || x.score < 0.55) break;
    if (seen.has(x.item.id) || x.item.kind === "addon" || x.precision < 1) continue;
    if (out.some((o) => o.name === x.item.name)) continue;
    seen.add(x.item.id);
    out.push({ id: x.item.id, name: x.item.name, emoji: x.item.emoji || "🍽", calories: x.item.calories, protein: x.item.protein, build: x.item.build || null, kind: x.item.kind });
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

function readQuantity(ws) {
  // "2 eggs", "two eggs", "half a quesadilla", "6 oz chicken", "200 g rice", "large latte"
  let qty = 1, size = 1, oz = null;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const next = ws[i + 1] ? stem(ws[i + 1]) : "";
    if (/^\d+(\.\d+)?$/.test(w)) {
      const n = parseFloat(w);
      if (OZ_WORDS.has(next)) { oz = n; continue; }
      if (GRAM_WORDS.has(next)) { oz = n / 28.35; continue; }
      if (i === 0 || qty === 1) qty = n;
    } else if (w in NUM_WORDS && !(w === "two" && MOD_OF[ws[i + 1]])) {
      if (w === "half" && ws[i + 1] && !["a", "an", "of"].includes(ws[i + 1]) && i > 0) continue; // "half rice" is a change, not a quantity
      if ((w === "a" || w === "an") && qty !== 1) continue;
      qty = w === "half" ? qty * 0.5 : NUM_WORDS[w] === 1 ? qty : NUM_WORDS[w];
    } else if (w in SIZE_WORDS) size = SIZE_WORDS[w];
  }
  return { qty, size, oz };
}

// ---------- modifiers ----------

/** Split "bowl double chicken no rice extra guac" into base words + changes. */
function splitMods(ws, lex) {
  const base = [];
  const mods = [];
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    let op = MOD_OF[w];
    if (w === "hold" && ws[i + 1] === "the") i++;
    if (op === "light" && w === "half" && (ws[i + 1] === "a" || ws[i + 1] === "an" || ws[i + 1] === "of" || i === 0)) op = null; // "half a sandwich" = quantity
    if (op === "double" && w === "two") op = null;
    if (!op) { base.push(w); i++; continue; }
    // take the longest run of following words that names something changeable
    let j = i + 1;
    while (MOD_OF[ws[j]] && ws[j] !== "two") { if (MOD_OF[ws[j]] !== "add") op = MOD_OF[ws[j]]; j++; }
    while (ws[j] === "the" || ws[j] === "on" || ws[j] === "of" || ws[j] === "a" || ws[j] === "some") j++;
    let take = 0;
    for (let len = Math.min(3, ws.length - j); len >= 1; len--) {
      const t = ws.slice(j, j + len).map(stem).filter((x) => !STOP.has(x));
      if (!t.length) continue;
      if (lex.modVocab.some((a) => a.length === t.length && a.every((x, k) => same(x, t[k])))) { take = len; break; }
    }
    if (!take) {
      // "with a coke" style: not a change, keep words for a possible second item
      if (op === "add") { base.push(...ws.slice(i, j + 1)); i = j + 1; continue; }
      take = ws[j] ? 1 : 0;
    }
    if (take) mods.push({ op, target: ws.slice(j, j + take).join(" "), tokens: ws.slice(j, j + take).map(stem).filter((x) => !STOP.has(x)) });
    // "dressing on the side" → light dressing
    i = j + take;
    // "no rice or beans" / "extra guac and cheese": the change carries over a conjunction
    while ((ws[i] === "or" || ws[i] === "and") && ws[i + 1] && !MOD_OF[ws[i + 1]]) {
      const t = [stem(ws[i + 1])];
      if (!lex.modVocab.some((a) => a.length === 1 && same(a[0], t[0]))) break;
      mods.push({ op, target: ws[i + 1], tokens: t });
      i += 2;
    }
  }
  const sideIdx = base.join(" ").indexOf("on the side");
  if (sideIdx >= 0) {
    const before = base.join(" ").slice(0, sideIdx).trim().split(" ");
    const target = before.pop();
    if (target) { mods.push({ op: "light", target, tokens: [stem(target)] }); base.length = 0; base.push(...before); }
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
  // An add-on portion if one fits the words exactly; otherwise a common food ("peanut butter",
  // not "butter"). Full coverage of the words beats a partial match.
  let best = null;
  for (const a of lex.items) {
    if (a.kind !== "addon" && a.kind !== "food") continue;
    const s = scoreItem(a, tokens, null);
    if (!s || s.precision < 1) continue;
    const rank = s.recall * 10 + (a.kind === "addon" ? 0.5 : 0) + s.score;
    if (!best || rank > best.rank) best = { item: a, rank };
  }
  return best ? best.item : null;
}

const fmtQ = (q) => (q === 0.5 ? "½" : q === 1.5 ? "1½" : String(q));

function applyMods(lex, match, mods, ctxPlace) {
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
          if (md.op === "add") now = portions;
        }
      }
      if (now === had) continue;
      if (now) picks[c.id] = now; else delete picks[c.id];
      changes.push({ label: now === 0 ? `no ${md.target}` : had === 0 ? `+ ${md.target}${now !== 1 ? ` ×${fmtQ(now)}` : ""}` : `${md.op === "light" ? "light" : md.op} ${md.target}`, kcal: Math.round(c.calories * (now - had)) });
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
      const mult = md.op === "light" ? 0.5 : md.op === "double" ? 2 : 1;
      extraCal += add.calories * mult; extraPro += add.protein * mult;
      changes.push({ label: `+ ${md.target}`, kcal: Math.round(add.calories * mult) });
    }
    const t = E.productTotals(lex.data, lex.state, rows.filter((r) => r.qty > 0));
    return { calories: Math.round(t.calories + extraCal), protein: Math.round(t.protein + extraPro), changes, unplaced, build: { kind: "products", items: rows.filter((r) => r.qty > 0) } };
  }
  // Fixed-number items: add or subtract typical add-on portions
  let cal = item.calories, pro = item.protein;
  for (const md of mods) {
    const add = findAddon(lex, md.tokens);
    if (!add) { unplaced.push(md); continue; }
    const mult = md.op === "remove" ? -1 : md.op === "light" ? -0.5 : md.op === "double" ? 1 : 1;
    // "with chicken" on something that already says chicken changes nothing
    if (md.op === "add" && keyTokens(item.name).some((n) => md.tokens.some((t) => same(n, t)))) continue;
    cal += add.calories * mult; pro += add.protein * mult;
    changes.push({ label: `${mult < 0 ? (md.op === "light" ? "light" : "no") : md.op === "double" ? "double" : md.op === "extra" ? "extra" : "+"} ${md.target}`, kcal: Math.round(add.calories * mult) });
  }
  return { calories: Math.max(Math.round(item.calories * 0.35), Math.round(cal)), protein: Math.max(0, Math.round(pro)), changes, unplaced, build: item.build || null };
}

// ---------- segments ----------

const SPLIT_RE = /\s*(?:[,;\n]|\band then\b|\bthen\b|\balso\b|\bplus\b(?=\s+(?:a|an|one|two|\d|some|my)\b)|\balong with\b)\s*/;

function splitSegments(text, lex) {
  const parts = normalize(text).split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);
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

function unknownItem(text) {
  const name = text.replace(/^(a|an|some|my|the)\s+/i, "").trim();
  return { status: "unknown", text, name: name.charAt(0).toUpperCase() + name.slice(1), emoji: "❓", calories: null, protein: null, qty: 1, changes: [], notes: [] };
}

function parseSegment(seg, lex, ctxPlace) {
  const ws = seg.split(" ").filter(Boolean);
  const placeHit = detectPlace(lex, placeToks(seg));
  const place = placeHit.place || ctxPlace;
  // whole phrase as one thing first ("bagel with cream cheese", "double chicken bowl")
  const allToks = keyTokens(placeHit.rest.join(" "));
  if (!allToks.length) return place ? [] : [unknownItem(seg)];
  const whole = bestMatch(lex, allToks, place);
  const { base, mods } = splitMods(ws, lex);
  let baseToks = keyTokens(detectPlace(lex, placeToks(base.join(" "))).rest.join(" "));
  let match = baseToks.length ? bestMatch(lex, baseToks, place) : null;
  let useMods = mods;
  if (whole && whole.precision === 1 && whole.recall === 1 && (!match || whole.score >= match.score + 0.05)) { match = whole; useMods = []; baseToks = allToks; }
  if (!match && whole) { match = whole; useMods = []; baseToks = allToks; }
  if (!match && mods.length && place) {
    // "chipotle double chicken no rice" with nothing else: start from that place's first build
    const pl = lex.items.find((i) => i.place === place && i.build);
    if (pl) match = { item: pl, score: 0.5, used: new Set(), precision: 1, recall: 1 };
  }
  if (!match) return [unknownItem(seg)];

  const { qty, size, oz } = readQuantity(ws);
  const res = applyMods(lex, match, useMods, place);
  const item = match.item;
  let mult = qty;
  const notes = [];
  if (oz && item.oz) { mult = oz / item.oz; notes.push(`${Math.round(oz * 10) / 10} oz`); }
  if (size !== 1 && (item.kind === "food" || item.kind === "addon")) { mult *= size; notes.push(size > 1 ? "large" : "small"); }
  const alts = alternatives(lex, baseToks, place, item.id);
  const close = alts.length && _rank(lex, baseToks, place).find((x) => x.item.id === alts[0].id)?.score >= match.score - 0.03;
  const out = [{
    status: match.score >= 0.75 && !res.unplaced.length && !close ? "ok" : "check",
    text: seg, id: item.id, kind: item.kind, name: item.name, emoji: item.emoji || "🍽", group: item.group,
    qty: Math.round(mult * 100) / 100, calories: res.calories, protein: res.protein,
    changes: res.changes, notes, build: res.build, unit: item.unit || "", alts,
    ignored: res.unplaced.map((m) => `${m.op === "remove" ? "no" : m.op} ${m.target}`),
    order: Math.min(...[...match.used].concat([99])),
  }];
  // leftover words that weren't part of the match → more items ("eggs toast coffee")
  let left = baseToks.map((t, i) => ({ t, i })).filter(({ i }) => !match.used.has(i));
  for (let guard = 0; left.length && useMods === mods && guard < 6; guard++) {
    const lt = left.map((x) => x.t);
    const extra = bestMatch(lex, lt, place);
    if (!extra || extra.precision < 1 || extra.score < 0.6) break;
    const r2 = applyMods(lex, extra, [], place);
    out.push({ status: "check", text: [...extra.used].map((k) => lt[k]).join(" "), id: extra.item.id, kind: extra.item.kind, name: extra.item.name, emoji: extra.item.emoji || "🍽", group: extra.item.group, qty: 1, calories: r2.calories, protein: r2.protein, changes: [], notes: [], build: r2.build, unit: extra.item.unit || "", ignored: [], alts: alternatives(lex, [...extra.used].map((k) => lt[k]), place, extra.item.id), order: Math.min(...[...extra.used].map((k) => left[k].i)) });
    left = left.filter((_, k) => !extra.used.has(k));
  }
  if (left.some((x) => x.t.length > 2)) { out[0].ignored.push(...left.map((x) => x.t)); out[0].status = "check"; }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Parse free text into items. Returns { items }, each item:
 *   status "ok" | "check" | "unknown", name, emoji, qty, calories/protein (per 1×, null when unknown),
 *   changes [{label, kcal}], notes [], ignored [] (words it couldn't apply), text (the phrase it came from).
 */
export function parseMeal(text, lex) {
  const segs = splitSegments(text, lex);
  const items = [];
  let ctxPlace = null;
  for (const seg of segs) {
    const toks = keyTokens(seg);
    const pl = detectPlace(lex, placeToks(seg)).place;
    // a bare follow-up like "and extra guac" belongs to the previous item
    const first = seg.split(" ")[0];
    if (MOD_OF[first] && MOD_OF[first] !== "add" && items.length && items[items.length - 1].status !== "unknown") {
      const prev = items[items.length - 1];
      const prevItem = lex.items.find((i) => i.id === prev.id);
      if (prevItem) {
        const { mods } = splitMods(seg.split(" "), lex);
        const merged = applyMods(lex, { item: { ...prevItem, build: prev.build || prevItem.build, calories: prev.calories, protein: prev.protein } }, mods, ctxPlace);
        prev.calories = merged.calories; prev.protein = merged.protein; prev.build = merged.build;
        prev.changes = [...prev.changes, ...merged.changes];
        prev.ignored.push(...merged.unplaced.map((m) => `${m.op} ${m.target}`));
        continue;
      }
    }
    if (pl) ctxPlace = pl;
    const prev = items[items.length - 1];
    const prevItem = prev && prev.status !== "unknown" ? lex.items.find((i) => i.id === prev.id) : null;
    if (prevItem && !pl && !/^\d/.test(first) && !["a", "an", "one", "two", "three", "my"].includes(first)) {
      // "chipotle burrito with steak, no beans, sour cream" → sour cream goes in the burrito;
      // "greek yogurt with berries and honey" → honey goes on the yogurt
      const build = prev.build || prevItem.build;
      const placeObj = build?.kind === "components" ? lex.places.find((p) => p.id === build.place) : null;
      const asComponent = placeObj && toks.length && findComponent(placeObj.components, toks);
      const top = !asComponent && toks.length ? bestMatch(lex, toks, null) : null;
      const addonHit = top && lex.addons.some((a) => scoreItem(a, toks, null)?.precision === 1 && scoreItem(a, toks, null)?.recall === 1);
      if (asComponent || (addonHit && ["addon", "product"].includes(top.item.kind))) {
        const merged = applyMods(lex, { item: { ...prevItem, build, calories: prev.calories, protein: prev.protein } }, [{ op: "add", target: seg.replace(/^(and|some|a little|a bit of)\s+/, ""), tokens: toks }], ctxPlace);
        if (merged.changes.length) {
          prev.calories = merged.calories; prev.protein = merged.protein; prev.build = merged.build;
          prev.changes = [...prev.changes, ...merged.changes];
          continue;
        }
      }
    }
    items.push(...parseSegment(seg, lex, pl || null));
  }
  return { items };
}

/** One-line description of what was understood, for the entry's detail field. */
export function describe(item) {
  const bits = [];
  if (item.qty !== 1) bits.push(`×${fmtQ(item.qty)}`);
  bits.push(...item.notes, ...item.changes.map((c) => c.label));
  return bits.join(", ");
}

// test/debug helper: every candidate's score for a token list, best first
export function _rank(lex, toks, ctxPlace = null) {
  return lex.items.map((item) => ({ item, ...(scoreItem(item, toks, ctxPlace) || { score: -1 }) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}
