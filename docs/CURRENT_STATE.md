# Fuel current state

Updated: 2026-08-23

## Product status

Fuel is a personal meal-planning PWA used primarily from the owner's Samsung Galaxy. It is deliberately small, framework-free, and offline-capable.

Current visible version: `fuel-v14`.

## Core behavior

- Builds a seven-day meal plan around a calorie budget and protein target.
- Prioritizes variety, opened/perishable ingredients, favorites, freezer portions, and groceries carried over from skipped days.
- Supports automatic, prep-oriented, and easy planning modes.
- Prevents weekday work lunches from requiring raw-protein cooking.
- Tracks meals eaten, snacks, weight, overage recovery, freezer inventory, pantry state, favorites, and product-label overrides.
- Separates a heavy day from an off-plan episode. A heavy day is absorbed by a bounded overage bank; an episode is
  recorded with its context and never trims a future day.
- Generates a shopping list from the remaining planned week.

## Data and persistence

- Shared product and recipe data live in `data/products.json` and `data/templates.json`.
- Personal state lives only in browser localStorage under `fuel.state.v1`.
- The repository does not contain the owner's personal logs.
- The record carries an explicit `schemaVersion` (currently 3) and migrates forward on load. Records written before versioning existed are treated as v1 and upgraded, not discarded.
- A migration that fails leaves the stored record untouched, keeps a recovery copy, and lets the app run on the last good state.
- Fuel keeps a rolling ring of up to five recovery copies, taken before any write that replaces or deletes the record: upgrades, restores, imports, and resets. The ring shrinks rather than failing when phone storage is full.
- An unreadable record no longer falls back to blank state. It is quarantined intact and a full-screen recovery path offers the copies, a pasted backup, or an explicit start-fresh.
- Export produces a versioned `fuel-backup.v1` archive; import still accepts the older bare-state exports. Round trips are covered by tests.
- `js/persistence.js` holds all of this and has no DOM access, so it is testable under `node --test`.

## Deployment and quality

- Hosted on Vercel, deployed from `main`, with a preview deployment per pull request.
- The Vercel build command is `npm test`, so a failing suite blocks the deployment.
- GitHub Actions also runs `node --test` on pushes and pull requests.
- The latest release has 75 automated tests.
- UI changes require phone-sized testing of the real application.
- PWA shell caching currently depends on manually keeping the application and service-worker versions aligned.

Fuel is a static site with no build step. `vercel.json` serves the repository root,
sets security headers and a strict Content-Security-Policy, and marks `sw.js`,
`index.html`, and the `js/`, `css/`, and `data/` directories no-cache so an update
actually reaches an installed phone app. `style-src` still allows `'unsafe-inline'`
for six static inline `style` attributes in `index.html`; removing those is the
prerequisite for tightening it.

## Identity

Fuel has no accounts and no sign-in, deliberately. It is used in the kitchen and in
the store, so opening instantly and working offline outranks cross-device sync.
Personal state stays in browser localStorage on the owner's device.

Adding the shared Supabase/Google sign-in used by Sentinel was considered and
declined in Phase 6: the data-loss risk that would justify a server was addressed by
versioned state, recovery copies, and export/import instead, and meal logs do not
carry the sensitivity that makes authentication worthwhile for financial records. It
remains available later, additively, if cross-device meal sync is ever actually
wanted.

## Overage bank and episodes

The overage bank absorbs a heavy day by trimming the daily budget, capped at
`MAX_DAILY_TRIM` (150 kcal) per day and `MAX_OVERAGE_BANK` (900 kcal) in total, so a trim
can never run longer than six days.

A log at or above `EPISODE_KCAL` (1200 kcal) is not treated as a heavy day. It is recorded
as an episode: a dated event carrying the time of day, whether the owner had smoked, hours
since the last real meal, and how the day had been going. Episodes never enter the bank,
never trim a budget, and never move the goal date, because eating below budget to compensate
for a binge is the most reliable trigger for the next one. The calorie cost is real and shows
up honestly in the weight trend rather than being repaid through deliberate hunger.

The v3 migration clamps a bank built under the old unbounded rule, so a phone upgrading from
v2 stops trimming as soon as the upgrade lands.

`episodeStats()` reports each rate against the number of episodes that actually answered that
question, so a small sample reads as a small sample rather than as a pattern.

## Product constraints

- No microwave.
- High-protein, calorie-conscious meals.
- Short, realistic steps.
- Workday lunches must be assembly/reheat friendly.
- Trader Joe's products and freezer workflows are first-class.
- Nutrition facts must distinguish verified from estimated data.

## Near-term priorities

1. Single-source application and service-worker versioning.
2. Remove model-specific operating text and user-facing copy.
3. Preserve the framework-free architecture while reducing risk in `app.js` as it grows.
4. Surface the recovery copies in a periodic backup nudge, so the owner notices drift before a failure does.
5. Revisit the episode thresholds once there is enough logged history to say whether 1200 kcal
   and a six-day trim ceiling are the right numbers for this owner.

## Deliberate non-priorities

- Multi-user accounts.
- A server backend before a concrete need exists.
- React/Next.js or native rewrites.
- Replacing deterministic planning with generative meal plans.
- Expanding beyond the owner's real shopping and cooking workflow.