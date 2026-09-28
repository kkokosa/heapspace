import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { indexGraph } from '../Client/graph.js';
import { analyzeReachability, matchingReachability, rootHoverText } from '../Client/reachability.js';
import { rootTypeNames } from '../Client/root-provenance.js';
import { referenceArrows } from '../Client/reference-arrows.js';
import { directReferenceRoute, referenceRoute, unbundledReference, pipeRadius } from '../Client/spatial.js';
import { Atlas } from '../Client/scene.js';

function fixture() {
  const data = {
    architecture: 'X64', reachabilityMetadataIncluded: true, heapVerifiedForReachability: true,
    objectsWalked: 4, finalizableObjects: ['f'],
    objects: [
      { id: 'live', address: '0x1000', segment: 's', size: 64, type: 'System.Object[]', generation: 'Generation0' },
      { id: 'child', address: '0x1040', segment: 's', size: 32, type: 'Node', generation: 'Generation0' },
      { id: 'dead', address: '0x1060', segment: 's', size: 32, type: 'Node', generation: 'Generation0' },
      { id: 'f', address: '0x1080', segment: 's', size: 32, type: 'Finalizable', generation: 'Generation0' },
    ],
    segments: [{ id: 's', start: '0x1000', end: '0x1100', kind: 'Generation0' }],
    edges: [{ source: 'live', target: 'child', kind: 'reference', offset: 8 }],
    roots: [{ id: 'stack', target: 'live', address: '0x7000', kind: 'Stack', strong: true },
      { id: 'handle', target: 'live', address: '0x7010', kind: 'Strong', strong: true }],
    threads: [], nativeAreas: [],
    finalizationQueues: [{ id: 'fq', heap: 0, storage: { start: '0x8000', end: '0x8008' }, ready: { start: '0x8008', end: '0x8008' },
      entries: [{ id: 'fq0', address: '0x8000', target: 'f', ready: false }] }],
    cardRegions: [{ segment: 's', start: '0x1000', count: 1, totalCount: 1, cardSize: 256, status: 'decoded', dirtyRuns: [] }],
  };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const index = indexGraph(data), analysis = analyzeReachability(data, index);
  const settings = { budget: 100, heap: 'all', color: 'reachability', reachability: analysis, gcGeneration: 0, roots: true, edges: true, cards: true };
  return { data, index, analysis, view, settings };
}

test('reachable and unreachable highlight produce opposite foreground sets instead of merely changing color', () => {
  const { data, index, analysis, view, settings } = fixture();
  assert.deepEqual([...matchingReachability(analysis, 0, 'unreachable')], ['dead']);
  const dead = view.show(data, index, { ...settings, highlightGc: true, highlightState: 'unreachable' }, null);
  const foreground = () => view.content.children.filter(item => item.userData.layer === 'foreground')
    .flatMap(item => item.userData.items.map(entry => entry.value.id)).sort();
  assert.equal(dead.analysisFocus, true); assert.equal(dead.visible, 1); assert.equal(dead.context, 3);
  assert.deepEqual(foreground(), ['dead']);
  assert.ok(view.content.children.filter(item => item.userData.layer === 'context').every(item => item.material.opacity === 0.05 && !item.material.depthWrite));
  const live = view.show(data, index, { ...settings, highlightGc: true, highlightState: 'reachable' }, null);
  assert.deepEqual(foreground(), ['child', 'f', 'live']);
  assert.equal(live.visible, 3); assert.equal(live.context, 1);
  const selected = view.show(data, index, { ...settings, isolate: true, highlightGc: true, highlightState: 'unreachable' }, 'live');
  assert.equal(selected.analysisFocus, false);
  assert.deepEqual(foreground(), ['child', 'live']);
  view.disposeContent();
});

test('unknown objects never become verified unreachable matches', () => {
  const { data, index } = fixture();
  data.objectsTruncated = true;
  const analysis = analyzeReachability(data, index);
  assert.equal(matchingReachability(analysis, 0, 'unreachable').size, 0);
  assert.match(rootHoverText(analysis, 'dead', 0), /observed\/partial.*unknown/);
  assert.ok(rootHoverText(analysis, 'child', 0).includes('Stack / register'));
});

