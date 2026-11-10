# Fuel current state

Updated: 2026-11-10

## Product status

Fuel is a responsive meal-planning website and installable PWA used primarily from the owner's
Samsung Galaxy. Desktop and laptop browsers remain supported. It is deliberately small,
framework-free, and offline-capable.

Current visible version: `fuel-v20`.

## Core behavior

- Builds a seven-day meal plan around a calorie budget and protein target.
- Prioritizes variety, opened/perishable ingredients, favorites, freezer portions, and groceries carried over from skipped days.
- Supports automatic, prep-oriented, and easy planning modes.
- Prevents weekday work lunches from requiring raw-protein cooking.
- Tracks meals eaten, snacks, weight, overage recovery, freezer inventory, pantry state, favorites, and product-label overrides.
- Generates a shopping list from the remaining planned week.

## Count mode ("Just count")

A second way to use Fuel for weeks without planning. Toggle on Today or in Settings; Plan and
Shop tabs hide while it's on, and nothing in the planner is lost.

- One-tap usuals (seeded from `data/eats.json` → `starterUsuals`, editable), recents, and a
  searchable catalog: restaurant orders (Pret, Just Salad, Chipotle with a per-ingredient
  builder), home combos built from `products.json`, every Fuel meal, and single ingredients.
- Quick add with "save as usual"; any entry can be re-sized (½–2×), corrected, or re-logged.
- Barcode scan (Chrome `BarcodeDetector` + Open Food Facts, manual number fallback); results are
  cached on the phone so repeat scans work offline.
- "Describe / photo" AI estimates via the Claude API using the owner's own key, stored in its own
  localStorage slot (`fuel.aikey.v1`) and never in state, backups, or recovery copies.
- "What still fits": ranks known foods by protein density within the calories left.
- Goal pacing: goal weight + date → deficit, capped at 1% bodyweight/week and the budget floor,
  with a realistic date when the requested one is too aggressive.
- Binge recovery: a finished day over budget moves its excess into the payback plan (the same
  overage bank as planning mode). Payback speed 150/250/350 kcal/day, never below the floor.
  Extra walks (conservative net estimate, capped at 300/day) cancel today's overage or pay down
  the plan. Under-eating never earns credit. Unlogged days are not settled. Editing a settled day
  moves the bank by exactly the change.
- Week balance: Mon–Sun deficit vs maintenance, counting today as eaten-to-budget.

## ✍️ Type it (count mode, no AI)

`js/parse.js` turns typed or dictated text into items entirely on the phone: splits on commas, "and"
(unless the joined phrase is one dish), "then", "plus a…"; reads quantities (2, two, half, 6 oz, 200 g,
large); applies no / without / extra / double / light / add / with / on the side to Chipotle-style
ingredient builds, home-combo products, or add-on portions for fixed items; attaches trailing add-ons
("…and honey") to the previous item; tolerates small typos; and ranks personal usuals and recents above
generic foods. Matches come from the catalog, Fuel meals, Trader Joe's products, scanned barcodes, and
`data/foods.json` (~120 common foods + add-ons). Ambiguous words offer one-tap alternatives; unknown
phrases ask for numbers once and are remembered as usuals with that phrase as an alias. Misses, swaps
and corrections are noted in `fuel.typemisses.v1` (outside state) for Settings → "Copy for tuning".
AI estimates remain available from the same sheet for photos and anything the parser can't place.

Measurements (`js/units.js`): every food carries a serving parsed from its label text plus known
grams/ml, so amounts convert — g/kg/oz/lb, ml/l/tsp/tbsp/cups/fl oz/pints, counts (slices, scoops,
pumps, shots, links…), whole things (a can, a jar, "half the bag" via pack servings, an onion, a
chicken breast). Spoken numbers ("one and a half cups", "twenty five grams", "a quarter cup") become
digits. Drinks: tall/grande/venti sizes, milk swaps ("latte with oat milk"), pumps, shots, sugar,
cream — add-ons count once per drink. Numbers said outright win ("a 250 calorie bar", "30g protein",
"each"). Portions: shared/split, bites, most of, seconds. "Fried" adds oil; "air fried" doesn't.
"Yesterday"/"last night" logs to that day (one tap to undo). An amount never multiplies something
without a known size. Recipes ("…makes 4, I had 1", or "name: ingredients…") combine into one entry
per serving with an editable ingredient breakdown, use raw/dry weights, and are saved by name.
Trader Joe's: ~130 products with short spoken names (a product wins on its own name, e.g. "orange
chicken"; generic words need "TJ's"); tapping any product, common food, My food or scanned item asks
how much (servings, grams/oz, cups/tbsp). "My foods" (v4) are added from a label, optionally with a
barcode; a scan checks My foods first and an unknown barcode goes straight to the label form. A 🎤
button uses the browser's speech recognition (Chrome sends audio to Google to transcribe) alongside
the keyboard's own dictation.

## Daily budget calibration

