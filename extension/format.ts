// Presentation helpers for goal UI and tool output.

import { remainingTokens } from "./store.ts";
import type { ThreadGoal } from "./types.ts";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return NUMBER_FORMAT.format(Math.max(0, Math.floor(value)));
}

export function formatElapsedTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) {
    return `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${secs}s`;
}

export function formatTokenUsage(goal: ThreadGoal): string {
  const used = `${formatCount(goal.tokensUsed)} used`;
  if (goal.tokenBudget === null) {
    return used;
  }
  const budget = formatCount(goal.tokenBudget);
  const remaining = goal.tokenBudget - goal.tokensUsed;
  if (remaining >= 0) {
    return `${used} (${formatCount(remaining)} remaining of ${budget} budget)`;
  }
  return `${used} (${budget} budget exceeded by ${formatCount(Math.abs(remaining))})`;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function budgetLine(goal: ThreadGoal): string {
  const remaining = remainingTokens(goal);
  return remaining === null ? "unbounded" : String(remaining);
}
