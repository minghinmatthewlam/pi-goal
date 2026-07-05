// Event-sourced goal store: pure fold + a write-through in-memory cache.
//
// The fold walks the CURRENT branch only (SessionManager.getBranch returns the
// leaf's parent chain in root->leaf order), so events on abandoned /tree
// branches never count. The cache is folded once per lifecycle boundary and
// updated in place as this extension appends its own events, so per-turn reads
// never re-scan the branch.

import {
  EMPTY_STATE,
  TERMINAL_STATUSES,
  type FoldedState,
  type GoalEvent,
  type GoalStatus,
  type ThreadGoal,
} from "./types.ts";

export const GOAL_ENTRY_TYPE = "pi-goal.event";
// v1 wrote goal snapshots under these custom types. We read them so upgrading
// does not drop an active goal from an existing session; v2 only ever writes
// GOAL_ENTRY_TYPE going forward.
const LEGACY_GOAL_ENTRY_TYPES: readonly string[] = ["pi-goal.goal", "pi-gui.goal"];

const VALID_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
];

/** Minimal structural view of a session entry (avoids host type coupling). */
export interface BranchEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/** Minimal structural view of an assistant message for accounting/stop-guards. */
export interface AssistantLike {
  readonly role?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly usage?: { readonly totalTokens?: unknown } | undefined;
}

export interface ToolResultLike {
  readonly toolName?: unknown;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeStatus(value: unknown): GoalStatus | undefined {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value)
    ? (value as GoalStatus)
    : undefined;
}

function toFiniteInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** Coerce a persisted goal snapshot into a well-formed ThreadGoal. */
export function normalizeGoal(raw: ThreadGoal): ThreadGoal {
  const createdAt = toFiniteInt(raw.createdAt, Date.now());
  return {
    goalId: String(raw.goalId),
    objective: String(raw.objective),
    // An unrecognized status is inert (paused), never silently active.
    status: normalizeStatus(raw.status) ?? "paused",
    tokenBudget:
      raw.tokenBudget === null || raw.tokenBudget === undefined
        ? null
        : Math.max(1, toFiniteInt(raw.tokenBudget, 1)),
    tokensUsed: Math.max(0, toFiniteInt(raw.tokensUsed, 0)),
    timeUsedSeconds: Math.max(0, toFiniteInt(raw.timeUsedSeconds, 0)),
    createdAt,
    updatedAt: toFiniteInt(raw.updatedAt, createdAt),
  };
}

