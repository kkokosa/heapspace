import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { findObjects, indexGraph, neighborhood } from '../Client/graph.js';
import { Atlas } from '../Client/scene.js';

function fixture() {
  const objects = Array.from({ length: 80 }, (_, i) => ({
    id: `o${i}`, address: `0x${(0x1000 + i * 32).toString(16)}`, type: i < 60 ? 'Wanted.Type' : 'Other.Type',
    size: 32, preview: `payload-${i}`, segment: 's', generation: 'Generation2',
  }));
  return {
    objects, objectsWalked: 80, roots: [], threads: [], nativeAreas: [],
    segments: [{ id: 's', start: '0x1000', end: '0x1a00', kind: 'Generation2', heap: 0 }],
    edges: objects.slice(1).map((object, i) => ({ source: `o${i}`, target: object.id, kind: 'reference', offset: 0 })),
  };
}

test('search returns all captured matches, not only the 40-row list preview', () => {
  const data = fixture();
  assert.equal(findObjects(data, ' WANTED.TYPE ').length, 60);
  assert.equal(findObjects(data, 'PAYLOAD-79')[0].id, 'o79');
  assert.equal(findObjects(data, '0X1000')[0].id, 'o0');
  assert.equal(findObjects(data, '').length, 0);
  assert.equal(findObjects(data, 'no match').length, 0);
});

test('multi-source neighborhoods keep every seed and expand from all selected objects', () => {
  const index = indexGraph(fixture());
  const graph = neighborhood(new Set(['o0', 'o5']), index, 1);
  assert.deepEqual([...graph.ids], ['o0', 'o5', 'o1', 'o6', 'o4']);
  assert.equal(graph.distances.get('o0'), 0); assert.equal(graph.distances.get('o5'), 0);
  const seeds = new Set(Array.from({ length: 60 }, (_, i) => `o${i}`));
  const bounded = neighborhood(seeds, index, 1, 2);
  assert.equal(bounded.ids.size, 60);
  assert.ok([...seeds].every(id => bounded.ids.has(id)));
  assert.equal(bounded.limited, true);
});

test('the scene highlights and frames every selected search result while retaining faint context', () => {
  const data = fixture(), index = indexGraph(data);
  const selectedObjects = new Set(findObjects(data, 'wanted').map(object => object.id));
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const result = view.show(data, index, {
    budget: 100, selectedObjects, isolate: true, depth: 0, heap: 'all', edges: true, roots: true,
  }, null);
  assert.equal(result.selectedCount, 60);
  assert.equal(result.visible, 60);
  assert.equal(result.context, 20);
  assert.equal(result.edges, 59);
  assert.equal(view.selectedObjectBounds.isEmpty(), false);
  for (const id of selectedObjects) assert.ok(view.selectedObjectBounds.containsPoint(new THREE.Vector3(...view.layout.objects.get(id).position)));
  const cleared = view.show(data, index, { budget: 100, heap: 'all', edges: true }, null);
  assert.equal(cleared.selectedCount, 0);
  assert.equal(cleared.visible, 80);
  view.disposeContent();
});
