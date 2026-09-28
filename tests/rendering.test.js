import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';
import { arrayOpacity, renderLayers } from '../Client/rendering.js';

test('all glass and connection materials disable depth writes, while far arrays have a separate opaque-depth pass', () => {
  const data = {
    architecture: 'X64',
    segments: [{ id: 's', start: '0x1000', end: '0x2000', kind: 'Pinned', heap: 0 }],
    objects: [
      { id: 'array', address: '0x1000', segment: 's', type: 'System.Object[]', generation: 'Pinned', size: 64 },
      { id: 'target', address: '0x1040', segment: 's', type: 'System.Object', generation: 'Pinned', size: 32 },
    ],
    edges: [{ source: 'array', target: 'target', kind: 'reference', offset: 8 },
      { source: 'array', target: 'target', kind: 'reference', offset: 16 }],
    roots: [], threads: [],
    nativeAreas: [{ start: '0x4000', end: '0x5000', size: 4096, state: 'committed', kind: 'private', owners: [] }],
  };
  const atlas = Object.create(Atlas.prototype);
  atlas.content = new THREE.Group(); atlas.selection = new THREE.Group(); atlas.pickables = [];
  atlas.label = () => {};
  atlas.camera = new THREE.PerspectiveCamera();
  atlas.camera.position.set(1000, 1000, 1000);
  const result = atlas.show(data, indexGraph(data), {
    budget: 100, heap: 'all', color: 'type', edges: true, roots: true, native: true, reserved: false,
  }, null);
  assert.equal(result.arraySlots, 2); assert.equal(result.unresolvedArraySlots, 0);
  assert.equal(result.localLinks, 2); assert.equal(result.bundles, 0);
  atlas.content.traverse(object => {
    if (object.material?.transparent) assert.equal(object.material.depthWrite, false);
  });
  const batch = atlas.arrayBatches[0];
  assert.equal(batch.mesh.renderOrder, renderLayers.glass);
  assert.equal(batch.mesh.material.depthWrite, false);
  assert.equal(batch.depth.material.colorWrite, false);
  assert.equal(batch.depth.material.depthWrite, true);
  assert.equal(batch.depth.material.alphaTest, 1);
  assert.equal(batch.alpha.array[0], 1);
  const array = atlas.layout.objects.get('array');
  atlas.camera.position.set(...array.position); atlas.updateArrayTransparency();
  assert.ok(Math.abs(batch.alpha.array[0] - 0.18) < 1e-6);
  const markers = atlas.content.children.find(object => object.userData.arraySlots);
  assert.deepEqual(markers.userData.arraySlots.map(slot => slot.address), ['0x1010', '0x1018']);
  for (const flow of atlas.flows) {
    const slot = markers.userData.arraySlots.find(slot => slot.address === flow.slotAddress);
    assert.ok(flow.curve.getPoint(0).distanceTo(new THREE.Vector3(...slot.position)) < 1e-9);
    const from = flow.curve.getPoint(0), to = flow.curve.getPoint(1);
    assert.ok(flow.curve.getLength() <= from.distanceTo(to) * 1.2);
  }
  atlas.disposeContent();
});

test('array approach fading is bounded, continuous, and independent of viewing direction', () => {
  const object = { side: 10, position: [0, 0, 0] };
  assert.equal(arrayOpacity([0, 0, 0], object), 0.18);
  assert.equal(arrayOpacity([5, 0, 0], object), 0.18);
  assert.equal(arrayOpacity([60, 0, 0], object), 1);
  assert.equal(arrayOpacity([15, 0, 0], object), arrayOpacity([0, -15, 0], object));
  let previous = 0;
  for (let distance = 0; distance < 65; distance += 0.1) {
    const alpha = arrayOpacity([distance, 0, 0], object);
    assert.ok(alpha >= previous - 1e-12 && alpha >= 0.18 && alpha <= 1);
    previous = alpha;
  }
});
