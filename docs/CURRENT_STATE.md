# Fuel current state

Updated: 2026-09-05

## Product status

Fuel is a responsive meal-planning website and installable PWA used primarily from the owner's
Samsung Galaxy. Desktop and laptop browsers remain supported. It is deliberately small,
framework-free, and offline-capable.

Current visible version: `fuel-v14`.

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
- A failed localStorage write stays in memory and raises a persistent retry warning; Fuel never reports the change as saved.
- Current-schema records with damaged container fields are copied before automatic shape repair.
- `js/persistence.js` holds all of this and has no DOM access, so it is testable under `node --test`.

## Deployment and quality

- Canonically hosted on GitHub Pages at `https://ryanrizk4.github.io/fuel/`.
- Install and use only that canonical origin; browser storage is isolated by origin.
- GitHub Actions also runs `node --test` on pushes and pull requests.
- The latest release has 61 automated tests.
- UI changes require phone-sized and desktop-width testing of the real application.
- `js/release.js` single-sources the visible application and service-worker cache version.

Fuel is a static GitHub Pages site with no build step. The service worker keeps the app
shell available offline and uses network-first requests for recipe/product data.

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
