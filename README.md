# Fuel

Fuel is a personal, mobile-first meal-planning PWA that builds high-protein, calorie-budgeted weeks around Trader Joe's shopping, workday constraints, freezer inventory, and the owner's actual kitchen.

**Live:** https://ryanrizk4.github.io/fuel/

## Why it exists

Fuel is not a generic recipe app. It reduces the weekly decisions around:

- What to eat within a calorie and protein target.
- What groceries to buy.
- Which fresh/opened ingredients should be used first.
- Which meals fit workday and weeknight constraints.
- How to create variety without relearning a new cooking process every day.

## Current architecture

Fuel intentionally has no framework and no build step:

- `index.html` — app shell.
- `css/styles.css` — mobile-first visual system.
- `js/app.js` — rendering, interactions, and persistence.
- `js/engine.js` — pure deterministic planning logic.
- `data/products.json` — products and macro data.
- `data/templates.json` — meal templates and variants.
- `sw.js` — installable/offline PWA caching.
- `tests/` — engine and data-integrity tests.

The owner's personal state remains on the phone in browser localStorage and is never committed.

## Run locally

Serve the repository over HTTP:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Run tests with:

```bash
node --test
```

## Contributor guide

Read:

1. [`AGENTS.md`](AGENTS.md) — current provider-neutral operating rules.
2. [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — what is live and what matters next.
3. `CLAUDE.md` — historical context and detailed product conventions until its remaining useful material is migrated.

## Non-negotiable product constraints

- No microwave recipes.
- High protein and calorie-conscious.
- Weeknight cooking should generally stay within 25 minutes.
- Weekday work lunches cannot require cooking raw protein.
- Trader Joe's and freezer workflows are first-class.
- Estimated nutrition data must be labeled honestly.
- Keep the app fast, installable, and usable from a Samsung Galaxy.

## Near-term direction

The priority is durability without overengineering:

- Versioned localStorage migrations.
- Recoverable state snapshots.
- Tested export and restore.
- Single-sourced app/service-worker versioning.
- Provider-neutral operating and user-facing language.

A framework rewrite, backend, and multi-user architecture are not current priorities.