test('unavailable unreachable analysis preserves the overview; Unknown is a separate selectable class', () => {
  const { data, index, view, settings } = fixture();
  data.objectsTruncated = true; data.objectsWalked = 10;
  const analysis = analyzeReachability(data, index);
  const options = { ...settings, reachability: analysis };
  const overview = view.show(data, index, options, null);
  const unavailable = view.show(data, index, { ...options, highlightGc: true, highlightState: 'unreachable' }, null);
  assert.equal(unavailable.analysisUnavailable, true);
  assert.equal(unavailable.analysisFocus, false);
  assert.equal(unavailable.visible, overview.visible);
  assert.equal(unavailable.context, 0);
  assert.equal(unavailable.edges, overview.edges);
  assert.equal(unavailable.arrows, 0);
  const unknown = view.show(data, index, { ...options, highlightGc: true, highlightState: 'unknown' }, null);
  assert.equal(unknown.analysisUnavailable, false);
  assert.equal(unknown.analysisFocus, true);
  assert.equal(unknown.analysisMatches, 1);
  assert.equal(unknown.visible, 1);
  assert.equal(unknown.context, 3);
  assert.deepEqual(view.content.children.filter(mesh => mesh.userData.layer === 'foreground')
    .flatMap(mesh => mesh.userData.items.map(item => item.value.id)), ['dead']);
  view.disposeContent();
});

test('limited analysis focus is distributed over matching regions instead of prioritizing the first object', () => {
  const { data, view, settings } = fixture();
  data.objects = []; data.segments = []; data.roots = []; data.edges = [];
  data.finalizableObjects = []; data.finalizationQueues = []; data.cardRegions = [];
  for (let region = 0; region < 4; region++) {
    const start = 0x1000 + region * 0x1000, segment = `s${region}`;
    data.segments.push({ id: segment, start: `0x${start.toString(16)}`, end: `0x${(start + 320).toString(16)}`, kind: 'Generation2' });
    for (let i = 0; i < 10; i++) {
      const address = `0x${(start + i * 32).toString(16)}`;
      data.objects.push({ id: address, address, segment, size: 32, type: 'Node', generation: 'Generation2' });
      data.roots.push({ id: `root${address}`, address: `0x${(0x10000 + region * 0x100 + i * 8).toString(16)}`,
        target: address, kind: 'Strong', strong: true });
    }
  }
  data.objectsWalked = data.objects.length;
  const index = indexGraph(data), analysis = analyzeReachability(data, index);
  const shown = view.show(data, index, { ...settings, budget: 4, reachability: analysis, gcGeneration: 2,
    highlightGc: true, highlightState: 'reachable' }, null);
  const foreground = view.content.children.filter(mesh => mesh.userData.layer === 'foreground')
    .flatMap(mesh => mesh.userData.items.map(item => item.value));
  assert.equal(shown.analysisMatches, 40);
  assert.equal(shown.analysisShown, 4);
  assert.equal(new Set(foreground.map(object => object.segment)).size, 4);
  assert.equal(shown.neighborhood, null);
  view.disposeContent();
});

test('hover lists exactly the known root categories used by stripes', () => {
  const { analysis } = fixture();
  const text = rootHoverText(analysis, 'child', 0);
  for (const label of rootTypeNames(analysis.objects.get('child').rootMasks[0])) assert.ok(text.includes(label));
  assert.match(text, /^Root types \(Gen 0\):/);
  assert.match(rootHoverText(analysis, 'dead', 0), /no captured retaining path/);
  assert.match(rootHoverText(null, 'missing', 0), /unavailable/);
});

test('card sheets and unrelated finalization boxes follow selection context opacity and stop intercepting picks', () => {
  const { data, index, view, settings } = fixture();
  view.show(data, index, { ...settings, isolate: true, contextOpacity: 0.08 }, 'live');
  const card = view.content.children.find(item => item.userData.cardMap);
  const queue = view.content.children.find(item => item.userData.item?.kind === 'finalizerQueue');
  assert.equal(card.material.opacity, 0.08); assert.equal(queue.material.opacity, 0.08);
  assert.equal(card.material.depthWrite, false); assert.equal(queue.material.depthWrite, false);
  assert.ok(!view.pickables.includes(card)); assert.ok(!view.pickables.includes(queue));
  view.setContextOpacity(0);
  assert.equal(card.material.opacity, 0); assert.equal(queue.material.opacity, 0);
  view.show(data, index, settings, null);
  assert.ok(view.pickables.some(item => item.userData.cardMap));
  assert.equal(view.content.children.find(item => item.userData.cardMap).material.opacity, 0.7);
  const cardSelection = { info: data.cardRegions[0], index: 0, sources: new Set(['live']), reachable: new Set(['child']),
    contributing: [{ edge: data.edges[0] }] };
  view.show(data, index, { ...settings, isolate: true, cardSelection }, null);
  const selectedSheet = view.content.children.find(item => item.userData.cardMap);
  assert.equal(selectedSheet.material.opacity, 0.7);
  assert.ok(view.pickables.includes(selectedSheet));
  view.disposeContent();
});

