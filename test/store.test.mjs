// Pure-function unit tests for the event-sourced store:
// fold correctness (incl. branch pruning), status transitions, stop-guards,
// and the blocked-audit counter.

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("../extension/store.ts");
const {
  GOAL_ENTRY_TYPE,
  GoalStore,
  foldBranch,
  isOverBudget,
  isTerminal,
  remainingTokens,
  blockedAuditTriggered,
  classifyTurnFailure,
  buildProgressNote,
  assistantTokens,
  BLOCKED_AUDIT_THRESHOLD,
} = store;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const now = 1_000_000;
function entry(event) {
  return { type: "custom", customType: GOAL_ENTRY_TYPE, data: event };
}
function createdEvent(overrides = {}) {
  return {
    v: 1,
    event: "goal_created",
    goal: {
      goalId: "g1",
      objective: "ship the thing",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
  };
}

// --- Fold: creation + accumulation --------------------------------------
test("fold applies creation, accounting, and status transition", () => {
  const state = foldBranch([
    entry(createdEvent()),
    entry({ v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 100, hadProgress: true, note: "ran bash", at: now + 1000 }),
    entry({ v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 50, hadProgress: false, note: "no tool progress", at: now + 2000 }),
    entry({ v: 1, event: "status_changed", goalId: "g1", status: "complete", at: now + 3000 }),
  ]);
  assert.equal(state.goal.status, "complete");
  assert.equal(state.goal.tokensUsed, 150);
  assert.equal(state.progress.length, 2);
  assert.equal(state.noProgressStreak, 1);
  assert.equal(state.goal.timeUsedSeconds, 3);
});

// --- Fold: only current-branch entries participate (branch pruning) -----
test("fold ignores non-goal and foreign entries; refold reflects branch switch", () => {
  const branchA = [
    entry(createdEvent()),
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "custom", customType: "other-ext", data: { anything: true } },
    entry({ v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 10, hadProgress: true, note: "ran read", at: now + 500 }),
  ];
  const a = foldBranch(branchA);
  assert.equal(a.goal.goalId, "g1");
  assert.equal(a.goal.tokensUsed, 10);

  // A different branch that never created g1 (abandoned-branch pruning: those
  // events are simply not in the entries getBranch would return).
  const branchB = [entry(createdEvent({ goalId: "g2", objective: "different work" }))];
  const managed = new GoalStore(() => {});
  managed.refold(branchA);
  assert.equal(managed.goal.goalId, "g1");
  managed.refold(branchB);
  assert.equal(managed.goal.goalId, "g2");
  assert.equal(managed.goal.tokensUsed, 0);
});

// --- Fold: legacy v1 entries are still recognized on upgrade -------------
test("legacy pi-goal.goal / pi-gui.goal snapshots fold to the current goal", () => {
  const legacy = (customType, data) => ({ type: "custom", customType, data });
  const g = (over) => ({
    goalId: "legacy1",
    objective: "old-format goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  const state = foldBranch([
    legacy("pi-gui.goal", { version: 1, event: "set", goalId: "legacy1", goal: g() }),
    legacy("pi-goal.goal", { version: 1, event: "set", goalId: "legacy1", goal: g({ tokensUsed: 500, status: "active" }) }),
  ]);
  assert.equal(state.goal.goalId, "legacy1");
  assert.equal(state.goal.tokensUsed, 500);
  assert.equal(state.goal.status, "active");

  const cleared = foldBranch([
    legacy("pi-goal.goal", { version: 1, event: "set", goalId: "legacy1", goal: g() }),
    legacy("pi-goal.goal", { version: 1, event: "clear", goalId: "legacy1" }),
  ]);
  assert.equal(cleared.goal, undefined);
});

// --- Fold: clear resets state -------------------------------------------
test("goal_cleared resets folded state", () => {
  const state = foldBranch([
    entry(createdEvent()),
    entry({ v: 1, event: "goal_cleared", at: now + 100 }),
  ]);
  assert.equal(state.goal, undefined);
  assert.equal(state.progress.length, 0);
});

// --- Fold: malformed status is inert, never active ----------------------
test("unrecognized persisted status folds to paused, not active", () => {
  const state = foldBranch([entry(createdEvent({ status: "migrating" }))]);
  assert.equal(state.goal.status, "paused");
});

