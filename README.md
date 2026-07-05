# pi-goal

Persistent goal mode for [pi](https://github.com/badlogic/pi-mono). Set a long-running objective with `/goal`; pi keeps working on it across idle turns until the model marks the goal complete or blocked.

## Install

```bash
pi install npm:@matthewlam/pi-goal
```

Or from git:

```bash
pi install git:github.com/minghinmatthewlam/pi-goal
```

## Usage

```text
/goal ship the auth refactor and verify it in the running app
/goal pause
/goal resume
/goal complete
/goal clear
```

The extension also exposes model-callable tools:

| Tool | Description |
|------|-------------|
| `get_goal` | Inspect the current goal and usage. |
| `create_goal` | Create a new active goal when the user explicitly asks. |
| `update_goal` | Mark the active goal complete/achieved or blocked. |

## How It Works

`pi-goal` stores goal state in the session, shows active goal status in extension UI, and schedules a hidden continuation message when pi is idle. The continuation prompt is only injected if the active goal still matches, so stale continuations cannot keep working on an old goal after pause, clear, or replacement.

## Headless mode (`pi -p`)

Goal continuation works in print/JSON mode the same way it does interactively: while a goal is active, each agent run that ends with the stop-guards passing schedules another turn, so a single `pi -p "<prompt>"` keeps working until the goal reaches a terminal status. The loop ends only when the goal becomes `complete`, `blocked`, `budget_limited`, or `usage_limited` — or when no goal was ever created.

The same stop-guards apply as interactively (token budget with a one-time wrap-up, non-retryable turn errors, and the three-turn no-progress audit). As a belt-and-suspenders bound, headless runs also enforce a turn cap:

```bash
pi -p --goal-max-turns 50 "<prompt>"   # default 50; headless (print/json) only
```

When the goal has been accounted for at least `--goal-max-turns` turns, the loop stops and marks the goal `blocked` with reason `headless turn cap of N reached`. Interactive and RPC sessions are never capped.

### Exit codes

So an orchestrator can tell "done" from "stopped incomplete" without parsing the transcript, headless runs report:

| Exit code | Meaning |
|-----------|---------|
| `0` | The goal completed, or no goal was used. |
| `4` | The goal loop ended on a non-complete terminal status: `blocked` (including the turn-cap block), `budget_limited`, or `usage_limited`. |
| `1` | A generic pi error / aborted turn (pi's own exit code; unchanged). |

Pair `--goal-max-turns` with `--goal-state-file <path>` to also get the folded goal state (status, tokens, elapsed time) written as JSON on every change.

## License

MIT
