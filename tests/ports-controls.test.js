import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { nearestRegionPorts, regionPorts, referenceRoute } from '../Client/spatial.js';
import { labelOpacity, addTubeCenters, applyTubeWidth } from '../Client/rendering.js';
import { getTheme } from '../Client/themes.js';

function region(id, position, size = [10, 10, 10]) { return { id, position, size, top: position[1] + size[1] / 2 }; }
function aligned(a, b) {
  const x = new THREE.Vector3(...a).normalize(), y = new THREE.Vector3(...b).normalize();
  return x.dot(y) > 0.999999;
}
const difference = (a, b) => a.map((value, i) => value - b[i]);

test('six axis directions choose facing side ports rather than a forced top entry', () => {
  const a = region('a', [0, 0, 0]);
  assert.equal(regionPorts(a).length, 6);
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const position = [0, 0, 0]; position[axis] = sign * 30;
    const b = region('b', position), pair = nearestRegionPorts(a, b);
    assert.equal(pair.source.face, `${'xyz'[axis]}${sign > 0 ? '+' : '-'}`);
    assert.equal(pair.target.face, `${'xyz'[axis]}${sign > 0 ? '-' : '+'}`);
    const reverse = nearestRegionPorts(b, a);
    assert.deepEqual(pair.source.entry, reverse.target.entry);
    const source = { id: 'source', position: [0, 0, 0], side: 1, region: a };
    const target = { id: 'target', position, side: 1, region: b };
    const route = referenceRoute(source, target, 'pair', pair);
    assert.deepEqual(route.inlet.at(-1), route.trunk[0]);
    assert.deepEqual(route.trunk.at(-1), route.outlet[0]);
    assert.ok(aligned(difference(route.inlet[3], route.inlet[2]), difference(route.trunk[1], route.trunk[0])));
    assert.ok(aligned(difference(route.trunk[3], route.trunk[2]), difference(route.outlet[1], route.outlet[0])));
    assert.ok([...route.inlet, ...route.trunk, ...route.outlet].every(point => point.every(Number.isFinite)));
  }
});

test('asymmetric diagonal regions use the globally closest pair of the 36 face-center combinations', () => {
  const a = region('a', [-7, 4, 3], [8, 12, 10]), b = region('b', [35, -18, 40], [20, 6, 14]);
  const chosen = nearestRegionPorts(a, b);
  const distance = (x, y) => Math.hypot(...difference(x.entry, y.entry));
  const minimum = Math.min(...regionPorts(a).flatMap(source => regionPorts(b).map(target => distance(source, target))));
  assert.ok(Math.abs(distance(chosen.source, chosen.target) - minimum) < 1e-9);
});

test('labels fade with both absolute distance and depth relative to nearby labels, except the selected region', () => {
  const near = labelOpacity(20, 20, 300), medium = labelOpacity(150, 20, 300), far = labelOpacity(800, 20, 300);
  assert.ok(near > medium && medium > far);
  assert.ok(far > 0 && far < 0.25);
  assert.ok(labelOpacity(800, 800, 300) < labelOpacity(20, 20, 300), 'Even a lone label dims when moving away.');
  assert.ok(labelOpacity(800, 20, 300, 0.45, true) >= 0.9);
});

test('F toggles flight without losing selection, G focuses without changing mode, and Space is the slow key', () => {
  const view = Object.create(Atlas.prototype);
  let focuses = 0, prevented = 0;
  view.keys = new Set(); view.selectedPosition = [1, 2, 3];
  view.flight = { isLocked: false, lock() { this.isLocked = true; }, unlock() { this.isLocked = false; } };
  view.focus = () => { focuses++; };
  const key = code => ({ code, preventDefault() { prevented++; } });
  view.handleKeyDown(key('KeyF')); assert.equal(view.flight.isLocked, true);
  view.handleKeyDown({ ...key('KeyF'), repeat: true }); assert.equal(view.flight.isLocked, true);
  view.handleKeyDown(key('KeyG')); assert.equal(focuses, 1); assert.equal(view.flight.isLocked, true);
  view.handleKeyDown(key('Space')); assert.equal(view.slowFlight, true); assert.equal(view.keys.has('Space'), false);
  view.handleKeyDown(key('KeyF')); assert.equal(view.flight.isLocked, false);
  view.handleKeyDown({ ...key('KeyF'), target: { tagName: 'INPUT' } }); assert.equal(view.flight.isLocked, false);
  view.handleKeyDown(key('KeyF')); assert.equal(view.flight.isLocked, true); assert.equal(view.slowFlight, true);
  assert.ok(prevented >= 5);
  assert.deepEqual(view.selectedPosition, [1, 2, 3]);
});

