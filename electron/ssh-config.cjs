const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const FIELDS = {
  hostName: 'HostName', user: 'User', port: 'Port', identityFile: 'IdentityFile',
  proxyJump: 'ProxyJump', forwardAgent: 'ForwardAgent', serverAliveInterval: 'ServerAliveInterval',
  strictHostKeyChecking: 'StrictHostKeyChecking',
}
const TAG_LINE = /^\s*#\s*remote-mgmt-tags:\s*(.*)$/i
const ORDER_LINE = /^\s*#\s*codex-manager-host-order:\s*(.*)$/i
const GROUP_LINE = /^\s*#\s*codex-manager-host-groups:\s*(.*)$/i
const MAX_GROUPS = 1000

function validGroupId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)
}

function groupName(value) {
  if (typeof value !== 'string') throw new Error('그룹 이름을 입력하십시오.')
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('그룹 이름에는 줄바꿈이나 제어 문자를 입력할 수 없습니다.')
  const name = value.trim()
  if (!name || name.length > 120) throw new Error('그룹 이름은 1자부터 120자까지 입력하십시오.')
  return name
}

function savedHostGroups(lines) {
  for (const line of lines) {
    const entry = option(line.text)
    if (entry && /^(host|match)$/i.test(entry.key)) break
    const match = line.text.match(GROUP_LINE)
    if (!match || match[1].length > 2 * 1024 * 1024) continue
    try {
      const value = JSON.parse(match[1])
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS) continue
      if (!value.hosts || typeof value.hosts !== 'object' || Array.isArray(value.hosts) || Object.keys(value.hosts).length > 10000) continue
      const ids = new Set(), names = new Set()
      const groups = value.groups.map(group => {
        if (!group || typeof group !== 'object' || Array.isArray(group) || !validGroupId(group.id) || (group.collapsed !== undefined && typeof group.collapsed !== 'boolean')) throw new Error('Invalid group metadata')
        const name = groupName(group.name)
        if (ids.has(group.id) || names.has(name)) throw new Error('Duplicate group metadata')
        ids.add(group.id); names.add(name)
        return { id: group.id, name, collapsed: group.collapsed ?? false }
      })
      const entries = Object.entries(value.hosts)
      if (entries.some(([id, groupId]) => !id || id.length > 256 || typeof groupId !== 'string')) continue
      return { groups, hosts: Object.fromEntries(entries.filter(([, groupId]) => ids.has(groupId))), saved: true }
    } catch { /* Display metadata must never prevent reading the SSH configuration. */ }
  }
  return { groups: [], hosts: {}, saved: false }
}

function option(line) {
  const value = line.trim()
  if (!value || value.startsWith('#')) return null
  const match = value.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  return match ? { key: match[1], value: match[2] } : null
}

function uncomment(value) {
  let quote = '', escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#') return value.slice(0, index).trimEnd()
  }
  return value.trimEnd()
}

function linesOf(content) {
  const result = []
  let start = 0
  while (start < content.length) {
    const newline = content.indexOf('\n', start)
    const end = newline < 0 ? content.length : newline + 1
    const raw = content.slice(start, end)
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : ''
    result.push({ raw, text: eol ? raw.slice(0, -eol.length) : raw, eol, start, end })
    start = end
  }
  return result
}

function concreteAlias(alias) {
  return Boolean(alias) && !/^[!-]/.test(alias) && !/[\s*?\[\]\x00-\x1f\x7f]/.test(alias)
}

function normalizedTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(/[,\n]/)
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
}

function savedHostOrder(lines) {
  for (const line of lines) {
    const entry = option(line.text)
    if (entry && /^(host|match)$/i.test(entry.key)) break
    const match = line.text.match(ORDER_LINE)
    if (!match) continue
    try {
      const ids = JSON.parse(match[1])
      if (Array.isArray(ids) && ids.length <= 10000 && ids.every(id => typeof id === 'string' && id.length <= 256)) return [...new Set(ids)]
    } catch { /* Ignore malformed display preferences; keep SSH options readable. */ }
  }
  return null
}

function orderedHosts(hosts, ids) {
  if (!ids) return hosts
  const remaining = new Map(hosts.map(host => [host.id, host]))
  const ordered = []
  for (const id of ids) {
    if (!remaining.has(id)) continue
    ordered.push(remaining.get(id))
    remaining.delete(id)
  }
  return [...ordered, ...remaining.values()]
}

function withHostOrder(content, ids) {
  return withPreambleComment(content, ORDER_LINE, 'codex-manager-host-order', ids)
}

