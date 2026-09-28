import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { finalizationAreas, finalizationRoots } from '../Client/finalization.js';
import { indexGraph } from '../Client/graph.js';
import { layout, arraySlotPosition } from '../Client/spatial.js';
import { Atlas } from '../Client/scene.js';

function fixture(readyStart = '0x8010', readyEnd = '0x8020') {
  return {
    architecture: 'X64', segments: [{ id: 's', start: '0x1000', end: '0x1020', kind: 'Generation2' }],
    objects: [{ id: 'a', address: '0x1000', segment: 's', generation: 'Generation2', size: 32, type: 'Finalizable' }],
    edges: [], roots: [], threads: [],
    nativeAreas: [{ start: '0x8000', end: '0x9000', size: 4096, state: 'committed', kind: 'private', owners: [] }],
    finalizationQueues: [{ id: 'fq', runtime: 0, heap: 0, storage: { start: '0x8000', end: '0x8020' },
      ready: { start: readyStart, end: readyEnd }, entries: Array.from({ length: 4 }, (_, i) => {
        const address = 0x8000n + BigInt(i * 8);
        return { id: `f${i}`, address: `0x${address.toString(16)}`, target: 'a',
          ready: address >= BigInt(readyStart) && address < BigInt(readyEnd) };
      }), truncated: false, unreadableSlots: 0 }],
  };
}

test('finalizer registrations and fReachable roots use distinct exact, nonoverlapping slot ranges', () => {
  const data = fixture(), original = structuredClone(data), areas = finalizationAreas(data);
  assert.deepEqual(areas.map(area => [area.phase, area.storage, area.entries.length]), [
    ['registered', { start: '0x8000', end: '0x8010' }, 2],
    ['ready', { start: '0x8010', end: '0x8020' }, 2],
  ]);
  assert.deepEqual(data, original);
  const roots = finalizationRoots(data);
  assert.equal(roots.filter(root => root.strong).length, 2);
  const atlas = layout(data), registered = atlas.finalizers.get('fq:registered'), ready = atlas.finalizers.get('fq:ready');
  assert.equal(registered.bytes + ready.bytes, 32);
  assert.equal(atlas.native[0].start, '0x8020');
  assert.deepEqual(atlas.roots.get('f0').position, arraySlotPosition('0x8000', registered));
  assert.deepEqual(atlas.roots.get('f2').position, arraySlotPosition('0x8010', ready));
  assert.notEqual(registered.id, ready.id);
  assert.deepEqual(registered.value.entries.map(entry => entry.id), ['f0', 'f1']);
  assert.deepEqual(ready.value.entries.map(entry => entry.id), ['f2', 'f3']);
});

test('empty fReachable gets a zero-byte marker, never duplicated storage or fake root slots', () => {
  const data = fixture('0x8020', '0x8020'), atlas = layout(data);
  const empty = atlas.finalizers.get('fq:ready');
  assert.equal(empty.empty, true); assert.equal(empty.bytes, 0); assert.equal(empty.value.entries.length, 0);
  assert.equal(atlas.finalizers.get('fq:registered').bytes, 32);
  assert.equal(finalizationRoots(data).filter(root => root.strong).length, 0);
  assert.equal(atlas.native[0].start, '0x8020');
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  view.show(data, indexGraph(data), { budget: 100, heap: 'all', roots: true, finalization: true }, null);
  const marker = view.content.children.find(mesh => mesh.userData.item?.value.id === empty.id);
  assert.equal(marker.material.wireframe, true);
  assert.equal(marker.userData.item.value.empty, true);
  assert.ok(view.pickables.includes(marker));
  view.disposeContent();
});

test('all-ready, partial captures, and non-tail ranges preserve every byte and entry', () => {
  for (const data of [fixture('0x8000', '0x8020'), fixture('0x8008', '0x8018')]) {
    data.finalizationQueues[0].entries = data.finalizationQueues[0].entries.filter((_, i) => i % 2 === 0);
    data.finalizationQueues[0].truncated = true;
    const areas = finalizationAreas(data);
    assert.equal(areas.reduce((sum, area) => sum + Number(BigInt(area.storage.end) - BigInt(area.storage.start)), 0), 32);
    assert.equal(areas.reduce((sum, area) => sum + area.entries.length, 0), 2);
    assert.ok(areas.every(area => area.truncated));
  }
});

test('invalid queue boundaries and inconsistent slot readiness fail explicitly', () => {
  assert.throws(() => finalizationAreas(fixture('0x7ff0', '0x8020')), /Invalid finalization queue boundaries/);
  assert.throws(() => finalizationAreas(fixture('0x8018', '0x8010')), /Invalid finalization queue boundaries/);
  const data = fixture(); data.finalizationQueues[0].entries[0].ready = true;
  assert.throws(() => finalizationAreas(data), /classification disagrees/);
});

test('queue section references originate in their own cube and no dimension arrows are drawn in fixed mode', () => {
  const data = fixture();
  data.roots.push({ id: 'existingReady', target: 'a', address: '0x8010', kind: 'FinalizerQueue', strong: true });
  const index = indexGraph(data), view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const shown = view.show(data, index, { budget: 100, heap: 'all', roots: true, finalization: true,
    dimensions: false, signals: true, signalSpeed: 3, isolate: true }, 'a');
  assert.equal(shown.roots, 4);
  assert.equal(view.signalSpeed, 3);
  assert.equal(view.content.children.some(child => child.userData.regionRulers), false);
  const cubes = view.content.children.filter(mesh => mesh.userData.item?.kind === 'finalizerQueue');
  assert.equal(cubes.length, 2);
  assert.notEqual(cubes[0].material.color.getHexString(), cubes[1].material.color.getHexString());
  assert.equal(view.layout.roots.get('existingReady').region.value.phase, 'ready');
  assert.equal(view.layout.roots.get('f0').region.value.phase, 'registered');
  view.disposeContent();
});
