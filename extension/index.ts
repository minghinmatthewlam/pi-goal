// pi-goal v2 — persistent session goals with timerless idle continuation.
//
// Design:
// - Storage is event-sourced and append-only (see store.ts): every state change
//   is one pi.appendEntry custom entry; current state is the branch fold.
// - Continuation is timerless: at idle boundaries (agent_end / resume) an active
//   goal injects a hidden trigger message with triggerTurn, and the host's
//   deferred delivery fires the next turn. No setTimeout / setInterval.
// - Per-turn awareness is injected in the context hook from the folded cache, so
//   compaction never erases goal context.
// - Stop-guards halt the loop on token-budget exhaustion (budget_limited, with a
//   one-time wrap-up), non-retryable turn errors (blocked), and usage limits
//   (usage_limited); a 3-turn no-progress audit forces justify-or-block.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentEndEvent,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  awarenessPrompt,
  budgetLimitPrompt,
  completionBudgetReport,
  continuationPrompt,
} from "./prompts.ts";
import {
  assistantTokens,
  buildProgressNote,
  classifyTurnFailure,
  GOAL_ENTRY_TYPE,
  GoalStore,
  isOverBudget,
  remainingTokens,
} from "./store.ts";
import { formatElapsedTime, formatTokenUsage, truncate } from "./format.ts";
import type { FoldedState, GoalEvent, GoalStatus, ThreadGoal } from "./types.ts";

type GoalMessage = ContextEvent["messages"][number];

const GOAL_TRIGGER_TYPE = "pi-goal.trigger";
const GOAL_AWARENESS_TYPE = "pi-goal.awareness";
const TRIGGER_CONTENT = "Goal continuation requested.";
const GOAL_STATUS_KEY = "goal";
const GOAL_WIDGET_KEY = "pi-goal";
const STATE_FILE_FLAG = "goal-state-file";
const MAX_OBJECTIVE_LENGTH = 4000;

type TriggerKind = "continuation" | "budget";

interface Armed {
  readonly id: string;
  readonly kind: TriggerKind;
  readonly goalId: string;
  consumed: boolean;
}

interface Runtime {
  armed: Armed | undefined;
  compacting: boolean;
  inAgentRun: boolean;
  agentGoalId: string | undefined;
  agentGoalWasActive: boolean;
  // Set in session_before_tree when navigating to reopen/edit an earlier
  // prompt, so session_tree does not auto-continue while the user edits history.
  suppressTreeContinuation: boolean;
}

interface TriggerDetails {
  readonly id: string;
  readonly kind: TriggerKind;
  readonly goalId: string;
}

export default function piGoalExtension(pi: ExtensionAPI): void {
  const runtime: Runtime = {
    armed: undefined,
    compacting: false,
    inAgentRun: false,
    agentGoalId: undefined,
    agentGoalWasActive: false,
    suppressTreeContinuation: false,
  };

  const store = new GoalStore(
    (event: GoalEvent) => pi.appendEntry(GOAL_ENTRY_TYPE, event),
    (state) => writeStateFile(pi, state),
  );

  pi.registerFlag(STATE_FILE_FLAG, {
    description: "Write folded goal state as JSON to this path on every change.",
    type: "string",
  });

  pi.registerCommand("goal", {
    description: "Create or manage a persistent session goal",
    handler: (args, ctx) => handleGoalCommand(pi, store, runtime, args, ctx),
  });

  pi.registerTool(createGetGoalTool(store));
  pi.registerTool(createCreateGoalTool(store, runtime));
  pi.registerTool(createUpdateGoalTool(store, runtime));

  // ---- Lifecycle boundaries: fold once, then attempt continuation on resume ----
  const onBoundary = (ctx: ExtensionContext, arm = true): void => {
    runtime.armed = undefined;
    runtime.compacting = false;
    store.refold(ctx.sessionManager.getBranch());
    syncUi(ctx, store);
    if (arm) {
      armContinuation(pi, store, runtime, ctx);
    }
  };

  pi.on("session_start", async (_event, ctx) => onBoundary(ctx));
  pi.on("model_select", async (_event, ctx) => onBoundary(ctx));

  pi.on("session_before_tree", async (event, ctx) => {
    const goal = store.goal;
    const target = ctx.sessionManager.getEntry(event.preparation.targetId);
    runtime.suppressTreeContinuation = goal?.status === "active" && isTreeEditorTarget(target);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const arm = !runtime.suppressTreeContinuation;
    runtime.suppressTreeContinuation = false;
    onBoundary(ctx, arm);
  });

  pi.on("session_shutdown", async () => {
    // No timers to cancel (the loop is timerless), so nothing captures ctx past
    // shutdown. Reset flags defensively.
    runtime.armed = undefined;
    runtime.compacting = false;
    runtime.inAgentRun = false;
  });

  // ---- Compaction: suppress continuation across the compaction window ----
  pi.on("session_before_compact", async () => {
    runtime.compacting = true;
  });
  pi.on("session_compact", async () => {
    runtime.compacting = false;
  });

  // A plain user message does NOT cancel the goal loop: a persistent goal
  // resumes after the user's turn (explicit /goal pause|clear|complete cancel
  // it through the command path). Keeping `armed` set means a follow-up trigger
  // delivered after the user's turn still swaps to a real continuation prompt
  // rather than firing a bare awareness-only turn.

  // ---- Per-turn context injection (awareness + trigger swap) ----
  pi.on("context", async (event) => injectContext(event, store, runtime));

  // ---- Agent/turn lifecycle ----
  pi.on("agent_start", async () => {
    runtime.inAgentRun = true;
    const goal = store.goal;
    runtime.agentGoalId = goal?.goalId;
    runtime.agentGoalWasActive = goal?.status === "active";
  });

  pi.on("turn_end", async (event, ctx) => {
    accountTurn(pi, store, runtime, event.message, event.toolResults ?? []);
    syncUi(ctx, store);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (runtime.armed?.consumed) {
      runtime.armed = undefined;
    }
    runtime.inAgentRun = false;
    runtime.agentGoalId = undefined;
    runtime.agentGoalWasActive = false;

    const goal = store.goal;
    if (goal && goal.status === "active") {
      const failure = classifyTurnFailure(lastAssistant(event.messages));
      if (failure) {
        store.changeStatus(goal.goalId, failure.status, Date.now(), failure.reason);
        runtime.armed = undefined;
        syncUi(ctx, store);
        return;
      }
    }
    if (!runtime.compacting) {
      armContinuation(pi, store, runtime, ctx);
    }
  });
}