// --- Write-through cache matches a fresh fold ---------------------------
test("write-through cache equals a fresh fold of appended events", () => {
  const events = [];
  const managed = new GoalStore((ev) => events.push(ev));
  managed.create(createdEvent().goal);
  managed.account("g1", 200, true, "ran bash", now + 1000);
  managed.changeStatus("g1", "paused", now + 2000);
  const fresh = foldBranch(events.map((ev) => entry(ev)));
  assert.deepEqual(managed.folded.goal, fresh.goal);
  assert.equal(managed.folded.noProgressStreak, fresh.noProgressStreak);
});

// --- Status transition attribution: events for another goal are ignored -
test("status/accounting events for a stale goalId are ignored", () => {
  const state = foldBranch([
    entry(createdEvent()),
    entry({ v: 1, event: "status_changed", goalId: "OTHER", status: "complete", at: now + 1 }),
    entry({ v: 1, event: "turn_accounted", goalId: "OTHER", addedTokens: 999, hadProgress: true, note: "x", at: now + 2 }),
  ]);
  assert.equal(state.goal.status, "active");
  assert.equal(state.goal.tokensUsed, 0);
});

// --- Budget stop-guard ---------------------------------------------------
test("isOverBudget / remainingTokens honor the token budget", () => {
  const under = { tokenBudget: 100, tokensUsed: 40 };
  const over = { tokenBudget: 100, tokensUsed: 100 };
  const unbounded = { tokenBudget: null, tokensUsed: 10_000 };
  assert.equal(isOverBudget(under), false);
  assert.equal(isOverBudget(over), true);
  assert.equal(isOverBudget(unbounded), false);
  assert.equal(remainingTokens(under), 60);
  assert.equal(remainingTokens(over), 0);
  assert.equal(remainingTokens(unbounded), null);
});

test("terminal statuses are recognized", () => {
  for (const s of ["blocked", "usage_limited", "budget_limited", "complete"]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ["active", "paused"]) {
    assert.equal(isTerminal(s), false, s);
  }
});

// --- Blocked-audit counter ----------------------------------------------
test("blocked-audit triggers after N consecutive no-progress turns and resets on progress", () => {
  const events = [entry(createdEvent())];
  for (let i = 0; i < BLOCKED_AUDIT_THRESHOLD; i += 1) {
    events.push(entry({ v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 1, hadProgress: false, note: "no tool progress", at: now + i }));
  }
  const blocked = foldBranch(events);
  assert.equal(blocked.noProgressStreak, BLOCKED_AUDIT_THRESHOLD);
  assert.equal(blockedAuditTriggered(blocked), true);

  const recovered = foldBranch([
    ...events,
    entry({ v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 1, hadProgress: true, note: "ran bash", at: now + 100 }),
  ]);
  assert.equal(recovered.noProgressStreak, 0);
  assert.equal(blockedAuditTriggered(recovered), false);
});

// --- Turn-failure classification ----------------------------------------
test("classifyTurnFailure maps usage-limit vs generic errors", () => {
  const usage = classifyTurnFailure({ role: "assistant", stopReason: "error", errorMessage: "429 rate limit exceeded" });
  assert.equal(usage.status, "usage_limited");
  const generic = classifyTurnFailure({ role: "assistant", stopReason: "error", errorMessage: "boom" });
  assert.equal(generic.status, "blocked");
  assert.equal(classifyTurnFailure({ role: "assistant", stopReason: "stop" }), undefined);
  assert.equal(classifyTurnFailure({ role: "assistant", stopReason: "aborted" }), undefined);
  assert.equal(classifyTurnFailure({ role: "user", content: "hi" }), undefined);
});

// --- Progress note derivation -------------------------------------------
test("buildProgressNote counts real work but not goal/meta tools", () => {
  assert.equal(buildProgressNote([{ toolName: "bash" }, { toolName: "read" }]).hadProgress, true);
  assert.equal(buildProgressNote([{ toolName: "update_goal" }]).hadProgress, false);
  assert.equal(buildProgressNote([{ toolName: "get_goal" }]).hadProgress, false);
  assert.equal(buildProgressNote([]).hadProgress, false);
  assert.match(buildProgressNote([{ toolName: "bash" }]).note, /bash/);
});

test("assistantTokens reads totalTokens defensively", () => {
  assert.equal(assistantTokens({ role: "assistant", usage: { totalTokens: 42 } }), 42);
  assert.equal(assistantTokens({ role: "assistant", usage: {} }), 0);
  assert.equal(assistantTokens({ role: "user" }), 0);
});

console.log(`\n${passed} store tests passed`);
