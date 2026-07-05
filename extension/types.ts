// Shared goal types for the event-sourced pi-goal extension.
//
// Storage is append-only: every state change is one custom session entry
// (a `GoalEvent`). Current state is the fold over the current branch's events.
// See store.ts for the reducer.

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

/** A goal marked terminal never auto-continues again. */
export const TERMINAL_STATUSES: readonly GoalStatus[] = [
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
];

export interface ThreadGoal {
  readonly goalId: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One entry in the progress ledger, produced by per-turn accounting. */
export interface ProgressNote {
  readonly at: number;
  readonly hadProgress: boolean;
  readonly note: string;
  readonly addedTokens: number;
}

/**
 * Event-sourced state changes. Each is persisted as one `pi.appendEntry`
 * custom entry and replayed by the fold. `v` is the schema version.
 */
export type GoalEvent =
  | { readonly v: 1; readonly event: "goal_created"; readonly goal: ThreadGoal }
  | {
      readonly v: 1;
      readonly event: "status_changed";
      readonly goalId: string;
      readonly status: GoalStatus;
      readonly at: number;
      readonly reason?: string;
    }
  | {
      readonly v: 1;
      readonly event: "turn_accounted";
      readonly goalId: string;
      readonly addedTokens: number;
      readonly hadProgress: boolean;
      readonly note: string;
      readonly at: number;
    }
  | { readonly v: 1; readonly event: "goal_cleared"; readonly at: number };

/** The folded state derived from replaying `GoalEvent`s on the current branch. */
export interface FoldedState {
  readonly goal: ThreadGoal | undefined;
  /** Progress ledger for the current goal (empty when no goal). */
  readonly progress: readonly ProgressNote[];
  /** Consecutive accounted goal turns with no real tool progress. */
  readonly noProgressStreak: number;
}

export const EMPTY_STATE: FoldedState = Object.freeze({
  goal: undefined,
  progress: Object.freeze([]),
  noProgressStreak: 0,
});
