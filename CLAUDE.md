# Fuel — personal meal-planning PWA

Static PWA (no build step, no framework) that plans high-protein, calorie-budgeted weeks
around Trader Joe's shopping. Deployed via GitHub Pages; used entirely from the owner's phone.

## Architecture

- `index.html` + `css/styles.css` + `js/app.js` (UI) + `js/engine.js` (pure logic, no DOM)
- `data/products.json` — TJ's product database (calories/protein per serving, `confidence: verified|estimated`, pack sizes)
- `data/templates.json` — meal templates: base ingredients + variants that keep the same cooking motions
- `sw.js` — cache-first shell, network-first for `data/*.json` (content updates land on next visit)
- User's personal logs (plan, weigh-ins, overage bank, freezer, product verifications) live in
  **localStorage on the phone** (`fuel.state.v1`), NOT in the repo. Never commit personal data.
- `VividScribe.html` is an unrelated older page — leave it alone.

Everything is plain ES modules; open `index.html` over HTTP (not file://) to test:
`python3 -m http.server 8000` then hit `http://localhost:8000`.

## The recipe-ingestion ritual (most common request)

The owner will paste a TikTok/Instagram link or describe a meal and say "add this to my rotation."
Do this:

1. Research the recipe (WebSearch/WebFetch if a link or a trend name is given).
2. Map every ingredient to a Trader Joe's product. Reuse existing entries in `data/products.json`;
   add new ones with honest `confidence` ("estimated" unless verified against a label/official source —
   the app then asks the owner to confirm from the package at the store, so estimated is fine).
3. Add a template to `data/templates.json`:
   - `base` = ingredients for ONE serving (qty in the product's unit); batch recipes use `servings > 1`
     and per-batch quantities.
   - 2–4 `variants` that keep the same cooking motions (swap a sauce, a protein, a carb). This is the
     core design principle: variety without relearning anything.
   - `mealType`, `prepMinutes`, `freezerFriendly`, `repeatOk` (true only for meals he'd happily eat 3–4×/week),
     `source: "trending"`, `origin` (one line on where it's from).
   - Steps: max 5, terse.
4. Sanity-check per-serving macros (aim: ≥30g protein, ≤650 kcal for mains) and JSON validity
   (`node -e "JSON.parse(require('fs').readFileSync('data/templates.json'))"`).
5. Commit + push to the designated branch. The app picks it up on the next visit (network-first data fetch).

Owner preferences: high protein (gym), calorie deficit, quick weeknight cooking (≤25 min), air fryer,
weekend batch-cook + freezer (he owns an extra freezer — TJ's frozen products are first-class citizens),
Middle Eastern flavors welcome (za'atar, shawarma, zhoug, labneh/yogurt), Mission Carb Balance tortillas
are a staple.

**NO MICROWAVE** (enforced by tests/data.test.js): never write a step that needs one. Alternatives that
keep it quick: frozen rice pouch → covered pan + splash of water ~4 min; frozen veg → air fryer 400°F
~8 min or pan-steam; reheat frozen portions → air fryer 350°F ~5 min or covered pan.

## Product verification loop

Products with `confidence: "estimated"` show a "Check label" chip in the shopping list. When the owner
confirms real numbers in-app they're stored as localStorage overrides. If he shares a backup JSON with
`productOverrides`, fold those numbers into `data/products.json` (set `confidence: "verified"`) so the
data survives phone resets.

## Design system

Tokens in `css/styles.css` follow a validated light/dark palette (accent blue #2a78d6/#3987e5,
protein green #1baf7a). Mobile-first, bottom nav, bottom sheets for all pickers. Keep charts single-axis,
2px lines, direct labels, tabular numerals. Don't add frameworks or a build step.

## The quality gate (non-negotiable, Sentinel-style)

Before ANY commit/push:

1. `node --test` must pass (engine math + data integrity — `tests/`). New engine logic or data
   rules get a test in the same commit. GitHub Actions runs the same suite on every push.
2. For UI changes: drive the real app in headless Chromium at phone size (390×844), click through
   the affected flow, screenshot, and check for console errors before pushing. A drive script
   pattern lives in the session scratchpad approach — recreate as needed with Playwright
   (`executablePath: '/opt/pw-browsers/chromium'` in this environment).
3. Data edits (products/templates) are covered by `tests/data.test.js` house rules:
   mains ≤700 kcal & ≥25g protein per serving (every variant), breakfasts ≤400 kcal,
   1–5 terse steps, first variant id must be `classic`, all product refs must resolve.

## Exercise calories (research-backed policy — don't "improve" it casually)

The owner walks ~10k steps/day and lifts; his TDEE multiplier (moderate, 1.55) already includes that.
Trackers overestimate burn 27–93% (Stanford 2017; 2025 Apple Watch meta-analysis ~28% MAPE), and a
lifting session really costs ~150–300 kcal. So the app NEVER treats tracker "calories burned" as
edible budget. Only user-flagged unusual days (long hike, ~2× normal steps) earn a credit:
50% of the estimate, capped at 300 kcal/day (`ACTIVITY_DISCOUNT` / `ACTIVITY_CAP` in engine.js).
Weekly weigh-in trend is the real calibrator. There is no Samsung Health/Health Connect web API for
PWAs — the 2-tap manual log is intentional, not a gap.

## Owner's device

Samsung Galaxy (Android) — test decisions against Chrome/Samsung Internet PWA behavior, not iOS.
Maskable icon is `icons/icon-maskable.png` (full-bleed). Install path: Chrome → ⋮ → Add to Home screen.

## Bump the service worker

Any change to shell files (`index.html`, `css/`, `js/`) should bump `VERSION` in `sw.js`
(e.g. `fuel-v1` → `fuel-v2`) or phones will keep the stale cached shell.