test('every drawn focused reference gets incoming/outgoing cones; overview gets none', () => {
  const { data, index, view, settings } = fixture();
  const overview = view.show(data, index, settings, null);
  assert.equal(overview.arrows, 0);
  const selection = view.show(data, index, { ...settings, isolate: true }, 'live');
  const cones = view.content.children.filter(item => item.userData.referenceArrows);
  assert.equal(cones.reduce((n, item) => n + item.count, 0), 2 * (selection.edges + selection.roots));
  assert.ok(cones.every(item => item.geometry.type === 'ConeGeometry' && !view.pickables.includes(item)));
  const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
  for (const cone of cones) for (let i = 0; i < cone.count; i++) {
    cone.getMatrixAt(i, matrix); scale.setFromMatrixScale(matrix);
    if (cone === cones[0] && i === 0)
      assert.ok(scale.x < pipeRadius(1), 'the internal array-slot arrow must stay much smaller than ordinary arrowheads');
    else assert.ok(scale.x >= pipeRadius(1) * 1.64, 'ordinary object arrows must protrude beyond their pipes');
  }
  assert.equal(cones[0].userData.referenceArrows.internal, 1);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>' };
  cones[0].material.onBeforeCompile(shader);
  view.setConnectionWidth(3);
  assert.equal(shader.uniforms.referenceWidth.value, 3);
  assert.match(shader.vertexShader, /tubeCenter/);
  view.disposeContent();
});

test('arrow cones follow real local, bundled, self-loop, and internal-slot curve tangents', () => {
  const a = { id: 'a', position: [0, 0, 0], side: 2, region: { id: 'r1', position: [0, 0, 0], size: [12, 12, 12] } };
  const b = { id: 'b', position: [5, 0, 0], side: 2, region: a.region };
  const c = { id: 'c', position: [30, 0, 0], side: 2, region: { id: 'r2', position: [30, 0, 0], size: [12, 12, 12] } };
  for (const mode of ['direct', 'bundled'])
    for (const [source, target] of [[a, b], [a, c], [a, a], [{ ...a, anchor: [0.2, -0.2, 0.1] }, c]]) {
    const record = { source, target, kind: 'reference' }, arrows = referenceArrows(record, mode);
    assert.equal(arrows.length, 2);
    const route = unbundledReference(record, mode) ? null : referenceRoute(source, target, 'test');
    const paths = route ? [route.inlet, route.outlet] : [directReferenceRoute(source, target), directReferenceRoute(source, target)];
    arrows.forEach((arrow, i) => {
      const curve = new THREE.CubicBezierCurve3(...paths[i].map(point => new THREE.Vector3(...point)));
      curve.arcLengthDivisions = 12;
      const u = i === 0 ? Math.min(0.2, arrow.length * 0.8 / curve.getLength()) : 1 - Math.min(0.2, arrow.length * 0.8 / curve.getLength());
      assert.ok(new THREE.Vector3(...arrow.direction).dot(curve.getTangentAt(u)) > 0.9999);
      assert.ok(new THREE.Vector3(...arrow.position).distanceTo(curve.getPointAt(u)) < 1e-8);
      assert.ok(arrow.position.every(Number.isFinite));
    });
  }
});

test('Prism textures, array fading, and root stripes coexist even while highlight focus is enabled', () => {
  const { data, index, view, settings } = fixture();
  view.show(data, index, { ...settings, theme: 'prism', highlightGc: true, highlightState: 'reachable' }, null);
  const array = view.arrayBatches[0];
  assert.ok(array.mesh.material.userData.semanticSurface);
  assert.ok(array.mesh.material.userData.rootStripes);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>' };
  array.mesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /vArrayAlpha/);
  assert.match(shader.fragmentShader, /semanticPattern/);
  assert.match(shader.fragmentShader, /rootColors/);
  assert.ok(array.mesh.geometry.attributes.rootTypeMask.array[0] > 0);
  view.disposeContent();
});
