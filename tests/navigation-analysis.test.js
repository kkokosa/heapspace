import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { indexGraph, neighborhood, retainingPath, retainingRoutes } from '../Client/graph.js';
import { indexCards, cardEvidence, cardTableEvidence } from '../Client/cards.js';
import { Atlas } from '../Client/scene.js';

function graph(ids, edges, roots = []) {
  return { objects: ids.map((id, i) => ({ id, address: `0x${(0x1000 + i * 32).toString(16)}`, size: 32,
    type: 'Node', generation: 'Generation2', segment: 's' })),
    segments: [{ id: 's', kind: 'Generation2', start: '0x1000', end: `0x${(0x1000 + ids.length * 32).toString(16)}` }],
    edges: edges.map(([source, target, kind = 'reference']) => ({ source, target, kind, offset: 0 })),
    roots: roots.map(([target, kind = 'Strong', strong = true, annotation = false], i) =>
      ({ id: `r${i}`, target, kind, strong, annotation, address: `0x${(0x8000 + i * 8).toString(16)}` })),
    threads: [], nativeAreas: [] };
}

test('incoming and outgoing depths walk independently without switching direction at intermediate nodes', () => {
  const data = graph(['a', 'b', 'focus', 'c', 'd', 'sibling'],
    [['a', 'b'], ['b', 'focus'], ['focus', 'c'], ['c', 'd'], ['b', 'sibling']]);
  const index = indexGraph(data);
  assert.deepEqual([...neighborhood('focus', index, { incoming: 2, outgoing: 0 }).ids], ['focus', 'b', 'a']);
  assert.deepEqual([...neighborhood('focus', index, { incoming: 0, outgoing: 2 }).ids], ['focus', 'c', 'd']);
  const both = neighborhood('focus', index, { incoming: 2, outgoing: 1 });
  assert.deepEqual([...both.ids], ['focus', 'b', 'a', 'c']);
  assert.equal(both.ids.has('sibling'), false);
  const multi = neighborhood(new Set(['focus', 'sibling']), index, { incoming: 1, outgoing: 1 });
  assert.ok(multi.ids.has('b') && multi.ids.has('c') && multi.ids.has('sibling'));
  assert.equal(neighborhood('focus', index, { incoming: 2, outgoing: 2 }, 2).limited, true);
});

test('all retaining routes include shared branches/cycles and every real source but prune unrooted predecessors', () => {
  const data = graph(['a', 'b', 'join', 'cycle', 'target', 'dead', 'weak', 'annotation', 'unrelated'],
    [['a', 'join'], ['b', 'join'], ['join', 'cycle'], ['cycle', 'join'], ['cycle', 'target'],
      ['dead', 'target'], ['weak', 'target'], ['annotation', 'target'], ['a', 'unrelated']],
    [['a'], ['b', 'Pinned'], ['weak', 'WeakShort', true], ['annotation', 'Static', true, true]]);
  const result = retainingRoutes('target', indexGraph(data));
  assert.deepEqual([...result.ids].sort(), ['a', 'b', 'cycle', 'join', 'target']);
  assert.deepEqual(result.roots.map(root => root.target).sort(), ['a', 'b']);
  assert.equal(result.edges.length, 5);
  assert.equal(result.edges.filter(edge => edge.source === 'cycle' && edge.target === 'join').length, 1);
  assert.equal(result.limited, false);
});

test('dependent primaries, finalization registrations and frozen sources retain their exact semantics in route queries', () => {
  const data = graph(['primary', 'secondary', 'deadPrimary', 'target', 'finalizer', 'frozen'],
    [['primary', 'secondary', 'dependent'], ['secondary', 'target'], ['deadPrimary', 'target', 'dependent'],
      ['finalizer', 'target'], ['frozen', 'target']], [['primary'], ['deadPrimary', 'Dependent']]);
  data.finalizableObjects = ['finalizer'];
  data.objects.find(object => object.id === 'frozen').generation = 'Frozen';
  const index = indexGraph(data), result = retainingRoutes('target', index);
  assert.equal(result.ids.has('deadPrimary'), false);
  assert.equal(result.roots.length, 3);
  assert.ok(result.roots.some(root => root.permanent));
  assert.ok(result.roots.some(root => root.synthetic && root.finalization));
  const unrooted = graph(['a', 'b'], [['a', 'b'], ['b', 'a']], [['a', 'WeakLong', true]]);
  assert.deepEqual([...retainingRoutes('b', indexGraph(unrooted)).ids], ['b']);
  assert.equal(retainingPath('b', indexGraph(unrooted)).root, null);
  assert.throws(() => retainingRoutes('absent', index), /not captured/);
});

