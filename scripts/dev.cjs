const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let electron;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')], { cwd: root, stdio: 'inherit' });
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  electron?.kill();
  vite.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
vite.on('exit', code => close(code || 0));
(async () => {
  for (let i = 0; i < 100; i++) {
    if (closing) return;
    try {
      const response = await fetch('http://127.0.0.1:5178');
      if (response.ok) {
        electron = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, CODEX_MANAGER_DEV_URL: 'http://127.0.0.1:5178' } });
        electron.on('exit', code => close(code || 0));
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  console.error('개발 화면을 시작하지 못했습니다.');
  close(1);
})();
