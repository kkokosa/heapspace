import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { layout, arraySlotPosition, gcHeapId, regionLabel, BYTES_PER_CUBIC_UNIT } from '../Client/spatial.js';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';

function fixture() {
  return {
    architecture: 'X64', freeRangesIncluded: true,
    segments: [
      { id: 'a', runtime: 0, heap: 0, kind: 'Generation2', start: '0x1000', end: '0x10a0' },
      { id: 'b', runtime: 0, heap: 0, kind: 'Generation2', start: '0x3000', end: '0x3080' },
      { id: 'mixed', runtime: 0, heap: 1, kind: 'Ephemeral', start: '0x5000', end: '0x5080' },
      { id: 'other-runtime', runtime: 1, heap: 0, kind: 'Generation0', start: '0x7000', end: '0x7080' },
    ],
    objects: [
      { id: 'array', address: '0x1000', segment: 'a', type: 'System.Object[]', size: 64, generation: 'Generation2' },
      { id: 'a1', address: '0x1080', segment: 'a', type: 'Node', size: 32, generation: 'Generation2' },
      { id: 'b1', address: '0x3000', segment: 'b', type: 'Node', size: 32, generation: 'Generation2' },
      { id: 'young', address: '0x5000', segment: 'mixed', type: 'Node', size: 32, generation: 'Generation0' },
      { id: 'older', address: '0x5040', segment: 'mixed', type: 'Node', size: 32, generation: 'Generation1' },
      { id: 'other', address: '0x7000', segment: 'other-runtime', type: 'Node', size: 64, generation: 'Generation0' },
    ],
    freeRanges: [{ segment: 'a', start: '0x1040', end: '0x1060', size: 32, generation: 'Generation2' }],
    edges: [{ source: 'array', target: 'b1', kind: 'reference', offset: 8 },
      { source: 'young', target: 'older', kind: 'reference', offset: 0 }],
    roots: [
      { id: 'array-slot', address: '0x1010', target: 'b1', kind: 'Static', strong: false, annotation: true },
      { id: 'stack', address: '0x9080', target: 'a1', kind: 'Stack', thread: 'thread', strong: true },
      { id: 'handle', address: '0xc008', target: 'other', kind: 'Strong', strong: true },
    ],
    threads: [{ id: 'thread', stackStart: '0x9000', stackEnd: '0xa000' }],
    nativeAreas: [{ start: '0x1000', end: '0xa000', size: 36864, kind: 'private', state: 'committed', owners: [] }],
  };
}
const box = region => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...region.position), new THREE.Vector3(...region.size));
const relative = span => span.position.map((value, axis) => value - span.region.position[axis]);
const close = (a, b) => assert.ok(a.every((value, axis) => Math.abs(value - b[axis]) < 1e-9));

test('physical labels use the requested Region/Gen and Heap/address format without runtime abbreviations', () => {
  const region = { physicalLabel: 'Region 29', start: '0x1234567890', value: { runtime: 0, heap: 2, kind: 'Generation0' } };
  assert.equal(regionLabel(region, true), 'Region 29/Gen 0\nHeap 2/0x1234567890');
  assert.equal(regionLabel(region), 'Heap 2/Gen 0');
  assert.equal(regionLabel({ ...region, value: { ...region.value, kind: 'Pinned' } }, true),
    'Region 29/Pinned\nHeap 2/0x1234567890');
  assert.notEqual(gcHeapId(region.value), gcHeapId({ ...region.value, runtime: 1 }));
});

test('opt-in physical grouping keeps same-generation allocations separate and namespaces GC heaps by runtime', () => {
  const data = fixture(), physical = layout(data, { physical: true });
  assert.equal(physical.gcHeaps.size, 3);
  const heap = physical.gcHeaps.get(gcHeapId(data.segments[0]));
  assert.deepEqual(heap.children.map(region => region.id), ['a', 'b']);
  assert.equal(heap.capturedObjects, 3);
  assert.equal(heap.generationCounts.get('Generation2'), 3);
  assert.equal(new Set([...physical.segments.values()].map(region => region.physicalLabel)).size, 4);
  assert.notEqual(physical.segments.get('a').heapContainer, physical.segments.get('other-runtime').heapContainer);
  for (const container of physical.gcHeaps.values()) for (const region of container.children)
    assert.ok(box(container).containsBox(box(region)));
  const topLevel = [...physical.regions.filter(region => region.kind !== 'segment'), ...physical.gcHeaps.values()];
  for (let i = 0; i < topLevel.length; i++) for (let j = i + 1; j < topLevel.length; j++)
    assert.equal(box(topLevel[i]).intersectsBox(box(topLevel[j])), false);
  for (let i = 0; i < heap.children.length; i++) for (let j = i + 1; j < heap.children.length; j++)
    assert.equal(box(heap.children[i]).intersectsBox(box(heap.children[j])), false);
});

