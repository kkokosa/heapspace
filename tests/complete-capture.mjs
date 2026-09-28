import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import * as THREE from 'three';
import { readSnapshot } from '../Client/snapshot-reader.js';
import { indexGraph } from '../Client/graph.js';
import { analyzeReachability } from '../Client/reachability.js';
import { Atlas } from '../Client/scene.js';

const report = stage => console.log(`${stage}: ${Math.round(process.memoryUsage().heapUsed / 1024 ** 2)} MiB JS heap`);
const data = await readSnapshot(createReadStream(process.argv[2] ?? 'artifacts/orchard-full.json'));
report('Parsed');
assert.equal(data.schemaVersion, 5);
assert.equal(data.objects.length, data.objectsWalked);
assert.ok(data.objects.length > 250000);
assert.ok(data.edges.length > 1000000);
assert.equal(data.objectsTruncated || data.edgesTruncated || data.rootsTruncated || data.finalizableObjectsTruncated, false);
const index = indexGraph(data);
report('Indexed');
const analysis = analyzeReachability(data, index);
report('Analyzed');
console.log(JSON.stringify({ objects: data.objects.length, edges: data.edges.length, roots: data.roots.length,
  complete: analysis.complete, reasons: analysis.reasons, collections: analysis.collections }, null, 2));
assert.equal(analysis.complete, true, analysis.reasons.join('\n'));
for (const counts of analysis.collections) {
  assert.equal(counts.unknown, 0);
  assert.equal(counts.reachable + counts.unreachable + counts.outside, data.objects.length);
}
assert.ok(analysis.collections[2].unreachable > 0, 'The real Orchard fixture must contain proven dead objects.');
const view = Object.create(Atlas.prototype);
view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
for (const state of ['reachable', 'unreachable']) {
  const shown = view.show(data, index, { budget: 5000, heap: 'all', color: 'type', roots: true, edges: true,
    reachability: analysis, gcGeneration: 2, highlightGc: true, highlightState: state }, null);
  assert.equal(shown.analysisUnavailable, false);
  assert.equal(shown.analysisMatches, analysis.collections[2][state]);
  assert.equal(shown.analysisShown, Math.min(5000, analysis.collections[2][state]));
  assert.equal(view.layout.objects.size, data.objectsWalked);
  report(`Rendered ${state}`);
}
view.disposeContent();
console.log('PASS: full object/reference capture, complete reachability partitions, and render-only budgets');
