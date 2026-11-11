import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('npm pack includes only the standalone extension, source and documentation', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }));
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pack.name, 'pi-task');
  assert.deepEqual(manifest.pi.extensions, ['./extensions/index.js']);
  assert.deepEqual(pack.files.map(({ path }) => path).sort(), [
    'LICENSE', 'NOTICE', 'README.md', 'README.ru.md', 'extensions/index.js', 'package.json', 'src/ask.js', 'src/result.js',
  ]);
});
