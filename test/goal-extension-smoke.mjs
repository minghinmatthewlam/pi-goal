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
  const tempDir = mkdtempSync(join(tmpdir(), "pi-goal-smoke-"));
  let entryCounter = 0;

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
    modelRegistry: { hasConfiguredAuth: () => false },
    isIdle: () => false,
    hasPendingMessages: () => false,
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
    sendMessage() {
      throw new Error("sendMessage should not run in smoke tests");
    },
  };

  piGoalExtension(pi);

  return {
    commands,
    ctx,
    entries,
    tools,
    cleanup: () => rmSync(tempDir, { force: true, recursive: true }),
    runEvent: async (name, event = {}) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx);
      }
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
