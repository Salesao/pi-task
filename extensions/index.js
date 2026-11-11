import { ASK_LIMITS, askResultText, createAskComponent, normalizeAskParams } from '../src/ask.js';
import { normalizeTaskResult } from '../src/result.js';

// Both Pi loaders resolve the legacy namespace to their own SDK packages.
import { Type } from '@mariozechner/pi-ai';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';

function askQuestionSchema(Type) {
  const AskOption = Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) });
  return Type.Object({
    question: Type.String({ description: 'The full question, about the matter itself' }),
    header: Type.String({ description: 'Tab label, up to 12 characters, e.g. "3 Rollback"' }),
    context: Type.Optional(Type.String({ description: 'The card (situation, proposal, cost) shown above the question, up to 600 characters' })),
    options: Type.Array(AskOption, { description: '2-4 options; the free answer "Type something." is added automatically' }),
    multiSelect: Type.Optional(Type.Boolean({ description: 'Set to true to allow the user to select multiple options instead of just one. Use when the choices are not mutually exclusive. Default false' })),
  });
}

function toolResult(raw) {
  const outcome = normalizeTaskResult(raw);
  return { content: [{ type: 'text', text: askResultText(outcome) }], details: outcome, structuredContent: outcome };
}

export default async function register(pi) {
  const kit = { Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi };
  const activeWindows = new Set();
  pi.on('session_shutdown', () => {
    for (const controller of activeWindows) controller.abort();
    activeWindows.clear();
  });

  pi.registerTool(defineTool({
    name: 'pi_task',
    label: 'Ask the user',
    description: 'Ask 1–4 questions with selectable options, descriptions and a free-text answer. Each question can include context. Enter selects an answer, Submit sends multiple answers, and Esc cancels the window. Set multiSelect: true on a question whose options are not mutually exclusive: the user checks any number of options (plus an optional typed answer) and the answer lists all of them.',
    promptSnippet: 'Ask the user questions in an interactive terminal window.',
    parameters: Type.Object({ questions: Type.Array(askQuestionSchema(Type), { minItems: 1, maxItems: ASK_LIMITS.questions }) }),
    exposure: 'model-only',
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const parsed = normalizeAskParams(params);
      if (!parsed.ok) return toolResult({ status: 'invalid', error: parsed.error });
      if (signal?.aborted) return toolResult({ status: 'aborted' });
      const hasTerminalUi = ctx.mode === undefined ? ctx.hasUI === true : ctx.mode === 'tui';
      if (!hasTerminalUi || typeof ctx.ui?.custom !== 'function') {
        return toolResult({ status: 'no-ui', mode: ctx.mode ?? 'without UI' });
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      activeWindows.add(controller);
      try {
        const result = await ctx.ui.custom((tui, theme, _keybindings, done) => createAskComponent({
          questions: parsed.questions, tui, theme, kit, signal: controller.signal, done,
        }));
        if (controller.signal.aborted) return toolResult({ status: 'aborted' });
        if (result === undefined && ctx.mode === undefined) return toolResult({ status: 'no-ui', mode: 'without terminal UI' });
        return toolResult(result);
      } catch (error) {
        if (controller.signal.aborted) return toolResult({ status: 'aborted' });
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        activeWindows.delete(controller);
        controller.abort();
      }
    },
  }));
}