function withHostGroups(content, groups, hosts) {
  return withPreambleComment(content, GROUP_LINE, 'codex-manager-host-groups', { groups, hosts })
}

function withPreambleComment(content, pattern, name, value) {
  const lines = linesOf(content)
  const eol = lines.find(line => line.eol)?.eol || '\n'
  const retained = withoutPreambleComments(content, [pattern])
  return `# ${name}: ${JSON.stringify(value)}${eol}${retained}`
}

function withoutPreambleComments(content, patterns) {
  let inPreamble = true
  // Only remove this app's preference comments in the preamble. Never move SSH sections.
  return linesOf(content).filter(line => {
    const entry = option(line.text)
    if (entry && /^(host|match)$/i.test(entry.key)) inPreamble = false
    return !inPreamble || !patterns.some(pattern => pattern.test(line.text))
  }).map(line => line.raw).join('')
}

function parseConfig(content) {
  const lines = linesOf(content)
  const blocks = []
  const occurrences = new Map()
  for (let index = 0; index < lines.length; index++) {
    const header = option(lines[index].text)
    if (!header || header.key.toLowerCase() !== 'host') continue
    const hostPatterns = uncomment(header.value).trim().replace(/\s+/g, ' ')
    const patterns = hostPatterns.split(/\s+/).filter(Boolean)
    let endIndex = index + 1
    while (endIndex < lines.length) {
      const next = option(lines[endIndex].text)
      if (next && /^(host|match)$/i.test(next.key)) break
      endIndex++
    }
    const body = lines.slice(index + 1, endIndex)
    const occurrence = occurrences.get(hostPatterns) || 0
    occurrences.set(hostPatterns, occurrence + 1)
    const host = {
      id: `host-${crypto.createHash('sha256').update(hostPatterns).digest('hex').slice(0, 16)}-${occurrence}`,
      alias: patterns[0] || '', hostPatterns, lineNumber: index + 1,
      optionsText: body.map(line => line.text).join('\n'), tags: [],
      connectable: concreteAlias(patterns[0] || ''),
    }
    for (const [field, key] of Object.entries(FIELDS)) {
      const found = body.map(line => option(line.text)).find(item => item && item.key.toLowerCase() === key.toLowerCase())
      host[field] = found ? uncomment(found.value).trim() : ''
    }
    for (const line of body) {
      const tags = line.text.match(TAG_LINE)
      if (tags) host.tags.push(...normalizedTags(tags[1]))
    }
    host.tags = normalizedTags(host.tags)
    blocks.push({ host, start: lines[index].start, end: endIndex < lines.length ? lines[endIndex].start : content.length, header: lines[index], body })
    index = endIndex - 1
  }
  const hostOrder = savedHostOrder(lines)
  const groupMetadata = savedHostGroups(lines)
  const hosts = blocks.map(block => {
    block.host.groupId = groupMetadata.hosts[block.host.id] || null
    return block.host
  })
  return { lines, blocks, hostOrder, groupMetadata, groups: groupMetadata.groups, hosts: orderedHosts(hosts, hostOrder) }
}

function validatedOrder(ids, hosts) {
  const currentIds = hosts.map(host => host.id)
  const requested = new Set(Array.isArray(ids) ? ids : [])
  if (!Array.isArray(ids) || ids.length > 10000 || ids.length !== currentIds.length || requested.size !== ids.length || ids.some(id => typeof id !== 'string' || id.length > 256) || currentIds.some(id => !requested.has(id))) throw new Error('모든 호스트를 한 번씩 포함한 목록으로 순서를 변경하십시오.')
  return ids
}

function existingGroup(snapshot, id) {
  if (!validGroupId(id)) throw new Error('그룹을 찾을 수 없습니다. 목록을 다시 불러오십시오.')
  const group = snapshot.groups.find(item => item.id === id)
  if (!group) throw new Error('그룹을 찾을 수 없습니다. 목록을 다시 불러오십시오.')
  return group
}

function validatedGroupId(snapshot, id) {
  if (id === null) return null
  return existingGroup(snapshot, id).id
}

function groupAssignments(snapshot) {
  return Object.fromEntries(snapshot.hosts.filter(host => host.groupId).map(host => [host.id, host.groupId]))
}

