# Fuel operating guide

This file is the current operating contract for any AI or human contributor. `CLAUDE.md` remains historical context until retired, but this file takes precedence.

## Product

Fuel is a personal, mobile-first meal-planning PWA for the owner. It plans high-protein, calorie-budgeted weeks around Trader Joe's shopping, workday constraints, freezer use, and a no-microwave kitchen.

Preserve the product's defining advantages:

- Personal rather than generic.
- Fast, offline-capable, and phone-first.
- Deterministic planning logic, not LLM-generated weekly plans.
- Variety through meal variants that preserve the same cooking motions.
- Honest nutrition confidence and explicit label verification.
- No framework or backend unless a concrete product need justifies the added complexity.

## Current architecture

- `index.html`: application shell.
- `css/styles.css`: mobile-first design system.
- `js/app.js`: UI rendering, interactions, and persistence wiring.
- `js/engine.js`: pure planning and nutrition logic with no DOM access.
- `data/products.json`: product/macronutrient database.
- `data/templates.json`: meal templates and variants.
- `sw.js`: PWA cache behavior.
- `tests/`: engine and data-integrity tests.

The owner's personal state is stored in the phone browser under `fuel.state.v1`. Never commit personal exports or logs.

## Owner constraints

- Samsung Galaxy / Android is the primary device target.
- No microwave. Tests enforce this.
- High protein and calorie deficit.
- Quick weeknight cooking, typically 25 minutes or less.
- Workday lunches must be assembly/reheat friendly and must not require cooking raw protein at work.
- Air fryer, covered-pan reheating, weekend batch cooking, and freezer portions are first-class workflows.
- Middle Eastern flavors and Trader Joe's products are welcome.

## Required checks

Before opening or updating a pull request:

```bash
node --test
```

For UI changes, run the real app over HTTP and test the affected flow at approximately 390×844. Check console errors, horizontal overflow, bottom sheets, keyboard behavior, and PWA cache/version behavior.

For product or template changes:

- All product references must resolve.
- Main-meal variants must remain within the tested calorie/protein bounds.
- Steps must remain short and microwave-free.
- New planner behavior requires regression tests.
- New shell changes must update the single release/cache version source once centralized.

## Persistence safety

Current localStorage persistence is the largest durability risk. Until versioned migrations and recovery snapshots ship:

- Do not casually rename or remove state fields.
- Preserve backward compatibility when adding fields.
- Never silently discard an existing readable state.
- Keep export/import behavior working.
- Treat a corrupted primary state as recoverable data, not a reason to reset without warning.

## Recipe ingestion

When the owner asks to add a recipe:

1. Research the recipe or trend when necessary.
2. Reuse existing product records where possible.
3. Mark unverifiable nutrition data as estimated.
4. Add two to four variants that preserve the same basic cooking process.
5. Keep instructions terse and realistic for the owner's equipment.
6. Run the full tests and verify macros before opening a PR.

## Pull-request discipline

Use one focused branch per change. A PR must explain:

- What changed and why.
- User impact.
- Planner, persistence, nutrition-data, or PWA-cache risks.
- Tests and phone-sized manual verification.

Do not rewrite Fuel into a framework because it looks more conventional. Rewrite only if the current architecture demonstrably blocks a required capability.

## Documentation truth

`README.md`, `AGENTS.md`, and `docs/CURRENT_STATE.md` describe what is true now. Keep model vendors out of durable operating instructions and user-facing copy.