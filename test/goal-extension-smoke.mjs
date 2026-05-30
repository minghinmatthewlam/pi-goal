import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: piGoalExtension } = await jiti.import("../extension/index.ts");

function createExtensionHarness() {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  const sentMessages = [];
  const tempDir = mkdtempSync(join(tmpdir(), "pi-goal-smoke-"));
  let entryCounter = 0;
  let hasConfiguredAuth = false;
  let isIdle = false;
  let hasPendingMessages = false;

  const ui = {
    notifications: [],
    status: new Map(),
    widgets: new Map(),
    notify(message, type = "info") {
      this.notifications.push({ message, type });
    },
    setStatus(key, text) {
      if (text === undefined) {
        this.status.delete(key);
      } else {
        this.status.set(key, text);
      }
    },
    setWidget(key, content) {
      if (content === undefined) {
        this.widgets.delete(key);
      } else {
        this.widgets.set(key, content);
      }
    },
    confirm: async () => true,
  };

  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    getLeafId: () => entries.at(-1)?.id ?? null,
    getSessionFile: () => join(tempDir, "session.jsonl"),
    _rewriteFile: () => {},
  };

  const ctx = {
    ui,
    sessionManager,
    model: undefined,
    modelRegistry: { hasConfiguredAuth: () => hasConfiguredAuth },
    isIdle: () => isIdle,
    hasPendingMessages: () => hasPendingMessages,
  };

  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(name, handler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    appendEntry(customType, data) {
      entries.push({
        id: `entry-${++entryCounter}`,
        type: "custom",
        customType,
        data,
      });
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };

  piGoalExtension(pi);

  return {
    commands,
    ctx,
    entries,
    sentMessages,
    tools,
    cleanup: () => rmSync(tempDir, { force: true, recursive: true }),
    runEvent: async (name, event = {}) => {
      const results = [];
      for (const handler of handlers.get(name) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
    setAutoContinueReady: () => {
      ctx.model = { provider: "test-provider", id: "test-model" };
      hasConfiguredAuth = true;
      isIdle = true;
      hasPendingMessages = false;
    },
    widgetLines: () => ui.widgets.get("pi-goal") ?? [],
  };
}

async function runGoalCommand(harness, args) {
  await harness.commands.get("goal").handler(args, harness.ctx);
}

async function runUpdateGoal(harness, status) {
  return harness.tools.get("update_goal").execute("tool-call", { status }, undefined, undefined, harness.ctx);
}

function assistantMessage(content, overrides = {}) {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    content,
    usage: {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function updateGoalToolCall(args = { status: "completed" }) {
  return {
    type: "toolCall",
    id: "goal-update-attempt",
    name: "update_goal",
    arguments: args,
  };
}

async function waitForSentMessages(harness, count) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (harness.sentMessages.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(harness.sentMessages.length, count);
}

{
  const harness = createExtensionHarness();
  try {
    await runGoalCommand(harness, "understand the README");
    const schema = JSON.stringify(harness.tools.get("update_goal").parameters);

    assert.match(schema, /achieved/);

    const result = await runUpdateGoal(harness, "achieved");

    assert.equal(result.details.goal.status, "complete");
    assert.equal(harness.ctx.ui.status.has("goal"), false);
    assert.equal(harness.ctx.ui.widgets.has("pi-goal"), false);
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    const now = Date.now();
    harness.entries.push({
      id: "seed-goal",
      type: "custom",
      customType: "pi-goal.goal",
      data: {
        version: 1,
        event: "set",
        goalId: "budget-goal",
        goal: {
          goalId: "budget-goal",
          objective: "summarize the README",
          status: "active",
          tokenBudget: 6000,
          tokensUsed: 162486,
          timeUsedSeconds: 14,
          createdAt: now - 18_000,
          updatedAt: now - 18_000,
        },
      },
    });

    await runGoalCommand(harness, "");

    const lines = harness.widgetLines();
    assert(lines.includes("Tokens: 162,486 used (6,000 budget exceeded by 156,486)"));
    assert(lines.some((line) => /^Elapsed: 1[89]s$/.test(line)));

    await runGoalCommand(harness, "clear");
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    harness.setAutoContinueReady();
    const now = Date.now();
    harness.entries.push({
      id: "seed-goal",
      type: "custom",
      customType: "pi-goal.goal",
      data: {
        version: 1,
        event: "set",
        goalId: "over-budget-active-goal",
        goal: {
          goalId: "over-budget-active-goal",
          objective: "continue despite legacy budget",
          status: "active",
          tokenBudget: 6000,
          tokensUsed: 162486,
          timeUsedSeconds: 14,
          createdAt: now - 18_000,
          updatedAt: now - 18_000,
        },
      },
    });

    await harness.runEvent("session_start");
    await waitForSentMessages(harness, 1);

    const [context] = await harness.runEvent("context", {
      messages: [{ role: "custom", ...harness.sentMessages[0].message }],
    });
    assert.match(context.messages[0].content, /Budget:/);
    assert.match(context.messages[0].content, /Tokens remaining: 0/);
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    const now = Date.now();
    harness.entries.push({
      id: "corrupt-goal",
      type: "custom",
      customType: "pi-goal.goal",
      data: {
        version: 1,
        event: "set",
        goalId: "corrupt-goal",
        goal: {
          goalId: "corrupt-goal",
          objective: "do not auto-continue corrupt state",
          status: "migrating",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 5,
          createdAt: now - 5_000,
          updatedAt: now - 5_000,
        },
      },
    });

    await harness.runEvent("session_start");

    assert(harness.widgetLines().includes("Status: paused"));
    assert(harness.widgetLines().includes("Elapsed: 5s"));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert(harness.widgetLines().includes("Elapsed: 5s"));
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    await runGoalCommand(harness, "watch elapsed time");
    assert(harness.widgetLines().includes("Elapsed: 0s"));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert(harness.widgetLines().some((line) => /^Elapsed: [12]s$/.test(line)));
    await runGoalCommand(harness, "clear");
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    await runGoalCommand(harness, "stop refreshing after shutdown");
    assert(harness.widgetLines().includes("Elapsed: 0s"));

    await harness.runEvent("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert(harness.widgetLines().includes("Elapsed: 0s"));
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    harness.setAutoContinueReady();
    await runGoalCommand(harness, "retry after a rejected completion attempt");
    await waitForSentMessages(harness, 1);

    const rejectedCompletion = assistantMessage([
      { type: "text", text: "I am done and will mark the goal complete." },
      updateGoalToolCall({ status: "finished" }),
    ]);

    await harness.runEvent("agent_start");
    await harness.runEvent("turn_start");
    await harness.runEvent("turn_end", { message: rejectedCompletion, toolResults: [] });
    await harness.runEvent("agent_end", { messages: [rejectedCompletion] });
    await waitForSentMessages(harness, 2);

    const suppressedEntries = harness.entries.filter(
      (entry) => entry.type === "custom" && entry.data?.event === "auto_suppressed",
    );
    assert.equal(suppressedEntries.length, 0);
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    harness.setAutoContinueReady();
    await runGoalCommand(harness, "suppress aborted partial completion attempts");
    await waitForSentMessages(harness, 1);

    const abortedPartialCompletion = assistantMessage([updateGoalToolCall()], { stopReason: "aborted" });

    await harness.runEvent("agent_start");
    await harness.runEvent("turn_start");
    await harness.runEvent("turn_end", { message: abortedPartialCompletion, toolResults: [] });
    await harness.runEvent("agent_end", { messages: [abortedPartialCompletion] });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.sentMessages.length, 1);

    const suppressedEntries = harness.entries.filter(
      (entry) => entry.type === "custom" && entry.data?.event === "auto_suppressed",
    );
    assert.equal(suppressedEntries.length, 1);
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    harness.setAutoContinueReady();
    const now = Date.now();
    const goal = {
      goalId: "rejected-goal",
      objective: "recover from stale suppression",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    harness.entries.push(
      {
        id: "seed-goal",
        type: "custom",
        customType: "pi-goal.goal",
        data: { version: 1, event: "set", goalId: goal.goalId, goal },
      },
      {
        id: "seed-auto-continue",
        type: "custom",
        customType: "pi-goal.goal",
        data: {
          version: 1,
          event: "auto_continue",
          goalId: goal.goalId,
          continuationId: "continuation-with-tool-attempt",
        },
      },
      {
        id: "seed-assistant",
        type: "message",
        message: assistantMessage([updateGoalToolCall({ status: "finished" })]),
      },
      {
        id: "seed-usage-update",
        type: "custom",
        customType: "pi-goal.goal",
        data: {
          version: 1,
          event: "set",
          goalId: goal.goalId,
          goal: {
            ...goal,
            tokensUsed: 1,
            updatedAt: now + 1,
          },
        },
      },
      {
        id: "seed-suppressed",
        type: "custom",
        customType: "pi-goal.goal",
        data: {
          version: 1,
          event: "auto_suppressed",
          goalId: goal.goalId,
          continuationId: "continuation-with-tool-attempt",
          reason: "continuation ended without tool progress",
        },
      },
    );

    await harness.runEvent("session_start");
    await waitForSentMessages(harness, 1);
  } finally {
    harness.cleanup();
  }
}

{
  const harness = createExtensionHarness();
  try {
    harness.setAutoContinueReady();
    const now = Date.now();
    const goal = {
      goalId: "quiet-goal",
      objective: "do not repeat text-only no-progress continuations",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    harness.entries.push(
      {
        id: "seed-goal",
        type: "custom",
        customType: "pi-goal.goal",
        data: { version: 1, event: "set", goalId: goal.goalId, goal },
      },
      {
        id: "seed-auto-continue",
        type: "custom",
        customType: "pi-goal.goal",
        data: {
          version: 1,
          event: "auto_continue",
          goalId: goal.goalId,
          continuationId: "continuation-without-tool-attempt",
        },
      },
      {
        id: "seed-assistant",
        type: "message",
        message: assistantMessage([{ type: "text", text: "goal needs more work" }]),
      },
      {
        id: "seed-suppressed",
        type: "custom",
        customType: "pi-goal.goal",
        data: {
          version: 1,
          event: "auto_suppressed",
          goalId: goal.goalId,
          continuationId: "continuation-without-tool-attempt",
          reason: "continuation ended without tool progress",
        },
      },
    );

    await harness.runEvent("session_start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    harness.cleanup();
  }
}
