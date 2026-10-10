const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { SshConfigStore, concreteAlias } = require('../electron/ssh-config.cjs')
const exec = promisify(execFile)

async function fixture(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-host-config-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const configPath = path.join(root, 'ssh', 'config')
  if (content !== undefined) { await fs.mkdir(path.dirname(configPath)); await fs.writeFile(configPath, content, { mode: 0o600 }) }
  return { root, configPath, store: new SshConfigStore({ configPath }) }
}

test('reading an absent SSH config does not create files', async t => {
  const { configPath, store } = await fixture(t)
  const state = await store.read()
  assert.equal(state.configPath, configPath)
  assert.deepEqual(state.hosts, [])
  assert.deepEqual(state.groups, [])
  await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' })
  assert.equal((await store.read()).revision, state.revision)
})

test('editing one host preserves unrelated blocks, comments, unknown options and CRLF', async t => {
  const before = '# SSH hosts\r\nInclude ~/.ssh/extra.conf\r\n\r\n'
  const body = 'Host alpha prod-alpha\r\n  HostName 10.0.0.1 # private network\r\n  User old-user\r\n  Port 22\r\n  # remote-mgmt-tags: prod, linux\r\n  Compression yes\r\n  LocalForward 8123 127.0.0.1:8123\r\n\r\n'
  const after = '# conditional connection\r\nMatch host office\r\n  User office-user\r\n\r\nHost beta\r\n  HostName 10.0.0.2\r\n  IdentityFile "~/.ssh/key with space"\r\n\r\nHost *\r\n  ServerAliveInterval 30\r\n'
  const { store, configPath } = await fixture(t, before + body + after)
  const state = await store.read()
  const betaId = state.hosts[1].id
  const next = await store.save({ ...state.hosts[0], hostName: '10.0.0.9', user: 'new-user', port: '2202' }, state.revision)
  const result = await fs.readFile(configPath, 'utf8')
  assert.ok(result.startsWith(before))
  assert.ok(result.endsWith(after))
  assert.ok(result.includes('  HostName 10.0.0.9 # private network\r\n'))
  assert.ok(result.includes('  Compression yes\r\n  LocalForward 8123 127.0.0.1:8123\r\n'))
  assert.ok(!/(?<!\r)\n/.test(result))
  assert.deepEqual(next.hosts[0].tags, ['prod', 'linux'])
  assert.equal(next.hosts[0].id, state.hosts[0].id)
  assert.equal(next.hosts[1].id, betaId)
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(path.dirname(configPath), backups[0]), 'utf8'), before + body + after)
  assert.equal((await fs.stat(path.join(path.dirname(configPath), backups[0]))).mode & 0o777, 0o600)
})

