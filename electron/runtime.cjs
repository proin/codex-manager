'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);

function platformTarget(platform, arch) {
  const targets = {
    'darwin-arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin'],
    'darwin-x64': ['codex-darwin-x64', 'x86_64-apple-darwin'],
    'linux-arm64': ['codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'linux-x64': ['codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'win32-arm64': ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
    'win32-x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
  };
  const value = targets[`${platform}-${arch}`];
  return value && { packageName: value[0], triple: value[1], executable: platform === 'win32' ? 'codex.exe' : 'codex' };
}

function vendorCandidates(packageRoot, target, paths = path) {
  if (!target) return [];
  const tail = ['vendor', target.triple, 'bin', target.executable];
  const candidates = [
    paths.join(packageRoot, 'node_modules', '@openai', target.packageName, ...tail),
    paths.join(packageRoot, '..', target.packageName, ...tail),
    paths.join(packageRoot, ...tail),
    // Older Codex releases used a codex directory instead of bin.
    paths.join(packageRoot, 'node_modules', '@openai', target.packageName, 'vendor', target.triple, 'codex', target.executable),
    paths.join(packageRoot, '..', target.packageName, 'vendor', target.triple, 'codex', target.executable),
    paths.join(packageRoot, 'vendor', target.triple, 'codex', target.executable),
  ];
  try {
    const requireFromPackage = createRequire(paths.join(packageRoot, 'package.json'));
    const packageJson = requireFromPackage.resolve(`@openai/${target.packageName}/package.json`);
    candidates.unshift(paths.join(paths.dirname(packageJson), ...tail));
  } catch { /* Optional npm dependency may be installed in a different known layout. */ }
  return candidates;
}

function defaultCandidates({ home, env, platform, target, resourcesPath }) {
  const candidates = [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = target?.executable || (platform === 'win32' ? 'codex.exe' : 'codex');
  if (resourcesPath) candidates.push(paths.join(resourcesPath, executable), paths.join(resourcesPath, 'bin', executable));
  if (platform === 'win32') {
    const roaming = env.APPDATA || paths.join(home, 'AppData', 'Roaming');
    const npmPrefixes = [paths.join(roaming, 'npm'), env.npm_config_prefix, env.NPM_CONFIG_PREFIX].filter(Boolean);
    for (const prefix of npmPrefixes) {
      if (!paths.isAbsolute(prefix)) continue;
      candidates.push(...vendorCandidates(paths.join(prefix, 'node_modules', '@openai', 'codex'), target, paths));
      candidates.push(paths.join(prefix, 'codex.exe'), paths.join(prefix, 'codex.cmd'), paths.join(prefix, 'codex.ps1'));
    }
  }
  const npmRoots = [
    path.join(home, '.local', 'lib', 'node_modules', '@openai', 'codex'),
    '/opt/homebrew/lib/node_modules/@openai/codex',
    '/usr/local/lib/node_modules/@openai/codex',
  ];
  if (platform !== 'win32') for (const root of npmRoots) candidates.push(...vendorCandidates(root, target, paths));
  if (platform === 'darwin') {
    for (const directory of ['/Applications', path.join(home, 'Applications')]) {
      for (const app of ['Codex.app', 'ChatGPT.app']) {
        const resources = path.join(directory, app, 'Contents', 'Resources');
        candidates.push(path.join(resources, 'codex'), path.join(resources, 'bin', 'codex'));
        candidates.push(...vendorCandidates(path.join(resources, 'app.asar.unpacked', 'node_modules', '@openai', 'codex'), target));
      }
    }
  }
  if (platform !== 'win32') candidates.push(path.join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
    // Ignore empty and relative PATH entries so the working directory cannot shadow Codex.
    if (!paths.isAbsolute(directory)) continue;
    candidates.push(paths.join(directory, executable));
    if (platform === 'win32') candidates.push(paths.join(directory, 'codex.cmd'), paths.join(directory, 'codex.ps1'));
  }
  return [...new Set(candidates)];
}

async function isNodeWrapper(file) {
  if (/\.(?:[cm]?js|cmd|bat|ps1)$/i.test(file)) return true;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /^#![^\r\n]*\bnode\b/.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

async function resolveNative(candidate, target) {
  const canonical = await fs.realpath(candidate);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error('실행 파일을 선택해 주십시오.');
  if (!await isNodeWrapper(canonical)) {
    await fs.access(canonical, constants.X_OK);
    return canonical;
  }
  // Do not execute JavaScript with process.execPath: in a packaged app it is Electron.
  const directory = path.dirname(canonical);
  const packageRoots = /\.(?:cmd|bat|ps1)$/i.test(canonical)
    ? [path.join(directory, 'node_modules', '@openai', 'codex'), path.join(directory, '..', '@openai', 'codex')]
    : [path.dirname(directory)];
  for (const binary of packageRoots.flatMap((root) => vendorCandidates(root, target))) {
    try {
      const native = await fs.realpath(binary);
      if (!(await fs.stat(native)).isFile() || await isNodeWrapper(native)) continue;
      await fs.access(native, constants.X_OK);
      return native;
    } catch { /* Try the next bounded vendor layout. */ }
  }
  throw new Error('Codex 실행 파일이 없습니다. Codex CLI를 다시 설치해 주십시오.');
}

/** Dependency injection keeps discovery tests independent of the user's installations. */
function createRuntimeFinder(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const target = platformTarget(platform, arch);
  const execute = options.execute || runFile;
  return async function findRuntime(customPath = '') {
    const custom = typeof customPath === 'string' ? customPath.trim() : '';
    if (customPath && !custom) return unavailable('Codex 실행 파일 경로가 올바르지 않습니다.');
    const expanded = custom.startsWith('~/') ? path.join(home, custom.slice(2)) : custom;
    if (custom && !path.isAbsolute(expanded)) return unavailable('Codex 실행 파일의 전체 경로를 입력해 주십시오.');
    const candidates = custom ? [expanded] : options.candidates || defaultCandidates({
      home, env, platform, target, resourcesPath: options.resourcesPath || process.resourcesPath,
    });
    const visited = new Set();
    let lastError;
    for (const candidate of candidates) {
      try {
        const command = await resolveNative(candidate, target);
        if (visited.has(command)) continue;
        visited.add(command);
        const { stdout } = await execute(command, ['--version'], {
          timeout: options.timeout || 5000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          shell: false,
          env,
        });
        const version = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m.exec(String(stdout).trim())?.[1];
        if (!version) throw new Error('선택한 파일은 Codex CLI가 아닙니다.');
        return { available: true, path: command, version, command, args: [] };
      } catch (error) {
        lastError = error;
      }
    }
    if (custom) {
      const message = lastError?.code === 'ENOENT' ? '선택한 Codex 실행 파일을 찾을 수 없습니다.'
        : lastError?.killed || lastError?.code === 'ETIMEDOUT' ? 'Codex 실행 파일이 응답하지 않습니다.'
          : lastError?.code === 'EACCES' ? 'Codex 실행 파일에 실행 권한이 없습니다.'
            : lastError?.message?.startsWith('Codex') || lastError?.message?.startsWith('선택한') || lastError?.message?.startsWith('실행 파일')
              ? lastError.message : '선택한 Codex 실행 파일을 실행할 수 없습니다.';
      return unavailable(message);
    }
    return unavailable('Codex CLI를 찾을 수 없습니다. 설치하거나 실행 파일을 선택해 주십시오.');
  };
}

function unavailable(error) {
  return { available: false, path: null, version: null, command: null, args: [], error };
}

module.exports = { findRuntime: createRuntimeFinder(), createRuntimeFinder, platformTarget, defaultCandidates };
