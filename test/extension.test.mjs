import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const params = { questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One' }, { label: 'Two' }] }] };
const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: (text) => text };

async function setup(t, scope = '@earendil-works') {
  const root = mkdtempSync(join(tmpdir(), 'pi-task-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['extensions', 'src']) cpSync(new URL(`../${directory}`, import.meta.url), join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const packages = {
    'pi-ai': 'export const Type = new Proxy({}, { get: (_, type) => (...args) => ({type, args}) });',
    'pi-coding-agent': 'export const defineTool = (tool) => tool;',
    'pi-tui': `export class Editor { setText() {} handleInput(text) { this.onSubmit(text); } }
      export const Key = {enter:'enter', escape:'esc', tab:'tab', down:'down', shift:(key) => 'shift+' + key};
      export const matchesKey = (data, key) => data === key;`,
  };
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', scope, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module","exports":"./index.js"}');
    writeFileSync(join(dir, 'index.js'), source);
  }
  const handlers = {};
  const tools = [];
  await (await import(pathToFileURL(join(root, 'extensions/index.js')))).default({
    registerTool: (tool) => tools.push(tool), on: (event, handler) => { handlers[event] = handler; },
  });
  assert.deepEqual(tools.map(({ name }) => name), ['pi_task']);
  return { tool: tools[0], shutdown: handlers.session_shutdown };
}

function open(tool, { signal, input = params, mode = 'tui' } = {}) {
  let component;
  const ui = { custom: (create) => new Promise((done) => {
    component = create({ requestRender() {} }, theme, {}, done);
  }) };
  const result = tool.execute('call', input, signal, undefined, { mode, ui });
  return { result, component };
}

async function expectResult(result, status, answers = []) {
  const outcome = await result;
  assert.deepEqual(outcome.details, outcome.structuredContent);
  assert.equal(outcome.details.status, status);
  assert.deepEqual(outcome.details.answers, answers);
  assert.equal(outcome.content.length, 1);
  assert.ok(outcome.content[0].text);
  return outcome.content[0].text;
}

test('registers only pi_task with either Pi package scope and reports a selection', async (t) => {
  for (const scope of ['@earendil-works', '@mariozechner']) {
    const { tool } = await setup(t, scope);
    const controller = new AbortController();
    const { component, result } = open(tool, { signal: controller.signal });
    component.handleInput('down');
    component.handleInput('enter');
    assert.match(await expectResult(result, 'submitted', [{ header: 'Choice', kind: 'option', label: 'Two' }]), /selected "Two"/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('invalid, headless and pre-aborted calls never open a window', async (t) => {
  const { tool } = await setup(t);
  assert.equal(open(tool, { input: {} }).component, undefined);
  await expectResult(open(tool, { input: {} }).result, 'invalid');
  for (const mode of ['print', 'json', 'rpc']) {
    const { result, component } = open(tool, { mode });
    assert.equal(component, undefined);
    await expectResult(result, 'no-ui');
  }
  const controller = new AbortController();
  controller.abort();
  const { result, component } = open(tool, { signal: controller.signal });
  assert.equal(component, undefined);
  await expectResult(result, 'aborted');
});

test('Esc, abort, shutdown and an unfinished window cannot submit answers', async (t) => {
  const { tool, shutdown } = await setup(t);
  const input = { questions: [params.questions[0], params.questions[0]] };
  for (const stop of ['esc', 'abort', 'shutdown']) {
    const controller = new AbortController();
    const { component, result } = open(tool, { input, signal: controller.signal });
    component.handleInput('enter');
    if (stop === 'esc') component.handleInput('esc');
    if (stop === 'abort') controller.abort();
    if (stop === 'shutdown') shutdown();
    await expectResult(result, stop === 'esc' ? 'cancelled' : 'aborted');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const ctx = { mode: 'tui', ui: { custom: () => undefined } };
  await expectResult(tool.execute('call', params, undefined, undefined, ctx), 'aborted');
});
