'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertAlias, shellQuote } = require('./host-ssh.cjs');
const { sshExecutable } = require('./local-commands.cjs');

// These are interactive sessions: OpenSSH reads the original configuration,
// asks for host trust / passwords in the terminal, and retains its usual TTY.
function terminalSshArgs(configPath, host) {
  assertAlias(host?.alias);
  if (typeof configPath !== 'string' || !configPath || /[\x00-\x1f\x7f]/.test(configPath)) {
    throw new Error('SSH 설정 파일 경로를 확인하십시오.');
  }
  return ['-F', configPath, '--', host.alias];
}

function windowsArgument(value) {
  // Windows native argument parsing uses backslashes to escape double quotes.
  // There is no cmd.exe parsing step between PowerShell and ssh.exe.
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function powershellLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function posixLauncher(args, directory, filename, platform = process.platform) {
  return `#!/bin/sh\n# Remove the launcher only after the terminal has opened it.\nrm -f -- ${shellQuote(filename)}\nrmdir -- ${shellQuote(directory)} 2>/dev/null || :\nexec ${sshExecutable(platform)} ${args.map(shellQuote).join(' ')}\n`;
}

function windowsLauncher(args, directory, filename) {
  // All variable text is inside an encoded PowerShell command. Percent signs,
  // exclamation marks and cmd metacharacters never enter the batch parser.
  // The PowerShell command is the batch file's last line, so it can remove the
  // launcher before SSH starts without discarding any unread batch commands.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$launcher = ${powershellLiteral(filename)}`,
    `$directory = ${powershellLiteral(directory)}`,
    'function Remove-Launcher {',
    '  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue',
    '  try { [System.IO.Directory]::Delete($directory, $false) } catch {}',
    '}',
    'try {',
    '  Remove-Launcher',
    '  $info = New-Object System.Diagnostics.ProcessStartInfo',
    "  $info.FileName = 'ssh.exe'",
    `  $info.Arguments = ${powershellLiteral(args.map(windowsArgument).join(' '))}`,
    '  $info.UseShellExecute = $false',
    '  $info.CreateNoWindow = $false',
    '  $ssh = [System.Diagnostics.Process]::Start($info)',
    '  $ssh.WaitForExit()',
    '  $status = $ssh.ExitCode',
    '} catch {',
    '  Write-Host $_.Exception.Message',
    '  $status = 1',
    "  [void](Read-Host '창을 닫으려면 Enter 키를 누르십시오.')",
    '} finally { Remove-Launcher }',
    'exit $status',
  ].join('\r\n');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\npowershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}\r\n`;
}

function spawnTerminal(command, args, spawnImpl, { filename, fsImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const startedAt = Date.now();
    const checkStarted = async () => {
      if (settled) return;
      try { await fsImpl.stat(filename); }
      catch (error) {
        // The shell deletes its launcher as its first action. Checking this
        // catches terminals that start but immediately reject the display or
        // command, while allowing terminals that delegate to an existing app.
        if (error.code === 'ENOENT') { finish(); return; }
        finish(error); return;
      }
      if (settled) return;
      if (Date.now() - startedAt >= timeoutMs) {
        finish(new Error('외부 터미널이 SSH 명령을 시작하지 못했습니다.')); return;
      }
      timer = setTimeout(checkStarted, 25);
    };
    try {
      child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false });
    } catch (error) { finish(error); return; }
    // The terminal belongs to the user, rather than the application's process
    // tree. No process handle is retained and app shutdown never kills it.
    child.once('error', finish);
    child.once('close', code => { if (code) finish(new Error('외부 터미널을 실행하지 못했습니다.')); });
    child.once('spawn', () => { child.unref(); void checkStarted(); });
  });
}

async function openLinuxTerminal(filename, spawnImpl, fsImpl, timeoutMs) {
  const candidates = [
    ['x-terminal-emulator', ['-e', '/bin/sh', filename]],
    ['gnome-terminal', ['--', '/bin/sh', filename]],
    ['konsole', ['-e', '/bin/sh', filename]],
    ['xterm', ['-e', '/bin/sh', filename]],
  ];
  for (const [command, args] of candidates) {
    try { await spawnTerminal(command, args, spawnImpl, { filename, fsImpl, timeoutMs }); return; }
    catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('외부 터미널 프로그램을 찾을 수 없습니다.');
}

async function openSshTerminal({ host, configPath, shell, platform = process.platform, fsImpl = fs, tempRoot = os.tmpdir(), spawnImpl = spawn, terminalStartTimeoutMs = 10000 }) {
  const args = terminalSshArgs(configPath, host);
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('이 운영체제에서는 외부 SSH 터미널을 지원하지 않습니다.');
  if (platform !== 'linux' && typeof shell?.openPath !== 'function') throw new Error('외부 터미널을 열 수 없습니다.');

  let directory;
  try {
    directory = await fsImpl.mkdtemp(path.join(tempRoot, 'codex-ssh-terminal-'));
    await fsImpl.chmod(directory, 0o700);
    const filename = path.join(directory, platform === 'win32' ? 'SSH.cmd' : platform === 'darwin' ? 'SSH.command' : 'SSH.sh');
    const contents = platform === 'win32' ? windowsLauncher(args, directory, filename) : posixLauncher(args, directory, filename, platform);
    await fsImpl.writeFile(filename, contents, { mode: 0o700, flag: 'wx' });
    // Explicit chmod also protects platforms whose default file creation mode
    // or filesystem ignores writeFile's mode option.
    await fsImpl.chmod(filename, 0o700);

    if (platform === 'linux') await openLinuxTerminal(filename, spawnImpl, fsImpl, terminalStartTimeoutMs);
    else {
      // macOS .command association opens the user's terminal application.
      // Windows .cmd uses the configured default console terminal.
      const error = await shell.openPath(filename);
      if (error) throw new Error(`외부 터미널을 열지 못했습니다. ${error}`);
    }
    // Native open acknowledges dispatch, not SSH authentication. The launcher
    // removes itself after the receiving terminal opens it, so delayed native
    // application startup is safe and this app can quit immediately afterward.
    return { opened: true };
  } catch (error) {
    if (directory) await fsImpl.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { openSshTerminal, terminalSshArgs, windowsArgument, posixLauncher, windowsLauncher };
