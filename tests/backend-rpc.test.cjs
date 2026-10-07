'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcClient } = require('../electron/rpc-client.cjs');

const fakeServer = `
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let initialized = false;
let waiting;
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { experimental: message.params.capabilities.experimentalApi } });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'probe') {
    send({ method: 'account/login/completed', params: { loginId: 'test', success: true } });
    send({ id: message.id, result: { initialized, params: message.params } });
  } else if (message.method === 'serverProbe') {
    waiting = message.id;
    send({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: {} });
  } else if (message.id === 'server-request') {
    send({ id: waiting, result: message });
  } else if (message.method === 'secretError') {
    send({ id: message.id, error: { code: -32601, message: 'sk-private-credential', data: {accessToken:'private'} } });
  } else if (message.method === 'malformed') {
    process.stdout.write('not-json\\n');
  }
});
`;

function client(t, timeoutMs = 1000) {
  const rpc = new RpcClient({ command: process.execPath, args: ['-e', fakeServer], timeoutMs });
  t.after(() => rpc.close());
  return rpc;
}

test('RPC initializes once, forwards notifications, and supports parallel correlated requests', async (t) => {
  const rpc = client(t);
  const notifications = [];
  rpc.on('notification', (method, params) => notifications.push({ method, params }));
  const replies = await Promise.all([rpc.request('probe', { index: 1 }), rpc.request('probe', { index: 2 })]);
  assert.deepEqual(replies, [{ initialized: true, params: { index: 1 } }, { initialized: true, params: { index: 2 } }]);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].method, 'account/login/completed');
  assert.equal(rpc.pending.size, 0);
});

test('server-side approval requests are refused without executing anything', async (t) => {
  const rpc = client(t);
  const result = await rpc.request('serverProbe');
  assert.equal(result.id, 'server-request');
  assert.equal(result.error.code, -32601);
});

test('RPC errors keep the safe code and discard potentially sensitive diagnostics', async (t) => {
  const rpc = client(t);
  await assert.rejects(rpc.request('secretError'), (error) => {
    assert.equal(error.code, -32601);
    assert.ok(!error.message.includes('private'));
    assert.equal(error.data, undefined);
    return true;
  });
});

test('a timeout rejects a request and closes the child without replaying it', async (t) => {
  const rpc = client(t, 100);
  await rpc.start();
  await assert.rejects(rpc.request('never-respond'), (error) => error.code === 'TIMEOUT');
  assert.equal(rpc.closed, true);
  assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.request('probe'), (error) => error.code === 'CLOSED');
});

test('malformed protocol output terminates the connection', async (t) => {
  const rpc = client(t);
  await assert.rejects(rpc.request('malformed'), (error) => error.code === 'PROTOCOL_ERROR');
  assert.equal(rpc.closed, true);
  assert.equal(rpc.pending.size, 0);
});

test('missing executable fails promptly without exposing process errors', async (t) => {
  const rpc = new RpcClient({ command: '/nonexistent/private-path/codex', timeoutMs: 300 });
  t.after(() => rpc.close());
  await assert.rejects(rpc.request('probe'), (error) => {
    assert.equal(error.code, 'SPAWN_ERROR');
    assert.ok(!error.message.includes('/nonexistent'));
    return true;
  });
});
