import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';
import { getTheme, signalPixels, typeColor } from '../Client/themes.js';
import { directReferenceRoute } from '../Client/spatial.js';

function scene() {
  const data = {
    segments: [{ id: 's', start: '0x1000', end: '0x3000', kind: 'Generation0', heap: 0 }],
    objects: [
      { id: 'a', address: '0x1000', segment: 's', type: 'Small', generation: 'Generation0', size: 32 },
      { id: 'b', address: '0x1100', segment: 's', type: 'Large', generation: 'Generation0', size: 256 },
    ],
    edges: [{ source: 'a', target: 'b', kind: 'reference' }],
    roots: [], threads: [], nativeAreas: [],
  };
  const atlas = Object.create(Atlas.prototype);
  atlas.content = new THREE.Group(); atlas.selection = new THREE.Group(); atlas.pickables = [];
  atlas.label = () => {};
  const settings = { budget: 100, heap: 'all', color: 'generation', edges: true, roots: true, native: true, reserved: false };
  return { atlas, data, index: indexGraph(data), settings };
}

test('all themes preserve geometry and topology while signals follow real source-to-target paths', () => {
  const { atlas, data, index, settings } = scene();
  let original;
  for (const theme of ['atlas', 'matrix', 'neon']) {
    const result = atlas.show(data, index, { ...settings, theme }, 'a');
    const objects = atlas.pickables.find(mesh => mesh.userData.layer === 'foreground');
    const transform = new THREE.Matrix4(); objects.getMatrixAt(0, transform);
    original ??= [...transform.elements];
    assert.deepEqual(transform.elements, original);
    assert.equal(result.edges, 1);
    assert.equal(atlas.streamStats.trunks, 0);
    assert.equal(atlas.streamStats.localLinks, 1);
    assert.equal(objects.material.wireframe, getTheme(theme).wireframe);
    assert.equal(atlas.particles.geometry.attributes.position.count, getTheme(theme).packets * getTheme(theme).trail);
    const flow = atlas.flows[0];
    assert.equal(flow.source, 'a'); assert.equal(flow.target, 'b');
    const route = directReferenceRoute(atlas.layout.objects.get('a'), atlas.layout.objects.get('b'));
    assert.ok(flow.curve.getPoint(1).distanceTo(new THREE.Vector3(...route.at(-1))) < 1e-8);
    const before = [...atlas.particles.geometry.attributes.position.array];
    atlas.updateSignals(0.5);
    assert.notDeepEqual([...atlas.particles.geometry.attributes.position.array], before);
    assert.ok([...atlas.particles.geometry.attributes.position.array].every(Number.isFinite));
    atlas.setAnimation(false);
    const paused = [...atlas.particles.geometry.attributes.position.array];
    atlas.updateSignals(1);
    assert.equal(atlas.particles.visible, false);
    assert.deepEqual([...atlas.particles.geometry.attributes.position.array], paused);
  }
  const direct = atlas.show(data, index, { ...settings, theme: 'neon', linkMode: 'direct' }, 'a');
  assert.equal(direct.edges, 1);
  assert.equal(atlas.streamStats.directLinks, 1);
  assert.equal(atlas.streamStats.trunks, 0);
  atlas.disposeContent();
});

test('flight hover refreshes at the crosshair without mouse events, and X clears without unlocking', () => {
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const { atlas, data, index, settings } = scene();
  atlas.show(data, index, settings, 'a');
  atlas.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.01, 1000);
  const object = atlas.layout.objects.get('a');
  atlas.camera.position.set(object.position[0], object.position[1] + 10, object.position[2]);
  atlas.camera.lookAt(new THREE.Vector3(...object.position));
  atlas.raycaster = new THREE.Raycaster();
  let unlocks = 0, clears = 0;
  atlas.flight = { isLocked: true, unlock() { unlocks++; this.isLocked = false; } };
  atlas.keys = new Set(['KeyW']); atlas.lastHover = -Infinity;
  atlas.onDeselect = () => { clears++; atlas.mark(null); };
  const hits = [];
  atlas.onHover = (item, cursor) => hits.push({ item, cursor });
  atlas.updateFlightHover(0);
  assert.equal(hits[0].item.value.id, 'a');
  assert.deepEqual(hits[0].cursor, { clientX: 400, clientY: 300 });
  atlas.camera.position.x += 100;
  atlas.updateFlightHover(50); assert.equal(hits.length, 1);
  atlas.updateFlightHover(100); assert.equal(hits[1].item, null);
  let prevented = false;
  atlas.handleKeyDown({ code: 'KeyX', preventDefault() { prevented = true; } });
  assert.equal(clears, 1); assert.equal(prevented, true); assert.equal(unlocks, 0);
  assert.equal(atlas.flight.isLocked, true); assert.equal(atlas.keys.has('KeyW'), true);
  atlas.handleKeyDown({ code: 'Escape' });
  assert.equal(unlocks, 1); assert.equal(atlas.keys.size, 0);
  atlas.handleKeyDown({ code: 'KeyX', target: { tagName: 'INPUT' }, preventDefault() { throw new Error('Typing X must not clear.'); } });
  assert.equal(clears, 2);
  atlas.disposeContent();
});

test('theme textures are distinct local RGBA sprites, and unsupported presets fail explicitly', () => {
  const atlas = signalPixels('dot'), matrix = signalPixels('bit'), neon = signalPixels('glow');
  assert.equal(atlas.length, 16 * 16 * 4);
  assert.notDeepEqual(atlas, matrix); assert.notDeepEqual(matrix, neon);
  assert.throws(() => getTheme('invalid'), RangeError);
});

test('default type colors are stable theme-derived shades rather than arbitrary rainbow hues', () => {
  const { atlas, data, index, settings } = scene();
  const shades = new Set();
  for (const id of ['atlas', 'matrix', 'neon']) {
    const theme = getTheme(id);
    assert.equal(typeColor('System.Object[]', theme), typeColor('System.Object[]', theme));
    shades.add(typeColor('System.Object[]', theme));
    atlas.show(data, index, { ...settings, color: undefined, theme: id }, null);
    const objects = atlas.pickables.find(mesh => mesh.userData.layer === 'foreground');
    const color = new THREE.Color(); objects.getColorAt(0, color);
    const expected = new THREE.Color(typeColor('Small', theme)).toArray();
    assert.ok(color.toArray().every((value, axis) => Math.abs(value - expected[axis]) < 1e-6));
  }
  assert.equal(shades.size, 3);
  for (let i = 0; i < 100; i++) {
    const rgb = new THREE.Color(typeColor(`Type${i}`, getTheme('matrix')));
    assert.ok(rgb.g >= rgb.r && rgb.g >= rgb.b, 'Matrix type shades stay green-dominant');
  }
  atlas.disposeContent();
});
