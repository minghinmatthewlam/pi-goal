// Integration tests driving the wired extension through a mock host:
// timerless continuation loop, budget stop-guard, blocked-audit escalation,
// and the strict update_goal contract.

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: piGoalExtension } = await jiti.import("../extension/index.ts");

let passed = 0;
function test(name, fn) {
  return fn().then(() => {
    passed += 1;
    console.log(`ok - ${name}`);
  });
}

function harness(options = {}) {
  const mode = options.mode ?? "tui";
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const flags = new Map();
  const entries = [];
  const sent = [];
  let counter = 0;

  const ui = {
    notifications: [],
    status: new Map(),
    widgets: new Map(),
    notify(message, type = "info") {
      this.notifications.push({ message, type });
    },
    setStatus(key, text) {
      if (text === undefined) this.status.delete(key);
      else this.status.set(key, text);
    },
    setWidget(key, content) {
      if (content === undefined) this.widgets.delete(key);
      else this.widgets.set(key, content);
    },
    confirm: async () => true,
  };

  const ctx = {
    ui,
    mode,
    hasUI: false,
    cwd: "/tmp/pi-goal-test",
    model: { provider: "test", id: "test-model" },
    modelRegistry: { hasConfiguredAuth: () => true },
    isIdle: () => true,
    hasPendingMessages: () => false,
    signal: undefined,
    abort() {},
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getEntry: (id) => entries.find((e) => e.id === id),
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionFile: () => "/tmp/pi-goal-test/session.jsonl",
    },
  };

  const pi = {
    registerCommand: (name, def) => commands.set(name, def),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerFlag: (name, def) => flags.set(name, { ...def, value: options.flags?.[name] }),
    getFlag: (name) => flags.get(name)?.value,
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry: (customType, data) => {
      entries.push({ id: `e${(counter += 1)}`, type: "custom", customType, data });
    },
    sendMessage: (message, options) => sent.push({ message, options }),
    sendUserMessage: () => {},
  };

  piGoalExtension(pi);

  const runEvent = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  };

  return {
    ctx,
    entries,
    sent,
    tools,
    ui,
    runEvent,
    runCommand: (name, args) => commands.get(name).handler(args, ctx),
    runTool: (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx),
    triggerMessagesFrom: (index = 0) =>
      sent.slice(index).map(({ message }) => ({
        role: "custom",
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      })),
    continuationTriggers: () =>
      sent.filter(({ message }) => message.details?.kind === "continuation").length,
    budgetTriggers: () => sent.filter(({ message }) => message.details?.kind === "budget").length,
  };
}