test('stale edits and removals do not overwrite changes made by another application', async t => {
  const { configPath, store } = await fixture(t, 'Host alpha\n  HostName 10.0.0.1\n')
  const old = await store.read()
  const external = 'Host alpha\n  HostName 10.0.0.20\n# changed outside the app\n'
  await fs.writeFile(configPath, external)
  await assert.rejects(store.save({ id: old.hosts[0].id, hostName: '10.0.0.2' }, old.revision), /설정이 변경/)
  await assert.rejects(store.remove(old.hosts[0].id, old.revision), /설정이 변경/)
  assert.equal(await fs.readFile(configPath, 'utf8'), external)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('two competing saves preserve the first successful write', async t => {
  const { configPath, store } = await fixture(t, 'Host alpha\n  HostName 10.0.0.1\n')
  const state = await store.read()
  const results = await Promise.allSettled([
    store.save({ id: state.hosts[0].id, hostName: '10.0.0.2' }, state.revision),
    store.save({ id: state.hosts[0].id, hostName: '10.0.0.3' }, state.revision),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(await fs.readFile(configPath, 'utf8'), /HostName 10\.0\.0\.2/)
})

test('new hosts precede wildcard defaults and OpenSSH resolves their explicit values', async t => {
  const { store, configPath } = await fixture(t, '# defaults\nHost *\n  User default-user\n  Port 22\n  Compression yes\n')
  const state = await store.read()
  const next = await store.save({ alias: 'new-server', hostName: '127.0.0.1', user: 'new-user', port: '2202' }, state.revision)
  assert.equal(next.hosts[0].alias, 'new-server')
  assert.equal(next.hosts[1].alias, '*')
  assert.equal(next.hosts[1].connectable, false)
  const { stdout } = await exec('ssh', ['-G', '-F', configPath, 'new-server'])
  assert.match(stdout, /^hostname 127\.0\.0\.1$/m)
  assert.match(stdout, /^user new-user$/m)
  assert.match(stdout, /^port 2202$/m)
  assert.match(stdout, /^compression yes$/m)
})

test('deleting a host keeps subsequent host comments and Match settings', async t => {
  const original = '# main hosts\nHost alpha\n  HostName 10.0.0.1\n\n# office connection\nMatch host office\n  User office-user\n\n# second server\nHost beta\n  HostName 10.0.0.2\n'
  const { store, configPath } = await fixture(t, original)
  const state = await store.read()
  const after = await store.remove(state.hosts[0].id, state.revision)
  assert.deepEqual(after.hosts.map(host => host.alias), ['beta'])
  assert.equal(after.hosts[0].id, state.hosts[1].id)
  assert.equal(await fs.readFile(configPath, 'utf8'), '# main hosts\n\n# office connection\nMatch host office\n  User office-user\n\n# second server\nHost beta\n  HostName 10.0.0.2\n')
})

test('host input cannot inject new SSH sections and invalid ports do not create backups', async t => {
  const original = 'Host alpha\n  HostName 10.0.0.1\n'
  const { store, configPath } = await fixture(t, original)
  const state = await store.read()
  for (const draft of [
    { alias: 'beta\nHost attacker' }, { alias: 'beta', hostName: 'host\u0000name' },
    { alias: 'beta', user: 'name\nProxyCommand bad' }, { alias: 'beta', port: '0' },
    { alias: 'beta', port: '65536' }, { alias: 'beta', port: '22 23' },
    { alias: 'beta', optionsText: 'Compression yes\nHost attacker\nUser root' },
    { alias: 'beta', optionsText: 'Match all\nProxyCommand bad' },
  ]) await assert.rejects(store.save(draft, state.revision))
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('wildcard and negated aliases can be edited but never executed', async t => {
  const { store } = await fixture(t, 'Host *.internal !excluded\n  User root\nHost !excluded\n  User root\nHost safe-host\n  User deploy\n')
  const state = await store.read()
  assert.deepEqual(state.hosts.map(host => host.connectable), [false, false, true])
  const changed = await store.save({ id: state.hosts[0].id, user: 'deploy' }, state.revision)
  assert.equal(changed.hosts[0].user, 'deploy')
  for (const unsafe of ['-oProxyCommand=x', '!server', 'a b', 'a\n', 'a*', 'a?', 'a[12]']) assert.equal(concreteAlias(unsafe), false)
})

test('saving a symlinked config updates its target and keeps existing permissions', async t => {
  const { root, configPath, store } = await fixture(t)
  const target = path.join(root, 'shared-config')
  await fs.mkdir(path.dirname(configPath))
  await fs.writeFile(target, 'Host alpha\n  HostName 10.0.0.1\n')
  await fs.chmod(target, 0o640)
  await fs.symlink(target, configPath)
  const state = await store.read()
  await store.save({ id: state.hosts[0].id, hostName: '10.0.0.2' }, state.revision)
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
  assert.match(await fs.readFile(target, 'utf8'), /HostName 10\.0\.0\.2/)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
})

test('renaming into another host fails while imported duplicate blocks remain editable', async t => {
  const original = 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\nHost beta\n  User deploy\n'
  const { configPath, store } = await fixture(t, original)
  const state = await store.read()
  await assert.rejects(store.save({ id: state.hosts[0].id, alias: 'beta' }, state.revision), /같은 이름/)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  const changed = await store.save({ id: state.hosts[2].id, user: 'other-user' }, state.revision)
  assert.equal(changed.hosts[2].user, 'other-user')
  assert.equal(changed.hosts[2].id, state.hosts[2].id)
})

test('a dangling config symlink is not replaced by a new file', async t => {
  const { root, configPath, store } = await fixture(t)
  await fs.mkdir(path.dirname(configPath))
  const target = path.join(root, 'missing-config')
  await fs.symlink(target, configPath)
  await assert.rejects(store.read(), /연결 대상 파일/)
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})

test('identity paths containing spaces stay valid for OpenSSH', async t => {
  const { root, store, configPath } = await fixture(t, '')
  const identityFile = path.join(root, 'key with space')
  const state = await store.read()
  await store.save({ alias: 'server', hostName: '127.0.0.1', identityFile }, state.revision)
  const { stdout } = await exec('ssh', ['-G', '-F', configPath, 'server'])
  assert.ok(stdout.includes(`identityfile ${identityFile}\n`))
})

test('display reordering survives reload while preserving every original SSH byte and backup', async t => {
  const original = '# shared settings\r\nInclude ~/.ssh/extra.conf\r\n\r\nHost alpha prod-alpha\r\n  HostName 10.0.0.1\r\n  # alpha comment\r\n  Compression yes\r\n\r\nMatch host office\r\n  User office-user\r\nHost beta\r\n  HostName 10.0.0.2\r\nHost *\r\n  ServerAliveInterval 30'
  const { configPath, store } = await fixture(t, original)
  const before = await store.read()
  const ids = [before.hosts[2].id, before.hosts[1].id, before.hosts[0].id]
  const next = await store.reorder(ids, before.revision)
  const written = await fs.readFile(configPath, 'utf8')
  assert.deepEqual(next.hosts.map(host => host.id), ids)
  assert.notEqual(next.revision, before.revision)
  assert.equal(written.slice(written.indexOf('\r\n') + 2), original)
  assert.ok(!/(?<!\r)\n/.test(written))
  assert.deepEqual(next.hosts.map(host => host.optionsText), ids.map(id => before.hosts.find(host => host.id === id).optionsText))
  const restarted = await new SshConfigStore({ configPath }).read()
  assert.deepEqual(restarted.hosts.map(host => host.id), ids)
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(path.dirname(configPath), backups[0]), 'utf8'), original)
  const unchanged = await store.reorder(ids, next.revision)
  assert.equal(unchanged.revision, next.revision)
  assert.equal((await fs.readdir(path.dirname(configPath))).length, 2)
})

test('display order leaves wildcard, Match and Include resolution unchanged in OpenSSH', async t => {
  const { root, configPath, store } = await fixture(t, '')
  const included = path.join(root, 'included-config')
  await fs.writeFile(included, 'Host alpha\n  Compression yes\nHost beta\n  ServerAliveInterval 47\n')
  const original = `# global include\nInclude ${included}\nHost alpha\n  HostName 127.0.0.1\n  User alpha-user\n  Port 2201\nHost *\n  User fallback-user\n  Port 2202\nMatch host beta\n  HostName 127.0.0.2\n  ServerAliveCountMax 8\nHost beta\n  User beta-user\n  Port 2203\n`
  await fs.writeFile(configPath, original)
  const resolve = async alias => (await exec('ssh', ['-G', '-F', configPath, alias])).stdout
  const before = await Promise.all(['alpha', 'beta', 'other'].map(resolve))
  const state = await store.read()
  await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  const after = await Promise.all(['alpha', 'beta', 'other'].map(resolve))
  assert.deepEqual(after, before)
  assert.match(before[1], /^user fallback-user$/m)
  assert.match(before[1], /^serveraliveinterval 47$/m)
  assert.match(before[1], /^serveralivecountmax 8$/m)
})

test('invalid or stale display orders do not write a config or backup', async t => {
  const original = 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\n'
  const { configPath, store } = await fixture(t, original)
  const state = await store.read()
  const [one, two] = state.hosts.map(host => host.id)
  for (const ids of [null, {}, [one], [one, one], [one, 'host-missing'], [one, two, 'host-extra'], [one, 2]]) await assert.rejects(store.reorder(ids, state.revision), /모든 호스트/)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
  const external = original + '# changed by another application\n'
  await fs.writeFile(configPath, external)
  await assert.rejects(store.reorder([two, one], state.revision), /설정이 변경/)
  assert.equal(await fs.readFile(configPath, 'utf8'), external)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('competing display orders preserve the first successful write', async t => {
  const { store } = await fixture(t, 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\nHost gamma\n  HostName 10.0.0.3\n')
  const state = await store.read()
  const ids = state.hosts.map(host => host.id)
  const first = [ids[1], ids[2], ids[0]]
  const results = await Promise.allSettled([store.reorder(first, state.revision), store.reorder(ids.reverse(), state.revision)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.deepEqual((await store.read()).hosts.map(host => host.id), first)
})

test('external host additions and removals retain saved order and append unknown hosts', async t => {
  const original = 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\nHost gamma\n  HostName 10.0.0.3\n'
  const { configPath, store } = await fixture(t, original)
  const state = await store.read()
  const ordered = await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  const comment = (await fs.readFile(configPath, 'utf8')).split('\n')[0] + '\n'
  await fs.writeFile(configPath, comment + 'Host added\n  User added-user\n' + original.replace('Host beta\n  HostName 10.0.0.2\n', ''))
  const changed = await store.read()
  assert.deepEqual(changed.hosts.map(host => host.alias), ['gamma', 'alpha', 'added'])
  assert.equal(changed.hosts[0].id, ordered.hosts[0].id)
  assert.equal(changed.hosts[1].id, ordered.hosts[2].id)
})

test('renaming a host retains its displayed position and edits target the correct physical block', async t => {
  const original = 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\nHost gamma\n  HostName 10.0.0.3\n'
  const { configPath, store } = await fixture(t, original)
  const state = await store.read()
  const ordered = await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  const changed = await store.save({ id: ordered.hosts[0].id, alias: 'renamed', user: 'deploy' }, ordered.revision)
  assert.deepEqual(changed.hosts.map(host => host.alias), ['renamed', 'beta', 'alpha'])
  const content = await fs.readFile(configPath, 'utf8')
  assert.ok(content.indexOf('Host alpha') < content.indexOf('Host beta'))
  assert.ok(content.indexOf('Host beta') < content.indexOf('Host renamed'))
  assert.match(content, /Host renamed\n  HostName 10\.0\.0\.3\n  User deploy\n/)
  const removed = await store.remove(changed.hosts[1].id, changed.revision)
  assert.deepEqual(removed.hosts.map(host => host.alias), ['renamed', 'alpha'])
})

test('display reordering preserves a config symlink and target permissions', async t => {
  const { root, configPath, store } = await fixture(t)
  const target = path.join(root, 'shared-config')
  await fs.mkdir(path.dirname(configPath))
  const original = 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n'
  await fs.writeFile(target, original)
  await fs.chmod(target, 0o640)
  await fs.symlink(target, configPath)
  const state = await store.read()
  await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  assert.ok((await fs.readFile(target, 'utf8')).endsWith(original))
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('groups, membership and collapsed state survive reload without moving SSH sections', async t => {
  const original = '# shared settings\r\nInclude ~/.ssh/extra.conf\r\n\r\nHost alpha\r\n  HostName 10.0.0.1\r\nMatch host office\r\n  User office-user\r\nHost beta\r\n  HostName 10.0.0.2\r\nHost *\r\n  ServerAliveInterval 30'
  const { configPath, store } = await fixture(t, original)
  let state = await store.read()
  assert.ok(state.hosts.every(host => host.groupId === null))
  state = await store.saveGroup({ name: '운영 서버' }, state.revision)
  const groupId = state.groups[0].id
  assert.deepEqual(state.groups, [{ id: groupId, name: '운영 서버', collapsed: false }])
  state = await store.moveHostToGroup(state.hosts[0].id, groupId, state.revision)
  state = await store.setGroupCollapsed(groupId, true, state.revision)
  const written = await fs.readFile(configPath, 'utf8')
  assert.equal(written.slice(written.indexOf('\r\n') + 2), original)
  assert.ok(!/(?<!\r)\n/.test(written))
  const reloaded = await new SshConfigStore({ configPath }).read()
  assert.deepEqual(reloaded.groups, [{ id: groupId, name: '운영 서버', collapsed: true }])
  assert.deepEqual(reloaded.hosts.map(host => host.groupId), [groupId, null, null])
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'))
  assert.equal(backups.length, 3)
  const originals = await Promise.all(backups.map(name => fs.readFile(path.join(path.dirname(configPath), name), 'utf8')))
  assert.ok(originals.includes(original))
  assert.ok((await Promise.all(backups.map(name => fs.stat(path.join(path.dirname(configPath), name))))).every(stat => (stat.mode & 0o777) === 0o600))
})

test('group assignment and display order commit together with one backup', async t => {
  const original = 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\nHost gamma\n  User gamma-user\n'
  const { store, configPath } = await fixture(t, original)
  let state = await store.read()
  state = await store.saveGroup({ name: '개발 서버' }, state.revision)
  const beforeMove = await fs.readFile(configPath, 'utf8')
  const beforeFiles = (await fs.readdir(path.dirname(configPath))).length
  const ids = state.hosts.map(host => host.id).reverse()
  state = await store.moveHostToGroup(ids[0], state.groups[0].id, state.revision, ids)
  assert.deepEqual(state.hosts.map(host => host.id), ids)
  assert.equal(state.hosts[0].groupId, state.groups[0].id)
  assert.equal((await fs.readdir(path.dirname(configPath))).length, beforeFiles + 1)
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'))
  assert.ok((await Promise.all(backups.map(name => fs.readFile(path.join(path.dirname(configPath), name), 'utf8')))).includes(beforeMove))
  const written = await fs.readFile(configPath, 'utf8')
  assert.equal(written.split('\n').filter(line => !line.startsWith('# codex-manager-host-')).join('\n'), original)
  const reloaded = await new SshConfigStore({ configPath }).read()
  assert.deepEqual(reloaded.hosts.map(host => [host.id, host.groupId]), state.hosts.map(host => [host.id, host.groupId]))
})

test('renaming and deleting a group keeps every host and displayed order', async t => {
  const original = 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n'
  const { store, configPath } = await fixture(t, original)
  let state = await store.read()
  state = await store.saveGroup({ name: '개발' }, state.revision)
  const groupId = state.groups[0].id
  state = await store.moveHostToGroup(state.hosts[0].id, groupId, state.revision, state.hosts.map(host => host.id).reverse())
  state = await store.saveGroup({ id: groupId, name: '운영' }, state.revision)
  assert.equal(state.groups[0].name, '운영')
  assert.equal(state.hosts[1].groupId, groupId)
  const ids = state.hosts.map(host => host.id)
  state = await store.deleteGroup(groupId, state.revision)
  assert.deepEqual(state.groups, [])
  assert.deepEqual(state.hosts.map(host => host.id), ids)
  assert.ok(state.hosts.every(host => host.groupId === null))
  assert.equal((await fs.readFile(configPath, 'utf8')).split('\n').filter(line => !line.startsWith('# codex-manager-host-')).join('\n'), original)
})

test('saving, renaming and removing hosts retain or remove their group membership', async t => {
  const { store } = await fixture(t, 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '관리 서버' }, state.revision)
  const groupId = state.groups[0].id
  const alphaId = state.hosts[0].id
  state = await store.save({ id: alphaId, groupId }, state.revision)
  state = await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  state = await store.save({ id: alphaId, alias: 'renamed' }, state.revision)
  assert.deepEqual(state.hosts.map(host => host.alias), ['beta', 'renamed'])
  assert.equal(state.hosts[1].groupId, groupId)
  state = await store.save({ alias: 'new-host', user: 'new-user', groupId }, state.revision)
  assert.equal(state.hosts.find(host => host.alias === 'new-host').groupId, groupId)
  const renamedId = state.hosts.find(host => host.alias === 'renamed').id
  state = await store.remove(renamedId, state.revision)
  assert.equal(state.hosts.some(host => host.id === renamedId), false)
  assert.equal(state.hosts.find(host => host.alias === 'new-host').groupId, groupId)
  state = await store.save({ id: state.hosts.find(host => host.alias === 'new-host').id, groupId: null }, state.revision)
  assert.ok(state.hosts.every(host => host.groupId === null))
})

test('duplicate imported host IDs are remapped to the same physical host after removal', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User first-user\nHost alpha\n  User second-user\nHost beta\n  User beta-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '두 번째 서버' }, state.revision)
  const groupId = state.groups[0].id
  const [firstId, secondId, betaId] = state.hosts.map(host => host.id)
  state = await store.moveHostToGroup(secondId, groupId, state.revision, [secondId, betaId, firstId])
  state = await store.remove(firstId, state.revision)
  assert.deepEqual(state.hosts.map(host => host.user), ['second-user', 'beta-user'])
  assert.equal(state.hosts[0].id, firstId)
  assert.equal(state.hosts[0].groupId, groupId)
  assert.equal(state.hosts[1].groupId, null)
  const groupLine = (await fs.readFile(configPath, 'utf8')).split('\n').find(line => line.startsWith('# codex-manager-host-groups:'))
  assert.deepEqual(JSON.parse(groupLine.slice(groupLine.indexOf(':') + 1)).hosts, { [firstId]: groupId })
})

test('renaming the first duplicate keeps group membership attached to each physical block', async t => {
  const { store } = await fixture(t, 'Host alpha\n  User first-user\nHost alpha\n  User second-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '첫 번째' }, state.revision)
  state = await store.saveGroup({ name: '두 번째' }, state.revision)
  const [firstGroup, secondGroup] = state.groups.map(group => group.id)
  const [firstId, secondId] = state.hosts.map(host => host.id)
  state = await store.moveHostToGroup(firstId, firstGroup, state.revision)
  state = await store.moveHostToGroup(secondId, secondGroup, state.revision, [secondId, firstId])
  state = await store.save({ id: firstId, alias: 'renamed' }, state.revision)
  assert.deepEqual(state.hosts.map(host => [host.alias, host.user, host.groupId]), [
    ['alpha', 'second-user', secondGroup], ['renamed', 'first-user', firstGroup],
  ])
})

test('invalid group inputs and invalid atomic orders do not change any file', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  const original = await fs.readFile(configPath, 'utf8')
  const originalFiles = await fs.readdir(path.dirname(configPath))
  const groupId = state.groups[0].id, hostId = state.hosts[0].id
  for (const draft of [null, [], {}, { name: '' }, { name: ' ' }, { name: 1 }, { name: 'A\nHost bad' }, { name: 'A\u0000' }, { name: 'A'.repeat(121) }, { name: ' 운영 ' }, { id: null, name: '새 그룹' }, { id: 'missing', name: '새 그룹' }]) await assert.rejects(store.saveGroup(draft, state.revision))
  for (const id of [undefined, '', false, 'missing', '__proto__', groupId + '\n']) await assert.rejects(store.moveHostToGroup(hostId, id, state.revision))
  await assert.rejects(store.moveHostToGroup('missing', groupId, state.revision), /호스트를 찾을 수/)
  await assert.rejects(store.moveHostToGroup(hostId, groupId, state.revision, [hostId]), /모든 호스트/)
  await assert.rejects(store.moveHostToGroup(hostId, groupId, state.revision, [hostId, hostId]), /모든 호스트/)
  await assert.rejects(store.setGroupCollapsed(groupId, 'true', state.revision), /접기 상태/)
  await assert.rejects(store.deleteGroup('missing', state.revision), /그룹을 찾을 수/)
  await assert.rejects(store.save({ id: hostId, groupId: 'missing', user: 'changed' }, state.revision), /그룹을 찾을 수/)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), originalFiles)
})

test('stale group actions cannot overwrite another application’s SSH changes', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User alpha-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  const groupId = state.groups[0].id, hostId = state.hosts[0].id
  const external = (await fs.readFile(configPath, 'utf8')) + '# external change\n'
  const originalFiles = await fs.readdir(path.dirname(configPath))
  await fs.writeFile(configPath, external)
  for (const action of [
    () => store.saveGroup({ name: '개발' }, state.revision),
    () => store.saveGroup({ id: groupId, name: '개발' }, state.revision),
    () => store.deleteGroup(groupId, state.revision),
    () => store.setGroupCollapsed(groupId, true, state.revision),
    () => store.moveHostToGroup(hostId, groupId, state.revision),
  ]) await assert.rejects(action(), /설정이 변경/)
  assert.equal(await fs.readFile(configPath, 'utf8'), external)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), originalFiles)
})

test('competing group assignments preserve the first successful assignment and order', async t => {
  const { store } = await fixture(t, 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  state = await store.saveGroup({ name: '개발' }, state.revision)
  const ids = state.hosts.map(host => host.id), groups = state.groups.map(group => group.id)
  const results = await Promise.allSettled([
    store.moveHostToGroup(ids[0], groups[0], state.revision, [...ids].reverse()),
    store.moveHostToGroup(ids[0], groups[1], state.revision, ids),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  const after = await store.read()
  assert.deepEqual(after.hosts.map(host => host.id), [...ids].reverse())
  assert.equal(after.hosts[1].groupId, groups[0])
})

test('unchanged group actions do not create extra backups', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User alpha-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  const files = await fs.readdir(path.dirname(configPath))
  const groupId = state.groups[0].id
  const unchanged = await store.saveGroup({ id: groupId, name: ' 운영 ' }, state.revision)
  assert.equal(unchanged.revision, state.revision)
  assert.equal((await store.setGroupCollapsed(groupId, false, state.revision)).revision, state.revision)
  assert.equal((await store.moveHostToGroup(state.hosts[0].id, null, state.revision, [state.hosts[0].id])).revision, state.revision)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), files)
})

test('malformed and stale group metadata do not prevent reading SSH hosts', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User alpha-user\n')
  const hostId = (await store.read()).hosts[0].id
  const malformed = [
    '{invalid', '[]', 'null', JSON.stringify({ groups: [], hosts: [] }),
    JSON.stringify({ groups: [{ id: 'group-ok', name: 'Bad\nname' }], hosts: {} }),
    JSON.stringify({ groups: [{ id: 'group-ok', name: 'A', collapsed: 'yes' }], hosts: {} }),
    JSON.stringify({ groups: [{ id: 'group-ok', name: 'A' }, { id: 'group-ok', name: 'B' }], hosts: {} }),
  ]
  for (const metadata of malformed) {
    const original = `# codex-manager-host-groups: ${metadata}\nHost alpha\n  User alpha-user\n`
    await fs.writeFile(configPath, original)
    const state = await store.read()
    assert.deepEqual(state.groups, [])
    assert.equal(state.hosts[0].groupId, null)
    assert.equal(await fs.readFile(configPath, 'utf8'), original)
  }
  const metadata = JSON.stringify({ groups: [{ id: 'group-ok', name: '운영' }], hosts: { [hostId]: 'missing-group', 'host-missing': 'group-ok' } })
  await fs.writeFile(configPath, `# codex-manager-host-groups: ${metadata}\nHost alpha\n  User alpha-user\n`)
  const state = await store.read()
  assert.deepEqual(state.groups, [{ id: 'group-ok', name: '운영', collapsed: false }])
  assert.equal(state.hosts[0].groupId, null)
  const changed = await store.setGroupCollapsed('group-ok', true, state.revision)
  assert.equal(changed.groups[0].collapsed, true)
  const written = await fs.readFile(configPath, 'utf8')
  assert.equal(written.includes('host-missing'), false)
  assert.equal(written.includes('missing-group'), false)
})

test('group metadata inside a Host body is preserved as a comment and is not a group preference', async t => {
  const original = 'Host alpha\n  User alpha-user\n  # codex-manager-host-groups: {"groups":[{"id":"group-body","name":"Body"}],"hosts":{}}\nHost beta\n  User beta-user\n'
  const { store, configPath } = await fixture(t, original)
  let state = await store.read()
  assert.deepEqual(state.groups, [])
  state = await store.saveGroup({ name: '운영' }, state.revision)
  assert.deepEqual(state.groups.map(group => group.name), ['운영'])
  assert.ok((await fs.readFile(configPath, 'utf8')).endsWith(original))
})

test('group mutations preserve a config symlink and target permissions', async t => {
  const { root, store, configPath } = await fixture(t)
  const target = path.join(root, 'shared-config')
  const original = 'Host alpha\n  User alpha-user\n'
  await fs.mkdir(path.dirname(configPath))
  await fs.writeFile(target, original)
  await fs.chmod(target, 0o640)
  await fs.symlink(target, configPath)
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  state = await store.moveHostToGroup(state.hosts[0].id, state.groups[0].id, state.revision)
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  assert.ok((await fs.readFile(target, 'utf8')).endsWith(original))
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('groups and membership leave OpenSSH Include, Match and wildcard resolution unchanged', async t => {
  const { root, store, configPath } = await fixture(t, '')
  const included = path.join(root, 'included-config')
  await fs.writeFile(included, 'Host alpha\n  Compression yes\nHost beta\n  ServerAliveInterval 47\n')
  const original = `# global include\nInclude ${included}\nHost alpha\n  HostName 127.0.0.1\n  User alpha-user\n  Port 2201\nHost *\n  User fallback-user\n  Port 2202\nMatch host beta\n  HostName 127.0.0.2\n  ServerAliveCountMax 8\nHost beta\n  User beta-user\n  Port 2203\n`
  await fs.writeFile(configPath, original)
  const resolve = async alias => (await exec('ssh', ['-G', '-F', configPath, alias])).stdout
  const before = await Promise.all(['alpha', 'beta', 'other'].map(resolve))
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  const groupId = state.groups[0].id
  state = await store.moveHostToGroup(state.hosts[0].id, groupId, state.revision, state.hosts.map(host => host.id).reverse())
  state = await store.setGroupCollapsed(groupId, true, state.revision)
  state = await store.saveGroup({ id: groupId, name: '서비스 서버' }, state.revision)
  assert.deepEqual(await Promise.all(['alpha', 'beta', 'other'].map(resolve)), before)
  await store.deleteGroup(groupId, state.revision)
  assert.deepEqual(await Promise.all(['alpha', 'beta', 'other'].map(resolve)), before)
})

test('connection revision ignores group and order preferences but detects global SSH changes', async t => {
  const original = '# global options\r\nInclude ~/.ssh/extra.conf\r\nHost alpha\r\n  User alpha-user\r\nHost beta\r\n  User beta-user\r\nHost *\r\n  ServerAliveInterval 30\r\n'
  const { store, configPath } = await fixture(t, original)
  let state = await store.read()
  const initial = state.connectionRevision
  state = await store.saveGroup({ id: undefined, name: '운영' }, state.revision)
  assert.equal(state.connectionRevision, initial)
  const groupId = state.groups[0].id
  state = await store.moveHostToGroup(state.hosts[0].id, groupId, state.revision, state.hosts.map(host => host.id).reverse())
  assert.equal(state.connectionRevision, initial)
  state = await store.setGroupCollapsed(groupId, true, state.revision)
  assert.equal(state.connectionRevision, initial)
  state = await store.saveGroup({ id: groupId, name: '서비스 서버' }, state.revision)
  assert.equal(state.connectionRevision, initial)
  state = await store.reorder(state.hosts.map(host => host.id).reverse(), state.revision)
  assert.equal(state.connectionRevision, initial)
  state = await store.deleteGroup(groupId, state.revision)
  assert.equal(state.connectionRevision, initial)
  const edited = (await fs.readFile(configPath, 'utf8')).replace('ServerAliveInterval 30', 'ServerAliveInterval 60')
  await fs.writeFile(configPath, edited)
  assert.notEqual((await store.read()).connectionRevision, initial)
})

test('connection revision includes app-like comments within Host sections', async t => {
  const original = 'Host alpha\n  User alpha-user\n  # codex-manager-host-groups: inside the Host section\n'
  const { store, configPath } = await fixture(t, original)
  const state = await store.read()
  await fs.writeFile(configPath, original.replace('inside the Host section', 'edited section comment'))
  assert.notEqual((await store.read()).connectionRevision, state.connectionRevision)
})

test('batch host removal preserves remaining Host, Match and Include bytes with one backup', async t => {
  const preamble = '# shared settings\r\nInclude ~/.ssh/extra.conf\r\n\r\n'
  const alpha = 'Host alpha\r\n  HostName 10.0.0.1\r\n  Compression yes\r\n\r\n'
  const conditional = '# office connection\r\nMatch host office\r\n  User office-user\r\n  Include ~/.ssh/office.conf\r\n\r\n'
  const beta = 'Host beta\r\n  HostName 10.0.0.2\r\n  LocalForward 8123 127.0.0.1:8123\r\n\r\n'
  const gamma = '# remaining server\r\nHost gamma\r\n  HostName 10.0.0.3\r\n  IdentityFile "~/.ssh/key with space"\r\n\r\nHost *\r\n  ServerAliveInterval 30'
  const original = preamble + alpha + conditional + beta + gamma
  const { configPath, store } = await fixture(t, original)
  const state = await store.read()
  const result = await store.removeMany(state.hosts.slice(0, 2).map(host => host.id).reverse(), state.revision)
  assert.deepEqual(result.hosts.map(host => host.alias), ['gamma', '*'])
  const written = await fs.readFile(configPath, 'utf8')
  assert.equal(written, preamble + '\r\n' + conditional + '\r\n' + gamma)
  assert.ok(!/(?<!\r)\n/.test(written))
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(path.dirname(configPath), backups[0]), 'utf8'), original)
})

test('invalid, missing and stale batch removal selections do not delete a subset or create backups', async t => {
  const original = 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\n'
  const { store, configPath } = await fixture(t, original)
  const state = await store.read(), ids = state.hosts.map(host => host.id)
  for (const selected of [null, {}, [], [ids[0], ids[0]], [ids[0], 'missing'], [ids[0], 1], [''], ['x'.repeat(257)]]) await assert.rejects(store.removeMany(selected, state.revision))
  await assert.rejects(store.removeMany(ids, 'outdated'), /설정이 변경/)
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
  const external = original + '# external change\n'
  await fs.writeFile(configPath, external)
  await assert.rejects(store.removeMany(ids, state.revision), /설정이 변경/)
  assert.equal(await fs.readFile(configPath, 'utf8'), external)
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
})

test('batch removal cleans group assignments and order for duplicate imported blocks', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User first-user\nHost alpha\n  User second-user\nHost beta\n  User beta-user\nHost gamma\n  User gamma-user\n')
  let state = await store.read()
  state = await store.saveGroup({ name: '운영' }, state.revision)
  const groupId = state.groups[0].id
  const [firstId, secondId, betaId, gammaId] = state.hosts.map(host => host.id)
  state = await store.moveHostToGroup(secondId, groupId, state.revision, [gammaId, secondId, betaId, firstId])
  state = await store.moveHostToGroup(betaId, groupId, state.revision)
  state = await store.removeMany([firstId, betaId], state.revision)
  assert.deepEqual(state.hosts.map(host => [host.id, host.user, host.groupId]), [[gammaId, 'gamma-user', null], [firstId, 'second-user', groupId]])
  const lines = (await fs.readFile(configPath, 'utf8')).split('\n')
  const order = JSON.parse(lines.find(line => line.startsWith('# codex-manager-host-order:')).split(':').slice(1).join(':'))
  const groups = JSON.parse(lines.find(line => line.startsWith('# codex-manager-host-groups:')).split(':').slice(1).join(':'))
  assert.deepEqual(order, [gammaId, firstId])
  assert.deepEqual(groups.hosts, { [firstId]: groupId })
  state = await store.removeMany(state.hosts.map(host => host.id), state.revision)
  assert.deepEqual(state.hosts, [])
  assert.deepEqual(state.groups, [{ id: groupId, name: '운영', collapsed: false }])
  const remaining = await fs.readFile(configPath, 'utf8')
  assert.ok(remaining.includes('"hosts":{}'))
  assert.ok(remaining.includes('# codex-manager-host-order: []'))
})

