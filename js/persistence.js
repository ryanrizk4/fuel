/* persistence.js — pure storage logic: no DOM. Versioned state records, forward
   migrations, a bounded ring of recovery copies, and the export/import archive
   format. The owner's logs live only on this phone, so the one rule here is:
   never throw away a record we could still read. Blank state is a last resort
   the owner has to choose, not something a parse error decides for them. */

export const STORE_KEY = "fuel.state.v1";        // primary record — unchanged, phones already hold it
export const RECOVERY_KEY = "fuel.recovery.v1";  // rolling recovery copies, newest first
export const QUARANTINE_KEY = "fuel.corrupt.v1"; // the exact bytes we couldn't read, kept for rescue
export const BACKUP_FORMAT = "fuel-backup.v1";

// Bump when the persisted shape changes, and add a migration below. Records
// written before versioning existed have no schemaVersion and are treated as 1.
export const SCHEMA_VERSION = 2;
export const LEGACY_VERSION = 1;
export const MAX_RECOVERY_SNAPSHOTS = 5;

// ---------- shape ----------

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: null,
    plan: { days: {} },
    weighIns: [],
    freezer: [],
    history: {},
    productOverrides: {},
    shopChecks: {},
    pantry: {},
    favorites: {},
    planSeed: 1,
    recipeInbox: [],
    checkinDismissed: "",
    opened: {},
    overageBank: 0,
    planMode: "auto",
    theme: "auto",
  };
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const nowIso = () => new Date().toISOString();

// Object-shaped fields (maps keyed by product/template id) and list-shaped fields.
const MAP_FIELDS = ["history", "productOverrides", "shopChecks", "pantry", "favorites", "opened"];
const LIST_FIELDS = ["weighIns", "freezer", "recipeInbox"];

/**
 * Repair a record's shape without discarding anything readable. Unknown fields are
 * kept (a record written by a newer build must survive a round trip through an older
 * one), and a field of the wrong kind is replaced by its default rather than deleted —
 * the original always survives in a recovery copy taken before the migrating write.
 * Never throws.
 */
function normalizeState(raw) {
  const out = { ...defaultState(), ...(isObj(raw) ? raw : {}) };
  out.plan = isObj(out.plan) ? { ...out.plan } : { days: {} };
  out.plan.days = isObj(out.plan.days) ? out.plan.days : {};
  for (const f of MAP_FIELDS) if (!isObj(out[f])) out[f] = {};
  for (const f of LIST_FIELDS) if (!Array.isArray(out[f])) out[f] = [];
  if (!isObj(out.profile)) out.profile = null;
  if (!Number.isFinite(out.overageBank)) out.overageBank = 0;
  if (!Number.isFinite(out.planSeed)) out.planSeed = 1;
  if (typeof out.planMode !== "string") out.planMode = "auto";
  if (typeof out.theme !== "string") out.theme = "auto";
  return out;
}

/** Counts for the recovery screen — "restore 42 planned days" beats a bare timestamp. */
function summarizeState(state) {
  const s = isObj(state) ? state : {};
  const days = isObj(s.plan) && isObj(s.plan.days) ? Object.keys(s.plan.days).length : 0;
  return {
    days,
    weighIns: Array.isArray(s.weighIns) ? s.weighIns.length : 0,
    freezer: Array.isArray(s.freezer) ? s.freezer.reduce((n, f) => n + (Number(f?.portions) || 0), 0) : 0,
    favorites: isObj(s.favorites) ? Object.keys(s.favorites).length : 0,
    hasProfile: isObj(s.profile),
  };
}

// ---------- migrations ----------

/**
 * Ordered forward migrations. Each step upgrades a record from `to - 1` to `to`.
 * Steps must be pure and tolerant: they receive whatever was on disk, however old.
 */
const MIGRATIONS = [
  {
    to: 2,
    describe: "stamp a schema version and repair container fields",
    migrate(state) {
      const out = normalizeState(state);
      // The protein target moved from 0.8g to 1.0g per lb of ideal bodyweight; the
      // old load() patched this on every boot, which is exactly what a migration is for.
      if (out.profile && out.profile.proteinPerLb === 0.8) out.profile = { ...out.profile, proteinPerLb: 1.0 };
      return out;
    },
  },
];

/** A record's schema version — anything unversioned predates versioning and is v1. */
function versionOf(record) {
  const v = isObj(record) ? Number(record.schemaVersion) : NaN;
  return Number.isFinite(v) && v > 0 ? v : LEGACY_VERSION;
}

/**
 * Upgrade a record to SCHEMA_VERSION, one step at a time.
 * A step that throws stops the pipeline and returns the last state that migrated
 * cleanly — never a blank state, and never a partially-applied one.
 * Returns { state, from, to, applied, ok, error }.
 */
