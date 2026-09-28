import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { indexGraph } from '../Client/graph.js';
import { analyzeReachability, collectionState } from '../Client/reachability.js';
import { rootTypeNames } from '../Client/root-provenance.js';
import { applyRootStripes } from '../Client/root-colors.js';
import { cardState, indexCards, cardEvidence } from '../Client/cards.js';
import { finalizationRoots } from '../Client/finalization.js';
import { layout, arraySlotPosition } from '../Client/spatial.js';
import { Atlas } from '../Client/scene.js';

function graph() {
  return {
    architecture: 'X64', reachabilityMetadataIncluded: true, heapVerifiedForReachability: true,
    objectsWalked: 5, finalizableObjects: ['f'],
    objects: [
      { id: 'a', address: '0x1000', size: 32, type: 'Node', generation: 'Generation2', segment: 's' },
      { id: 'b', address: '0x1100', size: 32, type: 'Node', generation: 'Generation2', segment: 's' },
      { id: 'target', address: '0x2000', size: 32, type: 'Node', generation: 'Generation0', segment: 'y' },
      { id: 'child', address: '0x2020', size: 32, type: 'Node', generation: 'Generation1', segment: 'y' },
      { id: 'f', address: '0x2040', size: 32, type: 'Node', generation: 'Generation0', segment: 'y' },
    ],
    segments: [{ id: 's', start: '0x1000', end: '0x1200', kind: 'Generation2' }, { id: 'y', start: '0x2000', end: '0x2060', kind: 'Ephemeral' }],
    edges: [
      { source: 'a', target: 'target', kind: 'reference', offset: 0 },
      { source: 'b', target: 'target', kind: 'reference', offset: 0 },
      { source: 'target', target: 'child', kind: 'reference', offset: 0 },
      { source: 'f', target: 'target', kind: 'reference', offset: 0 },
    ],
    roots: [{ id: 'r1', target: 'a', address: '0x6000', kind: 'Stack', strong: true },
      { id: 'r2', target: 'b', address: '0x6010', kind: 'StaticVar', strong: true }],
    cardRegions: [{ segment: 's', start: '0x1000', count: 2, totalCount: 2, cardSize: 256, status: 'decoded', tableAddress: '0x7000', dirtyRuns: [{ start: 0, count: 1 }] }],
    finalizationQueues: [{ id: 'fq', runtime: 0, heap: 0, storage: { start: '0x8000', end: '0x8010' },
      ready: { start: '0x8008', end: '0x8010' }, entries: [
        { id: 'finalizer1', address: '0x8000', target: 'f', ready: false },
        { id: 'finalizer2', address: '0x8008', target: 'a', ready: true },
      ], truncated: false, unreadableSlots: 0 }],
    threads: [], nativeAreas: [{ start: '0x8000', end: '0x9000', size: 4096, state: 'committed', kind: 'private', owners: [] }],
  };
}

test('root provenance unions multiple source types through cycles and treats finalization as reachable', () => {
  const data = graph(); data.edges.push({ source: 'child', target: 'target', kind: 'reference' });
  const analysis = analyzeReachability(data, indexGraph(data));
  const types = rootTypeNames(analysis.objects.get('target').rootMasks[0]);
  assert.ok(types.includes('Stack / register'));
  assert.ok(types.includes('Static storage'));
  assert.ok(types.includes('Finalization'));
  assert.ok(types.includes('Older-generation boundary'));
  assert.equal(collectionState(analysis.objects.get('f'), 0), 'reachable');
  assert.equal(collectionState(analysis.objects.get('a'), 0), 'outside');
  assert.equal(analysis.collections[0].unreachable, 0);
  const reversed = structuredClone(data); reversed.edges.reverse(); reversed.roots.reverse();
  assert.deepEqual(analyzeReachability(reversed, indexGraph(reversed)).objects.get('target').rootMasks,
    analysis.objects.get('target').rootMasks);
});

