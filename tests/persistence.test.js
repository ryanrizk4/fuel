/* Persistence tests — the owner's logs live only on his phone, so these cover the
   ways a stored record can go wrong: an old shape, a failed upgrade, unreadable
   bytes, and a backup that has to come back exactly as it went out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../js/persistence.js";

// localStorage stand-in. `limit` caps the size of a single value so the quota
// path can be exercised the way a full phone would trigger it.
function fakeStorage(seed = {}, { limit = Infinity } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const s = String(v);
      if (s.length > limit) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      map.set(k, s);
    },
    removeItem: (k) => { map.delete(k); },
  };
}

// A record shaped the way Fuel wrote them before versioning existed.
function legacyRecord(extra = {}) {
  return {
    profile: {
      sex: "male", age: 28, heightIn: 70, weightLb: 185, activity: "moderate",
      deficit: 500, goalLossLb: 10, startWeightLb: 185, breakfastDefault: "latte",
      treatsPerWeek: 3, proteinPerLb: 0.8,
    },
    plan: { days: { "2026-07-20": { status: "done", meals: [{ slot: "dinner", templateId: "turkey-burgers", variantId: "classic" }], snacks: [], eaten: [0] } } },
    weighIns: [{ date: "2026-07-20", lb: 184.2 }],
    freezer: [{ templateId: "turkey-burgers", portions: 3 }],
    history: { "t:turkey-burgers": "2026-07-20" },
    productOverrides: {}, shopChecks: {}, overageBank: 120, planMode: "auto",
    ...extra,
  };
}

const parseStored = (storage, key) => JSON.parse(storage.getItem(key));

// ---------- migrations ----------

test("an unversioned v1 record migrates forward instead of being discarded", () => {
  const storage = fakeStorage({ [P.STORE_KEY]: JSON.stringify(legacyRecord()) });
  const result = P.loadState(storage);

  assert.equal(result.status, "migrated");
  assert.deepEqual(result.migrated, [2]);
  assert.equal(result.state.schemaVersion, P.SCHEMA_VERSION);
  // every field the owner cared about survived the upgrade
  assert.equal(Object.keys(result.state.plan.days).length, 1);
  assert.equal(result.state.weighIns[0].lb, 184.2);
  assert.equal(result.state.freezer[0].portions, 3);
  assert.equal(result.state.overageBank, 120);
  assert.equal(result.state.profile.proteinPerLb, 1.0, "0.8 g/lb profiles are lifted to 1.0 by the v2 migration");
  // fields added after the record was written come in at their defaults
  assert.deepEqual(result.state.pantry, {});
  assert.deepEqual(result.state.favorites, {});
  // and the upgrade was persisted, with the pre-migration record kept
  assert.equal(parseStored(storage, P.STORE_KEY).schemaVersion, P.SCHEMA_VERSION);
  const copies = P.describeRecoverySnapshots(storage);
  assert.equal(copies.length, 1);
  assert.match(copies[0].reason, /before upgrade/);
});

test("a current record loads untouched and takes no recovery copy", () => {
  const current = P.migrateState(legacyRecord()).state;
  const storage = fakeStorage({ [P.STORE_KEY]: JSON.stringify(current) });
  const result = P.loadState(storage);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.state, current);
  assert.equal(P.listRecoverySnapshots(storage).length, 0, "a no-op load must not churn the ring");
});

test("nothing stored at all is a fresh start, not a recovery", () => {
  const result = P.loadState(fakeStorage());
  assert.equal(result.status, "fresh");
  assert.equal(result.state.profile, null);
  assert.equal(result.state.schemaVersion, P.SCHEMA_VERSION);
});

test("a migration that throws keeps the owner's data instead of wiping it", () => {
  const stored = JSON.stringify(legacyRecord());
  const storage = fakeStorage({ [P.STORE_KEY]: stored });
  const exploding = [{ to: 2, describe: "boom", migrate() { throw new Error("bad upgrade"); } }];
  const result = P.loadState(storage, { migrations: exploding });

  assert.equal(result.status, "degraded");
  assert.match(result.error.message, /bad upgrade/);
  assert.equal(Object.keys(result.state.plan.days).length, 1, "the app still runs on the last good state");
  assert.equal(result.state.weighIns[0].lb, 184.2);
  assert.equal(storage.getItem(P.STORE_KEY), stored, "a failed upgrade must not rewrite the stored record");
  assert.match(P.describeRecoverySnapshots(storage)[0].reason, /failed upgrade/);
});

test("shape repair keeps unknown fields and fixes wrong-kinded ones", () => {
  const repaired = P.normalizeState({ weighIns: "not a list", plan: null, favorites: 7, somethingNewer: { keep: true } });
  assert.deepEqual(repaired.weighIns, []);
  assert.deepEqual(repaired.plan, { days: {} });
  assert.deepEqual(repaired.favorites, {});
  assert.deepEqual(repaired.somethingNewer, { keep: true }, "a record from a newer build must survive an older one");
});

// ---------- corruption recovery ----------

test("a corrupt record offers recovery instead of silently blanking", () => {
  const storage = fakeStorage();
  P.saveState(storage, P.migrateState(legacyRecord()).state);
  P.createRecoverySnapshot(storage, P.migrateState(legacyRecord()).state, "nightly");
  storage.setItem(P.STORE_KEY, '{"profile":{"age":28,,,'); // truncated write

  const result = P.loadState(storage);
  assert.equal(result.status, "corrupt");
  assert.ok(result.snapshots.length >= 1, "the owner is offered something to restore");
  assert.equal(result.snapshots[0].summary.weighIns, 1, "copies describe themselves so they can be told apart");
  assert.equal(storage.getItem(P.STORE_KEY), '{"profile":{"age":28,,,', "the unreadable record is left alone until the owner chooses");
  assert.equal(storage.getItem(P.QUARANTINE_KEY), '{"profile":{"age":28,,,', "and the exact bytes are quarantined for rescue");

  const restored = P.restoreFromSnapshot(storage, 0);
  assert.equal(restored.weighIns[0].lb, 184.2);
  assert.equal(restored.freezer[0].portions, 3);
  assert.equal(parseStored(storage, P.STORE_KEY).weighIns[0].lb, 184.2);
  assert.equal(storage.getItem(P.QUARANTINE_KEY), null, "recovery clears the quarantine");
});

test("a corrupt record with no recovery copies still refuses to wipe itself", () => {
  const storage = fakeStorage({ [P.STORE_KEY]: "<html>not json</html>" });
  const result = P.loadState(storage);

  assert.equal(result.status, "corrupt");
  assert.deepEqual(result.snapshots, []);
  assert.equal(storage.getItem(P.STORE_KEY), "<html>not json</html>");

  // Blank state is reachable only by an explicit discard, which still keeps a copy.
  const blank = P.discardCorruptRecord(storage);
  assert.equal(blank.profile, null);
  assert.equal(storage.getItem(P.STORE_KEY), null);
  assert.equal(P.listRecoverySnapshots(storage)[0].raw, "<html>not json</html>");
});

test("a second boot on a corrupt record does not overwrite the quarantined original", () => {
  const storage = fakeStorage({ [P.STORE_KEY]: "first-bad-bytes" });
  P.loadState(storage);
  storage.setItem(P.STORE_KEY, "second-bad-bytes");
  P.loadState(storage);
  assert.equal(storage.getItem(P.QUARANTINE_KEY), "first-bad-bytes");
});

// ---------- recovery ring ----------

test("recovery copies roll newest-first and stay bounded", () => {
  const storage = fakeStorage();
  for (let i = 1; i <= P.MAX_RECOVERY_SNAPSHOTS + 3; i++) {
    P.createRecoverySnapshot(storage, P.normalizeState({ overageBank: i }), `copy ${i}`);
  }
  const copies = P.listRecoverySnapshots(storage);
  assert.equal(copies.length, P.MAX_RECOVERY_SNAPSHOTS, "the ring is bounded so it can't eat the phone's storage");
  assert.equal(copies[0].reason, `copy ${P.MAX_RECOVERY_SNAPSHOTS + 3}`, "newest first");
  assert.equal(copies[0].state.overageBank, P.MAX_RECOVERY_SNAPSHOTS + 3);
  assert.equal(copies.at(-1).reason, `copy ${4}`, "the oldest copies fall off the end");
});

test("a full phone drops old copies rather than failing the write", () => {
  const roomy = fakeStorage();
  for (let i = 1; i <= 4; i++) P.createRecoverySnapshot(roomy, P.normalizeState({ overageBank: i }), `copy ${i}`);
  const oneCopyLength = JSON.stringify(P.listRecoverySnapshots(roomy).slice(0, 1)).length;

  const tight = fakeStorage({ [P.RECOVERY_KEY]: roomy.getItem(P.RECOVERY_KEY) }, { limit: oneCopyLength + 40 });
  assert.doesNotThrow(() => P.createRecoverySnapshot(tight, P.normalizeState({ overageBank: 99 }), "copy 5"));
  const kept = P.listRecoverySnapshots(tight);
  assert.ok(kept.length >= 1 && kept.length < 5, `expected the ring to shrink to fit, got ${kept.length}`);
  assert.equal(kept[0].reason, "copy 5", "the newest copy is the one that survives");
});

test("reset keeps a recovery copy, so wiping everything stays undoable", () => {
  const storage = fakeStorage();
  P.saveState(storage, P.migrateState(legacyRecord()).state);
  P.clearState(storage);

  assert.equal(storage.getItem(P.STORE_KEY), null);
  const copies = P.describeRecoverySnapshots(storage);
  assert.equal(copies[0].reason, "before reset");
  assert.equal(copies[0].summary.weighIns, 1, "copies taken from raw bytes still describe themselves");
  assert.equal(P.restoreFromSnapshot(storage, 0).weighIns[0].lb, 184.2);
});

// ---------- export / import ----------

test("export → import round trips to an equivalent state", () => {
  const state = P.migrateState(legacyRecord({ favorites: { "turkey-burgers": true }, pantry: { "olive-oil": true } })).state;

  // through the wire exactly as the owner moves it: JSON out, JSON back in
  const wire = JSON.parse(JSON.stringify(P.exportArchive(state, { appVersion: "fuel-v13" })));
  assert.equal(wire.format, P.BACKUP_FORMAT);
  assert.equal(wire.schemaVersion, P.SCHEMA_VERSION);
  assert.equal(wire.summary.weighIns, 1);

  const { state: restored } = P.importArchive(wire);
  assert.deepEqual(restored, state, "a backup must import back to the state it came from");
});

test("an export taken before the archive format still restores", () => {
  const legacy = legacyRecord(); // pre-format exports were the bare state object
  const { state, source, migrated } = P.importArchive(JSON.parse(JSON.stringify(legacy)));

  assert.equal(source, "legacy");
  assert.deepEqual(migrated, [2]);
  assert.equal(state.schemaVersion, P.SCHEMA_VERSION);
  assert.equal(state.weighIns[0].lb, 184.2);
  assert.equal(state.profile.proteinPerLb, 1.0);
});

test("importing over live data keeps a copy of what it replaced", () => {
  const storage = fakeStorage();
  P.saveState(storage, P.migrateState(legacyRecord()).state);
  const incoming = P.exportArchive(P.normalizeState({ profile: { age: 40 }, overageBank: 7 }));

  const { state } = P.importArchiveInto(storage, JSON.parse(JSON.stringify(incoming)));
  assert.equal(state.overageBank, 7);
  assert.equal(parseStored(storage, P.STORE_KEY).overageBank, 7);
  const copies = P.describeRecoverySnapshots(storage);
  assert.match(copies[0].reason, /before restore from backup/);
  assert.equal(P.restoreFromSnapshot(storage, 0).weighIns[0].lb, 184.2, "the replaced state is still recoverable");
});

test("junk files are rejected without touching the stored record", () => {
  const storage = fakeStorage();
  const good = P.migrateState(legacyRecord()).state;
  P.saveState(storage, good);

  for (const junk of [null, 42, "a string", {}, { hello: "world" }, { format: P.BACKUP_FORMAT }]) {
    assert.throws(() => P.importArchiveInto(storage, junk), /Fuel|backup|state/i);
  }
  assert.deepEqual(parseStored(storage, P.STORE_KEY), good);
});
