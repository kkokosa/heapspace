import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

async function until(probe, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for the dump server.');
}

test('completed dumps do not block new uploads, while overlapping uploads are still rejected', { timeout: 180000 }, async () => {
  const dll = path.resolve(process.env.HEAPSCAPE_SERVER_DLL ?? path.join('Server', 'bin', 'Release', 'net10.0', 'Heapscape.dll'));
  const fixture = path.resolve('artifacts', 'dumps', 'console.dmp');
  assert.ok(existsSync(dll), 'Build the Release server first, or set HEAPSCAPE_SERVER_DLL.');
  assert.ok(existsSync(fixture), 'Generate the console dump fixture first.');
  const temporary = await mkdtemp(path.join(tmpdir(), 'heapscape-upload-test-'));
  const server = spawn('dotnet', [dll, '--Heapscape:Port=0'], {
    cwd: path.resolve('Server'),
    env: { ...process.env, TMP: temporary, TEMP: temporary },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', baseUrl;
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  const headers = { 'X-Heapscape': '1' };
  const uploadHeaders = { ...headers, 'Content-Type': 'application/octet-stream' };
  let blockedBody, controller, blockedUpload;
  try {
    baseUrl = await until(() => {
      if (server.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
      return output.match(/Now listening on: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    const list = async () => {
      const response = await fetch(`${baseUrl}/api/dumps`, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    blockedBody = new PassThrough();
    controller = new AbortController();
    blockedUpload = fetch(`${baseUrl}/api/dumps?name=held-upload.dmp`, {
      method: 'POST', headers: uploadHeaders, body: blockedBody, duplex: 'half', signal: controller.signal,
    }).then(response => ({ response }), error => ({ error }));
    blockedBody.write(Buffer.alloc(64));
    await until(async () => (await list()).some(job => job.state === 'uploading'));
    const conflict = await fetch(`${baseUrl}/api/dumps?name=overlap.dmp`, {
      method: 'POST', headers: uploadHeaders, body: Buffer.alloc(64),
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /operation is in progress/);
    controller.abort(); blockedBody.end();
    assert.ok((await blockedUpload).error, 'Cancelling an unfinished upload should abort the client request.');
    await until(async () => (await list()).length === 0);

    const ids = [];
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${baseUrl}/api/dumps?name=retained-${i}.dmp`, {
        method: 'POST', headers: uploadHeaders, body: createReadStream(fixture), duplex: 'half',
      });
      const result = await response.json();
      assert.equal(response.status, 202, JSON.stringify(result));
      ids.push(result.id);
      await until(async () => {
        const state = await (await fetch(`${baseUrl}/api/dumps/${result.id}`, { headers })).json();
        assert.notEqual(state.state, 'failed', state.error);
        return state.state === 'ready';
      }, 60000);
      const graphResponse = await fetch(`${baseUrl}/api/dumps/${result.id}/graph`, { headers });
      assert.equal(graphResponse.status, 200);
      assert.ok((await graphResponse.json()).objects.length > 0);
    }
    const retained = await list();
    assert.equal(retained.length, 4);
    assert.ok(retained.every(job => job.state === 'ready'));
    assert.deepEqual(retained.map(job => job.id).sort(), ids.sort());
  } finally {
    controller?.abort(); blockedBody?.destroy();
    if (blockedUpload) await blockedUpload;
    try {
      if (baseUrl && server.exitCode === null) {
        await until(async () => {
          const jobs = await (await fetch(`${baseUrl}/api/dumps`, { headers })).json();
          if (jobs.some(job => job.state === 'uploading')) return false;
          for (const job of jobs) {
            const result = await fetch(`${baseUrl}/api/dumps/${job.id}`, { method: 'DELETE', headers });
            assert.equal(result.status, 204);
          }
          return true;
        });
      }
    } finally {
      if (server.exitCode === null) server.kill();
      await exited;
      // This directory was uniquely created by this test; never touch the live viewer's storage.
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
