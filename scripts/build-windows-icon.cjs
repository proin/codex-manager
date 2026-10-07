'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// PNG images in ICO files are supported on every Windows version supported by
// Electron. Keep the macOS and Windows icons derived from the same artwork.
async function main() {
  const root = path.resolve(__dirname, '..');
  const frames = await Promise.all([
    [16, 'icon_16x16.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_256x256.png'],
  ].map(async ([size, file]) => ({
    size,
    png: await fs.readFile(path.join(root, 'build', 'windows-icon-source', file)),
  })));

  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, png }, index) => {
    const position = 6 + index * 16;
    directory[position] = size === 256 ? 0 : size;
    directory[position + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, position + 4);
    directory.writeUInt16LE(32, position + 6);
    directory.writeUInt32LE(png.length, position + 8);
    directory.writeUInt32LE(offset, position + 12);
    offset += png.length;
  });
  const output = path.join(root, 'build', 'icon.ico');
  await fs.writeFile(output, Buffer.concat([directory, ...frames.map(({ png }) => png)]));
  console.log('Windows 아이콘 생성: build/icon.ico');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
