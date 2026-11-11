const FAILURE_STATUSES = new Set(['cancelled', 'aborted', 'no-ui', 'invalid']);

const filled = (value) => typeof value === 'string' && value.trim() !== '';
const isSelection = (item) => ['option', 'text'].includes(item?.kind) && filled(item.label);

// A multi-select answer is { header, kind: 'multi', label: 'A, B', selections: [{ kind, label }, ...] }:
// `label` is the readable join, `selections` keeps each pick apart (a typed answer may itself contain commas).
function isAnswer(answer) {
  if (typeof answer?.header !== 'string' || !filled(answer.label)) return false;
  if (answer.kind === 'multi') {
    return Array.isArray(answer.selections) && answer.selections.length > 0 && answer.selections.every(isSelection);
  }
  return ['option', 'text'].includes(answer.kind);
}

function cleanAnswer({ header, kind, label, selections }) {
  if (kind !== 'multi') return { header, kind, label };
  return { header, kind, label, selections: selections.map((item) => ({ kind: item.kind, label: item.label })) };
}

/** Normalize component outcomes before returning them to a caller. */
export function normalizeTaskResult(raw) {
  const status = raw?.status ?? raw?.reason ?? (raw?.cancelled ? 'cancelled' : 'submitted');
  if (status === 'submitted' && Array.isArray(raw?.answers) && raw.answers.length > 0 && raw.answers.every(isAnswer)) {
    return { status, answers: raw.answers.map(cleanAnswer) };
  }
  const result = { status: FAILURE_STATUSES.has(status) ? status : 'aborted', answers: [] };
  for (const key of ['reason', 'mode', 'error']) {
    if (typeof raw?.[key] === 'string') result[key] = raw[key];
  }
  return result;
}