// ---------------------------------------------------------------------------
// Context injection
// ---------------------------------------------------------------------------

function injectContext(
  event: ContextEvent,
  store: GoalStore,
  runtime: Runtime,
): { messages: ContextEvent["messages"] } {
  const state = store.folded;
  const goal = state.goal;
  const out: GoalMessage[] = [];
  let injectedPrompt = false;

  for (const message of event.messages) {
    if (message.role === "custom" && message.customType === GOAL_TRIGGER_TYPE) {
      const details = parseTriggerDetails(message.details);
      const armed = runtime.armed;
      if (details && armed && !armed.consumed && details.id === armed.id && goal && goal.goalId === armed.goalId) {
        const matches =
          (armed.kind === "continuation" && goal.status === "active") ||
          (armed.kind === "budget" && goal.status === "budget_limited");
        if (matches) {
          armed.consumed = true;
          out.push({
            ...message,
            content: armed.kind === "budget" ? budgetLimitPrompt(goal) : continuationPrompt(goal, state),
          });
          injectedPrompt = true;
        }
      }
      // Stale or non-matching triggers never reach the model.
      continue;
    }
    out.push(message);
  }

  if (goal && goal.status === "active" && !injectedPrompt) {
    out.push(awarenessMessage(goal, state));
  }
  return { messages: out };
}

function awarenessMessage(goal: ThreadGoal, state: FoldedState): GoalMessage {
  return {
    role: "custom",
    customType: GOAL_AWARENESS_TYPE,
    content: awarenessPrompt(goal, state),
    display: false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Continuation + accounting
// ---------------------------------------------------------------------------

function armContinuation(pi: ExtensionAPI, store: GoalStore, runtime: Runtime, ctx: ExtensionContext): void {
  const goal = store.goal;
  if (!goal || goal.status !== "active" || runtime.armed || runtime.compacting) {
    return;
  }
  if (isOverBudget(goal)) {
    // An active goal already at/over budget (e.g. loaded from persisted or
    // legacy state on resume) must not sit active forever: move it to
    // budget_limited and send the one-time wrap-up, mirroring accountTurn.
    store.changeStatus(goal.goalId, "budget_limited", Date.now(), "token budget reached");
    syncUi(ctx, store);
    armBudgetWrapup(pi, runtime, goal.goalId);
    return;
  }
  const model = ctx.model;
  // Do not gate on ctx.isIdle(): at agent_end the run is ending but not yet
  // marked idle. The trigger is delivered as a followUp with triggerTurn, so
  // the host fires it once the agent actually reaches idle. Still defer to any
  // queued user input.
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model) || ctx.hasPendingMessages()) {
    return;
  }
  const id = randomUUID();
  runtime.armed = { id, kind: "continuation", goalId: goal.goalId, consumed: false };
  sendTrigger(pi, id, "continuation", goal.goalId);
}

function armBudgetWrapup(pi: ExtensionAPI, runtime: Runtime, goalId: string): void {
  const id = randomUUID();
  runtime.armed = { id, kind: "budget", goalId, consumed: false };
  sendTrigger(pi, id, "budget", goalId);
}