test('rendered all-route focus ignores depth and excludes unrelated roots and branches', () => {
  const data = graph(['a', 'b', 'target', 'side'], [['a', 'target'], ['b', 'target'], ['a', 'side']], [['a'], ['b']]);
  const index = indexGraph(data), routes = retainingRoutes('target', index), view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const shown = view.show(data, index, { budget: 100, heap: 'all', edges: true, roots: true, isolate: true,
    depth: { incoming: 0, outgoing: 0 }, routes }, 'target');
  assert.equal(shown.visible, 3); assert.equal(shown.context, 1);
  assert.equal(shown.edges, 2); assert.equal(shown.roots, 2);
  view.disposeContent();
});

test('orbit keyboard pans in the camera plane and rotates about the target without changing radius', () => {
  const view = Object.create(Atlas.prototype);
  view.camera = new THREE.PerspectiveCamera(); view.camera.position.set(4, 3, 10); view.camera.lookAt(0, 0, 0);
  view.orbit = { target: new THREE.Vector3() }; view.flight = { isLocked: false };
  const start = view.camera.position.clone(), direction = view.camera.getWorldDirection(new THREE.Vector3());
  view.keys = new Set(['KeyW', 'KeyD']); view.advanceOrbit(0.1);
  const movement = view.camera.position.clone().sub(start);
  assert.ok(Math.abs(movement.dot(direction)) < 1e-10);
  assert.ok(view.orbit.target.distanceTo(movement) < 1e-10);
  const center = view.orbit.target.clone(), radius = view.camera.position.distanceTo(center), before = view.camera.position.clone();
  view.keys = new Set(['KeyQ']); view.advanceOrbit(0.2);
  assert.ok(view.camera.position.distanceTo(before) > 0.1);
  assert.ok(Math.abs(view.camera.position.distanceTo(center) - radius) < 1e-10);
  view.keys = new Set(['KeyE']); view.advanceOrbit(0.2);
  assert.ok(view.camera.position.distanceTo(before) < 1e-10);
  view.flight.isLocked = true; view.keys = new Set(['KeyW']); view.advanceOrbit(1);
  assert.ok(view.camera.position.distanceTo(before) < 1e-10);
});

test('orbit keyboard does not intercept typing, modified browser shortcuts or consumed keys', () => {
  const view = Object.create(Atlas.prototype); view.flight = { isLocked: false }; view.keys = new Set();
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
    for (const event of [{ target: { tagName: 'INPUT', type: 'search' } }, { ctrlKey: true }, { metaKey: true },
      { altKey: true }, { isComposing: true }, { defaultPrevented: true }])
      view.handleKeyDown({ code: key, ...event, preventDefault() { assert.fail('Must not intercept typing/shortcuts'); } });
    assert.equal(view.keys.has(key), false);
    let prevented = false;
    view.handleKeyDown({ code: key, target: { tagName: 'CANVAS' }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(view.keys.has(key), true); view.keys.clear();
  }
});

test('camera focus updates card-control visibility immediately instead of waiting for another mouse move', () => {
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const view = Object.create(Atlas.prototype);
  view.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 20000);
  view.orbit = { target: new THREE.Vector3() };
  const control = new THREE.Sprite(new THREE.SpriteMaterial({ sizeAttenuation: false }));
  control.userData.label = { width: 20, aspect: 5, minPixels: 0, maxPixels: 150, cullBelowPixels: 55, kind: 'cardTableToggle' };
  view.labels = [control]; view.lastLabels = -Infinity;
  view.camera.position.set(0, 0, 10000); view.camera.lookAt(0, 0, 0); view.updateLabels(0);
  assert.equal(control.visible, false);
  view.focus([0, 0, 0], [20, 20, 20]);
  assert.equal(control.visible, true);
  control.geometry.dispose(); control.material.dispose();
});

function cardGraph() {
  const data = graph(['straddle', 'noYoung', 'clean', 'young', 'child'], [['straddle', 'young'], ['young', 'child']]);
  data.architecture = 'X64';
  Object.assign(data.objects[0], { address: '0x10f0', size: 32 });
  Object.assign(data.objects[1], { address: '0x1110', size: 32 });
  Object.assign(data.objects[2], { address: '0x1200', size: 32 });
  Object.assign(data.objects[3], { address: '0x2000', segment: 'y', generation: 'Generation0' });
  Object.assign(data.objects[4], { address: '0x2020', segment: 'y', generation: 'Generation0' });
  data.edges[0].offset = 8;
  data.segments = [{ id: 's', kind: 'Generation2', start: '0x1000', end: '0x1300' },
    { id: 'y', kind: 'Generation0', start: '0x2000', end: '0x2040' }];
  data.cardRegions = [{ segment: 's', start: '0x1000', count: 3, totalCount: 3, cardSize: 256, status: 'decoded',
    dirtyRuns: [{ start: 1, count: 1 }] }];
  return data;
}

