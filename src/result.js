const FAILURE_STATUSES = new Set(['cancelled', 'aborted', 'no-ui', 'invalid']);

/** Normalize component outcomes before returning them to a caller. */
export function normalizeTaskResult(raw) {
  const status = raw?.status ?? raw?.reason ?? (raw?.cancelled ? 'cancelled' : 'submitted');
  if (status === 'submitted' && Array.isArray(raw?.answers) && raw.answers.length > 0 &&
    raw.answers.every((answer) => typeof answer?.header === 'string' &&
      ['option', 'text'].includes(answer.kind) && typeof answer.label === 'string' && answer.label.trim())) {
    return { status, answers: raw.answers.map(({ header, kind, label }) => ({ header, kind, label })) };
  }
  const result = { status: FAILURE_STATUSES.has(status) ? status : 'aborted', answers: [] };
  for (const key of ['reason', 'mode', 'error']) {
    if (typeof raw?.[key] === 'string') result[key] = raw[key];
  }
  return result;
}
