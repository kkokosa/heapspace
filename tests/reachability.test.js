import test from 'node:test';
import assert from 'node:assert/strict';
import { indexGraph } from '../Client/graph.js';
import { analyzeReachability, collectionExplanation, collectionState, matchingReachability, reachabilityColor, reachabilityPalette, reachableBy } from '../Client/reachability.js';
import { Atlas } from '../Client/scene.js';
import { typeColor, getTheme } from '../Client/themes.js';
import * as THREE from 'three';

function graph(generations, edges = [], roots = [], finalizableObjects = []) {
  return {
    reachabilityMetadataIncluded: true, heapVerifiedForReachability: true,
    objectsTruncated: false, edgesTruncated: false, rootsTruncated: false,
    invalidObjects: 0, heapVerificationIssues: 0, invalidFinalizableObjects: 0, finalizableObjectsTruncated: false,
    objectsWalked: Object.keys(generations).length, finalizableObjects,
    objects: Object.entries(generations).map(([id, generation], i) => ({
      id, generation, address: `0x${(0x1000 + i * 32).toString(16)}`, size: 32, type: 'Fixture.Node', segment: 's',
    })),
    segments: [{ id: 's', start: '0x1000', end: `0x${(0x1000 + Object.keys(generations).length * 32).toString(16)}`, kind: 'Generation2' }],
    edges: edges.map(([source, target, kind = 'reference']) => ({ source, target, kind, offset: 0 })),
    roots: roots.map(([target, kind = 'Strong', strong = true, annotation = false], i) =>
      ({ id: `root${i}`, address: `0x${(0x5000 + i * 8).toString(16)}`, target, kind, strong, annotation })),
    threads: [], nativeAreas: [],
  };
}
const analyze = data => analyzeReachability(data, indexGraph(data));

test('reachable-by lists observed sources but never labels partial missing paths not reachable', () => {
  const data = graph({ live: 'Generation2', child: 'Generation0', dead: 'Generation0', finalizer: 'Generation2' },
    [['live', 'child']], [['live']], ['finalizer']);
  const result = analyze(data);
  assert.deepEqual(reachableBy(result, 'child'), { state: 'reachable', types: ['Strong handle'] });
  assert.deepEqual(reachableBy(result, 'dead'), { state: 'not reachable', types: [] });
  assert.deepEqual(reachableBy(result, 'finalizer'), { state: 'reachable', types: ['Finalization'] });
  assert.ok(reachableBy(result, 'child', 0).types.includes('Older-generation boundary'));
  data.objectsTruncated = true;
  const partial = analyze(data);
  assert.deepEqual(reachableBy(partial, 'dead'), { state: 'unknown', types: [] });
  assert.deepEqual(reachableBy(partial, 'child'), { state: 'reachable', types: ['Strong handle'] });
  assert.deepEqual(reachableBy(null, 'absent'), { state: 'unknown', types: [] });
});

test('marking handles cycles and never treats weak handles or static annotations as retaining roots', () => {
  const data = graph({ a: 'Generation0', b: 'Generation0', c: 'Generation0', d: 'Generation0' },
    [['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c']],
    [['a'], ['c', 'WeakShort', false], ['d', 'Static', true, true]]);
  const result = analyze(data);
  assert.equal(result.complete, true);
  assert.equal(result.objects.get('a').state, 'reachable');
  assert.equal(result.objects.get('b').state, 'reachable');
  assert.equal(result.objects.get('c').state, 'unreachable');
  assert.deepEqual(result.counts.candidates, [2, 2, 2]);
});

test('dependent-handle chains activate only after a primary is live', () => {
  const data = graph({ primary: 'Generation0', secondary: 'Generation0', last: 'Generation0' },
    [['primary', 'secondary', 'dependent'], ['secondary', 'last', 'dependent']],
    [['primary', 'Dependent', true]]);
  assert.equal(analyze(data).counts.unreachable, 3);
  data.roots.push({ id: 'real', target: 'primary', kind: 'Strong', strong: true });
  assert.equal(analyze(data).counts.reachable, 3);
});

test('unreachable older objects can retain young objects until the older generation is condemned', () => {
  const data = graph({ old: 'Generation2', middle: 'Generation1', young: 'Generation0', lone: 'Generation0' },
    [['old', 'middle'], ['middle', 'young']]);
  const result = analyze(data);
  assert.equal(result.olderToYounger, 2);
  assert.deepEqual(result.objects.get('young').eligible, [false, false, true]);
  assert.equal(result.objects.get('young').earliest, 2);
  assert.match(collectionExplanation(result.objects.get('young'), 0), /generations not collected/);
  assert.deepEqual(result.objects.get('lone').eligible, [true, true, true]);
  const onlyMiddle = graph({ middle: 'Generation1', young: 'Generation0' }, [['middle', 'young']]);
  assert.equal(analyze(onlyMiddle).objects.get('young').earliest, 1);
});

test('LOH and POH are Gen2; frozen objects are permanent and preserve their referents', () => {
  const data = graph({ large: 'Large', pinned: 'Pinned', frozen: 'Frozen', child: 'Generation0' }, [['frozen', 'child']]);
  const result = analyze(data);
  assert.deepEqual(result.objects.get('large').eligible, [false, false, true]);
  assert.deepEqual(result.objects.get('pinned').eligible, [false, false, true]);
  assert.equal(result.objects.get('frozen').state, 'permanent');
  assert.equal(result.objects.get('child').state, 'reachable');
});