test('card lookup distinguishes dirty/clean/unknown and attributes only captured condemned paths', () => {
  const data = graph(), index = indexGraph(data), cards = indexCards(data, index), info = data.cardRegions[0];
  assert.equal(cardState(info, 0), true); assert.equal(cardState(info, 1), false); assert.equal(cardState(info, 2), null);
  assert.equal(cardState({ ...info, status: 'unreadable' }, 0), null);
  const gen0 = cardEvidence({ segment: 's', index: 0 }, cards, index, 0);
  assert.equal(gen0.contributing[0].slot, '0x1008');
  assert.deepEqual([...gen0.reachable], ['target']);
  assert.deepEqual([...cardEvidence({ segment: 's', index: 0 }, cards, index, 1).reachable], ['target', 'child']);
  assert.equal(cardEvidence({ segment: 's', index: 1 }, cards, index, 0).reachable.size, 0);
  assert.equal(cardEvidence({ segment: 's', index: 0 }, cards, index, 2).reachable.size, 0);
  assert.throws(() => cardEvidence({ segment: 's', index: 5 }, cards, index, 0), /not decoded/);
});

test('finalization storage is address-backed, not duplicated as native, and ready sources are deduplicated', () => {
  const data = graph();
  data.roots.push({ id: 'ready', target: 'a', address: '0x8008', kind: 'FinalizerQueue', strong: true });
  assert.equal(finalizationRoots(data).length, 1);
  const atlas = layout(data), queue = atlas.finalizers.get('fq:registered'), ready = atlas.finalizers.get('fq:ready');
  assert.deepEqual(atlas.roots.get('finalizer1').position, arraySlotPosition('0x8000', queue));
  assert.deepEqual(atlas.roots.get('ready').position, arraySlotPosition('0x8008', ready));
  assert.equal(atlas.native[0].start, '0x8010');
  assert.equal(queue.bytes, 8); assert.equal(ready.bytes, 8);
});

test('the renderer uses striped instanced materials, real queue areas, and pickable card sheets', () => {
  const data = graph(), index = indexGraph(data), analysis = analyzeReachability(data, index);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const result = view.show(data, index, { budget: 100, heap: 'all', color: 'reachability', gcGeneration: 0,
    reachability: analysis, cards: true, roots: true, edges: true, native: true }, null);
  assert.equal(result.cardStats.shown, 2); assert.equal(result.cardStats.dirty, 1);
  assert.ok(view.content.children.some(object => object.userData.item?.kind === 'finalizerQueue'));
  assert.ok(view.pickables.some(object => object.userData.cardMap?.info.segment === 's'));
  assert.ok(view.content.children.filter(object => object.userData.layer === 'foreground').every(object => object.material.userData.rootStripes));
  const material = new THREE.MeshBasicMaterial(), geometry = new THREE.BoxGeometry();
  applyRootStripes(material, geometry, [3]);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
  material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /rootCount/); assert.equal(geometry.attributes.rootTypeMask.getX(0), 3);
  material.dispose(); geometry.dispose(); view.disposeContent();
});

test('truncated card grids include an explicit unknown remainder rather than stretching known states over missing cards', () => {
  const data = graph(), index = indexGraph(data);
  data.cardRegions[0] = { ...data.cardRegions[0], status: 'truncated', count: 1, totalCount: 10 };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const result = view.show(data, index, { budget: 100, heap: 'all', cards: true, edges: false, roots: false }, null);
  const plane = view.pickables.find(item => item.userData.cardMap);
  assert.equal(plane.userData.cardMap.displayCount, 2);
  assert.equal(result.cardStats.shown, 1);
  assert.equal(result.cardStats.unavailable, 1);
  assert.equal(cardState(data.cardRegions[0], 1), null);
  view.disposeContent();
});

test('provenance stripe shader composes with array opacity and retains every known root category', () => {
  const data = graph(), index = indexGraph(data), analysis = analyzeReachability(data, index);
  const target = analysis.objects.get('target');
  const mask = target.rootMasks[0];
  assert.ok(rootTypeNames(mask).length >= 4);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  data.objects[0].type = 'System.Object[]';
  view.show(data, index, { budget: 100, heap: 'all', color: 'reachability', reachability: analysis, gcGeneration: 0 }, null);
  const array = view.arrayBatches[0];
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>' };
  array.mesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /vArrayAlpha/);
  assert.match(shader.fragmentShader, /rootCount/);
  view.disposeContent();
});
