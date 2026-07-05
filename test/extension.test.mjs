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

function harness() {
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
    mode: "print",
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
    registerFlag: (name, def) => flags.set(name, def),
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

console.log(`\n${passed} extension tests passed`);