test('competing batch removals commit only the first complete selection', async t => {
  const { store, configPath } = await fixture(t, 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\nHost gamma\n  User gamma-user\n')
  const state = await store.read(), ids = state.hosts.map(host => host.id)
  const results = await Promise.allSettled([store.removeMany([ids[0], ids[1]], state.revision), store.removeMany([ids[1], ids[2]], state.revision)])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.deepEqual((await store.read()).hosts.map(host => host.alias), ['gamma'])
  assert.equal((await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-')).length, 1)
})

test('batch removal preserves the config symlink and target permissions', async t => {
  const { root, configPath, store } = await fixture(t)
  const target = path.join(root, 'shared-config')
  await fs.mkdir(path.dirname(configPath))
  const original = 'Host alpha\n  User alpha-user\nHost beta\n  User beta-user\nHost gamma\n  User gamma-user\n'
  await fs.writeFile(target, original)
  await fs.chmod(target, 0o640)
  await fs.symlink(target, configPath)
  const state = await store.read()
  await store.removeMany(state.hosts.slice(0, 2).map(host => host.id), state.revision)
  assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  assert.equal(await fs.readFile(target, 'utf8'), 'Host gamma\n  User gamma-user\n')
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config'])
  const backups = (await fs.readdir(root)).filter(name => name.includes('.codex-manager-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(path.join(root, backups[0]), 'utf8'), original)
})
