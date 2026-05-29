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
/goal clear
```

The extension also exposes model-callable tools:

| Tool | Description |
|------|-------------|
| `get_goal` | Inspect the current goal and usage. |
| `create_goal` | Create a new active goal when the user explicitly asks. |
| `update_goal` | Mark the active goal complete or blocked. |

## How It Works

`pi-goal` stores goal state in the session, shows active goal status in extension UI, and schedules a hidden continuation message when pi is idle. The continuation prompt is only injected if the active goal still matches, so stale continuations cannot keep working on an old goal after pause, clear, or replacement.

## License

MIT