test('F works from panel controls without deselecting, but leaves typing and browser shortcuts alone', () => {
  const view = Object.create(Atlas.prototype);
  view.keys = new Set(); view.selectedPosition = [1, 2, 3];
  view.flight = { isLocked: false, lock() { this.isLocked = true; }, unlock() { this.isLocked = false; } };
  view.onDeselect = () => assert.fail('Entering flight must not clear selection or highlighting.');
  for (const target of [
    { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'radio' },
    { tagName: 'INPUT', type: 'range' }, { tagName: 'SELECT' }, { tagName: 'BUTTON' },
  ]) {
    let prevented = false;
    view.handleKeyDown({ code: 'KeyF', target, preventDefault() { prevented = true; } });
    assert.equal(view.flight.isLocked, true, `${target.type ?? target.tagName} focus must allow F`);
    assert.equal(prevented, true, 'F must not also change the focused control.');
    view.handleKeyDown({ code: 'KeyF', target: { tagName: 'CANVAS' }, preventDefault() {} });
    assert.equal(view.flight.isLocked, false);
  }
  for (const target of [
    ...['text', 'search', 'email', 'password', 'number', 'url', 'tel'].map(type => ({ tagName: 'INPUT', type })),
    { tagName: 'TEXTAREA' }, { tagName: 'SPAN', isContentEditable: true },
  ]) {
    view.handleKeyDown({ code: 'KeyF', target, preventDefault() { assert.fail('Typing must not be intercepted.'); } });
    assert.equal(view.flight.isLocked, false);
  }
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'isComposing', 'defaultPrevented']) {
    view.handleKeyDown({ code: 'KeyF', target: { tagName: 'SELECT' }, [flag]: true,
      preventDefault() { assert.fail(`${flag} must not be intercepted.`); } });
    assert.equal(view.flight.isLocked, false);
  }
  view.handleKeyDown({ code: 'KeyX', target: { tagName: 'INPUT', type: 'checkbox' }, preventDefault() {} });
  assert.deepEqual(view.selectedPosition, [1, 2, 3]);
});

test('wide reference width updates uniforms and line widths without moving centerlines or rebuilding geometry', () => {
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.wideLineMaterials = [];
  view.theme = getTheme();
  view.setConnectionWidth(1.5);
  view.lines(new Float32Array([0, 0, 0, 5, 0, 0]), '#00ff00');
  const line = view.content.children[0], geometry = line.geometry;
  assert.equal(line.isLineSegments2, true);
  assert.equal(line.material.linewidth, 3);
  view.setConnectionWidth(3);
  assert.equal(line.material.linewidth, 6); assert.equal(line.geometry, geometry);
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(), new THREE.Vector3(1, 1, 0), new THREE.Vector3(2, 1, 0), new THREE.Vector3(3, 0, 0));
  const tube = addTubeCenters(new THREE.TubeGeometry(curve, 8, 0.1, 5), curve, 8);
  assert.equal(tube.attributes.tubeCenter.count, tube.attributes.position.count);
  const material = applyTubeWidth(new THREE.MeshStandardMaterial(), view.referenceWidth);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>' };
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.referenceWidth, view.referenceWidth);
  assert.match(shader.vertexShader, /tubeCenter/);
  tube.dispose(); material.dispose(); geometry.dispose(); line.material.dispose();
});

test('all visual themes now carry several packets with substantial trails', () => {
  for (const id of ['atlas', 'matrix', 'neon']) {
    const theme = getTheme(id);
    assert.ok(theme.packets >= 3); assert.ok(theme.trail >= 4);
  }
});
