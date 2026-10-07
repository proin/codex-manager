'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRuntimeFinder, platformTarget, defaultCandidates } = require('../electron/runtime.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, contents = 'native test placeholder', mode = 0o700) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode });
    return file;
  };
  return { root, write };
}

test('returns a validated direct executable without a shell', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('Codex CLI');
  const calls = [];
  const find = createRuntimeFinder({ home: root, candidates: [file], execute: async (...args) => { calls.push(args); return { stdout: 'codex-cli 0.149.0\n' }; } });
  const result = await find();
  assert.equal(result.available, true);
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.command, result.path);
  assert.equal(result.version, '0.149.0');
  assert.deepEqual(result.args, []);
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].timeout, 5000);
});

test('resolves an npm symlink and JavaScript wrapper to the native optional dependency', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('lib/node_modules/@openai/codex/bin/codex.js', '#!/usr/bin/env node\nthrow new Error("must not execute");');
  const native = await write('lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
  const link = path.join(root, 'codex');
  await fs.symlink(wrapper, link);
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, execute: async (file) => { calls.push(file); return { stdout: 'codex-cli 0.149.0' }; } });
  const result = await find(link);
  assert.equal(result.path, await fs.realpath(native));
  assert.deepEqual(calls, [await fs.realpath(native)]);
});

test('rejects a wrapper with a missing native dependency without executing it', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('package/bin/codex.js', '#!/usr/bin/env node\n');
  let executions = 0;
  const find = createRuntimeFinder({ home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.149.0' }; } });
  const result = await find(wrapper);
  assert.equal(result.available, false);
  assert.equal(executions, 0);
  assert.match(result.error, /다시 설치/);
});

test('invalid custom path does not silently fall back to another installation', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('codex');
  const find = createRuntimeFinder({ home: root, candidates: [file], execute: async () => ({ stdout: 'codex-cli 0.149.0' }) });
  assert.equal((await find(path.join(root, 'missing'))).available, false);
  assert.match((await find('codex')).error, /전체 경로/);
  assert.equal((await find('~/codex')).available, true);
});

test('rejects an unrelated program and reports version timeout', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('codex');
  const wrong = createRuntimeFinder({ home: root, execute: async () => ({ stdout: 'node v24.0.0' }) });
  assert.match((await wrong(file)).error, /Codex CLI가 아닙니다/);
  const timeout = createRuntimeFinder({ home: root, execute: async () => { throw Object.assign(new Error('timeout'), { killed: true }); } });
  assert.match((await timeout(file)).error, /응답하지 않습니다/);
});

test('continues discovery after one broken installation and deduplicates symlinks', async (t) => {
  const { root, write } = await fixture(t);
  const bad = await write('bad');
  const good = await write('good');
  const link = path.join(root, 'bad-link');
  await fs.symlink(bad, link);
  const calls = [];
  const find = createRuntimeFinder({ home: root, candidates: [bad, link, good], execute: async (file) => { calls.push(file); return { stdout: file.endsWith('good') ? 'codex-cli 0.149.0-beta.1' : 'other program' }; } });
  assert.equal((await find()).version, '0.149.0-beta.1');
  assert.equal(calls.length, 2);
});

test('rejects a directory or non-executable file before launching a process', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('readonly', 'placeholder', 0o600);
  let executions = 0;
  const find = createRuntimeFinder({ home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.149.0' }; } });
  assert.equal((await find(root)).available, false);
  assert.equal((await find(file)).available, false);
  assert.equal(executions, 0);
});

test('Windows discovery includes resources, npm prefixes and absolute PATH entries with native exe names', () => {
  const candidates = defaultCandidates({
    platform: 'win32', target: platformTarget('win32', 'x64'), home: 'C:\\Users\\Operator', resourcesPath: 'C:\\Program Files\\Codex Account Manager\\resources',
    env: { APPDATA: 'C:\\Users\\Operator\\AppData\\Roaming', npm_config_prefix: 'D:\\Tools\\npm', Path: 'C:\\Windows\\System32;D:\\Programs\\node;relative;;.' },
  });
  assert.ok(candidates.includes('C:\\Program Files\\Codex Account Manager\\resources\\bin\\codex.exe'));
  assert.ok(candidates.some((file) => file.startsWith('C:\\Users\\Operator\\AppData\\Roaming\\npm\\node_modules\\@openai\\') && file.endsWith('\\codex.exe')));
  assert.ok(candidates.some((file) => file.startsWith('D:\\Tools\\npm\\node_modules\\@openai\\') && file.endsWith('\\codex.exe')));
  assert.ok(candidates.includes('D:\\Programs\\node\\codex.cmd'));
  assert.ok(candidates.includes('D:\\Programs\\node\\codex.ps1'));
  assert.equal(candidates.some((file) => file.includes('relative') || /homebrew/.test(file)), false);
  assert.equal(candidates.length, new Set(candidates).size);
});

test('Windows npm cmd and PowerShell launchers resolve to codex.exe without a shell or invoking their contents', async (t) => {
  const { root, write } = await fixture(t);
  const cmd = await write('npm/codex.cmd', '@echo off\necho do-not-run-this-launcher');
  const powershell = await write('npm/codex.ps1', 'throw "do not run this launcher"');
  const native = await write('npm/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const calls = [];
  const find = createRuntimeFinder({ platform: 'win32', arch: 'x64', home: root, execute: async (...args) => { calls.push(args); return { stdout: 'codex-cli 0.161.0' }; } });
  assert.equal((await find(cmd)).path, await fs.realpath(native));
  assert.equal((await find(powershell)).path, await fs.realpath(native));
  const nativePath = await fs.realpath(native);
  assert.ok(calls.every(([file, args, options]) => file === nativePath && args[0] === '--version' && options.shell === false && options.windowsHide));
});

test('Windows local npm shim finds an optional native dependency in node_modules', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('project/node_modules/.bin/codex.cmd', '@echo off\n');
  const native = await write('project/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/codex/codex.exe');
  const find = createRuntimeFinder({ platform: 'win32', arch: 'arm64', home: root, execute: async () => ({ stdout: 'codex-cli 0.161.0' }) });
  assert.equal((await find(wrapper)).path, await fs.realpath(native));
});

test('Windows launcher without a native dependency fails without attempting cmd or PowerShell', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('npm/codex.cmd', '@echo off\n');
  let executions = 0;
  const find = createRuntimeFinder({ platform: 'win32', arch: 'x64', home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.161.0' }; } });
  assert.equal((await find(wrapper)).available, false);
  assert.equal(executions, 0);
});