test('registered finalizable objects and descendants are conservatively deferred, while ready finalizers are roots', () => {
  const data = graph({ finalizer: 'Generation0', child: 'Generation0', separate: 'Generation0' },
    [['finalizer', 'child']], [], ['finalizer']);
  const result = analyze(data);
  assert.equal(result.objects.get('finalizer').state, 'finalization');
  assert.equal(result.objects.get('child').state, 'finalization');
  assert.deepEqual(result.objects.get('child').eligible, [false, false, false]);
  assert.equal(result.objects.get('separate').state, 'unreachable');
  data.roots.push({ id: 'ready', target: 'finalizer', kind: 'FinalizerQueue', strong: true });
  assert.equal(analyze(data).objects.get('finalizer').state, 'reachable');
});

test('partial/legacy/unverified graphs return unknown instead of false unreachability, while positive paths remain valid', () => {
  for (const patch of [
    { objectsTruncated: true }, { edgesTruncated: true }, { rootsTruncated: true }, { objectsWalked: 10 },
    { heapVerifiedForReachability: false }, { reachabilityMetadataIncluded: false },
    { invalidObjects: 1 }, { heapVerificationIssues: 1 }, { invalidFinalizableObjects: 1 },
    { finalizableObjectsTruncated: true }, { finalizableObjects: undefined },
  ]) {
    const data = { ...graph({ live: 'Generation0', missingPath: 'Generation0' }, [], [['live']]), ...patch };
    const result = analyze(data);
    assert.equal(result.complete, false, JSON.stringify(patch));
    assert.equal(result.objects.get('live').state, 'reachable');
    assert.equal(result.objects.get('missingPath').state, 'unknown');
    assert.deepEqual(result.objects.get('missingPath').eligible, [null, null, null]);
    assert.deepEqual(result.counts.candidates, [0, 0, 0]);
  }
  for (const data of [
    graph({ x: 'Generation0' }, [['x', 'absent']]),
    graph({ x: 'Generation0' }, [], [['absent']]),
    graph({ x: 'Generation0' }, [], [], ['absent']),
    graph({ x: 'Unknown' }),
  ]) assert.equal(analyze(data).objects.get('x').state, 'unknown');
});

test('full-GC reachable and unreachable sets partition a verified collectible heap, with frozen objects outside', () => {
  const data = graph({ live: 'Generation2', young: 'Generation0', middle: 'Generation1', large: 'Large',
    pinned: 'Pinned', dead: 'Generation2', finalizer: 'Generation2', finalizedChild: 'Generation2', frozen: 'Frozen' },
    [['live', 'young'], ['young', 'live'], ['finalizer', 'finalizedChild']], [['live']], ['finalizer']);
  const result = analyze(data);
  const live = matchingReachability(result, 2, 'reachable'), dead = matchingReachability(result, 2, 'unreachable');
  assert.equal(result.complete, true);
  assert.deepEqual([...live].sort(), ['finalizedChild', 'finalizer', 'live', 'young']);
  assert.deepEqual([...dead].sort(), ['dead', 'large', 'middle', 'pinned']);
  assert.equal([...live].some(id => dead.has(id)), false);
  assert.equal(live.size + dead.size + result.collections[2].outside, data.objects.length);
  assert.equal(result.collections[2].outside, 1);
  assert.equal(result.collections[2].unknown, 0);
});

test('a missing intermediate path creates unknown objects, not a complementary dead set', () => {
  const data = graph({ live: 'Generation2', target: 'Generation2', finalizer: 'Generation2',
    finalizedChild: 'Generation2', frozen: 'Frozen' },
    [['live', 'omitted'], ['omitted', 'target'], ['finalizer', 'finalizedChild']], [['live']], ['finalizer']);
  data.objectsWalked++;
  data.objectsTruncated = true;
  const result = analyze(data);
  assert.equal(result.complete, false);
  assert.equal(result.collections[2].reachable, 3);
  assert.equal(result.collections[2].unreachable, 0);
  assert.equal(result.collections[2].unknown, 1);
  assert.equal(result.collections[2].outside, 1);
  assert.deepEqual([...matchingReachability(result, 2, 'unknown')], ['target']);
  assert.equal(collectionState(result.objects.get('finalizedChild'), 2), 'reachable');
  assert.match(collectionExplanation(result.objects.get('finalizedChild'), 2), /Reachable through an observed retention source/);
});

test('overlay respects collection scope and does not alter graph layout, edges, or object sizes', () => {
  const data = graph({ old: 'Generation2', young: 'Generation0' }, [['old', 'young']]);
  const analysis = analyze(data), entry = analysis.objects.get('young');
  assert.equal(reachabilityColor(entry, '0'), null);
  assert.equal(reachabilityColor(entry, '2'), reachabilityPalette.unreachable);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const settings = { budget: 100, heap: 'all', edges: true, roots: true };
  const index = indexGraph(data);
  const baseline = view.show(data, index, settings, null);
  const positions = data.objects.map(object => [...view.layout.objectPosition(object)]);
  for (const theme of ['atlas', 'matrix', 'neon', 'prism']) {
    const result = view.show(data, index, { ...settings, theme, reachability: analysis, gcGeneration: 2, highlightGc: true }, null);
    assert.equal(result.edges, baseline.edges);
    assert.deepEqual(data.objects.map(object => view.layout.objectPosition(object)), positions);
    const mesh = view.pickables.find(item => item.userData.layer === 'foreground'), color = new THREE.Color();
    mesh.getColorAt(0, color);
    assert.equal(result.analysisFocus, true);
    assert.equal(color.getHexString(), new THREE.Color(typeColor('Fixture.Node', getTheme(theme))).getHexString());
  }
  view.disposeContent();
});
