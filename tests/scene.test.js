import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';

test('actual scene uses byte-scaled boxes, non-pickable region guides, and noninflating selection', () => {
  const data = {
    segments: [{ id: 's', start: '0x1000', end: '0x3000', kind: 'Generation0', heap: 0 }],
    objects: [{ id: 'a', address: '0x1000', segment: 's', type: 'Small', generation: 'Generation0', size: 32 },
      { id: 'b', address: '0x1100', segment: 's', type: 'Large', generation: 'Generation0', size: 256 },
      { id: 'c', address: '0x1200', segment: 's', type: 'Unrelated', generation: 'Generation0', size: 32 }],
    edges: [{ source: 'a', target: 'b', kind: 'reference' }],
    roots: [], threads: [], nativeAreas: [],
  };
  const atlas = Object.create(Atlas.prototype);
  atlas.content = new THREE.Group(); atlas.selection = new THREE.Group(); atlas.pickables = [];
  atlas.label = () => {};
  const settings = { budget: 100, heap: 'all', color: 'generation', edges: true, roots: true, native: true, reserved: false };
  atlas.show(data, indexGraph(data), settings, null);
  const boxes = atlas.pickables.find(mesh => mesh.isInstancedMesh);
  assert.equal(boxes.geometry.type, 'BoxGeometry');
  assert.ok(atlas.pickables.every(mesh => mesh.userData.item?.kind !== 'segment'));
  const before = new THREE.Matrix4(); boxes.getMatrixAt(0, before);
  atlas.show(data, indexGraph(data), settings, 'a');
  const after = new THREE.Matrix4(); atlas.pickables[0].getMatrixAt(0, after);
  assert.deepEqual(after.elements, before.elements);
  assert.equal(atlas.selection.children.length, 1);
  assert.ok(atlas.content.children.some(mesh => mesh.isMesh && !mesh.isInstancedMesh));
  assert.ok(atlas.flows.length > 0);
  assert.ok(atlas.content.children.every(mesh => !mesh.geometry || [...mesh.geometry.attributes.position.array].every(Number.isFinite)));
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  atlas.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.01, 1000);
  const position = atlas.layout.objectPosition(data.objects[0]);
  atlas.camera.position.set(position[0], position[1] + 10, position[2]);
  atlas.camera.lookAt(new THREE.Vector3(...position)); atlas.camera.updateMatrixWorld();
  atlas.content.updateMatrixWorld(true); atlas.flight = { isLocked: false }; atlas.raycaster = new THREE.Raycaster();
  assert.equal(atlas.pick({ clientX: 400, clientY: 300 }).value.id, 'a');
  atlas.mark(null);
  assert.equal(atlas.selection.children.length, 0);
  assert.equal(atlas.selectedPosition, null);
  const originalPosition = [...atlas.layout.objectPosition(data.objects[0])];
  const isolated = atlas.show(data, indexGraph(data), { ...settings, isolate: true }, 'a');
  assert.equal(isolated.visible, 2);
  assert.equal(isolated.context, 1);
  const context = atlas.content.children.find(mesh => mesh.userData.layer === 'context');
  assert.equal(context.material.opacity, 0.05);
  assert.equal(context.material.depthWrite, false);
  assert.ok(!atlas.pickables.includes(context));
  atlas.setContextOpacity(0.2);
  assert.equal(context.material.opacity, 0.2);
  assert.equal(atlas.streamStats.trunks, 0);
  assert.equal(atlas.streamStats.localLinks, 1);
  assert.equal(atlas.streamStats.inlets, 0);
  assert.equal(atlas.streamStats.outlets, 0);
  assert.deepEqual(atlas.layout.objectPosition(data.objects[0]), originalPosition);
  assert.equal(atlas.show(data, indexGraph(data), settings, null).visible, 3);
  atlas.disposeContent();
});

