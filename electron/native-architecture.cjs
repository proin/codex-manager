'use strict';

const fs = require('node:fs/promises');

const CPU_ARCHITECTURES = new Map([[0x0100000c, 'arm64'], [0x01000007, 'x64']]);
const THIN_HEADERS = new Map([
  [0xfeedface, { littleEndian: false, length: 28 }],
  [0xcefaedfe, { littleEndian: true, length: 28 }],
  [0xfeedfacf, { littleEndian: false, length: 32 }],
  [0xcffaedfe, { littleEndian: true, length: 32 }],
]);

function thinArchitecture(buffer) {
  if (buffer.length < 4) return null;
  const header = THIN_HEADERS.get(buffer.readUInt32BE(0));
  if (!header || buffer.length < header.length) return null;
  const read = header.littleEndian ? buffer.readUInt32LE.bind(buffer) : buffer.readUInt32BE.bind(buffer);
  // MH_EXECUTE: a library or object file is not a CLI executable.
  if (read(12) !== 2) return null;
  return { cpu: read(4), architecture: CPU_ARCHITECTURES.get(read(4)), length: header.length };
}

/** Read Mach-O headers without starting the executable or invoking Rosetta. */
async function macExecutableArchitectures(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const readAt = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    };
    const header = await readAt(0, 32);
    const thin = thinArchitecture(header);
    if (thin) return thin.architecture ? [thin.architecture] : [];
    if (header.length < 8) return [];
    const magic = header.readUInt32BE(0);
    const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return [];
    const read32 = (buffer, offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const read64 = (buffer, offset) => Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
    const count = read32(header, 4);
    const entrySize = fat64 ? 32 : 20;
    const tableSize = 8 + count * entrySize;
    if (!count || count > 64 || tableSize > size) return [];
    const table = await readAt(8, count * entrySize);
    if (table.length !== count * entrySize) return [];
    const architectures = new Set();
    for (let index = 0; index < count; index++) {
      const base = index * entrySize;
      const cpu = read32(table, base);
      const offset = fat64 ? read64(table, base + 8) : read32(table, base + 8);
      const length = fat64 ? read64(table, base + 16) : read32(table, base + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < tableSize || length < 28 || offset > size - length) return [];
      const slice = thinArchitecture(await readAt(offset, Math.min(32, length)));
      if (!slice || slice.cpu !== cpu || slice.length > length) return [];
      if (slice.architecture) architectures.add(slice.architecture);
    }
    return [...architectures];
  } finally {
    await handle.close();
  }
}

module.exports = { macExecutableArchitectures };