function sendTrigger(pi: ExtensionAPI, id: string, kind: TriggerKind, goalId: string): void {
  pi.sendMessage(
    {
      customType: GOAL_TRIGGER_TYPE,
      content: TRIGGER_CONTENT,
      display: false,
      details: { id, kind, goalId } satisfies TriggerDetails,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function accountTurn(
  pi: ExtensionAPI,
  store: GoalStore,
  runtime: Runtime,
  message: AgentEndEvent["messages"][number],
  toolResults: readonly { readonly toolName?: unknown }[],
): void {
  const goal = store.goal;
  if (!goal) {
    return;
  }
  // Attribute usage to the goal that was active when this run started, so a
  // turn cannot charge a goal that was created/replaced mid-run.
  const attributed = runtime.agentGoalId
    ? goal.goalId === runtime.agentGoalId && runtime.agentGoalWasActive
    : goal.status === "active";
  if (!attributed) {
    return;
  }
  const added = assistantTokens(message);
  const { hadProgress, note } = buildProgressNote(toolResults);
  const state = store.account(goal.goalId, added, hadProgress, note, Date.now());
  const updated = state.goal;
  if (updated && updated.status === "active" && isOverBudget(updated)) {
    store.changeStatus(updated.goalId, "budget_limited", Date.now(), "token budget reached");
    armBudgetWrapup(pi, runtime, updated.goalId);
  }
}

// ---------------------------------------------------------------------------
// Command + tools
// ---------------------------------------------------------------------------

async function handleGoalCommand(
  pi: ExtensionAPI,
  store: GoalStore,
  runtime: Runtime,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  const goal = store.goal;

  if (!trimmed) {
    ctx.ui.notify(goal ? goalSummary(goal) : "Usage: /goal <objective>", "info");
    syncUi(ctx, store);
    return;
  }

  const command = trimmed.toLowerCase();
  const now = Date.now();
  const setStatus = (status: GoalStatus): void => {
    if (!goal) {
      ctx.ui.notify("No goal is currently set", "error");
      return;
    }
    if (status === "active") {
      runtime.armed = undefined;
    } else {
      // pause / complete / blocked: abort an in-flight continuation turn so it
      // stops mutating state after the user explicitly stopped the goal.
      cancelContinuation(runtime, ctx);
    }
    store.changeStatus(goal.goalId, status, now);
    ctx.ui.notify(`Goal ${status}: ${truncate(goal.objective, 140)}`, "info");
    syncUi(ctx, store);
    if (status === "active") {
      armContinuation(pi, store, runtime, ctx);
    }
  };

  switch (command) {
    case "clear":
      cancelContinuation(runtime, ctx);
      store.clear(now);
      syncUi(ctx, store);
      ctx.ui.notify(goal ? "Goal cleared" : "No goal is currently set", "info");
      return;
    case "pause":
      setStatus("paused");
      return;
    case "blocked":
      setStatus("blocked");
      return;
    case "complete":
    case "completed":
    case "done":
      setStatus("complete");
      return;
    case "resume":
      setStatus("active");
      return;
    default:
      break;
  }

  const objective = validateObjective(trimmed);
  if (goal && goal.status !== "complete") {
    const confirmed = await ctx.ui.confirm(
      "Replace goal?",
      `Replace the current ${goal.status} goal with: ${objective}`,
    );
    if (!confirmed) {
      ctx.ui.notify("Goal unchanged", "info");
      return;
    }
  }
  cancelContinuation(runtime, ctx);
  store.create(makeGoalSnapshot(objective, null, now));
  ctx.ui.notify(`Goal active: ${truncate(objective, 140)}`, "info");
  syncUi(ctx, store);
  armContinuation(pi, store, runtime, ctx);
}

/**
 * Drop any armed continuation. If a continuation turn is actually running
 * (its trigger was consumed into the live turn), abort that turn too so the
 * agent stops working immediately.
 */
function cancelContinuation(runtime: Runtime, ctx: ExtensionContext): void {
  const wasRunning = runtime.armed?.consumed === true;
  runtime.armed = undefined;
  if (wasRunning && ctx.signal && !ctx.signal.aborted) {
    ctx.abort();
  }
}

function isTreeEditorTarget(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as { readonly type?: unknown; readonly message?: { readonly role?: unknown } };
  return candidate.type === "custom_message" || (candidate.type === "message" && candidate.message?.role === "user");
}

function createGetGoalTool(store: GoalStore) {
  return defineTool({
    name: "get_goal",
    label: "Get Goal",
    description:
      "Get the current session goal, including status, token budget, tokens and elapsed-time used, and remaining budget.",
    parameters: Type.Object({}),
    promptGuidelines: ["Use get_goal to check the current session goal before deciding it is complete."],
    async execute() {
      return goalToolResult(store.goal);
    },
  });
}

function createCreateGoalTool(store: GoalStore, runtime: Runtime) {
  return defineTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a session goal only when explicitly requested by the user or system/developer instructions. Fails if a goal already exists. Do not set a token budget unless the user explicitly requested one.",
    parameters: Type.Object({
      objective: Type.String({ description: "The concrete objective to start pursuing." }),
      token_budget: Type.Optional(
        Type.Integer({ description: "Optional positive token budget. Omit unless the user supplied one." }),
      ),
    }),
    promptGuidelines: [
      "Use create_goal only when the user explicitly asks to start a persistent goal; it fails if one already exists.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (store.goal) {
        return errorToolResult("cannot create a new goal because this session already has a goal");
      }
      const objective = validateObjective(params.objective);
      const tokenBudget = normalizeTokenBudget(params.token_budget);
      const goal = makeGoalSnapshot(objective, tokenBudget, Date.now());
      store.create(goal);
      if (runtime.inAgentRun && !runtime.agentGoalId) {
        runtime.agentGoalId = goal.goalId;
        runtime.agentGoalWasActive = true;
      }
      syncUi(ctx, store);
      return goalToolResult(goal);
    },
  });
}