function remapHostMetadata(snapshot, content, previousBlocks, newPatterns = null, editedId = null, groupId = undefined) {
  const nextBlocks = parseConfig(content).blocks
  const added = newPatterns ? nextBlocks.find(block => block.host.hostPatterns === newPatterns) : null
  const remaining = added ? nextBlocks.filter(block => block !== added) : nextBlocks
  const ids = new Map(previousBlocks.map((block, index) => [block.host.id, remaining[index].host.id]))
  if (snapshot.hostOrder) content = withHostOrder(content, snapshot.hostOrder.filter(id => ids.has(id)).map(id => ids.get(id)))
  const hosts = Object.fromEntries(previousBlocks.filter(block => block.host.groupId).map(block => [ids.get(block.host.id), block.host.groupId]))
  if (groupId !== undefined) {
    const target = added || nextBlocks.find(block => block.host.id === ids.get(editedId))
    if (target && groupId) hosts[target.host.id] = groupId
    else if (target) delete hosts[target.host.id]
  }
  if (snapshot.groupMetadata.saved || snapshot.groups.length || Object.keys(hosts).length) content = withHostGroups(content, snapshot.groups, hosts)
  return content
}

function revisionOf(content, exists) {
  return crypto.createHash('sha256').update(exists ? 'file\0' : 'missing\0').update(content).digest('hex')
}

function valueOf(value, label) {
  const text = String(value ?? '')
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`${label}에 줄바꿈이나 제어 문자를 입력할 수 없습니다.`)
  return text.trim()
}

function validateBody(text) {
  if (/[\x00\x7f]/.test(text)) throw new Error('추가 옵션에 제어 문자를 입력할 수 없습니다.')
  for (const line of text.split(/\r?\n/)) {
    const entry = option(line)
    if (entry && /^(host|match)$/i.test(entry.key)) throw new Error('추가 옵션에는 Host 또는 Match 항목을 입력할 수 없습니다.')
  }
}