test('dirty-card scan candidates include straddling and no-young-reference objects; descendants remain distinct', () => {
  const data = cardGraph(), index = indexGraph(data), cards = indexCards(data, index);
  const selected = cardEvidence({ segment: 's', index: 1 }, cards, index, 0);
  assert.deepEqual([...selected.sources], ['straddle', 'noYoung']);
  assert.deepEqual([...selected.reachable], ['young', 'child']);
  assert.equal(selected.contributing[0].slot, '0x1100');
  assert.equal(cardEvidence({ segment: 's', index: 2 }, cards, index, 0).sources.size, 0);
  const all = cardTableEvidence(new Set(['s']), cards, index, 0);
  assert.deepEqual(all.sources, selected.sources); assert.deepEqual(all.reachable, selected.reachable);
  assert.equal(all.dirtyCards, 1);
  assert.equal(cardTableEvidence(new Set(['s']), cards, index, 2).sources.size, 0);
  assert.throws(() => cardTableEvidence(new Set(['absent']), cards, index, 0), /no decoded cards/);
});

test('table toggles combine source/target focus and stay available while other card sheets are dimmed', () => {
  const data = cardGraph();
  data.cardRegions.push({ segment: 'y', start: '0x2000', count: 1, totalCount: 1, cardSize: 256, status: 'decoded', dirtyRuns: [] });
  const index = indexGraph(data), cards = indexCards(data, index), evidence = cardTableEvidence(new Set(['s']), cards, index, 0);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = [];
  view.label = function (text, position, color, width, opacity = 1, options = {}) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity }));
    sprite.position.set(...position); sprite.layers.set(1);
    sprite.userData.label = { text, width, aspect: 5, ...options }; this.content.add(sprite); this.labels.push(sprite);
    return sprite;
  };
  const shown = view.show(data, index, { budget: 100, heap: 'all', edges: true, roots: true, cards: true, isolate: true,
    selectedObjects: new Set([...evidence.sources, ...evidence.reachable]), cardSelection: evidence }, null);
  assert.equal(shown.visible, 4); assert.equal(shown.context, 1);
  const active = view.content.children.find(mesh => mesh.userData.cardMap?.info.segment === 's');
  const ghost = view.content.children.find(mesh => mesh.userData.cardMap?.info.segment === 'y');
  assert.equal(active.material.opacity, 0.7); assert.equal(ghost.material.opacity, 0.05);
  assert.equal(view.uiPickables.length, 2);
  assert.ok(view.uiPickables.every(toggle => toggle.userData.item.kind === 'cardTableToggle'));
  assert.equal(view.uiPickables.find(toggle => toggle.userData.item.value.segment === 's').userData.item.value.active, true);
  assert.equal(view.uiPickables.find(toggle => toggle.userData.item.value.segment === 'y').userData.item.value.active, false);
  view.disposeContent();
});

test('multiple table scans union overlapping young descendants without losing either source region', () => {
  const data = cardGraph();
  data.objects.push({ id: 'otherSource', address: '0x3000', size: 32, type: 'Node', generation: 'Generation1', segment: 'other' });
  data.segments.push({ id: 'other', start: '0x3000', end: '0x3020', kind: 'Generation1' });
  data.edges.push({ source: 'otherSource', target: 'young', kind: 'reference', offset: 0 });
  data.cardRegions.push({ segment: 'other', start: '0x3000', cardSize: 256, count: 1, totalCount: 1,
    status: 'decoded', dirtyRuns: [{ start: 0, count: 1 }] });
  const index = indexGraph(data), cards = indexCards(data, index);
  const evidence = cardTableEvidence(new Set(['s', 'other']), cards, index, 0);
  assert.equal(evidence.tables.length, 2);
  assert.deepEqual([...evidence.sources].sort(), ['noYoung', 'otherSource', 'straddle']);
  assert.deepEqual([...evidence.reachable], ['young', 'child']);
  assert.equal(evidence.contributing.length, 2);
  assert.equal(evidence.dirtyCards, 2);
});

test('free-space outlines use neutral gray and remain separate from unclassified dashed spans', () => {
  const view = Object.create(Atlas.prototype); view.content = new THREE.Group();
  view.gapOutlines([{ kind: 'free', side: 1, position: [0, 0, 0] }, { kind: 'unrepresented', side: 1, position: [2, 0, 0] }]);
  const free = view.content.children.find(line => line.userData.gapKind === 'free');
  const unknown = view.content.children.find(line => line.userData.gapKind === 'unrepresented');
  assert.equal(free.material.color.getHexString(), 'a5adb8');
  assert.equal(unknown.material.isLineDashedMaterial, true);
  for (const item of view.content.children) { item.geometry.dispose(); item.material.dispose(); }
});
