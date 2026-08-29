# Fuel current state

Updated: 2026-08-29

## Product status

Fuel is a personal meal-planning PWA used primarily from the owner's Samsung Galaxy. It is deliberately small, framework-free, and offline-capable.

Current visible version: `fuel-v14`.

## Core behavior

- Builds a seven-day meal plan around a calorie budget and protein target.
- Prioritizes variety, opened/perishable ingredients, favorites, freezer portions, and groceries carried over from skipped days.
- Supports automatic, prep-oriented, and easy planning modes.
- Prevents weekday work lunches from requiring raw-protein cooking.
- Tracks meals eaten, snacks, weight, overage recovery, freezer inventory, pantry state, favorites, and product-label overrides.
- Generates a shopping list from the remaining planned week.

## Stabilization mode (CBT-E)

Fuel now carries a second, deliberately separate programme for the owner's binge pattern,
built on CBT-E. It is off until he turns it on in Settings, and it changes what the rest
of the app is allowed to do.

- **Stabilization mode** freezes the overage bank: a heavy night is no longer banked and
  no longer trimmed out of later daily budgets. That repayment is post-binge undereating
  implemented in software, and it is the restriction with the clearest link to loading the
  next episode. The owner's chosen deficit is left exactly where it is, so that if episodes
  drop it is clear which change did it.
- **Planned eating occasions** carry times, warn on any gap over four hours, and are the
  intervention rather than a metric. The next occasion is shown on Today.
- **The risk window** is self-reported (nights plus an hour range) rather than inferred:
  the owner already knows when it is, and the decision-point algorithm needs entries it
  does not have yet. The plan for that window is written sober and surfaces two hours
  before the window opens.
- **The acute screen** asks nothing. One button on every tab, then three ways out: eat the
  planned option, start a ten-minute pause, or record that it already started. Detail is
  captured the next morning instead, when answering is possible.
- **The morning after** leads Today with the fact that nothing needs repairing, names the
  next planned occasion, and offers the log.
- **Progress is multidimensional and holds no streak.** Counts run over six weeks; the
  headline is recovery quality — how many episodes were followed by eating the next planned
  occasion, and the mean days to resume. A "days since" counter turns one lapse into a total
  loss, which is the same all-or-nothing structure that drives the binge.
- While the programme runs, the goal-date countdown, the overage-bank tile, and the
  trend-calibration prompt are hidden. Weekly weighing and the trend chart stay.
- Nothing on this side of the app reads a calorie or a weight. Tests hold both that
  exclusion and the absence of streak mechanics.

## Data and persistence

- Shared product and recipe data live in `data/products.json` and `data/templates.json`.
- Personal state lives only in browser localStorage under `fuel.state.v1`.
- The repository does not contain the owner's personal logs.
- The record carries an explicit `schemaVersion` (currently 3) and migrates forward on load. Records written before versioning existed are treated as v1 and upgraded, not discarded.
- A migration that fails leaves the stored record untouched, keeps a recovery copy, and lets the app run on the last good state.
- Fuel keeps a rolling ring of up to five recovery copies, taken before any write that replaces or deletes the record: upgrades, restores, imports, and resets. The ring shrinks rather than failing when phone storage is full.
- An unreadable record no longer falls back to blank state. It is quarantined intact and a full-screen recovery path offers the copies, a pasted backup, or an explicit start-fresh.
- Export produces a versioned `fuel-backup.v1` archive; import still accepts the older bare-state exports. Round trips are covered by tests.
- Schema v3 adds `urges` (the log) and `cbt` (mode, eating occasions, risk window, the
  written window and setback plans, exit criteria). The container keeps unknown fields and
  is repaired field by field, because a half-shaped plan renders as a blank one and a blank
  plan reads as "you never wrote it". Backups carry both.
- `js/persistence.js` holds all of this and has no DOM access, so it is testable under `node --test`.

## Deployment and quality

- Hosted on Vercel, deployed from `main`, with a preview deployment per pull request.
- The Vercel build command is `npm test`, so a failing suite blocks the deployment.
- GitHub Actions also runs `node --test` on pushes and pull requests.
- The latest release has 85 automated tests.
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