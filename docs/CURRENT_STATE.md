# Fuel current state

Updated: 2026-07-27

## Product status

Fuel is a personal meal-planning PWA used primarily from the owner's Samsung Galaxy. It is deliberately small, framework-free, and offline-capable.

Current visible version: `fuel-v13`.

## Core behavior

- Builds a seven-day meal plan around a calorie budget and protein target.
- Prioritizes variety, opened/perishable ingredients, favorites, freezer portions, and groceries carried over from skipped days.
- Supports automatic, prep-oriented, and easy planning modes.
- Prevents weekday work lunches from requiring raw-protein cooking.
- Tracks meals eaten, snacks, weight, overage recovery, freezer inventory, pantry state, favorites, and product-label overrides.
- Generates a shopping list from the remaining planned week.

## Data and persistence

- Shared product and recipe data live in `data/products.json` and `data/templates.json`.
- Personal state lives only in browser localStorage under `fuel.state.v1`.
- The repository does not contain the owner's personal logs.
- The record carries an explicit `schemaVersion` (currently 2) and migrates forward on load. Records written before versioning existed are treated as v1 and upgraded, not discarded.
- A migration that fails leaves the stored record untouched, keeps a recovery copy, and lets the app run on the last good state.
- Fuel keeps a rolling ring of up to five recovery copies, taken before any write that replaces or deletes the record: upgrades, restores, imports, and resets. The ring shrinks rather than failing when phone storage is full.
- An unreadable record no longer falls back to blank state. It is quarantined intact and a full-screen recovery path offers the copies, a pasted backup, or an explicit start-fresh.
- Export produces a versioned `fuel-backup.v1` archive; import still accepts the older bare-state exports. Round trips are covered by tests.
- `js/persistence.js` holds all of this and has no DOM access, so it is testable under `node --test`.

## Deployment and quality

- Hosted through GitHub Pages.
- GitHub Actions runs `node --test` on pushes and pull requests.
- The latest release has 59 automated tests.
- UI changes require phone-sized testing of the real application.
- PWA shell caching currently depends on manually keeping the application and service-worker versions aligned.

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

## Deliberate non-priorities

- Multi-user accounts.
- A server backend before a concrete need exists.
- React/Next.js or native rewrites.
- Replacing deterministic planning with generative meal plans.
- Expanding beyond the owner's real shopping and cooking workflow.