function migrateState(record, { migrations = MIGRATIONS } = {}) {
  const from = versionOf(record);
  let state = normalizeState(record);
  let at = from;
  const applied = [];
  for (const step of migrations) {
    if (step.to <= at) continue;
    try {
      const next = step.migrate(clone(state));
      if (!isObj(next)) throw new Error(`migration to v${step.to} returned no record`);
      state = next;
      at = step.to;
      applied.push(step.to);
    } catch (error) {
      // Stop here on purpose. The caller keeps the last good state and the untouched
      // record on disk; a broken upgrade must never cost the owner their logs.
      state.schemaVersion = at;
      return { state, from, to: at, applied, ok: false, error };
    }
  }
  state.schemaVersion = Math.max(at, SCHEMA_VERSION);
  return { state, from, to: state.schemaVersion, applied, ok: true, error: null };
}

// ---------- raw storage ----------
// Every access is guarded: localStorage throws in private modes and when the quota is full.

function readRaw(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function writeRaw(storage, key, value) {
  try { storage.setItem(key, value); return true; } catch { return false; }
}

function removeRaw(storage, key) {
  try { storage.removeItem(key); return true; } catch { return false; }
}

// ---------- recovery copies ----------

function listRecoverySnapshots(storage) {
  try {
    const parsed = JSON.parse(readRaw(storage, RECOVERY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isObj) : [];
  } catch {
    return [];
  }
}

/**
 * Push a recovery copy onto the ring, newest first, bounded to MAX_RECOVERY_SNAPSHOTS.
 * `payload` is a state object, or { raw } when all we have is bytes we couldn't parse.
 * Phone storage is small, so a quota failure drops the oldest copies and retries
 * rather than failing the write that asked for the copy.
 */
function createRecoverySnapshot(storage, payload, reason = "automatic") {
  const entry = { createdAt: nowIso(), reason };
  if (typeof payload === "string") {
    // Keep the exact bytes, but describe them if they happen to parse — a copy the
    // owner can't tell apart from the others is a copy they won't dare restore.
    entry.raw = payload;
    entry.schemaVersion = null;
    try {
      const parsed = JSON.parse(payload);
      if (isObj(parsed)) { entry.schemaVersion = versionOf(parsed); entry.summary = summarizeState(parsed); }
    } catch { /* unreadable bytes stay undescribed, which is the honest answer */ }
  } else if (isObj(payload)) {
    entry.state = clone(payload);
    entry.schemaVersion = versionOf(payload);
    entry.summary = summarizeState(payload);
  } else {
    return null;
  }
  const ring = [entry, ...listRecoverySnapshots(storage)].slice(0, MAX_RECOVERY_SNAPSHOTS);
  for (let keep = ring.length; keep >= 1; keep--) {
    if (writeRaw(storage, RECOVERY_KEY, JSON.stringify(ring.slice(0, keep)))) return entry;
  }
  return null; // out of room even for one copy — the caller still has the live state
}

/** What the recovery screen shows: enough to tell the copies apart, without the payload. */
function describeRecoverySnapshots(storage) {
  return listRecoverySnapshots(storage).map((entry, index) => ({
    index,
    createdAt: entry.createdAt || "",
    reason: entry.reason || "automatic",
    schemaVersion: entry.schemaVersion ?? null,
    restorable: isObj(entry.state) || typeof entry.raw === "string",
    summary: entry.summary || (isObj(entry.state) ? summarizeState(entry.state) : null),
  }));
}

/** Pull a recovery copy back out; `raw`-only copies are parsed on the way. */
function readRecoverySnapshot(storage, index) {
  const entry = listRecoverySnapshots(storage)[index];
  if (!entry) return null;
  if (isObj(entry.state)) return entry.state;
  if (typeof entry.raw === "string") {
    try { return JSON.parse(entry.raw); } catch { return null; }
  }
  return null;
}

// ---------- load / save ----------

function saveState(storage, state) {
  const record = { ...state, schemaVersion: SCHEMA_VERSION };
  return writeRaw(storage, STORE_KEY, JSON.stringify(record));
}

/**
 * Read the persisted record and bring it up to date.
 * Returns { state, status, snapshots, migrated, error }, where status is one of:
 *   "fresh"     nothing stored yet — first run, blank state is correct
 *   "ok"        readable and current
 *   "migrated"  readable, upgraded, and written back (old bytes kept as a recovery copy)
 *   "degraded"  readable but a migration failed — usable, original kept, warn the owner
 *   "corrupt"   unreadable — nothing is overwritten and the owner must choose what happens
 * The corrupt path deliberately leaves the stored record alone. Recovery is an
 * offer, never something that happens quietly behind the owner's back.
 */
function loadState(storage, options = {}) {
  const raw = readRaw(storage, STORE_KEY);
  if (raw == null || raw === "") {
    return { state: normalizeState(null), status: "fresh", snapshots: [], migrated: [], error: null };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return corruptResult(storage, raw, error);
  }
  if (!isObj(parsed)) {
    return corruptResult(storage, raw, new Error("stored record is not an object"));
  }

  const result = migrateState(parsed, options);
  const snapshots = describeRecoverySnapshots(storage);

  if (!result.ok) {
    // Readable but not upgradable. Keep the original safe and let the app run on the
    // last good state; the alternative — refusing to start — helps nobody.
    createRecoverySnapshot(storage, parsed, `before failed upgrade to v${SCHEMA_VERSION}`);
    return {
      state: result.state, status: "degraded", snapshots: describeRecoverySnapshots(storage),
      migrated: result.applied, error: result.error,
    };
  }
  if (result.applied.length) {
    // A replacing write: copy the pre-migration record first, then persist the upgrade.
    createRecoverySnapshot(storage, parsed, `before upgrade to v${result.to}`);
    saveState(storage, result.state);
    return {
      state: result.state, status: "migrated", snapshots: describeRecoverySnapshots(storage),
      migrated: result.applied, error: null,
    };
  }
  return { state: result.state, status: "ok", snapshots, migrated: [], error: null };
}

function corruptResult(storage, raw, error) {
  // Quarantine the exact bytes (once — a second boot must not overwrite the original
  // with whatever replaced it) and offer the recovery ring. Nothing is written to
  // STORE_KEY here: the unreadable record stays put until the owner decides.
  if (readRaw(storage, QUARANTINE_KEY) == null) writeRaw(storage, QUARANTINE_KEY, raw);
  const snapshots = describeRecoverySnapshots(storage);
  return { state: normalizeState(null), status: "corrupt", snapshots, migrated: [], error };
}

/** Restore a recovery copy over the primary record, copying what's there first. */
function restoreFromSnapshot(storage, index) {
  const recovered = readRecoverySnapshot(storage, index);
  if (!recovered) throw new Error("That recovery copy can't be read.");
  const current = readRaw(storage, STORE_KEY);
  if (current != null) createRecoverySnapshot(storage, current, "before restore");
  const { state } = migrateState(recovered);
  saveState(storage, state);
  removeRaw(storage, QUARANTINE_KEY);
  return state;
}

/** Wipe the primary record. The recovery ring survives, so a reset stays undoable. */
function clearState(storage) {
  const current = readRaw(storage, STORE_KEY);
  if (current != null) createRecoverySnapshot(storage, current, "before reset");
  removeRaw(storage, STORE_KEY);
  removeRaw(storage, QUARANTINE_KEY);
}

/** Drop the quarantined bytes and start over — the only path to a blank state. */
function discardCorruptRecord(storage) {
  const corrupt = readRaw(storage, QUARANTINE_KEY) ?? readRaw(storage, STORE_KEY);
  if (corrupt != null) createRecoverySnapshot(storage, corrupt, "unreadable record discarded");
  removeRaw(storage, STORE_KEY);
  removeRaw(storage, QUARANTINE_KEY);
  return normalizeState(null);
}

// ---------- export / import ----------

/** The backup file. Wrapped and versioned so a future import knows what it's holding. */
function exportArchive(state, { appVersion = "" } = {}) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    appVersion,
    summary: summarizeState(state),
    state: clone(normalizeState(state)),
  };
}

