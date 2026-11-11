/* Recovery program rules: no compensation, regular eating, stages with a brake, escalation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/engine.js";
import * as P from "../js/persistence.js";

const profile = { sex: "male", age: 30, heightIn: 69, weightLb: 160, activity: "walker", deficit: 500, startWeightLb: 160, goalLossLb: 10, proteinPerLb: 1 };
const day = (n, from = "2026-11-01") => E.dateKey(E.addDays(E.parseKey(from), n));
function st(extra = {}) {
  const s = { ...P.normalizeState(null), profile: { ...profile } };
  s.recovery = E.newRecovery({ today: "2026-11-01", baseline: 2 });
  return Object.assign(s, extra);
}
const binge = (s, key) => { (s.foodLog[key] ||= { entries: [], walks: [] }).entries.push({ id: key + "b", name: "CVS sweets", calories: 3000, protein: 20, qty: 1, binge: true }); };

test("default schedule from Ryan's day: no gap over 4 hours, ends with a planned evening treat", () => {
  const sch = E.defaultSchedule({ wake: "09:00", dinner: "19:00" });
  assert.deepEqual(sch.map((x) => x.time), ["09:30", "13:00", "16:00", "19:00", "21:30"]);
  const mins = sch.map((x) => { const [h, m] = x.time.split(":").map(Number); return h * 60 + m; });
  for (let i = 1; i < mins.length; i++) assert.ok(mins[i] - mins[i - 1] <= 240, "no gap over 4h");
  assert.equal(sch[4].label, "Evening treat");
});

test("recovery never builds a payback bank or trims the next day", () => {
  const s = st({ overageBank: 0 });
  binge(s, "2026-11-05");
  E.settleCountDays(s, "2026-11-06");
  assert.equal(s.overageBank, 0, "a binge is data, not a debt");
  s.overageBank = 900; // left over from before recovery started
  assert.equal(E.dailyTrim(s), 0, "and an old bank is never trimmed while in recovery");
});

test("timeline: logged meals tick their slot; past unlogged ones are 'missed', the current one is 'now'", () => {
  const sch = E.defaultSchedule();
  const at = (h, m) => { const d = new Date(2026, 10, 11, h, m); return d.toISOString(); };
  const entries = [{ id: "a", at: at(9, 40), calories: 300 }, { id: "b", slot: "lunch", calories: 500 }];
  const now = 16 * 60 + 10;
  const st2 = E.scheduleStatus(sch, entries, now);
  assert.deepEqual(st2.map((x) => x.status), ["done", "done", "now", "later", "later"], "only one thing is highlighted at a time");
  const late = E.scheduleStatus(sch, [], 21 * 60);
  assert.equal(late[2].status, "missed");
  assert.equal(late[3].status, "missed"); assert.equal(late[4].status, "now");
  assert.ok(E.scheduleStatus(sch, [{ id: "x", at: at(14, 0), binge: true }], 15 * 60).every((x) => x.status !== "done"), "a binge doesn't count as a planned meal");
});

test("logging guesses the meal you're on: dinner at 8:30pm, not the 9:30 treat; breakfast late at 11:15am", () => {
  const sch = E.defaultSchedule();
  const at = (h, m) => new Date(2026, 10, 11, h, m).toISOString();
  assert.equal(E.guessSlot(sch, [], 20 * 60 + 30), "dinner", "8:30pm with dinner not logged → dinner");
  assert.equal(E.guessSlot(sch, [], 11 * 60 + 15), "breakfast", "11:15am → breakfast (late, still breakfast)");
  assert.equal(E.guessSlot(sch, [], 7 * 60), "breakfast", "before anything starts → the next one");
  assert.equal(E.guessSlot(sch, [{ id: "d", slot: "dinner" }], 23 * 60 + 20), "evening", "11:20pm after dinner → the evening treat");
  const all = sch.map((s, i) => ({ id: "e" + i, slot: s.id }));
  assert.equal(E.guessSlot(sch, all, 23 * 60), "extra", "everything covered → extra (allowed, no judgement)");
  // the 8:30pm dinner the owner logged must tick dinner and nothing else
  const tl = E.scheduleStatus(sch, [{ id: "q", slot: "dinner", at: at(20, 30) }], 20 * 60 + 31);
  assert.deepEqual(tl.filter((x) => x.status === "done").map((x) => x.id), ["dinner"]);
  // several items logged together tick one meal, not the neighbours too
  const lunch = [1, 2, 3].map((i) => ({ id: "l" + i, at: at(14, 30) }));
  assert.deepEqual(E.scheduleStatus(sch, lunch, 15 * 60).filter((x) => x.status === "done").map((x) => x.id), ["lunch"]);
  // the Today list groups entries by meal; "extra" and binges never tick a slot
  const map = E.entrySlots(sch, [{ id: "x", slot: "extra" }, { id: "y", slot: "lunch", binge: true }, { id: "z", at: at(9, 50) }]);
  assert.deepEqual(map, { x: "extra", y: "binge", z: "breakfast" });
});

test("stage 2 starts after 4 weeks with ≤2 binge days in the last 28; 2 binge days in 14 brakes back", () => {
  const s = st();
  binge(s, day(3));
  assert.equal(E.evaluateStage(s, day(20)).stage, 1, "not before 4 weeks");
  const r = E.evaluateStage(s, day(29));
  assert.equal(r.stage, 2); assert.equal(r.changed, true);
  assert.equal(E.recoveryTarget(s), E.tdee({ ...s.profile, budgetKcal: 0 }) - E.REC_STAGE2_DEFICIT);
  binge(s, day(35)); binge(s, day(38));
  const b = E.evaluateStage(s, day(40));
  assert.equal(b.stage, 1); assert.equal(b.reason, "brake");
  assert.equal(E.recoveryTarget(s), E.tdee({ ...s.profile, budgetKcal: 0 }), "back to maintenance");
});

test("stage 1 holds while binges continue", () => {
  const s = st();
  for (const n of [5, 12, 19, 26]) binge(s, day(n));
  assert.equal(E.evaluateStage(s, day(30)).stage, 1);
});

test("binge counting: log flags, 'it happened' urges, and the evening check-in", () => {
  const s = st();
  binge(s, "2026-11-05");
  s.recovery.urges.push({ date: "2026-11-06", outcome: "binge" }, { date: "2026-11-06", outcome: "passed" });
  s.recovery.checkins["2026-11-07"] = { binge: true, mood: 3 };
  assert.equal(E.bingesOn(s, "2026-11-05"), 1);
  assert.equal(E.bingesOn(s, "2026-11-06"), 1);
  assert.equal(E.bingesOn(s, "2026-11-07"), 1);
  const w = E.recoveryWeek(s, "2026-11-02", "2026-11-08");
  assert.equal(w.bingeDays, 3);
  assert.equal(w.ridden, 1);
});

test("week-4 checkpoint: recommends a human if binges aren't down ~65% from baseline", () => {
  const s = st();
  for (const n of [30, 33, 37, 40]) binge(s, day(n)); // ~2/week, same as baseline
  assert.ok(E.recoveryFlags(s, day(42)).some((f) => f.type === "slow"));
  const ok = st();
  binge(ok, day(31));                                   // 0.5/week vs 2 → 75% down
  assert.ok(!E.recoveryFlags(ok, day(42)).some((f) => f.type === "slow"));
  assert.equal(E.recoveryFlags(st(), day(10)).length, 0, "no verdict before 4 weeks");
});

test("compensation or a low-mood run always surfaces support", () => {
  const s = st();
  s.recovery.weekly["2026-11-08"] = { compensate: 1 };
  assert.ok(E.recoveryFlags(s, "2026-11-09").some((f) => f.type === "compensation"));
  const m = st();
  for (let i = 1; i <= 6; i++) m.recovery.checkins[day(i)] = { mood: 2 };
  assert.ok(E.recoveryFlags(m, day(8)).some((f) => f.type === "mood"));
});

test("plan-ahead appears the evening before a risky day and on the day", () => {
  const s = st();
  const wedEve = new Date(2026, 10, 11, 19, 0);   // Wed Nov 11, 7pm → Thursday is risky
  assert.deepEqual(E.riskPlanFor(s, wedEve), { key: "2026-11-12", when: "tomorrow" });
  assert.equal(E.riskPlanFor(s, new Date(2026, 10, 11, 10, 0)), null, "not in the morning before");
  assert.equal(E.riskPlanFor(s, new Date(2026, 10, 13, 12, 0)).when, "today", "Friday is risky too");
});

test("recovery record survives a backup round trip and repairs a damaged shape", () => {
  const s = st();
  s.recovery.checkins["2026-11-02"] = { mood: 4, schedule: "yes" };
  const { state } = P.importArchive(JSON.parse(JSON.stringify(P.exportArchive(s))));
  assert.deepEqual(state.recovery.checkins, s.recovery.checkins);
  const bad = P.normalizeState({ recovery: { enabled: true, urges: "x", checkins: [] } });
  assert.deepEqual(bad.recovery.urges, []); assert.deepEqual(bad.recovery.checkins, {});
  assert.equal(P.normalizeState({ recovery: "nope" }).recovery, null);
});
