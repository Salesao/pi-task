import assert from "node:assert/strict";
import { test } from "node:test";
import { askResultText, createAskComponent, normalizeAskParams } from "../src/ask.js";
import { normalizeTaskResult } from "../src/result.js";

// src/ask.js is the pi_task question window without Pi imports: index.js passes in
// the pi-tui kit. Here a fake kit stands in for it, so the keys, answers and abort handling run under node:test.

class FakeEditor {
  constructor() { this.text = ""; this.onSubmit = undefined; }
  setText(text) { this.text = text; }
  getText() { return this.text; }
  handleInput(data) {
    if (data === "enter") this.onSubmit?.(this.text);
    else if (data === "clear") this.text = "";
    else this.text += data;
  }
  render() { return [`| ${this.text}`]; }
  invalidate() {}
}

const kit = {
  Editor: FakeEditor,
  Key: { enter: "enter", escape: "escape", tab: "tab", space: "space", up: "up", down: "down", left: "left", right: "right", shift: (key) => `shift+${key}` },
  matchesKey: (data, key) => data === key,
  visibleWidth: (text) => text.length,
  // Cuts at the width, so the lines depend on it (a cache that ignores the width shows stale lines).
  wrapTextWithAnsi: (text, width) => text.match(new RegExp(`.{1,${Math.max(1, width)}}`, "g")) ?? [""],
};
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

const ROLLBACK = {
  question: "What should happen to the database if the update fails?",
  header: "3 Rollback",
  options: [
    { label: "Restore the copy (proposed)", description: "The server comes back; seconds of writes are lost" },
    { label: "Leave the database", description: "Nothing is lost; the old program may not start" },
  ],
};
const MAP = {
  question: "Keep the order of work?",
  header: "1 Map",
  options: [
    { label: "Keep", description: "Tasks 1-6 in order" },
    { label: "Change (I'll say how)", description: "Another order" },
  ],
};

/** A component over the given questions; `calls` collects every done(...) result. */
function open(questions, signal) {
  const calls = [];
  const tui = { renders: 0, requestRender() { this.renders++; } };
  const component = createAskComponent({ questions, tui, theme, kit, signal, done: (result) => calls.push(result) });
  const press = (...keys) => { for (const key of keys) component.handleInput(key); };
  return { component, calls, press };
}

const option = (n) => ({ label: `Option ${n}`, description: "" });
const question = (overrides = {}) => ({ question: "Q?", header: "H", options: [option(1), option(2)], ...overrides });

