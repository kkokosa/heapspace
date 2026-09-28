import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { layout, regionSpans, BYTES_PER_CUBIC_UNIT } from '../Client/spatial.js';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';

function fixture() {
  return {
    architecture: 'X64', freeRangesIncluded: true, objectsTruncated: true,
    segments: [{ id: 's', start: '0xf000000000001000', end: '0xf000000000001080', kind: 'Generation2' }],
    objects: [
      { id: 'a', address: '0xf000000000001000', segment: 's', size: 32, type: 'Node' },
      { id: 'b', address: '0xf000000000001060', segment: 's', size: 32, type: 'Node' },
    ],
    freeRanges: [{ segment: 's', start: '0xf000000000001020', end: '0xf000000000001040', size: 32, generation: 'Generation2' }],
    roots: [], threads: [], nativeAreas: [], edges: [{ source: 'a', target: 'b', kind: 'reference', offset: 0 }],
  };
}

test('region partition preserves exact high addresses and separates real free space from omitted memory', () => {
  const data = fixture(), spans = regionSpans(data.segments[0], data.objects, data.freeRanges);
  assert.deepEqual(spans.map(span => span.kind), ['object', 'free', 'unrepresented', 'object']);
  assert.deepEqual(spans.map(span => span.bytes), [32, 32, 32, 32]);
  let cursor = BigInt(data.segments[0].start);
  for (const span of spans) { assert.equal(BigInt(span.start), cursor); cursor = BigInt(span.end); }
  assert.equal(cursor, BigInt(data.segments[0].end));
  const atlas = layout(data), region = atlas.segments.get('s');
  assert.equal(region.freeBytes, 32); assert.equal(region.unrepresentedBytes, 32);
  for (const gap of atlas.gaps) assert.ok(Math.abs(gap.side ** 3 * BYTES_PER_CUBIC_UNIT - gap.bytes) < 1e-9);
  const boxes = region.spans.map(span => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...span.position), new THREE.Vector3(...span.size)));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
    assert.equal(boxes[i].intersectsBox(boxes[j]), false);
});

test('larger real gaps reserve larger volumes and separate formerly adjacent objects', () => {
  const data = fixture();
  data.segments[0] = { id: 's', start: '0x1000', end: '0x1040', kind: 'Generation2' };
  data.objects[0].address = '0x1000'; data.objects[1].address = '0x1020'; data.freeRanges = [];
  const contiguous = layout(data);
  const separation = view => new THREE.Vector3(...view.objects.get('a').position).distanceTo(new THREE.Vector3(...view.objects.get('b').position));
  data.objects[1].address = '0x2020'; data.segments[0].end = '0x2040';
  data.freeRanges = [{ segment: 's', start: '0x1020', end: '0x2020', size: 4096, generation: 'Generation2' }];
  const fragmented = layout(data);
  assert.ok(separation(fragmented) > separation(contiguous));
  assert.equal(fragmented.gaps.length, 1);
  assert.ok(Math.abs(fragmented.gaps[0].side ** 3 * BYTES_PER_CUBIC_UNIT - 4096) < 1e-8);
});

test('leading and trailing spans are retained, and old snapshots never guess GC-free classification', () => {
  const data = fixture();
  data.objects = [data.objects[1]];
  const spans = regionSpans(data.segments[0], data.objects);
  assert.equal(spans[0].kind, 'unrepresented');
  assert.equal(spans[0].bytes, 96);
  data.objects = [];
  assert.equal(regionSpans(data.segments[0], []).length, 1);
  const legacy = fixture(); delete legacy.freeRangesIncluded; delete legacy.freeRanges;
  const atlas = layout(legacy);
  assert.equal(atlas.gaps.length, 1);
  assert.equal(atlas.gaps[0].kind, 'unrepresented');
  assert.equal(atlas.gaps[0].bytes, 64);
});

test('roots in uncaptured spans are placed inside the corresponding reserved volume', () => {
  const data = fixture();
  data.roots = [{ id: 'unknown-owner', address: '0xf000000000001048', target: 'a', kind: 'Static' }];
  const atlas = layout(data), root = atlas.roots.get('unknown-owner');
  const gap = atlas.gaps.find(gap => gap.kind === 'unrepresented');
  assert.match(root.placement, /uncaptured\/unclassified span/);
  assert.ok(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...gap.position), new THREE.Vector3(...gap.size))
    .containsPoint(new THREE.Vector3(...root.position)));
});

test('gap outlines do not consume object budgets or intercept object picking', () => {
  const data = fixture(), view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const settings = { budget: 'all', referenceBudget: 'all', heap: 'all', roots: true, edges: true, gaps: true };
  const result = view.show(data, indexGraph(data), settings, null);
  assert.equal(result.visible, 2); assert.equal(result.gaps.total, 2); assert.equal(result.gaps.outlined, 2);
  assert.ok(view.pickables.every(item => !item.userData.gapKind));
  const positions = data.objects.map(object => view.layout.objectPosition(object));
  const hidden = view.show(data, indexGraph(data), { ...settings, gaps: false }, null);
  assert.equal(hidden.gaps.outlined, 0);
  assert.deepEqual(data.objects.map(object => view.layout.objectPosition(object)), positions);
  view.disposeContent();
});

test('overlapping or out-of-region memory spans fail explicitly', () => {
  const data = fixture();
  const bad = { ...data.freeRanges[0], start: data.objects[0].address };
  assert.throws(() => regionSpans(data.segments[0], data.objects, [bad]), /Overlapping/);
  assert.throws(() => regionSpans(data.segments[0], [{ ...data.objects[0], size: 1024 }]), /out-of-bounds/);
});
