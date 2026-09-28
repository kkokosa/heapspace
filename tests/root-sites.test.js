import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph, resolveSite, siteKey } from '../Client/graph.js';
import { renderLayers } from '../Client/rendering.js';

function fixture() {
  const data = {
    architecture: 'X64',
    segments: [{ id: 'heap', start: '0x1000', end: '0x2000', kind: 'Pinned', heap: 0 }],
    objects: [
      { id: 'array', address: '0x1000', type: 'System.Object[]', size: 96, segment: 'heap', generation: 'Pinned' },
      { id: 'a', address: '0x1060', type: 'Node', size: 32, segment: 'heap', generation: 'Pinned' },
      { id: 'b', address: '0x1080', type: 'Node', size: 32, segment: 'heap', generation: 'Pinned' },
    ],
    edges: [{ source: 'array', target: 'a', kind: 'reference', offset: 8 },
      { source: 'array', target: 'b', kind: 'reference', offset: 16 }],
    roots: [
      { id: 'static', address: '0x1010', target: 'a', kind: 'Static', annotation: true, strong: false },
      { id: 'handle', address: '0x5008', target: 'b', kind: 'Strong', strong: true },
    ],
    threads: [], nativeAreas: [],
  };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = [];
  view.label = () => {};
  view.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.01, 1000);
  view.raycaster = new THREE.Raycaster();
  view.flight = { isLocked: false }; view.keys = new Set();
  return { data, index: indexGraph(data), view,
    settings: { budget: 100, heap: 'all', color: 'type', edges: true, roots: true, isolate: true, contextOpacity: 0.05 } };
}

test('Ctrl raycasting picks shaded root/slot sites through an opaque array, not the array shell', () => {
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const { data, index, view, settings } = fixture();
  view.show(data, index, settings, null);
  const center = { clientX: 400, clientY: 300 };
  for (const key of ['root:static', siteKey({ kind: 'slot', edge: data.edges[1] })]) {
    const item = view.siteItems.get(key);
    view.camera.position.set(item.position[0], item.position[1] + 10, item.position[2]);
    view.camera.lookAt(new THREE.Vector3(...item.position));
    assert.equal(view.pick(center).value.id, 'array');
    const picked = view.pick({ ...center, ctrlKey: true });
    assert.equal(picked.key, key);
    view.keys.add('ControlLeft');
    assert.equal(view.pick(center).key, key);
    view.flight.isLocked = true;
    assert.equal(view.pick({ clientX: 0, clientY: 0 }).key, key);
    view.flight.isLocked = false;
    view.keys.clear();
    view.keys.add('KeyR');
    assert.equal(view.pick(center).key, key);
    view.keys.clear();
  }
  for (const mesh of view.sitePickables) {
    assert.equal(mesh.geometry.type, 'SphereGeometry');
    assert.equal(mesh.material.isMeshStandardMaterial, true);
    assert.ok(mesh.material.metalness > 0);
  }
  view.disposeContent();
});

test('single array-slot selection highlights only that edge and keeps other slots as context', () => {
  const { data, index, view, settings } = fixture();
  const site = { kind: 'slot', edge: data.edges[1] };
  const result = view.show(data, index, { ...settings, site }, null);
  assert.equal(result.edges, 1); assert.equal(result.roots, 0);
  assert.deepEqual([...result.neighborhood.ids], ['array', 'b']);
  assert.equal(view.streamStats.references, 1);
  assert.equal(view.flows[0].source, 'array'); assert.equal(view.flows[0].target, 'b');
  assert.equal(view.flows[0].slotAddress, '0x1018');
  assert.equal(view.selection.children[0].geometry.type, 'RingGeometry');
  assert.equal(view.selection.children[0].userData.billboard, true);
  assert.ok(view.siteItems.has(siteKey({ kind: 'slot', edge: data.edges[0] })));
  view.disposeContent();
});

test('single GC-root selection does not highlight other roots or claim an annotation is retaining', () => {
  const { data, index, view, settings } = fixture();
  const result = view.show(data, index, { ...settings, site: { kind: 'root', id: 'static' } }, null);
  assert.equal(result.edges, 0); assert.equal(result.roots, 1);
  assert.equal(result.site.root.annotation, true); assert.equal(result.site.root.strong, false);
  assert.deepEqual([...result.neighborhood.ids], ['array', 'a']);
  assert.equal(view.streamStats.references, 1);
  assert.equal(view.flows[0].source, 'static'); assert.equal(view.flows[0].target, 'a');
  assert.equal(view.selectionKind, 'site');
  view.disposeContent();
});

test('unresolved targets remain explicit and stale sites are rejected', () => {
  const { data, view, settings } = fixture();
  data.roots.push({ id: 'missing', address: '0x5010', target: null, kind: 'WeakShort', strong: false });
  const index = indexGraph(data);
  const result = view.show(data, index, { ...settings, site: { kind: 'root', id: 'missing' } }, null);
  assert.equal(result.roots, 0); assert.equal(result.neighborhood.missing, 1);
  assert.ok(view.siteItems.has('root:missing'));
  assert.throws(() => resolveSite({ kind: 'root', id: 'removed' }, index), /no longer present/);
  assert.throws(() => resolveSite({ kind: 'slot', edge: { ...data.edges[0] } }, index), /no longer present/);
  view.disposeContent();
});

test('region plaques have bounded screen size and prefer the selected region when labels overlap', () => {
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const view = Object.create(Atlas.prototype);
  view.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 1000);
  view.camera.position.set(0, 0, 20); view.camera.lookAt(0, 0, 0);
  view.labels = ['a', 'b'].map(regionId => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
    sprite.userData.label = { width: 20, aspect: 5 }; sprite.userData.regionId = regionId;
    sprite.renderOrder = renderLayers.labels;
    return sprite;
  });
  view.activeLabelRegion = 'b'; view.lastLabels = -Infinity;
  view.updateLabels(0);
  assert.equal(view.labels[0].visible, false); assert.equal(view.labels[1].visible, true);
  const pixelsPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(55 / 2)));
  for (const z of [2, 20, 900]) {
    view.camera.position.z = z; view.updateLabels(z * 1000);
    const width = view.labels[1].scale.x * pixelsPerUnit;
    assert.ok(width >= 110 - 1e-9 && width <= 230 + 1e-9);
  }
  for (const sprite of view.labels) { sprite.geometry.dispose(); sprite.material.dispose(); }
});
