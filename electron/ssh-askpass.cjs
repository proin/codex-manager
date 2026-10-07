'use strict';

// OpenSSH starts this helper only for the current connection. The password
// travels over a private local socket and is never placed in a file or argv.
const net = require('node:net');
const socketPath = process.env.CODEX_MANAGER_ASKPASS_SOCKET;
const token = process.env.CODEX_MANAGER_ASKPASS_TOKEN;
if (!socketPath || !token) process.exit(1);
const client = net.connect(socketPath);
let response = '';
client.setTimeout(5000, () => { client.destroy(); process.exitCode = 1; });
client.on('connect', () => client.end(`${JSON.stringify({ token, prompt: process.argv.slice(2).join(' ') })}\n`));
client.on('data', (chunk) => { response += chunk.toString(); if (response.length > 8192) client.destroy(); });
client.on('end', () => {
  try {
    const result = JSON.parse(response);
    if (typeof result.password !== 'string') throw new Error();
    process.stdout.write(`${result.password}\n`);
  } catch { process.exitCode = 1; }
  response = '';
});
client.on('error', () => { response = ''; process.exitCode = 1; });
