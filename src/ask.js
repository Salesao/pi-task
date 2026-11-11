// The Pi question window: tabs per question, options with
// descriptions, a free "Type something." answer, Submit, Esc. A port of Pi's examples/extensions/questionnaire.ts
// plus multi-select, modelled on Claude Code's AskUserQuestion: a question with `multiSelect: true` shows
// checkboxes (Space/Enter toggles) and a Next/Submit row instead of answering on the first Enter.
// Nothing here imports Pi packages: index.js passes in the pi-tui kit
// ({ Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi }), so the logic is testable under node:test.

export const ASK_LIMITS = { questions: 4, minOptions: 2, options: 4, header: 12, context: 600 };
const OTHER_LABEL = 'Type something.';
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** Checks and trims the tool parameters: { ok: true, questions } or { ok: false, error }. */
export function normalizeAskParams(params) {
  const raw = Array.isArray(params?.questions) ? params.questions : [];
  if (raw.length < 1 || raw.length > ASK_LIMITS.questions) {
    return { ok: false, error: `${raw.length} questions (1-${ASK_LIMITS.questions} allowed)` };
  }
  const questions = [];
  for (const [index, item] of raw.entries()) {
    const where = `question ${index + 1}`;
    const question = text(item?.question);
    const header = text(item?.header);
    // Optional context is displayed above the question.
    const context = text(item?.context);
    const options = Array.isArray(item?.options) ? item.options : [];
    const multiSelect = item?.multiSelect ?? false;
    if (typeof multiSelect !== 'boolean') return { ok: false, error: `${where}: multiSelect must be true or false` };
    if (!question) return { ok: false, error: `${where}: empty question text` };
    if (!header) return { ok: false, error: `${where}: empty header` };
    if (header.length > ASK_LIMITS.header) {
      return { ok: false, error: `${where}: header "${header}" is ${header.length} characters (up to ${ASK_LIMITS.header})` };
    }
    if (context.length > ASK_LIMITS.context) {
      return { ok: false, error: `${where}: context is ${context.length} characters (up to ${ASK_LIMITS.context})` };
    }
    if (options.length < ASK_LIMITS.minOptions || options.length > ASK_LIMITS.options) {
      return { ok: false, error: `${where}: ${options.length} options (${ASK_LIMITS.minOptions}-${ASK_LIMITS.options} allowed)` };
    }
    const normalized = options.map((option) => ({ label: text(option?.label), description: text(option?.description) }));
    const labels = new Set();
    for (const { label } of normalized) {
      if (!label) return { ok: false, error: `${where}: an option without a label` };
      if (labels.has(label)) return { ok: false, error: `${where}: duplicate option "${label}"` };
      labels.add(label);
    }
    questions.push({ question, header, context, multiSelect, options: normalized });
  }
  return { ok: true, questions };
}

/** The text the agent gets back from the tool. */
export function askResultText({ answers = [], cancelled = false, reason, status = reason, mode, error } = {}) {
  if (status === 'invalid') {
    return `Invalid questions: ${error}. Limits: 1-${ASK_LIMITS.questions} questions, a header of up to ${ASK_LIMITS.header} characters, `
      + `a context of up to ${ASK_LIMITS.context} characters, ${ASK_LIMITS.minOptions}-${ASK_LIMITS.options} options each; shorten the context or split the questions into several calls.`;
  }
  if (status === 'no-ui') return `No interactive terminal UI (mode ${mode}). Ask the same questions as numbered text instead.`;
  if (status === 'aborted') return 'The questions were interrupted before an answer.';
  if (cancelled || status === 'cancelled') return 'The user cancelled the questions (Esc); nothing was answered.';
  return answers.map(describeAnswer).join('\n');
}

function describeAnswer({ header, kind, label, selections }) {
  if (kind !== 'multi') return `${header}: ${kind === 'text' ? 'wrote' : 'selected'} "${label}"`;
  const quote = (kindOfPick) => selections.filter((pick) => pick.kind === kindOfPick).map((pick) => `"${pick.label}"`).join(', ');
  const parts = [];
  if (selections.some((pick) => pick.kind === 'option')) parts.push(`selected ${quote('option')}`);
  if (selections.some((pick) => pick.kind === 'text')) parts.push(`wrote ${quote('text')}`);
  return `${header}: ${parts.join('; ')}`;
}

/**
 * The component for ctx.ui.custom. done({ answers, cancelled, reason? }) is called exactly once:
 * on Submit, Esc, or when `signal` aborts (ctx.ui.custom takes no signal, so the component listens itself).
 */
