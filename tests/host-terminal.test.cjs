'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { openSshTerminal, terminalSshArgs, windowsArgument, posixLauncher } = require('../electron/host-terminal.cjs');
const { shellQuote } = require('../electron/host-ssh.cjs');

const host = { alias: 'example-host', hostName: '192.0.2.12', user: 'operator', port: '2222', identityFile: '/tmp/private key', proxyJump: 'jump-host' };

async function temporary(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-terminal-test-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('interactive SSH uses the exact configured alias and original SSH config', () => {
  assert.deepEqual(terminalSshArgs('/tmp/config with spaces', host), ['-F', '/tmp/config with spaces', '--', host.alias]);
  // No background-only flags or replacement user / port / key bypass the config.
  assert.deepEqual(terminalSshArgs('/tmp/config', { ...host, alias: "host'&%$`name" }), ['-F', '/tmp/config', '--', "host'&%$`name"]);
  for (const alias of ['', '-oProxyCommand=bad', 'host name', 'host\nname', '*', 'host!name']) {
    assert.throws(() => terminalSshArgs('/tmp/config', { alias }), /개별 호스트 이름/);
  }
  for (const configPath of ['', null, '/tmp/config\nnew', '/tmp/config\x00new']) {
    assert.throws(() => terminalSshArgs(configPath, host), /SSH 설정 파일/);
  }
});

test('macOS launcher is private and opened using the native default association', async (t) => {
  const tempRoot = await temporary(t);
  let openedPath;
  const result = await openSshTerminal({ host, configPath: '/tmp/user config', platform: 'darwin', tempRoot, shell: { openPath: async (filename) => { openedPath = filename; return ''; } } });
  assert.deepEqual(result, { opened: true });
  assert.equal(path.basename(openedPath), 'SSH.command');
  assert.equal((await fs.stat(path.dirname(openedPath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(openedPath)).mode & 0o777, 0o700);
  const text = await fs.readFile(openedPath, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.ok(text.includes("exec /usr/bin/ssh '-F' '/tmp/user config' '--' 'example-host'"));
  assert.ok(text.includes('rm -f --'));
  // A delayed terminal still needs the file after native dispatch returns.
  assert.ok((await fs.stat(openedPath)).isFile());
});

test('Linux launcher passes hostile path and alias as literal arguments and removes only its own files', async (t) => {
  const tempRoot = await temporary(t);
  const executableDir = path.join(tempRoot, 'fake executables');
  await fs.mkdir(executableDir);
  const argsLog = path.join(tempRoot, 'arguments');
  const configPath = path.join(tempRoot, "config ' $(touch injected) `touch injected-again` & percent%");
  const alias = "host';$(touch${IFS}injected);&`uname`%";
  await fs.writeFile(configPath, 'Host example\n');
  const ssh = path.join(executableDir, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nprintf '%s\\0' "$@" > ${shellQuote(argsLog)}\n`, { mode: 0o700 });
  const launchDirectory = path.join(tempRoot, 'launcher');
  await fs.mkdir(launchDirectory);
  const launcher = path.join(launchDirectory, 'SSH.sh');
  await fs.writeFile(launcher, posixLauncher(terminalSshArgs(configPath, { alias }), launchDirectory, launcher, 'linux'), { mode: 0o700 });
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [launcher], { cwd: tempRoot, env: { ...process.env, PATH: `${executableDir}:/usr/bin:/bin` }, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  assert.equal(processResult, 0);
  assert.deepEqual((await fs.readFile(argsLog, 'utf8')).split('\x00').slice(0, -1), ['-F', configPath, '--', alias]);
  assert.equal(await fs.readFile(configPath, 'utf8'), 'Host example\n');
  await assert.rejects(fs.stat(path.dirname(launcher)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(tempRoot, 'injected')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(tempRoot, 'injected-again')), { code: 'ENOENT' });
});

test('macOS launcher ignores a different SSH in PATH without opening a connection', async (t) => {
  if (process.platform !== 'darwin') { t.skip('Uses the macOS system SSH.'); return; }
  const tempRoot = await temporary(t);
  const executableDir = path.join(tempRoot, 'fake executables');
  const marker = path.join(tempRoot, 'wrong-ssh-used');
  await fs.mkdir(executableDir);
  await fs.writeFile(path.join(executableDir, 'ssh'), `#!/bin/sh\nprintf wrong > ${shellQuote(marker)}\nexit 1\n`, { mode: 0o700 });
  const configPath = path.join(tempRoot, "config ' $(touch injected) `touch injected-again`");
  await fs.writeFile(configPath, 'Host test-host\n  HostName example.invalid\n  User fixture-user\n');
  const launchDirectory = path.join(tempRoot, 'launcher');
  await fs.mkdir(launchDirectory);
  const launcher = path.join(launchDirectory, 'SSH.command');
  // -G only expands this temporary config and never contacts a server.
  await fs.writeFile(launcher, posixLauncher(['-G', '-F', configPath, '--', 'test-host'], launchDirectory, launcher, 'darwin'), { mode: 0o700 });
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [launcher], { cwd: tempRoot, env: { ...process.env, PATH: `${executableDir}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^hostname example\.invalid$/m);
  assert.match(result.stdout, /^user fixture-user$/m);
  for (const filename of [marker, launchDirectory, path.join(tempRoot, 'injected'), path.join(tempRoot, 'injected-again')]) await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('Windows launcher contains no variable CMD text and passes literal native SSH arguments', async (t) => {
  const tempRoot = await temporary(t);
  const configPath = "C:\\Users\\O'Brien & 100% ! $`name\\SSH config";
  const alias = "host'&%$`name";
  let launcher;
  await openSshTerminal({ host: { alias }, configPath, tempRoot, platform: 'win32', shell: { openPath: async (filename) => { launcher = filename; return ''; } } });
  assert.equal(path.basename(launcher), 'SSH.cmd');
  const text = await fs.readFile(launcher, 'utf8');
  assert.ok(text.startsWith('@echo off\r\nsetlocal DisableDelayedExpansion\r\n'));
  assert.equal(text.includes(configPath), false);
  assert.equal(text.includes(alias), false);
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)\r\n$/.exec(text)?.[1];
  assert.ok(encoded);
  const command = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(command.includes("$info.Arguments = '\"-F\" \"C:\\Users\\O''Brien & 100% ! $`name\\SSH config\" \"--\" \"host''&%$`name\"'"));
  assert.ok(command.includes("$info.FileName = 'ssh.exe'"));
  assert.ok(command.includes('$info.UseShellExecute = $false'));
  assert.ok(command.includes('$info.CreateNoWindow = $false'));
  assert.ok(command.includes('$ssh.WaitForExit()'));
  assert.ok(command.includes('Remove-Item -LiteralPath $launcher'));
  assert.ok(command.includes('finally { Remove-Launcher }'));
  assert.equal(command.includes('cmd.exe'), false);
  assert.equal(command.includes('Invoke-Expression'), false);
});

test('Windows native quoting preserves embedded quotes and trailing backslashes', () => {
  assert.equal(windowsArgument(''), '""');
  assert.equal(windowsArgument('C:\\space path\\'), '"C:\\space path\\\\"');
  assert.equal(windowsArgument('name"quoted'), '"name\\"quoted"');
  assert.equal(windowsArgument('name\\"quoted'), '"name\\\\\\"quoted"');
});

test('native app opening failures remove the pending launcher and report the failure', async (t) => {
  const tempRoot = await temporary(t);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'darwin', tempRoot, shell: { openPath: async () => 'No application is registered' } }), /외부 터미널.*No application is registered/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'win32', tempRoot, shell: { openPath: async () => { throw new Error('native open failed'); } } }), /native open failed/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('partial launcher writes are removed on filesystem failure', async (t) => {
  const tempRoot = await temporary(t);
  const fsImpl = { ...fs, writeFile: async (...args) => { await fs.writeFile(...args); throw new Error('write failed'); } };
  let opened = false;
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'darwin', tempRoot, fsImpl, shell: { openPath: async () => { opened = true; } } }), /write failed/);
  assert.equal(opened, false);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('invalid host, unsupported platform and missing native opener create no files', async (t) => {
  const tempRoot = await temporary(t);
  await assert.rejects(openSshTerminal({ host: { alias: '-invalid' }, configPath: '/tmp/config', platform: 'darwin', tempRoot }), /개별 호스트/);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'aix', tempRoot }), /운영체제/);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'darwin', tempRoot }), /외부 터미널/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('Linux terminal fallback starts a separate native process with an argument array', async (t) => {
  const tempRoot = await temporary(t);
  const calls = [];
  let unrefCount = 0;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => { unrefCount += 1; };
    queueMicrotask(async () => {
      if (command === 'x-terminal-emulator') child.emit('error', Object.assign(new Error('missing terminal'), { code: 'ENOENT' }));
      else { await fs.rm(path.dirname(args.at(-1)), { recursive: true, force: true }); child.emit('spawn'); }
    });
    return child;
  };
  const result = await openSshTerminal({ host, configPath: '/tmp/config', platform: 'linux', tempRoot, spawnImpl });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(calls.map((call) => call.command), ['x-terminal-emulator', 'gnome-terminal']);
  assert.equal(unrefCount, 1);
  assert.deepEqual(calls[1].args.slice(0, 2), ['--', '/bin/sh']);
  assert.equal(path.basename(calls[1].args[2]), 'SSH.sh');
  for (const call of calls) assert.deepEqual(call.options, { detached: true, stdio: 'ignore', shell: false });
  await assert.rejects(fs.stat(calls[1].args[2]), { code: 'ENOENT' });
});

test('Linux missing terminals and spawn errors remove launchers without starting SSH', async (t) => {
  const tempRoot = await temporary(t);
  const missing = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'linux', tempRoot, spawnImpl: missing }), /터미널 프로그램을 찾을 수 없습니다/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'linux', tempRoot, spawnImpl: () => { throw new Error('native spawn failed'); } }), /native spawn failed/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('Linux terminal launch failure and stalled startup are reported and cleaned up', async (t) => {
  const tempRoot = await temporary(t);
  const fakeTerminal = (closes) => () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); if (closes) child.emit('close', 1); });
    return child;
  };
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'linux', tempRoot, spawnImpl: fakeTerminal(true) }), /외부 터미널을 실행하지 못했습니다/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await assert.rejects(openSshTerminal({ host, configPath: '/tmp/config', platform: 'linux', tempRoot, spawnImpl: fakeTerminal(false), terminalStartTimeoutMs: 1 }), /SSH 명령을 시작하지 못했습니다/);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});