test("normalizeAskParams: 1-4 questions, 2-4 options, a header of up to 12 characters, unique labels", () => {
  const cases = [
    [{ questions: [1, 2, 3, 4, 5].map(() => question()) }, /1-4/],
    [{ questions: [] }, /1-4/],
    [{ questions: [question({ options: [option(1)] })] }, /2-4/],
    [{ questions: [question({ options: [1, 2, 3, 4, 5].map(option) })] }, /2-4/],
    [{ questions: [question({ header: "1234567890123" })] }, /12/],
    [{ questions: [question({ options: [option(1), option(1)] })] }, /duplicate/],
  ];
  for (const [params, limit] of cases) {
    const result = normalizeAskParams(params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.match(result.error, limit);
  }
  const ok = normalizeAskParams({ questions: [question({ header: " 3 Rollback ", options: [{ label: " Keep " }, option(2)] })] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.questions, [{ question: "Q?", header: "3 Rollback", context: "", multiSelect: false, options: [{ label: "Keep", description: "" }, option(2)] }]);
});

test("one question: the first answer submits it", () => {
  const { calls, press } = open([ROLLBACK]);
  press("down", "enter");
  assert.deepEqual(calls, [{ answers: [{ header: "3 Rollback", kind: "option", label: "Leave the database" }], cancelled: false }]);
});

test("two questions: Submit waits for every answer, then returns them in question order", () => {
  const { calls, press } = open([MAP, ROLLBACK]);
  press("tab", "enter"); // answers 3 Rollback, moves to Submit
  press("enter");
  assert.deepEqual(calls, [], "Submit with 1 Map unanswered does nothing");
  press("tab", "enter"); // back to 1 Map (wraps), answers it, moves to 3 Rollback
  press("tab", "enter");
  assert.deepEqual(calls, [{
    answers: [
      { header: "1 Map", kind: "option", label: "Keep" },
      { header: "3 Rollback", kind: "option", label: "Restore the copy (proposed)" },
    ],
    cancelled: false,
  }]);
});

test("Type something.: an empty answer is not recorded and the editor stays open; text is returned as written", () => {
  const { component, calls, press } = open([ROLLBACK]);
  press("down", "down", "enter"); // the third row is "Type something."
  press("enter");
  assert.deepEqual(calls, []);
  assert.ok(component.render(80).some((line) => line.includes("Your answer:")), "the editor is still open");
  press("keep the old db", "enter");
  assert.deepEqual(calls, [{ answers: [{ header: "3 Rollback", kind: "text", label: "keep the old db" }], cancelled: false }]);
});

test("Esc cancels the window", () => {
  const { calls, press } = open([MAP, ROLLBACK]);
  press("enter", "escape");
  assert.deepEqual(calls, [{ answers: [], cancelled: true }]);
});

test("an abort closes the window once, also when the signal was aborted before it opened", () => {
  const later = new AbortController();
  const first = open([ROLLBACK], later.signal);
  later.abort();
  first.press("enter");
  assert.deepEqual(first.calls, [{ answers: [], cancelled: true, reason: "aborted" }]);

  const before = new AbortController();
  before.abort();
  const second = open([ROLLBACK], before.signal);
  second.press("enter");
  assert.deepEqual(second.calls, [{ answers: [], cancelled: true, reason: "aborted" }]);
});

test("render shows the tabs, the options with descriptions, Type something. and Submit; the cache follows the width", () => {
  const { component } = open([MAP, ROLLBACK]);
  const text = component.render(200).join("\n");
  for (const needle of ["1 Map", "3 Rollback", "Keep the order of work?", "Keep", "Tasks 1-6 in order", "Change (I'll say how)", "Type something.", "Submit"]) {
    assert.ok(text.includes(needle), needle);
  }
  const narrow = component.render(20);
  const wide = component.render(80);
  assert.notDeepEqual(wide, narrow);
  assert.ok(narrow.every((line) => line.length <= 20), "narrow lines fit 20 columns");
});

test("askResultText: answers, Esc, interruption, no UI and invalid questions", () => {
  assert.equal(askResultText({ answers: [
    { header: "1 Map", kind: "option", label: "Keep" },
    { header: "3 Rollback", kind: "text", label: "keep the old db" },
  ] }), '1 Map: selected "Keep"\n3 Rollback: wrote "keep the old db"');
  assert.equal(askResultText({ answers: [], cancelled: true }),
    "The user cancelled the questions (Esc); nothing was answered.");
  assert.equal(askResultText({ answers: [], cancelled: true, reason: "aborted" }),
    "The questions were interrupted before an answer.");
  assert.equal(askResultText({ reason: "no-ui", mode: "print" }),
    "No interactive terminal UI (mode print). Ask the same questions as numbered text instead.");
  assert.equal(askResultText({ reason: "invalid", error: "5 questions (1-4 allowed)" }),
    "Invalid questions: 5 questions (1-4 allowed). Limits: 1-4 questions, a header of up to 12 characters, a context of up to 600 characters, 2-4 options each; shorten the context or split the questions into several calls.");
});

// Revision 2: the card (situation, proposal, cost) goes inside the window as `context`, above the question.
const CARD = "Situation: a failed update leaves the server down.\nProposal: restore the database copy.\nCost: seconds of writes are lost.";

test("normalizeAskParams: context is trimmed, \"\" when absent, and capped at 600 characters", () => {
  const kept = normalizeAskParams({ questions: [question({ context: `  ${CARD}  ` })] });
  assert.equal(kept.ok, true);
  assert.equal(kept.questions[0].context, CARD);
  assert.equal(normalizeAskParams({ questions: [question()] }).questions[0].context, "");
  const long = normalizeAskParams({ questions: [question({ context: "x".repeat(601) })] });
  assert.equal(long.ok, false);
  assert.match(long.error, /context is 601 characters \(up to 600\)/);
  assert.equal(normalizeAskParams({ questions: [question({ context: "x".repeat(600) })] }).ok, true);
});

test("render: the context sits between the tab bar and the question, line by line", () => {
  const { component } = open([{ ...ROLLBACK, context: CARD }, MAP]);
  const lines = component.render(80);
  const tabs = lines.findIndex((line) => line.includes("3 Rollback"));
  const situation = lines.findIndex((line) => line.includes("Situation: a failed update leaves the server down."));
  const cost = lines.findIndex((line) => line.includes("Cost: seconds of writes are lost."));
  const stem = lines.findIndex((line) => line.includes(ROLLBACK.question));
  assert.ok(tabs >= 0 && tabs < situation && situation < cost && cost < stem, JSON.stringify(lines));
});

test("render: a narrow window wraps the context within the width", () => {
  const { component } = open([{ ...ROLLBACK, context: CARD }]);
  const lines = component.render(20);
  assert.ok(lines.every((line) => line.length <= 20), JSON.stringify(lines));
  assert.ok(lines.join("").includes("Situation"), "the context is shown");
});

test("render: a question without context looks exactly as before", () => {
  const { component } = open([MAP, ROLLBACK]);
  const rule = "─".repeat(200);
  assert.deepEqual(component.render(200), [
    rule, " ←  □ 1 Map   □ 3 Rollback   ✓ Submit  →", "", " Keep the order of work?", "",
    "> 1. Keep", "     Tasks 1-6 in order", "  2. Change (I'll say how)", "     Another order", "  3. Type something.", "",
    " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel", rule,
  ]);
});


test("duplicate headers keep ordered answers; partial answers are discarded on Esc or abort", () => {
  const questions = [MAP, { ...ROLLBACK, header: MAP.header }];
  const submitted = open(questions);
  submitted.press("enter", "down", "enter", "enter", "enter");
  assert.deepEqual(submitted.calls[0].answers.map(({ label }) => label), [MAP.options[0].label, ROLLBACK.options[1].label]);
  assert.equal(submitted.calls.length, 1);
  const escaped = open(questions);
  escaped.press("enter", "escape", "enter");
  assert.deepEqual(escaped.calls, [{ answers: [], cancelled: true }]);
  const controller = new AbortController();
  const aborted = open(questions, controller.signal);
  aborted.press("enter", "down", "down", "enter", "draft");
  controller.abort();
  controller.abort();
  aborted.press("enter");
  assert.deepEqual(aborted.calls, [{ answers: [], cancelled: true, reason: "aborted" }]);
});

test("accepts exact question, option, header and context limits", () => {
  const largest = question({ header: "h".repeat(12), context: "c".repeat(600), options: [1, 2, 3, 4].map(option) });
  assert.equal(normalizeAskParams({ questions: [largest] }).ok, true);
  assert.equal(normalizeAskParams({ questions: Array(4).fill(largest) }).ok, true);
});

// Revision 3: multiSelect, as in Claude Code's AskUserQuestion. Rows of a two-option question:
// 0 and 1 are the options, 2 is "Type something.", 3 is the Submit row (Next when there are several questions).
const TAGS = {
  question: "Which platforms should it support?",
  header: "Platforms",
  multiSelect: true,
  options: [
    { label: "macOS", description: "Apple silicon and Intel" },
    { label: "Linux", description: "glibc and musl" },
  ],
};

test("normalizeAskParams: multiSelect is false when absent, true when set, and must be a boolean", () => {
  assert.equal(normalizeAskParams({ questions: [question()] }).questions[0].multiSelect, false);
  assert.equal(normalizeAskParams({ questions: [question({ multiSelect: true })] }).questions[0].multiSelect, true);
  const bad = normalizeAskParams({ questions: [question(), question({ multiSelect: "true" })] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /question 2: multiSelect must be true or false/);
});

test("multiSelect: Space and Enter toggle checkboxes, Enter on Submit sends every checked option in option order", () => {
  const { calls, press } = open([TAGS]);
  press("down", "space"); // Linux
  press("up", "enter"); // macOS, toggled by Enter
  assert.deepEqual(calls, [], "toggling never submits");
  press("down", "down", "down", "enter");
  assert.deepEqual(calls, [{
    answers: [{ header: "Platforms", kind: "multi", label: "macOS, Linux", selections: [{ kind: "option", label: "macOS" }, { kind: "option", label: "Linux" }] }],
    cancelled: false,
  }]);
});

test("multiSelect: a second press unchecks, and Submit with nothing checked warns and does not submit", () => {
  const { component, calls, press } = open([TAGS]);
  press("space", "space", "down", "down", "down", "enter");
  assert.deepEqual(calls, []);
  assert.ok(component.render(80).some((line) => line.includes("Select at least one option")));
  press("up", "space"); // any key clears the warning
  assert.ok(!component.render(80).some((line) => line.includes("Select at least one option")));
  press("space"); // Space on the Submit row does nothing
  assert.deepEqual(calls, []);
});

test("multiSelect: Type something. adds a typed answer next to the checked options; Enter edits it, Space or an empty save clears it", () => {
  const { component, calls, press } = open([TAGS]);
  press("down", "down", "enter", "Windows", "enter"); // opens the editor, types, saves
  const text = component.render(80).join("\n");
  assert.ok(text.includes("[✓] Type something.") && text.includes("Windows"), text);
  press("enter", " too", "enter"); // reopens with "Windows" in the editor
  assert.ok(component.render(80).join("\n").includes("Windows too"));
  press("space"); // clears the typed answer
  assert.ok(component.render(80).join("\n").includes("[ ] Type something."));
  press("enter", "later", "enter", "enter", "clear", "enter"); // type again, reopen, erase it and save the empty text
  assert.ok(component.render(80).join("\n").includes("[ ] Type something."));
  press("enter", "Windows", "enter", "up", "up", "space", "down", "down", "down", "enter");
  assert.deepEqual(calls, [{
    answers: [{ header: "Platforms", kind: "multi", label: "macOS, Windows", selections: [{ kind: "option", label: "macOS" }, { kind: "text", label: "Windows" }] }],
    cancelled: false,
  }]);
});

test("multiSelect: Esc in the editor keeps the previous typed answer", () => {
  const { component, press } = open([TAGS]);
  press("down", "down", "enter", "Windows", "enter", "enter", " draft", "escape");
  assert.ok(component.render(80).join("\n").includes("[✓] Type something."));
  assert.ok(!component.render(80).join("\n").includes("draft"));
});

test("multiSelect in a tabbed window: Next moves on, Submit waits for every question, answers keep question order", () => {
  const { component, calls, press } = open([TAGS, MAP]);
  press("space", "down", "down", "down", "enter"); // checks macOS, Next moves to 1 Map
  press("enter"); // answers 1 Map, moves to Submit
  const review = component.render(80).join("\n");
  assert.ok(review.includes("Platforms: macOS") && review.includes("1 Map: Keep"), review);
  press("shift+tab", "shift+tab", "down", "space"); // back to Platforms, adds Linux after leaving it
  press("tab", "tab", "enter");
  assert.deepEqual(calls, [{
    answers: [
      { header: "Platforms", kind: "multi", label: "macOS, Linux", selections: [{ kind: "option", label: "macOS" }, { kind: "option", label: "Linux" }] },
      { header: "1 Map", kind: "option", label: "Keep" },
    ],
    cancelled: false,
  }]);
});

test("multiSelect in a tabbed window: an unchecked question stays unanswered and blocks Submit", () => {
  const { component, calls, press } = open([TAGS, MAP]);
  press("tab", "enter", "enter"); // answers 1 Map, then Submit with Platforms empty
  assert.deepEqual(calls, []);
  assert.ok(component.render(80).join("\n").includes("Unanswered: Platforms"));
});

test("multiSelect render: checkboxes, the typed answer, the Submit row and the toggle help line", () => {
  const { component, press } = open([TAGS]);
  const rule = "─".repeat(200);
  assert.deepEqual(component.render(200), [
    rule, " Which platforms should it support?", "",
    "> 1. [ ] macOS", "     Apple silicon and Intel", "  2. [ ] Linux", "     glibc and musl", "  3. [ ] Type something.", "",
    "  ✓ Submit", "", " ↑↓ move • Space/Enter toggle • Esc cancel", rule,
  ]);
  press("space");
  assert.ok(component.render(200).includes("> 1. [✓] macOS"));
  const tabbed = open([TAGS, MAP]).component.render(200);
  assert.ok(tabbed.includes("  ✓ Next"));
  assert.ok(tabbed.includes(" Tab/←→ navigate • ↑↓ move • Space/Enter toggle • Esc cancel"));
});

test("multiSelect: Esc cancels and discards the checked options", () => {
  const { calls, press } = open([TAGS]);
  press("space", "escape", "enter");
  assert.deepEqual(calls, [{ answers: [], cancelled: true }]);
});

test("askResultText: a multi-select answer lists the selected options and the typed answer", () => {
  const selections = [{ kind: "option", label: "macOS" }, { kind: "option", label: "Linux" }, { kind: "text", label: "Windows, maybe" }];
  assert.equal(askResultText({ answers: [
    { header: "Platforms", kind: "multi", label: "macOS, Linux, Windows, maybe", selections },
    { header: "1 Map", kind: "option", label: "Keep" },
  ] }), 'Platforms: selected "macOS", "Linux"; wrote "Windows, maybe"\n1 Map: selected "Keep"');
  assert.equal(askResultText({ answers: [{ header: "P", kind: "multi", label: "macOS", selections: selections.slice(0, 1) }] }), 'P: selected "macOS"');
});

test("normalizeTaskResult: a multi answer keeps its selections; a malformed one is not submitted", () => {
  const good = { header: "P", kind: "multi", label: "A, B", selections: [{ kind: "option", label: "A" }, { kind: "text", label: "B", extra: 1 }] };
  assert.deepEqual(normalizeTaskResult({ answers: [good], cancelled: false }), {
    status: "submitted",
    answers: [{ header: "P", kind: "multi", label: "A, B", selections: [{ kind: "option", label: "A" }, { kind: "text", label: "B" }] }],
  });
  for (const selections of [undefined, [], [{ kind: "multi", label: "A" }], [{ kind: "option", label: " " }]]) {
    assert.deepEqual(normalizeTaskResult({ answers: [{ ...good, selections }], cancelled: false }), { status: "aborted", answers: [] });
  }
});