export function createAskComponent({ questions, tui, theme, kit, signal, done }) {
  const { Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi } = kit;
  const hasTabs = questions.length > 1;
  const submitTab = questions.length;
  const answers = new Map(); // single-select: question index -> { header, kind, label }
  const picks = new Map(); // multi-select: question index -> { chosen: Set of option indexes, text: typed answer or '' }
  let tab = 0;
  let cursor = 0;
  let editing = false;
  let notice = ''; // a one-line warning under the options; the next key clears it
  let finished = false;
  let cachedLines;
  let cachedWidth;

  const editor = new Editor(tui, {
    borderColor: (s) => theme.fg('accent', s),
    selectList: {
      selectedPrefix: (s) => theme.fg('accent', s),
      selectedText: (s) => theme.fg('accent', s),
      description: (s) => theme.fg('muted', s),
      scrollInfo: (s) => theme.fg('dim', s),
      noMatch: (s) => theme.fg('warning', s),
    },
  });

  const onAbort = () => finish({ answers: [], cancelled: true, reason: 'aborted' });
  function finish(result) {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', onAbort);
    done(result);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const refresh = () => { cachedLines = undefined; tui.requestRender(); };
  const pickOf = (index) => {
    if (!picks.has(index)) picks.set(index, { chosen: new Set(), text: '' });
    return picks.get(index);
  };
  // A multi-select answer is read live from the checkboxes, so Submit always sends what the tab shows.
  // Nothing checked and nothing typed is no answer: it must not read as approval.
  function answerFor(index) {
    const { header, multiSelect, options } = questions[index];
    if (!multiSelect) return answers.get(index);
    const pick = pickOf(index);
    const selections = options.flatMap((option, i) => (pick.chosen.has(i) ? [{ kind: 'option', label: option.label }] : []));
    if (pick.text) selections.push({ kind: 'text', label: pick.text });
    if (!selections.length) return undefined;
    return { header, kind: 'multi', label: selections.map((item) => item.label).join(', '), selections };
  }
  const allAnswered = () => questions.every((_, index) => answerFor(index));
  const ordered = () => questions.map((_, index) => answerFor(index));
  const rows = (index) => {
    const { options, multiSelect } = questions[index];
    const list = [...options, { label: OTHER_LABEL, description: '', isOther: true }];
    if (multiSelect) list.push({ label: hasTabs ? 'Next' : 'Submit', description: '', isConfirm: true });
    return list;
  };

  function advance() {
    if (!hasTabs) return finish({ answers: ordered(), cancelled: false });
    tab = tab < questions.length - 1 ? tab + 1 : submitTab;
    cursor = 0;
    refresh();
  }

  function commit(answer) {
    answers.set(tab, { header: questions[tab].header, ...answer });
    advance();
  }

  function openEditor(text = '') {
    editing = true;
    editor.setText(text);
    refresh();
  }

  editor.onSubmit = (value) => {
    const answer = value.trim();
    if (questions[tab].multiSelect) {
      pickOf(tab).text = answer; // here an empty answer clears the typed one (unchecks it) instead of recording anything
      editing = false;
      editor.setText('');
      return refresh();
    }
    if (!answer) return; // an empty answer is never recorded: it must not read as approval
    editing = false;
    editor.setText('');
    commit({ kind: 'text', label: answer });
  };

  function handleInput(data) {
    if (finished) return;
    if (editing) {
      if (matchesKey(data, Key.escape)) {
        editing = false;
        editor.setText('');
      } else {
        editor.handleInput(data);
      }
      return refresh();
    }
    if (notice) { notice = ''; refresh(); }
    if (matchesKey(data, Key.escape)) return finish({ answers: [], cancelled: true });
    if (hasTabs && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
      tab = (tab + 1) % (submitTab + 1);
      cursor = 0;
      return refresh();
    }
    if (hasTabs && (matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.left))) {
      tab = (tab + submitTab) % (submitTab + 1);
      cursor = 0;
      return refresh();
    }
    if (tab === submitTab) {
      if (matchesKey(data, Key.enter) && allAnswered()) finish({ answers: ordered(), cancelled: false });
      return;
    }
    const options = rows(tab);
    if (matchesKey(data, Key.up)) { cursor = Math.max(0, cursor - 1); return refresh(); }
    if (matchesKey(data, Key.down)) { cursor = Math.min(options.length - 1, cursor + 1); return refresh(); }
    const choice = options[cursor];
    if (questions[tab].multiSelect) {
      // Space and Enter both toggle a checkbox; only Enter on the Next/Submit row moves on.
      const space = matchesKey(data, Key.space);
      if (!space && !matchesKey(data, Key.enter)) return;
      if (choice.isConfirm) {
        if (space) return;
        if (answerFor(tab)) return advance();
        notice = 'Select at least one option';
        return refresh();
      }
      if (choice.isOther) {
        const pick = pickOf(tab);
        if (space && pick.text) { pick.text = ''; return refresh(); }
        return openEditor(pick.text); // Enter edits the typed answer in place
      }
      const { chosen } = pickOf(tab);
      if (!chosen.delete(cursor)) chosen.add(cursor);
      return refresh();
    }
    if (matchesKey(data, Key.enter)) {
      if (!choice.isOther) return commit({ kind: 'option', label: choice.label });
      openEditor();
    }
  }

  function render(width) {
    // Keyed by the width: a terminal resize only requests a render, it does not invalidate.
    if (cachedLines && cachedWidth === width) return cachedLines;
    const renderWidth = Math.max(1, width);
    const lines = [];
    const add = (prefix, value) => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) { lines.push(...wrapTextWithAnsi(prefix + value, renderWidth)); return; }
      wrapTextWithAnsi(value, renderWidth - prefixWidth)
        .forEach((line, index) => lines.push((index === 0 ? prefix : ' '.repeat(prefixWidth)) + line));
    };
    const renderOptions = () => {
      const pick = questions[tab].multiSelect ? pickOf(tab) : undefined;
      rows(tab).forEach((option, index) => {
        const selected = index === cursor;
        const prefix = selected ? theme.fg('accent', '> ') : '  ';
        if (option.isConfirm) {
          lines.push('');
          const ready = answerFor(tab) !== undefined;
          return add(prefix, theme.fg(selected ? 'accent' : ready ? 'success' : 'dim', `✓ ${option.label}`));
        }
        const checked = pick && (option.isOther ? pick.text !== '' : pick.chosen.has(index));
        const box = pick ? `${checked ? '[✓]' : '[ ]'} ` : '';
        const label = `${index + 1}. ${box}${option.label}${option.isOther && editing ? ' ✎' : ''}`;
        add(prefix, theme.fg(selected || (option.isOther && editing) ? 'accent' : checked ? 'success' : 'text', label));
        const description = option.isOther && pick ? pick.text : option.description; // the typed answer shows under its row
        if (description) add('     ', theme.fg('muted', description));
      });
    };
    const describe = (answer) => (answer.kind === 'multi'
      ? answer.selections.map((item) => (item.kind === 'text' ? '(wrote) ' : '') + item.label).join(', ')
      : (answer.kind === 'text' ? '(wrote) ' : '') + answer.label);

    lines.push(theme.fg('accent', '─'.repeat(renderWidth)));
    if (hasTabs) {
      const tabs = questions.map((question, index) => {
        const answered = answerFor(index) !== undefined;
        const label = ` ${answered ? '■' : '□'} ${question.header} `;
        return index === tab ? theme.bg('selectedBg', theme.fg('text', label)) : theme.fg(answered ? 'success' : 'muted', label);
      });
      const submit = ' ✓ Submit ';
      tabs.push(tab === submitTab ? theme.bg('selectedBg', theme.fg('text', submit)) : theme.fg(allAnswered() ? 'success' : 'dim', submit));
      add(' ', ['←', ...tabs, '→'].join(' '));
      lines.push('');
    }
    if (tab === submitTab) {
      add(' ', theme.fg('accent', theme.bold('Ready to submit')));
      lines.push('');
      for (const [index, question] of questions.entries()) {
        const answer = answerFor(index);
        if (answer) add(' ', `${theme.fg('muted', `${question.header}: `)}${theme.fg('text', describe(answer))}`);
      }
      lines.push('');
      const missing = questions.filter((_, index) => !answerFor(index)).map((question) => question.header).join(', ');
      add(' ', missing ? theme.fg('warning', `Unanswered: ${missing}`) : theme.fg('success', 'Press Enter to submit'));
    } else {
      const { context } = questions[tab];
      if (context) {
        for (const line of context.split('\n')) add(' ', theme.fg('muted', line));
        lines.push('');
      }
      add(' ', theme.fg('text', questions[tab].question));
      lines.push('');
      renderOptions();
      if (notice) {
        lines.push('');
        add(' ', theme.fg('warning', notice));
      }
      if (editing) {
        lines.push('');
        add(' ', theme.fg('muted', 'Your answer:'));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
      }
    }
    lines.push('');
    const multiSelect = questions[tab]?.multiSelect;
    const help = editing
      ? (multiSelect ? 'Enter to save (empty clears) • Esc to go back' : 'Enter to submit • Esc to go back')
      : multiSelect ? `${hasTabs ? 'Tab/←→ navigate • ' : ''}↑↓ move • Space/Enter toggle • Esc cancel`
        : hasTabs ? 'Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel' : '↑↓ navigate • Enter select • Esc cancel';
    add(' ', theme.fg('dim', help));
    lines.push(theme.fg('accent', '─'.repeat(renderWidth)));
    cachedLines = lines;
    cachedWidth = width;
    return lines;
  }

  return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
}
