import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../Client/snapshot-reader.js';

async function* chunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

test('streaming snapshot loading preserves graph records across arbitrary UTF-8 and JSON boundaries', async () => {
  const graph = { schemaVersion: 5, objects: [{ id: 'r0:0xfffffffffffffff0', address: '0xfffffffffffffff0',
    type: 'Example.Node', segment: 's', generation: 'Generation2', preview: 'zażółć 🧠 "quoted"\\\n' }],
    edges: [{ source: 'r0:0xfffffffffffffff0', target: 'r0:0xfffffffffffffff0', kind: 'reference', label: 'Next', offset: 8 }],
    roots: [{ target: 'r0:0xfffffffffffffff0', dependentTarget: null }], segments: [{ id: 's' }],
    finalizableObjects: ['r0:0xfffffffffffffff0'], objectsWalked: 1 };
  for (const size of [1, 3, 7, 1024]) assert.deepEqual(await readSnapshot(chunks(JSON.stringify(graph), size)), graph);
});

test('streaming snapshot loading rejects truncation, malformed JSON, missing graph data and failed streams', async () => {
  for (const text of ['', '{"objects":[', '{"objects":[{}]', '{"objects":[],}', 'null', '{}']) {
    await assert.rejects(readSnapshot(chunks(text, 4)));
  }
  const failure = new Error('Network failed');
  async function* broken() { yield new TextEncoder().encode('{"objects":['); throw failure; }
  await assert.rejects(readSnapshot(broken()), failure);
});
