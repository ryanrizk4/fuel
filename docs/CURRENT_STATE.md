# Fuel current state

Updated: 2026-07-25

## Product status

Fuel is a personal meal-planning PWA used primarily from the owner's Samsung Galaxy. It is deliberately small, framework-free, and offline-capable.

Current visible version: `fuel-v12`.

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
- localStorage is currently a single JSON record. A malformed record can fall back to a blank state, so versioned migrations and recoverable snapshots are the highest-priority durability work.
- Export/restore must remain available as the safety floor.

## Deployment and quality

- Hosted through GitHub Pages.
- GitHub Actions runs `node --test` on pushes and pull requests.
- The latest release has 43 automated tests.
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

1. Add versioned persisted-state migrations.
2. Add rolling recovery snapshots and a visible corruption-recovery path.
3. Prove export/import round trips with tests.
4. Single-source application and service-worker versioning.
5. Remove model-specific operating text and user-facing copy.
6. Preserve the framework-free architecture while reducing risk in `app.js` as it grows.

## Deliberate non-priorities

- Multi-user accounts.
- A server backend before a concrete need exists.
- React/Next.js or native rewrites.
- Replacing deterministic planning with generative meal plans.
- Expanding beyond the owner's real shopping and cooking workflow.