/**
 * Accept a backup file and hand back a current-schema state.
 * Bare state objects — everything Fuel exported before this format existed — are
 * still valid backups and go through the same migrations.
 * Throws only when the payload contains no Fuel state at all.
 */
function importArchive(payload) {
  if (!isObj(payload)) throw new Error("That file isn't a Fuel backup.");
  let record = null;
  let source = "";
  if (payload.format === BACKUP_FORMAT) {
    if (!isObj(payload.state)) throw new Error("That backup is missing its state.");
    record = payload.state;
    source = "archive";
  } else if (isObj(payload.profile) || isObj(payload.plan)) {
    record = payload; // pre-format export: the raw state object itself
    source = "legacy";
  } else {
    throw new Error("That doesn't look like a Fuel backup.");
  }
  const result = migrateState(record);
  if (!result.ok) throw new Error("That backup is from a version Fuel can't read yet.");
  return { state: result.state, source, migrated: result.applied };
}

/** Replace the live record with an imported one, keeping a copy of what it replaced. */
function importArchiveInto(storage, payload) {
  const { state, source, migrated } = importArchive(payload);
  const current = readRaw(storage, STORE_KEY);
  if (current != null) createRecoverySnapshot(storage, current, "before restore from backup");
  saveState(storage, state);
  removeRaw(storage, QUARANTINE_KEY);
  return { state, source, migrated };
}

export {
  defaultState, normalizeState, summarizeState, versionOf, migrateState, MIGRATIONS,
  loadState, saveState, clearState, discardCorruptRecord,
  createRecoverySnapshot, listRecoverySnapshots, describeRecoverySnapshots, readRecoverySnapshot, restoreFromSnapshot,
  exportArchive, importArchive, importArchiveInto,
};
