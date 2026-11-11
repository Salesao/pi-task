# pi-task

`pi-task` is a standalone [Pi](https://pi.dev/) package. It registers the `pi_task` tool for asking a person questions in Pi's terminal UI.

Install from npm with `pi install npm:pi-task`, then restart Pi or reload extensions. To try it for one session without changing settings, use `pi -e npm:pi-task`. To work from a checkout instead, use `pi install /absolute/path/to/pi-task` or `pi -e /absolute/path/to/pi-task/extensions/index.js`. For an isolated installation, set `PI_CODING_AGENT_DIR` to a fresh directory on every command.

Call `pi_task` with `questions`, an array of 1–4 objects. Each object has a `question`, a `header` of at most 12 characters, an optional `context` of at most 600 characters, and 2–4 `options`. Each option has a unique `label` and an optional `description`.

```json
{"questions":[{"header":"Layout","question":"Which layout should we use?","options":[{"label":"Grid","description":"Compare items side by side."},{"label":"List","description":"Read item details in order."}]}]}
```

Use the arrow keys and Enter to select an option. Select **Type something.** to enter your own answer. A single answer submits immediately. For multiple questions, use the tabs and choose **Submit** when all are answered. Esc leaves the editor first and cancels the window from the question view.

`details` and `structuredContent` contain the same result. `content` contains its readable text. `submitted` includes an ordered `answers` array of `{header, kind, label}`. `kind` is `option` or `text`. `cancelled`, `aborted`, `no-ui`, and `invalid` all return an empty `answers` array. The caller interprets the answer and decides whether it constitutes approval.

An older orca-pod setup extension may still register `orca_pod_ask`. Both tools can coexist. Package and unit checks use `npm test`; the independent JavaScript tests require Node 18 or later.

See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for licensing.

Verified with Pi 1.4.0 in an isolated agent directory. The terminal smoke covered option selection, free text, cancellation, and coexistence with the older setup extension.