function sshValue(value) {
  const quoted = /^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^'\\]|\\.)*'$/.test(value)
  return /[\s#"'\\]/.test(value) && !quoted ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value
}

function patchedBlock(block, draft, eol) {
  const existing = block?.host || {}
  let patterns = existing.hostPatterns || ''
  if (Object.hasOwn(draft, 'hostPatterns')) patterns = valueOf(draft.hostPatterns, '호스트 이름')
  else if (Object.hasOwn(draft, 'alias')) patterns = valueOf(draft.alias, '호스트 이름')
  if (!patterns || patterns.startsWith('#')) throw new Error('호스트 이름을 입력하십시오.')
  if (/#/.test(patterns)) throw new Error('호스트 이름에 # 문자를 입력할 수 없습니다.')
  const bodyReplaced = Object.hasOwn(draft, 'optionsText') && String(draft.optionsText ?? '').replace(/\r\n/g, '\n') !== (existing.optionsText || '')
  let body = bodyReplaced ? String(draft.optionsText ?? '').replace(/\r\n/g, '\n').split('\n') : (block ? block.body.map(line => line.text) : [])
  validateBody(body.join('\n'))
  // Change only the requested options; leave all other options and comments in place.
  for (const [field, key] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(draft, field)) continue
    const value = valueOf(draft[field], key)
    if (field === 'port' && value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error('SSH 포트는 1부터 65535까지 입력하십시오.')
    if (!bodyReplaced && block && value === existing[field]) continue
    const indexes = []
    body.forEach((line, index) => { if (option(line)?.key.toLowerCase() === key.toLowerCase()) indexes.push(index) })
    if (indexes.length) {
      const first = indexes[0]
      const previous = body[first]
      const indent = previous.match(/^\s*/)[0] || '  '
      const previousOption = option(previous)
      const previousValue = previousOption?.value || ''
      const comment = uncomment(previousValue).length < previousValue.length ? previousValue.slice(uncomment(previousValue).length).trimStart() : ''
      body[first] = value ? `${indent}${key} ${sshValue(value)}${comment ? ` ${comment}` : ''}` : (comment ? `${indent}${comment}` : null)
      for (const index of indexes.slice(1)) body[index] = null
      body = body.filter(line => line !== null)
    } else if (value) {
      let insertAt = body.length
      while (insertAt > 0 && !body[insertAt - 1].trim()) insertAt--
      body.splice(insertAt, 0, `  ${key} ${sshValue(value)}`)
    }
  }
  if (Object.hasOwn(draft, 'tags')) {
    const tags = normalizedTags(draft.tags).map(tag => valueOf(tag, '태그'))
    if (JSON.stringify(tags) !== JSON.stringify(existing.tags || []) || bodyReplaced) {
      const firstTag = body.findIndex(line => TAG_LINE.test(line))
      body = body.filter(line => !TAG_LINE.test(line))
      if (tags.length) body.splice(firstTag < 0 ? 0 : Math.min(firstTag, body.length), 0, `  # remote-mgmt-tags: ${tags.join(', ')}`)
    }
  }
  const header = block && patterns === existing.hostPatterns ? block.header.text : `Host ${patterns}`
  const trailingEol = block ? (block.body.at(-1)?.eol ?? block.header.eol) : eol
  return `${header}${body.length ? eol + body.join(eol) : ''}${trailingEol ? eol : ''}`
}

class SshConfigStore {
  constructor({ configPath = path.join(os.homedir(), '.ssh', 'config') } = {}) {
    this.configPath = path.resolve(configPath)
    this.queue = Promise.resolve()
  }

  async load() {
    let actualPath = this.configPath
    let content = '', stat = null
    try {
      actualPath = await fs.realpath(this.configPath)
      stat = await fs.stat(actualPath)
      if (!stat.isFile()) throw new Error('SSH 설정 경로가 파일이 아닙니다.')
      content = await fs.readFile(actualPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const entry = await fs.lstat(this.configPath).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (entry?.isSymbolicLink()) throw new Error('SSH 설정의 연결 대상 파일을 찾을 수 없습니다.')
    }
    return { actualPath, content, stat, revision: revisionOf(content, Boolean(stat)), ...parseConfig(content) }
  }

  async read() {
    const snapshot = await this.load()
    const connectionRevision = crypto.createHash('sha256').update(withoutPreambleComments(snapshot.content, [ORDER_LINE, GROUP_LINE])).digest('hex')
    return { configPath: this.configPath, revision: snapshot.revision, connectionRevision, groups: snapshot.groups, hosts: snapshot.hosts }
  }

  serializeWrite(callback) {
    const result = this.queue.then(callback)
    this.queue = result.catch(() => {})
    return result
  }

  async write(snapshot, content, requestedRevision) {
    if (!requestedRevision || requestedRevision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
    if (content === snapshot.content) return this.read()
    const directory = path.dirname(snapshot.actualPath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.codex-manager-config-${crypto.randomUUID()}`)
    const mode = snapshot.stat ? snapshot.stat.mode & 0o777 : 0o600
    let backupPath
    try {
      const file = await fs.open(temporary, 'wx', mode)
      try { await file.writeFile(content, 'utf8'); await file.chmod(mode); await file.sync() } finally { await file.close() }
      const current = await this.load()
      if (current.revision !== snapshot.revision || current.actualPath !== snapshot.actualPath) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      if (snapshot.stat) {
        backupPath = path.join(directory, `${path.basename(snapshot.actualPath)}.codex-manager-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`)
        await fs.writeFile(backupPath, snapshot.content, { flag: 'wx', mode: 0o600 })
      }
      const finalCheck = await this.load()
      if (finalCheck.revision !== snapshot.revision || finalCheck.actualPath !== snapshot.actualPath) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      await fs.rename(temporary, snapshot.actualPath)
      try { const dir = await fs.open(directory, 'r'); try { await dir.sync() } finally { await dir.close() } } catch {}
      return this.read()
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }

  async save(draft, revision) {
    return this.serializeWrite(async () => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('호스트 정보를 입력하십시오.')
      const snapshot = await this.load()
      if (revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      const block = draft.id ? snapshot.blocks.find(item => item.host.id === draft.id) : null
      if (draft.id && !block) throw new Error('호스트를 찾을 수 없습니다. 목록을 다시 불러오십시오.')
      const groupId = Object.hasOwn(draft, 'groupId') ? validatedGroupId(snapshot, draft.groupId) : undefined
      const eol = snapshot.lines.find(line => line.eol)?.eol || '\n'
      const replacement = patchedBlock(block, draft, eol)
      const patterns = parseConfig(replacement).hosts[0]?.hostPatterns
      const changedPatterns = !block || patterns !== block.host.hostPatterns
      if (changedPatterns && snapshot.hosts.some(host => host.id !== block?.host.id && host.hostPatterns === patterns)) throw new Error('같은 이름의 호스트가 이미 있습니다.')
      let content
      if (block) content = snapshot.content.slice(0, block.start) + replacement + snapshot.content.slice(block.end)
      else {
        // Specific hosts must precede catch-all defaults because SSH uses the first value it finds.
        const firstDefault = snapshot.blocks.find(item => item.host.hostPatterns.split(/\s+/).some(pattern => /[*?]/.test(pattern)))
        const at = firstDefault?.start ?? snapshot.content.length
        const before = snapshot.content.slice(0, at)
        content = before + (before && !before.endsWith('\n') ? eol : '') + replacement + eol + snapshot.content.slice(at)
      }
      content = remapHostMetadata(snapshot, content, snapshot.blocks, block ? null : patterns, block?.host.id, groupId)
      return this.write(snapshot, content, revision)
    })
  }

  async reorder(ids, revision) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      if (!revision || revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      const currentIds = snapshot.hosts.map(host => host.id)
      validatedOrder(ids, snapshot.hosts)
      if (currentIds.every((id, index) => id === ids[index])) return this.write(snapshot, snapshot.content, revision)
      return this.write(snapshot, withHostOrder(snapshot.content, ids), revision)
    })
  }

  async remove(id, revision) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      const block = snapshot.blocks.find(item => item.host.id === id)
      if (!block) throw new Error('호스트를 찾을 수 없습니다. 목록을 다시 불러오십시오.')
      // Keep comments immediately preceding the next Host or Match block.
      let end = block.body.length
      while (end > 0 && (!block.body[end - 1].text.trim() || block.body[end - 1].text.trim().startsWith('#'))) end--
      const tail = block.body.slice(end).map(line => line.raw).join('')
      let content = snapshot.content.slice(0, block.start) + tail + snapshot.content.slice(block.end)
      content = remapHostMetadata(snapshot, content, snapshot.blocks.filter(item => item !== block))
      return this.write(snapshot, content, revision)
    })
  }

  async saveGroup(draft, revision) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      if (!revision || revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('그룹 정보를 입력하십시오.')
      const name = groupName(draft.name)
      const group = draft.id !== undefined ? existingGroup(snapshot, draft.id) : null
      if (snapshot.groups.some(item => item.id !== group?.id && item.name === name)) throw new Error('같은 이름의 그룹이 이미 있습니다.')
      if (!group && snapshot.groups.length >= MAX_GROUPS) throw new Error('그룹은 최대 1,000개까지 추가할 수 있습니다.')
      const groups = group
        ? snapshot.groups.map(item => item.id === group.id ? { ...item, name } : item)
        : [...snapshot.groups, { id: `group-${crypto.randomUUID()}`, name, collapsed: false }]
      if (group?.name === name) return this.write(snapshot, snapshot.content, revision)
      return this.write(snapshot, withHostGroups(snapshot.content, groups, groupAssignments(snapshot)), revision)
    })
  }

  async deleteGroup(id, revision) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      if (!revision || revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      existingGroup(snapshot, id)
      const groups = snapshot.groups.filter(group => group.id !== id)
      const hosts = Object.fromEntries(Object.entries(groupAssignments(snapshot)).filter(([, groupId]) => groupId !== id))
      return this.write(snapshot, withHostGroups(snapshot.content, groups, hosts), revision)
    })
  }

  async setGroupCollapsed(id, collapsed, revision) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      if (!revision || revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      const group = existingGroup(snapshot, id)
      if (typeof collapsed !== 'boolean') throw new Error('그룹 접기 상태를 선택하십시오.')
      if (group.collapsed === collapsed) return this.write(snapshot, snapshot.content, revision)
      const groups = snapshot.groups.map(item => item.id === id ? { ...item, collapsed } : item)
      return this.write(snapshot, withHostGroups(snapshot.content, groups, groupAssignments(snapshot)), revision)
    })
  }

  async moveHostToGroup(hostId, groupId, revision, orderedIds) {
    return this.serializeWrite(async () => {
      const snapshot = await this.load()
      if (!revision || revision !== snapshot.revision) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 다시 불러온 후 저장하십시오.')
      const host = snapshot.hosts.find(item => item.id === hostId)
      if (!host) throw new Error('호스트를 찾을 수 없습니다. 목록을 다시 불러오십시오.')
      validatedGroupId(snapshot, groupId)
      if (orderedIds !== undefined) validatedOrder(orderedIds, snapshot.hosts)
      const hosts = groupAssignments(snapshot)
      if (groupId) hosts[hostId] = groupId
      else delete hosts[hostId]
      let content = snapshot.content
      if (host.groupId !== groupId) content = withHostGroups(content, snapshot.groups, hosts)
      if (orderedIds !== undefined && snapshot.hosts.some((item, index) => item.id !== orderedIds[index])) content = withHostOrder(content, orderedIds)
      return this.write(snapshot, content, revision)
    })
  }
}

module.exports = { SshConfigStore, parseConfig, concreteAlias }