function createUpdateGoalTool(store: GoalStore, runtime: Runtime) {
  return defineTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the current session goal. Only 'complete' (every requirement proven by current evidence) or 'blocked' (a genuine impasse that has persisted for at least three consecutive goal turns) are accepted. Pause, resume, and clear are user-controlled.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    }),
    promptGuidelines: [
      "Use update_goal with 'complete' only after proving every requirement of the objective against current evidence, and with 'blocked' only after the same blocker has persisted for at least three consecutive goal turns.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goal = store.goal;
      if (!goal) {
        return errorToolResult("cannot update goal because this session has no goal");
      }
      if (goal.status !== "active") {
        return errorToolResult("cannot update goal because the current goal is not active");
      }
      const state = store.changeStatus(goal.goalId, params.status, Date.now());
      runtime.armed = undefined;
      syncUi(ctx, store);
      const updated = state.goal ?? goal;
      const report = params.status === "complete" ? completionBudgetReport(updated) : undefined;
      return goalToolResult(updated, report);
    },
  });
}

// ---------------------------------------------------------------------------
// UI + helpers
// ---------------------------------------------------------------------------

function syncUi(ctx: ExtensionContext, store: GoalStore): void {
  const goal = store.goal;
  if (!goal || goal.status === "complete") {
    ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
    ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined, { placement: "aboveEditor" });
    return;
  }
  ctx.ui.setStatus(GOAL_STATUS_KEY, `${goal.status}: ${truncate(goal.objective, 80)}`);
  ctx.ui.setWidget(
    GOAL_WIDGET_KEY,
    [
      `Goal: ${truncate(goal.objective, 160)}`,
      `Status: ${goal.status}`,
      `Tokens: ${formatTokenUsage(goal)}`,
      `Elapsed: ${formatElapsedTime(goal.timeUsedSeconds)}`,
    ],
    { placement: "aboveEditor" },
  );
}

function writeStateFile(pi: ExtensionAPI, state: FoldedState): void {
  const path = pi.getFlag(STATE_FILE_FLAG);
  if (typeof path !== "string" || path.length === 0) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          version: 1,
          goal: state.goal ?? null,
          noProgressStreak: state.noProgressStreak,
          updatedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Observability is best-effort; never break the session on a write failure.
  }
}

function makeGoalSnapshot(objective: string, tokenBudget: number | null, now: number): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function goalToolResult(goal: ThreadGoal | undefined, report?: string) {
  const normalized = goal ?? null;
  const remaining = goal ? remainingTokens(goal) : null;
  const payload = { goal: normalized, remainingTokens: remaining, ...(report ? { report } : {}) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function errorToolResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
    isError: true,
  };
}

function goalSummary(goal: ThreadGoal): string {
  return `Goal ${goal.status}: ${truncate(goal.objective, 180)} (${formatTokenUsage(goal)}, ${formatElapsedTime(
    goal.timeUsedSeconds,
  )})`;
}

function parseTriggerDetails(details: unknown): TriggerDetails | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const d = details as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.goalId === "string" && (d.kind === "continuation" || d.kind === "budget")
    ? { id: d.id, kind: d.kind, goalId: d.goalId }
    : undefined;
}

function lastAssistant(messages: AgentEndEvent["messages"]): AgentEndEvent["messages"][number] | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function validateObjective(value: string): string {
  const objective = value.trim();
  if (!objective) {
    throw new Error("Goal objective is required");
  }
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    throw new Error(`Goal objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer`);
  }
  return objective;
}

function normalizeTokenBudget(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Goal token budget must be a positive integer");
  }
  return value;
}
