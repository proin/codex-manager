const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

async function present(filePath) {
  try { await fs.lstat(filePath); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function runKeygen(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', args, {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', DISPLAY: '' },
    })
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('SSH 키 처리 시간이 초과되었습니다.')) }, 10000)
    timer.unref()
    function finish(error, code) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ code, stdout, stderr })
    }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.on('error', error => finish(error))
    child.on('close', code => finish(null, code))
  })
}

function identityPath(value, host, sshDir) {
  let identity = String(value || '')
  if (/[\x00-\x1f\x7f]/.test(identity)) throw new Error('SSH 키 경로에 제어 문자를 사용할 수 없습니다.')
  identity = identity.trim()
  if (!identity || identity.toLowerCase() === 'none') return ''
  if ((identity.startsWith('"') && identity.endsWith('"')) || (identity.startsWith("'") && identity.endsWith("'"))) identity = identity.slice(1, -1)
  identity = identity.replace(/\\([\\" ])/g, '$1')
  const homeDir = path.dirname(sshDir)
  const username = os.userInfo().username
  const tokens = { '%': '%', d: homeDir, u: username, h: host?.hostName || host?.alias || '', r: host?.user || username, p: host?.port || '22' }
  identity = identity.replace(/%([%duhrp])/g, (_, token) => tokens[token])
  identity = identity.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || '')
  if (identity === '~') identity = homeDir
  else if (identity.startsWith('~/') || identity.startsWith('~\\')) identity = path.join(homeDir, identity.slice(2))
  if (identity.startsWith('~') || /%[A-Za-z]/.test(identity)) throw new Error('SSH 키 경로를 해석할 수 없습니다. 전체 파일 경로를 입력하십시오.')
  return path.resolve(homeDir, identity)
}

function publicLine(content) {
  const value = String(content).trim()
  if (/[\r\n\x00-\x1f\x7f]/.test(value)) return ''
  const match = value.match(/^(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-ssh-\S+|sk-ecdsa-\S+|rsa-sha2-\S+)\s+([A-Za-z0-9+/]+={0,3})(?:\s+.*)?$/)
  if (!match) return ''
  try {
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length < 12) return ''
    const length = bytes.readUInt32BE(0)
    if (length < 1 || length > bytes.length - 4 || bytes.subarray(4, 4 + length).toString('utf8') !== match[1]) return ''
  } catch { return '' }
  return value
}

class LocalKeyStore {
  constructor({ sshDir = path.join(os.homedir(), '.ssh'), run = runKeygen } = {}) {
    this.sshDir = path.resolve(sshDir)
    this.run = run
    this.queue = Promise.resolve()
  }

  async selectedPath(host) {
    const configured = identityPath(host?.identityFile, host, this.sshDir)
    if (configured) return configured
    for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa']) {
      const candidate = path.join(this.sshDir, name)
      if (await present(candidate) || await present(`${candidate}.pub`)) return candidate
    }
    return path.join(this.sshDir, 'codex-manager_ed25519')
  }

  async status(host = {}) {
    const privateKeyPath = await this.selectedPath(host)
    const publicKeyPath = `${privateKeyPath}.pub`
    const [privateExists, publicExists] = await Promise.all([present(privateKeyPath), present(publicKeyPath)])
    const result = { sshDir: this.sshDir, privateKeyPath, publicKeyPath, privateExists, publicExists, fingerprint: '', publicKey: '' }
    if (publicExists) {
      const stat = await fs.stat(publicKeyPath)
      if (stat.isFile() && stat.size <= 65536) {
        const line = publicLine(await fs.readFile(publicKeyPath, 'utf8'))
        if (line) {
          const fingerprint = await this.run(['-lf', publicKeyPath]).catch(() => null)
          if (fingerprint?.code === 0) { result.publicKey = line; result.fingerprint = fingerprint.stdout.trim() }
        }
      }
    }
    return result
  }

  async generate(host = {}) {
    const result = this.queue.then(() => this.generateSelected(host))
    this.queue = result.catch(() => {})
    return result
  }

  async generateSelected(host) {
    const current = await this.status(host)
    if (current.privateExists && current.publicExists) {
      if (!current.publicKey) throw new Error('기존 공개키를 읽을 수 없습니다. SSH 키 파일을 점검하십시오.')
      return current
    }
    if (current.publicExists) throw new Error('공개키만 있는 경로에는 새 키를 만들 수 없습니다. 기존 키를 이동하거나 다른 키 경로를 입력하십시오.')
    const directory = path.dirname(current.privateKeyPath)
    if (!current.privateExists && directory !== this.sshDir && !directory.startsWith(`${this.sshDir}${path.sep}`)) throw new Error('새 SSH 키는 SSH 폴더 안의 경로에 생성할 수 있습니다.')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryDir = await fs.mkdtemp(path.join(directory, '.codex-manager-key-'))
    await fs.chmod(temporaryDir, 0o700)
    const temporaryPrivate = path.join(temporaryDir, 'identity')
    const temporaryPublic = `${temporaryPrivate}.pub`
    let installedPrivate = false
    let installedPublic = false
    try {
      if (current.privateExists) {
        const derived = await this.run(['-y', '-P', '', '-f', current.privateKeyPath])
        const key = derived.code === 0 ? publicLine(derived.stdout) : ''
        if (!key) throw new Error('공개키를 만들 수 없습니다. 비밀번호가 설정된 키는 공개키 파일을 직접 추가하십시오.')
        await fs.writeFile(temporaryPublic, `${key}\n`, { flag: 'wx', mode: 0o644 })
        const check = await this.run(['-lf', temporaryPublic])
        if (check.code !== 0) throw new Error('SSH 공개키 형식이 올바르지 않습니다.')
      } else {
        const generated = await this.run(['-t', 'ed25519', '-f', temporaryPrivate, '-N', '', '-C', `codex-account-manager@${os.hostname()}`])
        if (generated.code !== 0) throw new Error('SSH 키 생성에 실패했습니다.')
        await fs.chmod(temporaryPrivate, 0o600)
        await fs.chmod(temporaryPublic, 0o644)
        // Hard links fail if a destination already exists; existing keys are never replaced.
        await fs.link(temporaryPrivate, current.privateKeyPath)
        installedPrivate = true
      }
      await fs.link(temporaryPublic, current.publicKeyPath)
      installedPublic = true
      return await this.status({ ...host, identityFile: current.privateKeyPath })
    } catch (error) {
      if (installedPrivate && !installedPublic) {
        const [target, original] = await Promise.all([fs.lstat(current.privateKeyPath).catch(() => null), fs.lstat(temporaryPrivate).catch(() => null)])
        if (target && original && target.ino === original.ino && target.dev === original.dev) await fs.unlink(current.privateKeyPath).catch(() => {})
      }
      if (error.code === 'EEXIST') throw new Error('SSH 키 파일이 이미 있습니다. 기존 키를 변경하지 않았습니다.')
      throw error
    } finally { await fs.rm(temporaryDir, { recursive: true, force: true }) }
  }
}

module.exports = { LocalKeyStore, identityPath, publicLine }