test('forward flight follows upward/downward pitch, reverses correctly, and retains world altitude control', () => {
  for (const pitch of [-Math.PI / 3, Math.PI / 3, Math.PI / 2 - 0.001]) {
    const atlas = Object.create(Atlas.prototype);
    atlas.camera = new THREE.PerspectiveCamera();
    atlas.camera.rotation.set(pitch, 0.4, 0, 'YXZ'); atlas.camera.updateMatrixWorld();
    atlas.speed = 10; atlas.keys = new Set(['KeyW']);
    const direction = atlas.camera.getWorldDirection(new THREE.Vector3());
    atlas.advanceFlight(1);
    assert.ok(atlas.camera.position.distanceTo(direction.clone().multiplyScalar(10)) < 1e-9);
    assert.ok(Math.abs(atlas.camera.position.y) > 5);
    atlas.keys = new Set(['KeyS']); atlas.advanceFlight(1);
    assert.ok(atlas.camera.position.length() < 1e-9);
    atlas.keys = new Set(['KeyE']); atlas.advanceFlight(1);
    assert.deepEqual(atlas.camera.position.toArray(), [0, 10, 0]);
    atlas.camera.position.set(0, 0, 0); atlas.keys = new Set(['KeyW', 'KeyD', 'ShiftLeft']); atlas.advanceFlight(1);
    assert.ok(Math.abs(atlas.camera.position.length() - 40) < 1e-9);
  }
});

test('Space latches one-tenth flight speed and Shift always overrides it with fourfold speed', () => {
  const atlas = Object.create(Atlas.prototype);
  atlas.camera = new THREE.PerspectiveCamera();
  atlas.camera.rotation.set(0.6, 0.4, 0, 'YXZ');
  atlas.speed = 50; atlas.flight = { isLocked: true };
  const event = code => ({ code, preventDefault() {} });
  for (const movement of [['KeyW'], ['KeyS'], ['KeyA'], ['KeyD'], ['KeyQ'], ['KeyE'], ['KeyW', 'KeyD']]) {
    atlas.camera.position.set(0, 0, 0); atlas.keys = new Set(movement); atlas.slowFlight = false;
    atlas.advanceFlight(1); const normal = atlas.camera.position.clone();
    const measure = factor => {
      atlas.camera.position.set(0, 0, 0); atlas.advanceFlight(1);
      assert.ok(atlas.camera.position.distanceTo(normal.clone().multiplyScalar(factor)) < 1e-9);
      assert.equal(atlas.speed, 50);
    };
    let prevented = false;
    atlas.handleKeyDown({ code: 'Space', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    atlas.handleKeyUp(event('Space'));
    assert.equal(atlas.slowFlight, true); measure(0.1);
    atlas.handleKeyDown({ ...event('Space'), repeat: true });
    assert.equal(atlas.slowFlight, true); measure(0.1);
    for (const shift of ['ShiftLeft', 'ShiftRight']) {
      atlas.handleKeyDown(event(shift)); measure(4);
      atlas.handleKeyUp(event(shift)); measure(0.1);
    }
    atlas.handleKeyDown(event('Space')); atlas.handleKeyUp(event('Space'));
    assert.equal(atlas.slowFlight, false); measure(1);
    atlas.handleKeyDown(event('ShiftLeft')); measure(4);
    atlas.handleKeyUp(event('ShiftLeft')); measure(1);
  }
});

test('flight speed feedback follows the latch and both Shift keys without intercepting Space outside flight', () => {
  const atlas = Object.create(Atlas.prototype), modes = [];
  atlas.flight = { isLocked: true }; atlas.keys = new Set(); atlas.slowFlight = false;
  atlas.onFlightSpeed = mode => modes.push(mode);
  const event = code => ({ code, preventDefault() {} });
  atlas.handleKeyDown(event('Space'));
  atlas.handleKeyDown({ ...event('Space'), repeat: true });
  atlas.handleKeyUp(event('Space'));
  assert.deepEqual(modes, ['slow']);
  atlas.handleKeyDown(event('ShiftLeft'));
  atlas.handleKeyDown(event('Space')); atlas.handleKeyUp(event('Space'));
  assert.equal(atlas.slowFlight, false);
  assert.equal(atlas.flightSpeedMode(), 'fast');
  atlas.handleKeyDown(event('ShiftRight')); atlas.handleKeyUp(event('ShiftLeft'));
  assert.equal(modes.at(-1), 'fast');
  atlas.handleKeyUp(event('ShiftRight'));
  assert.equal(modes.at(-1), 'normal');
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'isComposing', 'defaultPrevented']) {
    atlas.handleKeyDown({ code: 'Space', [flag]: true, preventDefault() { assert.fail('Reserved keys must not be intercepted.'); } });
    assert.equal(atlas.slowFlight, false);
  }
  atlas.flight.isLocked = false;
  for (const target of [{ tagName: 'CANVAS' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'BUTTON' }])
    atlas.handleKeyDown({ code: 'Space', target, preventDefault() { assert.fail('Space retains normal UI behavior outside flight.'); } });
  assert.equal(atlas.slowFlight, false);
});