Budget = maintenance − deficit (capped at 1%/week, floored at 1,500 for men). Maintenance comes from, in
order: a budget the owner sets directly; his own results ("I ate ~1,800 and lost ~1 lb/week" → 2,300);
measured maintenance from ≥10 logged days and ≥2 weigh-ins ≥10 days apart (least-squares trend,
offered as a one-tap card on Today/Progress when it differs by ≥150 kcal); and only then the
Mifflin-St Jeor formula. The goal card shows the breakdown and flags formula estimates. A new
`walker` activity level (×1.45) covers desk job + ~10k steps + lifting and is the onboarding default.

## History & stats (Progress tab, both modes)

`js/history.js` renders every logged day from both modes (count logs win; logged plan days are
converted to calories, "ate out" days marked estimated) over 7/30/90/365 days: average calories and
protein, on-budget rate and streaks, estimated fat lost vs maintenance, calories chart (weekly bars
past 60 days), protein line, week-by-week table next to actual scale change, most-eaten foods, a
tappable list of every day (edit opens it in Today), and CSV export (share sheet or download).
Switching modes never removes data. Settings shows browser storage used (localStorage is ~5 MB).

## Data and persistence

- Shared product and recipe data live in `data/products.json` and `data/templates.json`.
- Personal state lives only in browser localStorage under `fuel.state.v1`.
- The repository does not contain the owner's personal logs.
- The record carries an explicit `schemaVersion` (currently 4; v3 added `trackMode`, `foodLog`, `usuals`, `paybackPerDay`, `barcodes`; v4 added `myFoods`) and migrates forward on load. Records written before versioning existed are treated as v1 and upgraded, not discarded.
- A migration that fails leaves the stored record untouched, keeps a recovery copy, and lets the app run on the last good state.
- Fuel keeps a rolling ring of up to five recovery copies, taken before any write that replaces or deletes the record: upgrades, restores, imports, and resets. The ring shrinks rather than failing when phone storage is full.
- An unreadable record no longer falls back to blank state. It is quarantined intact and a full-screen recovery path offers the copies, a pasted backup, or an explicit start-fresh.
- Export produces a versioned `fuel-backup.v1` archive; import still accepts the older bare-state exports. Round trips are covered by tests.
- A failed localStorage write stays in memory and raises a persistent retry warning; Fuel never reports the change as saved.
- Current-schema records with damaged container fields are copied before automatic shape repair.
- `js/persistence.js` holds all of this and has no DOM access, so it is testable under `node --test`.

## Deployment and quality

- Vercel production is `https://fuel-rosy-one.vercel.app/`. GitHub Pages has also been used at
  `https://ryanrizk4.github.io/fuel/`. Earlier documentation incorrectly treated Pages as the only
  supported installed origin. Preserve the owner's existing origin; never ask them to switch
  without an explicit export/import migration because browser storage is isolated by origin.
- GitHub Actions also runs `node --test` on pushes and pull requests.
- The release includes engine, persistence, reload-safety, and service-worker regression tests.
- UI changes require phone-sized and desktop-width testing of the real application.
- `js/release.js` single-sources the visible application and service-worker cache version.

Fuel is a static site with no build step. The service worker precaches every required module
and both data files. The shell remains coherent for each release; failed network responses cannot
replace working cached data. Only old Fuel-owned caches are removed. Automatic reloads retry failed
storage writes first and leave the app open if saving still fails; browser navigation gets an
unsaved-data warning. These protections cover unsaved application state, not every unfinished form.
Meal toggles expose their selected state to assistive technology. `scripts/ui-smoke.mjs` exercises
all tabs plus settings, saved-meal reopening, and offline reopening at 390 and 1280 pixels using
isolated synthetic profiles. It needs Playwright in PW_DIR and a local HTTP server via QA_URL.

## Identity

Fuel has no accounts and no sign-in, deliberately. It is used in the kitchen and in
the store, so opening instantly and working offline outranks cross-device sync.
Personal state stays in browser localStorage on the owner's device.

Adding the shared Supabase/Google sign-in used by Sentinel was considered and
declined in Phase 6. Versioning and on-device recovery reduce write/corruption risk, but do not
protect against a lost phone, erased browser storage, or origin changes. A copied backup is not
durable until saved elsewhere. Meal and weight logs are private health-related information. Sync
remains available later, additively, if cross-device meal sync is ever actually
wanted.

## Product constraints

- No microwave.
- High-protein, calorie-conscious meals.
- Short, realistic steps.
- Workday lunches must be assembly/reheat friendly.
- Trader Joe's products and freezer workflows are first-class.
- Nutrition facts must distinguish verified from estimated data.

## Near-term priorities

1. Preserve the framework-free architecture while reducing risk in `app.js` as it grows.
2. Keep phone-sized regression testing part of every UI release.
3. Consider optional cross-device sync only if the owner explicitly needs it.

## Deliberate non-priorities

- Multi-user accounts.
- A server backend before a concrete need exists.
- React/Next.js or native rewrites.
- Replacing deterministic planning with generative meal plans.
- Expanding beyond the owner's real shopping and cooking workflow.
