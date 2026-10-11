'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { macExecutableArchitectures } = require('../electron/native-architecture.cjs');

function thin(arch, littleEndian = true, fileType = 2) {
  const header = Buffer.alloc(32);
  const write = littleEndian ? header.writeUInt32LE.bind(header) : header.writeUInt32BE.bind(header);
  write(0xfeedfacf, 0);
  write(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  write(fileType, 12);
  return header;
}

function universal({ fat64 = false, littleEndian = false } = {}) {
  const entrySize = fat64 ? 32 : 20;
  const buffer = Buffer.alloc(8 + 2 * entrySize + 64);
  const write32 = littleEndian ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer);
  const write64 = littleEndian ? buffer.writeBigUInt64LE.bind(buffer) : buffer.writeBigUInt64BE.bind(buffer);
  write32(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  write32(2, 4);
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const base = 8 + index * entrySize;
    const offset = 8 + 2 * entrySize + index * 32;
    write32(arch === 'arm64' ? 0x0100000c : 0x01000007, base);
    if (fat64) { write64(BigInt(offset), base + 8); write64(32n, base + 16); }
    else { write32(offset, base + 8); write32(32, base + 12); }
    thin(arch).copy(buffer, offset);
  }
  return buffer;
}

async function inspect(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mach-o-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'binary');
  await fs.writeFile(file, bytes);
  return macExecutableArchitectures(file);
}

test('recognizes native ARM and Intel Mach-O executables in both byte orders', async (t) => {
  for (const littleEndian of [false, true]) for (const arch of ['arm64', 'x64']) {
    assert.deepEqual(await inspect(t, thin(arch, littleEndian)), [arch]);
  }
});

test('recognizes Universal executables in 32-bit and 64-bit fat tables', async (t) => {
  for (const fat64 of [false, true]) for (const littleEndian of [false, true]) {
    assert.deepEqual(await inspect(t, universal({ fat64, littleEndian })), ['x64', 'arm64']);
  }
});

test('rejects truncated files, non-executables and malformed Universal headers', async (t) => {
  const invalidTable = universal();
  invalidTable.writeUInt32BE(65, 4);
  const invalidOffset = universal();
  invalidOffset.writeUInt32BE(invalidOffset.length + 1, 16);
  const mismatchedCpu = universal();
  mismatchedCpu.writeUInt32BE(0x0100000c, 8);
  const unsafeOffset = universal({ fat64: true });
  unsafeOffset.writeBigUInt64BE(2n ** 63n, 16);
  for (const bytes of [Buffer.alloc(0), thin('arm64').subarray(0, 16), thin('arm64', true, 6), Buffer.from('#!/bin/sh\n'), invalidTable, invalidOffset, mismatchedCpu, unsafeOffset]) {
    assert.deepEqual(await inspect(t, bytes), []);
  }
});
