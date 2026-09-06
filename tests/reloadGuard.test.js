import test from "node:test";
import assert from "node:assert/strict";
import { createReloadGuard } from "../js/reloadGuard.js";

test("a full-storage failure keeps the only in-memory changes alive", () => {
  let reloads = 0, warnings = 0;
  const reload = createReloadGuard({ isDirty: () => true, save: () => false, reload: () => reloads++, notify: () => warnings++ });
  assert.equal(reload(), false);
  assert.equal(reloads, 0);
  assert.equal(warnings, 1);
});

test("a successful retry saves before reload, while a clean session needs no write", () => {
  const events = [];
  const guard = (dirty) => createReloadGuard({ isDirty: () => dirty, save: () => { events.push("save"); return true; }, reload: () => events.push("reload"), notify: () => assert.fail("unexpected warning") });
  assert.equal(guard(true)(), true);
  assert.equal(guard(false)(), true);
  assert.deepEqual(events, ["save", "reload", "reload"]);
});