test('a classic ephemeral segment remains one physical unit even with several logical generations', () => {
  const atlas = layout(fixture(), { physical: true });
  const segment = atlas.segments.get('mixed');
  assert.equal(atlas.objects.get('young').region, segment);
  assert.equal(atlas.objects.get('older').region, segment);
  assert.deepEqual([...segment.generationCounts], [['Generation0', 1], ['Generation1', 1]]);
  assert.equal(segment.heapContainer.children.length, 1);
});

test('physical reorganization preserves internal object/array/gap coordinates and never mutates the captured graph', () => {
  const data = fixture(), original = structuredClone(data);
  const normal = layout(data), physical = layout(data, { physical: true });
  assert.equal(normal.gcHeaps.size, 0);
  assert.equal(physical.objects.size, normal.objects.size);
  for (const [id, object] of normal.objects) {
    const changed = physical.objects.get(id);
    close(relative(changed), relative(object));
    assert.equal(changed.side, object.side);
    assert.equal(changed.region.id, object.region.id);
    assert.equal(changed.address, object.address);
  }
  for (const gap of normal.gaps) {
    const changed = physical.gaps.find(item => item.id === gap.id);
    assert.equal(changed.kind, gap.kind); assert.equal(changed.bytes, gap.bytes);
    close(relative(changed), relative(gap));
    assert.ok(Math.abs(changed.side ** 3 * BYTES_PER_CUBIC_UNIT - changed.bytes) < 1e-8);
  }
  assert.deepEqual(physical.roots.get('array-slot').position, arraySlotPosition('0x1010', physical.objects.get('array')));
  assert.equal(physical.roots.get('stack').region.id, 'thread');
  assert.equal(physical.roots.get('handle').region.kind, 'rootRegion');
  assert.deepEqual(data, original);
  const reordered = structuredClone(data);
  reordered.objects.reverse(); reordered.segments.reverse();
  close(layout(reordered, { physical: true }).objects.get('array').position, physical.objects.get('array').position);
  assert.deepEqual(layout(data, { physical: false }).objects.get('array').position, normal.objects.get('array').position);
});

test('the scene cache, selection, references and gap counts remain consistent across physical-mode toggles', () => {
  const data = fixture(), index = indexGraph(data);
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const settings = { budget: 100, referenceBudget: 'all', heap: 'all', edges: true, roots: true, native: true, gaps: true };
  const before = view.show(data, index, settings, 'array');
  const normal = view.layout;
  const shown = view.show(data, index, { ...settings, physical: true }, 'array');
  assert.notEqual(view.layout, normal);
  assert.equal(shown.physicalRanges, 4); assert.equal(shown.gcHeapContainers, 3);
  assert.equal(shown.edges, before.edges); assert.equal(shown.roots, before.roots);
  assert.deepEqual(shown.gaps, before.gaps);
  assert.deepEqual(view.selectedPosition, view.layout.objects.get('array').position);
  assert.equal(view.content.children.filter(child => child.userData.guide === 'gcHeap').length, 3);
  assert.ok(view.pickables.every(child => !child.userData.guide));
  const current = view.layout;
  view.show(data, index, { ...settings, physical: true, budget: 4 }, 'array');
  assert.equal(view.layout, current);
  view.show(data, index, settings, 'array');
  assert.deepEqual(view.layout.objects.get('array').position, normal.objects.get('array').position);
  const site = { kind: 'root', id: 'array-slot' };
  const rootView = view.show(data, index, { ...settings, physical: true, site }, null);
  assert.equal(rootView.roots, 1); assert.equal(rootView.edges, 0);
  assert.deepEqual(view.selectedPosition, view.layout.roots.get('array-slot').position);
  assert.deepEqual(view.selectedPosition, arraySlotPosition('0x1010', view.layout.objects.get('array')));
  view.disposeContent();
});