function assistant(content, overrides = {}) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: Array.isArray(content) ? content : [{ type: "text", text: content }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// Simulate one host-delivered continuation/budget turn: deliver the last trigger
// message through the context hook, then run a turn + agent end.
async function runInjectedTurn(h, { toolResults = [], usage = 1, stopReason = "stop" } = {}) {
  const startIndex = h.sent.length - 1;
  await h.runEvent("agent_start");
  const trigger = h.triggerMessagesFrom(startIndex)[0];
  const [ctxResult] = await h.runEvent("context", { messages: [trigger] });
  const msg = assistant("working", { usage: { totalTokens: usage, cost: {} }, stopReason });
  await h.runEvent("turn_end", { turnIndex: 0, message: msg, toolResults });
  await h.runEvent("agent_end", { messages: [msg] });
  return ctxResult.messages[0].content;
}

await test("continuation loop: auto-continues twice, then update_goal complete stops it", async () => {
  const h = harness();
  await h.runCommand("goal", "make the tests green");
  assert.equal(h.continuationTriggers(), 1, "creating a goal arms the first continuation");

  // First continuation turn does real work -> re-arms a second continuation.
  const firstPrompt = await runInjectedTurn(h, { toolResults: [{ toolName: "bash" }], usage: 5 });
  assert.match(firstPrompt, /Continue working toward the active session goal/);
  assert.equal(h.continuationTriggers(), 2, "auto-continues a second time");

  // Second continuation: the model marks the goal complete.
  await h.runEvent("agent_start");
  const trigger = h.triggerMessagesFrom(h.sent.length - 1)[0];
  await h.runEvent("context", { messages: [trigger] });
  const result = await h.runTool("update_goal", { status: "complete" });
  assert.equal(result.details.goal.status, "complete");
  await h.runEvent("agent_end", { messages: [assistant("done")] });

  assert.equal(h.continuationTriggers(), 2, "no further continuation after completion");
  assert.equal(h.ui.status.has("goal"), false, "completed goal clears the status bar");
});

await test("budget stop-guard: over-budget goal becomes budget_limited and stops continuing", async () => {
  const h = harness();
  await h.runEvent("agent_start");
  await h.runTool("create_goal", { objective: "summarize the repo", token_budget: 10 });
  // A turn that consumes more than the budget.
  const msg = assistant("working", { usage: { totalTokens: 50, cost: {} } });
  await h.runEvent("turn_end", { turnIndex: 0, message: msg, toolResults: [{ toolName: "bash" }] });

  const goal = (await h.runTool("get_goal")).details.goal;
  assert.equal(goal.status, "budget_limited");
  assert.equal(h.budgetTriggers(), 1, "arms one wrap-up");

  // The wrap-up turn shows the budget prompt.
  const budgetTrigger = h.triggerMessagesFrom(h.sent.length - 1)[0];
  const [ctxResult] = await h.runEvent("context", { messages: [budgetTrigger] });
  assert.match(ctxResult.messages[0].content, /reached its token budget/);

  await h.runEvent("agent_end", { messages: [assistant("wrapped up")] });
  assert.equal(h.continuationTriggers(), 0, "budget_limited goal never auto-continues");
});

await test("turn-error stop-guard: a non-retryable turn error blocks the goal", async () => {
  const h = harness();
  await h.runCommand("goal", "do the thing");
  await h.runEvent("agent_start");
  const trigger = h.triggerMessagesFrom(h.sent.length - 1)[0];
  await h.runEvent("context", { messages: [trigger] });
  const errored = assistant("", { stopReason: "error", errorMessage: "the server exploded" });
  await h.runEvent("turn_end", { turnIndex: 0, message: errored, toolResults: [] });
  await h.runEvent("agent_end", { messages: [errored] });

  const goal = (await h.runTool("get_goal")).details.goal;
  assert.equal(goal.status, "blocked");
  assert.equal(h.continuationTriggers(), 1, "blocked goal does not re-arm");
});

await test("blocked-audit escalation appears after three no-progress goal turns", async () => {
  const h = harness();
  const now = Date.now();
  h.entries.push({
    id: "seed",
    type: "custom",
    customType: "pi-goal.event",
    data: {
      v: 1,
      event: "goal_created",
      goal: {
        goalId: "g1",
        objective: "unreachable objective",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  for (let i = 0; i < 3; i += 1) {
    h.entries.push({
      id: `np${i}`,
      type: "custom",
      customType: "pi-goal.event",
      data: { v: 1, event: "turn_accounted", goalId: "g1", addedTokens: 1, hadProgress: false, note: "no tool progress", at: now + i },
    });
  }
  await h.runEvent("session_start", { reason: "resume" });
  assert.equal(h.continuationTriggers(), 1, "resume arms a continuation for the active goal");
  const trigger = h.triggerMessagesFrom(0)[0];
  const [ctxResult] = await h.runEvent("context", { messages: [trigger] });
  assert.match(ctxResult.messages[0].content, /No-progress audit/);
});

await test("update_goal contract: strict schema, active-only", async () => {
  const h = harness();
  const schema = JSON.stringify(h.tools.get("update_goal").parameters);
  assert.doesNotMatch(schema, /achieved|completed|done/, "no completion aliases in the model schema");
  assert.match(schema, /complete/);
  assert.match(schema, /blocked/);

  const noGoal = await h.runTool("update_goal", { status: "complete" });
  assert.equal(noGoal.isError, true);

  await h.runCommand("goal", "something");
  await h.runCommand("goal", "pause");
  const paused = await h.runTool("update_goal", { status: "complete" });
  assert.equal(paused.isError, true, "cannot complete a non-active goal via the tool");
});

await test("resuming an over-budget active goal moves it to budget_limited (no stranded active loop)", async () => {
  const h = harness();
  const now = Date.now();
  h.entries.push({
    id: "seed",
    type: "custom",
    customType: "pi-goal.event",
    data: {
      v: 1,
      event: "goal_created",
      goal: {
        goalId: "g1",
        objective: "already spent",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 5000,
        timeUsedSeconds: 10,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await h.runEvent("session_start", { reason: "resume" });
  const goal = (await h.runTool("get_goal")).details.goal;
  assert.equal(goal.status, "budget_limited");
  assert.equal(h.continuationTriggers(), 0, "over-budget goal never arms a continuation");
  assert.equal(h.budgetTriggers(), 1, "it arms the one-time wrap-up instead");
});

await test("navigating /tree to reopen a user prompt suppresses auto-continuation", async () => {
  const h = harness();
  await h.runCommand("goal", "keep working");
  const startTriggers = h.continuationTriggers();
  h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "earlier prompt" } });
  await h.runEvent("session_before_tree", { preparation: { targetId: "u1" } });
  await h.runEvent("session_tree", { newLeafId: "u1", oldLeafId: null });
  assert.equal(h.continuationTriggers(), startTriggers, "editing history does not enqueue a goal turn");
});

await test("a cancelled/failed compaction does not permanently disable continuation", async () => {
  const h = harness();
  await h.runCommand("goal", "survive a failed compaction");
  await runInjectedTurn(h, { toolResults: [{ toolName: "bash" }] }); // cycle the first arm
  const before = h.continuationTriggers();
  // Compaction starts but never emits session_compact (cancelled/failed).
  await h.runEvent("session_before_compact", { reason: "threshold", willRetry: false });
  // The next agent run must clear the stuck suppression flag and re-arm.
  await runInjectedTurn(h, { toolResults: [{ toolName: "bash" }] });
  assert.equal(h.continuationTriggers(), before + 1, "continuation re-arms after a failed compaction");
});

await test("per-turn awareness is injected on active-goal turns and survives compaction", async () => {
  const h = harness();
  await h.runCommand("goal", "keep context alive");
  // A normal user turn (no trigger message): awareness should be appended.
  const [ctxResult] = await h.runEvent("context", {
    messages: [{ role: "user", content: "hello" }],
  });
  const last = ctxResult.messages.at(-1);
  assert.equal(last.role, "custom");
  assert.match(last.content, /Active session goal/);
});

// Run body with process.exitCode isolated: pi-goal sets process.exitCode in
// headless mode, and we must not let that leak into the test runner's own exit.
async function withIsolatedExitCode(fn) {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    return await fn();
  } finally {
    process.exitCode = saved;
  }
}

// Drive one accounted goal turn that reports real tool progress, from the last
// armed trigger, and return the folded progress length afterward.
async function runProgressTurn(h) {
  await runInjectedTurn(h, { toolResults: [{ toolName: "bash" }], usage: 3 });
}

await test("headless turn cap: force-blocks the goal and sets exit code 4 after N turns", async () => {
  await withIsolatedExitCode(async () => {
    const h = harness({ mode: "print", flags: { "goal-max-turns": "2" } });
    await h.runCommand("goal", "keep iterating forever");
    assert.equal(h.continuationTriggers(), 1, "goal creation arms the first continuation");

    await runProgressTurn(h); // turn 1: progress.length -> 1, re-arms
    assert.equal(h.continuationTriggers(), 2, "under the cap, a second continuation arms");
    assert.notEqual((await h.runTool("get_goal")).details.goal.status, "blocked");

    await runProgressTurn(h); // turn 2: progress.length -> 2, cap reached at agent_end
    const goal = (await h.runTool("get_goal")).details.goal;
    assert.equal(goal.status, "blocked", "hitting the turn cap blocks the goal");
    assert.equal(h.continuationTriggers(), 2, "no continuation is armed once the cap is hit");
    assert.equal(process.exitCode, 4, "a turn-capped headless goal reports exit code 4");
  });
});

await test("headless turn cap default (50) does not fire early; interactive mode is never capped", async () => {
  await withIsolatedExitCode(async () => {
    // Interactive (tui) run with a cap of 1 must NOT block: the cap is headless-only.
    const interactive = harness({ mode: "tui", flags: { "goal-max-turns": "1" } });
    await interactive.runCommand("goal", "long interactive goal");
    await runProgressTurn(interactive);
    await runProgressTurn(interactive);
    await runProgressTurn(interactive);
    assert.equal((await interactive.runTool("get_goal")).details.goal.status, "active", "interactive runs ignore the cap");
    assert.equal(process.exitCode, undefined, "interactive mode never sets a headless exit code");

    // Headless run with the default cap stays active well before 50 turns.
    const headless = harness({ mode: "print" });
    await headless.runCommand("goal", "short headless goal");
    await runProgressTurn(headless);
    await runProgressTurn(headless);
    assert.equal((await headless.runTool("get_goal")).details.goal.status, "active", "default cap does not fire at 2 turns");
  });
});

await test("headless exit code: budget_limited reports 4, completion stays 0", async () => {
  await withIsolatedExitCode(async () => {
    const budget = harness({ mode: "print" });
    await budget.runEvent("agent_start");
    await budget.runTool("create_goal", { objective: "summarize", token_budget: 10 });
    const overspend = assistant("working", { usage: { totalTokens: 50, cost: {} } });
    await budget.runEvent("turn_end", { turnIndex: 0, message: overspend, toolResults: [{ toolName: "bash" }] });
    assert.equal((await budget.runTool("get_goal")).details.goal.status, "budget_limited");
    assert.equal(process.exitCode, 4, "budget_limited reports the incomplete exit code");

    process.exitCode = undefined;
    const done = harness({ mode: "print" });
    await done.runCommand("goal", "finish the thing");
    await done.runEvent("agent_start");
    const trigger = done.triggerMessagesFrom(done.sent.length - 1)[0];
    await done.runEvent("context", { messages: [trigger] });
    await done.runTool("update_goal", { status: "complete" });
    await done.runEvent("agent_end", { messages: [assistant("done")] });
    assert.equal((await done.runTool("get_goal")).details.goal.status, "complete");
    assert.equal(process.exitCode, undefined, "a completed headless goal leaves the exit code at 0");
  });
});

await test("headless exit code: model-blocked goal reports 4", async () => {
  await withIsolatedExitCode(async () => {
    const h = harness({ mode: "print" });
    await h.runCommand("goal", "do the thing");
    await h.runEvent("agent_start");
    const trigger = h.triggerMessagesFrom(h.sent.length - 1)[0];
    await h.runEvent("context", { messages: [trigger] });
    const errored = assistant("", { stopReason: "error", errorMessage: "the server exploded" });
    await h.runEvent("turn_end", { turnIndex: 0, message: errored, toolResults: [] });
    await h.runEvent("agent_end", { messages: [errored] });
    assert.equal((await h.runTool("get_goal")).details.goal.status, "blocked");
    assert.equal(process.exitCode, 4, "a blocked headless goal reports exit code 4");
  });
});

console.log(`\n${passed} extension tests passed`);