/** Parse a persisted custom-entry payload into a typed GoalEvent. */
export function parseGoalEvent(data: unknown): GoalEvent | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || typeof d.event !== "string") {
    return undefined;
  }
  switch (d.event) {
    case "goal_created":
      return d.goal && typeof d.goal === "object"
        ? { v: 1, event: "goal_created", goal: normalizeGoal(d.goal as ThreadGoal) }
        : undefined;
    case "status_changed": {
      const status = normalizeStatus(d.status);
      return typeof d.goalId === "string" && status
        ? {
            v: 1,
            event: "status_changed",
            goalId: d.goalId,
            status,
            at: toFiniteInt(d.at, Date.now()),
            ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
          }
        : undefined;
    }
    case "turn_accounted":
      return typeof d.goalId === "string"
        ? {
            v: 1,
            event: "turn_accounted",
            goalId: d.goalId,
            addedTokens: Math.max(0, toFiniteInt(d.addedTokens, 0)),
            hadProgress: Boolean(d.hadProgress),
            note: typeof d.note === "string" ? d.note : "",
            at: toFiniteInt(d.at, Date.now()),
          }
        : undefined;
    case "goal_cleared":
      return { v: 1, event: "goal_cleared", at: toFiniteInt(d.at, Date.now()) };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

function withElapsed(goal: ThreadGoal, at: number): number {
  return Math.max(goal.timeUsedSeconds, Math.floor((at - goal.createdAt) / 1000));
}

/** Apply a single event to the folded state (shared by fold + write-through). */
export function applyEvent(state: FoldedState, ev: GoalEvent): FoldedState {
  switch (ev.event) {
    case "goal_created":
      return { goal: ev.goal, progress: [], noProgressStreak: 0 };
    case "goal_cleared":
      return EMPTY_STATE;
    case "status_changed":
      if (!state.goal || state.goal.goalId !== ev.goalId) {
        return state;
      }
      return {
        ...state,
        goal: {
          ...state.goal,
          status: ev.status,
          updatedAt: ev.at,
          timeUsedSeconds: withElapsed(state.goal, ev.at),
        },
      };
    case "turn_accounted": {
      if (!state.goal || state.goal.goalId !== ev.goalId) {
        return state;
      }
      const goal: ThreadGoal = {
        ...state.goal,
        tokensUsed: state.goal.tokensUsed + Math.max(0, ev.addedTokens),
        timeUsedSeconds: withElapsed(state.goal, ev.at),
        updatedAt: ev.at,
      };
      return {
        goal,
        progress: [
          ...state.progress,
          { at: ev.at, hadProgress: ev.hadProgress, note: ev.note, addedTokens: ev.addedTokens },
        ],
        noProgressStreak: ev.hadProgress ? 0 : state.noProgressStreak + 1,
      };
    }
    default:
      return state;
  }
}

/**
 * Apply a legacy v1 goal entry. v1 appended a full goal snapshot on every
 * change (`set`) and a `clear` to drop it, so replaying "last set wins / clear
 * resets" reconstructs the current goal. Progress ledger detail is not
 * recoverable from v1 and starts fresh.
 */
function applyLegacyEntry(state: FoldedState, data: unknown): FoldedState {
  if (!data || typeof data !== "object") {
    return state;
  }
  const d = data as Record<string, unknown>;
  if (d.event === "clear") {
    return EMPTY_STATE;
  }
  if (d.event === "set" && d.goal && typeof d.goal === "object") {
    return { goal: normalizeGoal(d.goal as ThreadGoal), progress: [], noProgressStreak: 0 };
  }
  return state;
}

/** Fold the current branch into goal state. Only pi-goal events participate. */
export function foldBranch(entries: Iterable<BranchEntry>): FoldedState {
  let state = EMPTY_STATE;
  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }
    if (entry.customType === GOAL_ENTRY_TYPE) {
      const ev = parseGoalEvent(entry.data);
      if (ev) {
        state = applyEvent(state, ev);
      }
    } else if (entry.customType && LEGACY_GOAL_ENTRY_TYPES.includes(entry.customType)) {
      state = applyLegacyEntry(state, entry.data);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Stop-guard helpers (pure)
// ---------------------------------------------------------------------------

/** Number of consecutive no-progress goal turns that forces a justify-or-block. */
export const BLOCKED_AUDIT_THRESHOLD = 3;

const USAGE_LIMIT_PATTERN =
  /rate.?limit|usage.?limit|quota|resource[_ ]exhausted|insufficient_quota|too many requests|overloaded|\b429\b/i;

export function isTerminal(status: GoalStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isOverBudget(goal: ThreadGoal): boolean {
  return goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
}

export function remainingTokens(goal: ThreadGoal): number | null {
  return goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

/** True once the blocked-audit threshold of no-progress turns is reached. */
export function blockedAuditTriggered(state: FoldedState): boolean {
  return state.noProgressStreak >= BLOCKED_AUDIT_THRESHOLD;
}

function isAssistant(message: unknown): message is AssistantLike {
  return Boolean(message) && typeof message === "object" && (message as AssistantLike).role === "assistant";
}

/**
 * Classify a terminal turn failure from an assistant message's stop reason.
 * Returns the goal status to move to, or undefined when the turn is fine.
 * `aborted` is intentionally ignored (user/system interruption, resumable).
 */
export function classifyTurnFailure(
  message: unknown,
): { readonly status: GoalStatus; readonly reason: string } | undefined {
  if (!isAssistant(message) || message.stopReason !== "error") {
    return undefined;
  }
  const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (USAGE_LIMIT_PATTERN.test(text)) {
    return { status: "usage_limited", reason: truncateReason(text) || "usage limit reached" };
  }
  return { status: "blocked", reason: truncateReason(text) || "non-retryable turn error" };
}

function truncateReason(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

export function assistantTokens(message: unknown): number {
  if (!isAssistant(message)) {
    return 0;
  }
  const total = message.usage?.totalTokens;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
}

const NON_PROGRESS_TOOLS = new Set(["get_goal", "update_goal", "create_goal"]);

/** Derive a progress-ledger note from a turn's tool results. */
export function buildProgressNote(toolResults: readonly ToolResultLike[]): {
  readonly hadProgress: boolean;
  readonly note: string;
} {
  const names: string[] = [];
  for (const result of toolResults) {
    if (typeof result.toolName === "string" && !NON_PROGRESS_TOOLS.has(result.toolName)) {
      names.push(result.toolName);
    }
  }
  if (names.length === 0) {
    return { hadProgress: false, note: "no tool progress" };
  }
  const unique = [...new Set(names)];
  return { hadProgress: true, note: `ran ${unique.slice(0, 8).join(", ")}` };
}

// ---------------------------------------------------------------------------
// Write-through cache
// ---------------------------------------------------------------------------

export type AppendGoalEvent = (data: GoalEvent) => void;
export type StateListener = (state: FoldedState) => void;

/**
 * Owns the folded state. Fold once per lifecycle boundary via `refold`, then
 * mutate through `create`/`changeStatus`/`account`/`clear`, which both persist
 * an event (append) and update the cache in place. This extension is the only
 * writer of its events, so the cache never drifts from the branch between
 * boundaries.
 */
export class GoalStore {
  private state: FoldedState = EMPTY_STATE;

  constructor(
    private readonly append: AppendGoalEvent,
    private readonly onChange?: StateListener,
  ) {}

  get folded(): FoldedState {
    return this.state;
  }

  get goal(): ThreadGoal | undefined {
    return this.state.goal;
  }

  /** Rebuild the cache from the current branch (a lifecycle boundary). */
  refold(entries: Iterable<BranchEntry>): FoldedState {
    this.state = foldBranch(entries);
    this.onChange?.(this.state);
    return this.state;
  }

  private commit(ev: GoalEvent): FoldedState {
    this.append(ev);
    this.state = applyEvent(this.state, ev);
    this.onChange?.(this.state);
    return this.state;
  }

  create(goal: ThreadGoal): FoldedState {
    return this.commit({ v: 1, event: "goal_created", goal });
  }

  changeStatus(goalId: string, status: GoalStatus, at: number, reason?: string): FoldedState {
    return this.commit({
      v: 1,
      event: "status_changed",
      goalId,
      status,
      at,
      ...(reason ? { reason } : {}),
    });
  }

  account(
    goalId: string,
    addedTokens: number,
    hadProgress: boolean,
    note: string,
    at: number,
  ): FoldedState {
    return this.commit({ v: 1, event: "turn_accounted", goalId, addedTokens, hadProgress, note, at });
  }

  clear(at: number): FoldedState {
    return this.commit({ v: 1, event: "goal_cleared", at });
  }
}
