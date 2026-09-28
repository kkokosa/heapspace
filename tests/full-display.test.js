import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { CurveLineBuffer } from '../Client/rendering.js';
import { indexGraph, selectObjects, selectReferences, neighborhood } from '../Client/graph.js';

function graph(count, rootCount = 0) {
  const objects = Array.from({ length: count }, (_, i) => ({
    id: `o${i}`, address: `0x${(0x1000 + i * 32).toString(16)}`, segment: i < count / 2 ? 's0' : 's1',
    type: 'Fixture.Node', generation: 'Generation2', size: 32,
  }));
  const split = Math.ceil(count / 2);
  return {
    architecture: 'X64',
    objects, objectsWalked: count,
    segments: [
      { id: 's0', start: '0x1000', end: `0x${(0x1000 + split * 32).toString(16)}`, kind: 'Generation2' },
      { id: 's1', start: `0x${(0x1000 + split * 32).toString(16)}`, end: `0x${(0x1000 + count * 32).toString(16)}`, kind: 'Large' },
    ],
    edges: objects.slice(1).map((o, i) => ({ source: `o${i}`, target: o.id, kind: 'reference', offset: 0 })),
    roots: Array.from({ length: rootCount }, (_, i) => ({
      id: `root${i}`, address: `0x${(0x800000 + i * 8).toString(16)}`, target: `o${i % count}`, kind: 'Strong', strong: true,
    })),
    threads: [], nativeAreas: [],
  };
}

function atlas() {
  const result = Object.create(Atlas.prototype);
  result.content = new THREE.Group(); result.selection = new THREE.Group(); result.pickables = [];
  result.label = () => {};
  return result;
}

const settings = { budget: 'all', referenceBudget: 'all', heap: 'all', edges: true, roots: true, native: false };

test('all object selection includes every candidate even after prioritization, while preserving filters', () => {
  const data = graph(120), index = indexGraph(data);
  assert.equal(selectObjects(data, index, 'all', 'all', 'o20', new Set(['o20', 'o30'])).length, 120);
  assert.equal(selectObjects(data, index, 120, 'all', 'o20', new Set(['o20', 'o30'])).length, 120);
  assert.equal(selectObjects(data, index, 'all', 'LOH', null).length, 60);
  assert.equal(selectObjects(data, index, 15, 'all', null).length <= 15, true);
});

test('all references removes the 6000-edge cap in both overview and selected-neighborhood collection', () => {
  const data = graph(2);
  data.edges = Array.from({ length: 7001 }, () => ({ source: 'o0', target: 'o1', kind: 'reference' }));
  const index = indexGraph(data), ids = new Set(data.objects.map(o => o.id));
  assert.equal(selectReferences(data.edges, ids).edges.length, 6000);
  assert.equal(selectReferences(data.edges, ids, Infinity).edges.length, 7001);
  const focused = neighborhood('o0', index, 1, data.objects.length, Infinity, Infinity);
  assert.equal(focused.edges.length, 7001);
  assert.equal(focused.limited, false);
});

test('all-object mode also expands a selected neighborhood beyond the default 2000 objects', () => {
  const data = graph(2100), view = atlas();
  data.edges = data.objects.slice(1).map(object => ({ source: 'o0', target: object.id, kind: 'reference' }));
  const fullIndex = indexGraph(data);
  assert.equal(neighborhood('o0', fullIndex, 1).ids.size, 2000);
  const result = view.show(data, fullIndex, { ...settings, isolate: true, depth: 1 }, 'o0');
  assert.equal(result.neighborhood.ids.size, 2100);
  assert.equal(result.neighborhood.limited, false);
  assert.equal(result.visible, 2100);
  assert.equal(result.edges, 2099);
  view.disposeContent();
});

test('the all-mode scene really contains all objects, object links, root links, and root markers', () => {
  const data = graph(7002, 11001), view = atlas();
  const result = view.show(data, indexGraph(data), settings, null);
  assert.equal(result.visible, data.objects.length);
  assert.equal(result.edges, data.edges.length);
  assert.equal(result.roots, data.roots.length);
  assert.equal(result.references.limited, false);
  assert.equal(view.streamStats.representedReferences, result.edges + result.roots);
  const objects = view.content.children.filter(mesh => mesh.userData.layer === 'foreground').reduce((sum, mesh) => sum + mesh.count, 0);
  const roots = view.content.children.filter(mesh => mesh.userData.items?.[0]?.kind === 'root').reduce((sum, mesh) => sum + mesh.count, 0);
  assert.equal(objects, 7002); assert.equal(roots, 11001);
  assert.ok(view.streamStats.lineSegments > 0);
  view.disposeContent();
});

test('large complete object sets are partitioned by region without dropping instances', () => {
  const data = graph(41000), view = atlas();
  data.edges = [];
  const result = view.show(data, indexGraph(data), settings, null);
  const batches = view.content.children.filter(mesh => mesh.userData.layer === 'foreground');
  assert.equal(result.visible, 41000);
  assert.equal(batches.length, 2);
  assert.equal(batches.reduce((sum, batch) => sum + batch.count, 0), 41000);
  view.disposeContent();
});

test('typed curve chunks preserve every segment across buffer boundaries and keep exact endpoints', () => {
  const buffer = new CurveLineBuffer(2);
  const curve = new THREE.LineCurve3(new THREE.Vector3(0, 1, 2), new THREE.Vector3(5, 6, 7));
  buffer.add(curve, 5);
  assert.equal(buffer.segmentCount, 5);
  const arrays = buffer.buffers();
  assert.deepEqual(arrays.map(array => array.length), [12, 12, 6]);
  assert.deepEqual([...arrays[0].subarray(0, 3)], [0, 1, 2]);
  assert.deepEqual([...arrays.at(-1).subarray(-3)], [5, 6, 7]);
  for (let i = 1; i < arrays.length; i++) assert.deepEqual([...arrays[i - 1].subarray(-3)], [...arrays[i].subarray(0, 3)]);
  assert.ok(arrays.every(array => [...array].every(Number.isFinite)));
});
