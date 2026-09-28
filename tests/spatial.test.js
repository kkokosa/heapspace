import test from 'node:test';
import assert from 'node:assert/strict';
import { boxSide, packBoxes, layout, referenceRoute, directReferenceRoute, bundleReferences, pipeRadius,
  MIN_BOX_SIDE, BYTES_PER_CUBIC_UNIT, arraySlotAddress, arraySlotPosition, referenceSource, unbundledReference } from '../Client/spatial.js';

function fixture() {
  return {
    segments: [
      { id: 'low', start: '0x1000', end: '0x3000', kind: 'Generation2' },
      { id: 'high', start: '0xf000000000001000', end: '0xf000000000003000', kind: 'Large' },
    ],
    objects: [
      { id: 'a', address: '0x1000', size: 32, segment: 'low' },
      { id: 'b', address: '0x1040', size: 256, segment: 'low' },
      { id: 'c', address: '0xf000000000001000', size: 4096, segment: 'high' },
    ],
    threads: [{ id: 'thread', stackStart: '0x5000', stackEnd: '0x6000' }],
    nativeAreas: [
      { start: '0x800', end: '0x3800', size: 12288, state: 'committed', owners: [] },
      { start: '0x4000', end: '0x7000', size: 12288, state: 'committed', owners: [] },
      { start: '0x10000', end: '0x80000', size: 458752, state: 'reserved', owners: [] },
    ],
  };
}
function overlaps(a, b) {
  return a.position.every((v, axis) => Math.abs(v - b.position[axis]) < (a.size[axis] + b.size[axis]) / 2 - 1e-9);
}
test('box volume is proportional to bytes without a maximum cap, except the explicit minimum', () => {
  for (const bytes of [32, 256, 180024, 1024 ** 2, 2 * 1024 ** 4]) {
    assert.ok(Math.abs(boxSide(bytes) ** 3 * BYTES_PER_CUBIC_UNIT / bytes - 1) < 1e-12);
  }
  assert.equal(boxSide(1), MIN_BOX_SIDE);
  assert.equal(boxSide(256) / boxSide(32), 2);
  assert.ok(boxSide(2 * 1024 ** 4) > boxSide(1024 ** 3));
});
test('size-aware shelves never overlap and enclose all boxes', () => {
  const input = Array.from({ length: 120 }, (_, i) => ({ id: i, size: [1 + i % 9, 1 + i % 7, 1 + i % 11] }));
  const packed = packBoxes(input, 0.25);
  const slots = [...packed.slots.values()];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) assert.equal(overlaps(slots[i], slots[j]), false);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(slots[i].position[axis] - slots[i].size[axis] / 2 >= 0);
      assert.ok(slots[i].position[axis] + slots[i].size[axis] / 2 <= packed.size[axis] + 1e-9);
    }
  }
});
test('exact 64-bit address ordering, collapsed gaps, and input-order independence', () => {
  const data = fixture(), atlas = layout(data);
  assert.deepEqual(atlas.regions.map(r => r.start), [...atlas.regions].sort((a, b) => BigInt(a.start) < BigInt(b.start) ? -1 : 1).map(r => r.start));
  const reordered = structuredClone(data);
  reordered.segments.reverse(); reordered.objects.reverse(); reordered.nativeAreas.reverse();
  assert.deepEqual(layout(reordered).objectPosition(data.objects[0]), atlas.objectPosition(data.objects[0]));
  const high = reordered.segments.find(s => s.id === 'high');
  high.start = '0x90000'; high.end = '0x92000';
  reordered.objects.find(o => o.id === 'c').address = high.start;
  assert.deepEqual(layout(reordered).objectPosition(data.objects[2]), atlas.objectPosition(data.objects[2]));
  for (let i = 0; i < atlas.regions.length; i++)
    for (let j = i + 1; j < atlas.regions.length; j++) assert.equal(overlaps(atlas.regions[i], atlas.regions[j]), false);
});
test('native ranges split around managed/stack extents and share their byte-volume scale', () => {
  const data = fixture(), atlas = layout(data);
  assert.deepEqual(atlas.native.map(r => [r.start, r.end]), [['0x800', '0x1000'], ['0x3000', '0x3800'], ['0x4000', '0x5000'], ['0x6000', '0x7000']]);
  assert.equal(atlas.native[0].value.mappingStart, '0x800');
  assert.equal(atlas.native[0].value.mappingEnd, '0x3800');
  assert.equal(atlas.native.find(r => r.start === '0x4000').size[0], atlas.objectSide(data.objects[2]));
  assert.equal(atlas.threads.get('thread').size[0], atlas.objectSide(data.objects[2]));
  assert.equal(layout(data, { reserved: true }).native.length, 5);
  const object = atlas.objects.get('a'), region = object.region;
  assert.ok(object.position.every((v, axis) => Math.abs(v - region.position[axis]) + object.side / 2 <= region.size[axis] / 2));
});
test('reference routes join real box surfaces, share trunks, and preserve direction/self-loops', () => {
  const atlas = layout(fixture());
  const a = atlas.objects.get('a'), b = atlas.objects.get('b'), c = atlas.objects.get('c');
  const route = referenceRoute(a, c, 'low>high');
  const shared = referenceRoute(b, c, 'low>high');
  assert.deepEqual(route.trunk, shared.trunk);
  assert.ok(Math.abs(Math.max(...route.inlet[0].map((v, axis) => Math.abs(v - a.position[axis]))) - a.side / 2) < 1e-9);
  assert.ok(Math.abs(Math.max(...route.outlet.at(-1).map((v, axis) => Math.abs(v - c.position[axis]))) - c.side / 2) < 1e-9);
  assert.deepEqual(route.inlet.at(-1), route.trunk[0]);
  assert.deepEqual(route.outlet[0], route.trunk.at(-1));
  assert.deepEqual(route.trunk[0], route.ports.source.junction);
  assert.deepEqual(route.trunk.at(-1), route.ports.target.junction);
  assert.throws(() => referenceRoute(a, a, 'low>low'), /Same-region/);
});
test('bundling emits one trunk with correctly counted inlet/outlet branches, not duplicate full paths', () => {
  const atlas = layout(fixture()), a = atlas.objects.get('a'), b = atlas.objects.get('b'), c = atlas.objects.get('c');
  const records = [
    { source: a, target: c, kind: 'reference' }, { source: a, target: c, kind: 'reference' },
    { source: b, target: c, kind: 'reference' },
  ];
  const groups = bundleReferences(records);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.count, 3);
  assert.equal(group.inlets.size, 2); assert.equal(group.outlets.size, 1);
  assert.equal(group.inlets.get('a').count, 2);
  assert.equal(group.outlets.get('c').count, 3);
  for (const branch of group.inlets.values()) assert.deepEqual(branch.points.at(-1), group.trunk[0]);
  for (const branch of group.outlets.values()) assert.deepEqual(branch.points[0], group.trunk.at(-1));
  assert.equal([...group.inlets.values()].reduce((n, b) => n + b.count, 0), group.count);
  assert.equal([...group.outlets.values()].reduce((n, b) => n + b.count, 0), group.count);
  assert.ok(Math.abs((pipeRadius(4) / pipeRadius(1)) ** 2 - 4) < 1e-9);
  assert.equal(pipeRadius(10000), 0.7);
  assert.equal(bundleReferences([...records, { source: c, target: a, kind: 'reference' },
    { source: a, target: c, kind: 'dependent' }]).length, 3);
});
test('root markers use source-slot addresses, preserve mapped-byte coverage, and label unavailable locations', () => {
  const data = fixture();
  data.roots = [
    { id: 'handle1', address: '0x4008', target: 'c', kind: 'Strong' },
    { id: 'handle2', address: '0x4010', target: 'a', kind: 'Pinned' },
    { id: 'stack', address: '0x5800', target: 'c', kind: 'Stack', thread: 'thread' },
    { id: 'static', address: '0x1010', target: 'c', kind: 'Static' },
    { id: 'register', address: '0x0', target: 'a', kind: 'Stack', thread: 'thread' },
    { id: 'unknown', address: '0x0', target: 'c', kind: 'Strong' },
  ];
  const atlas = layout(data), handle = atlas.roots.get('handle1');
  assert.equal(handle.region.start, '0x4000');
  assert.equal(handle.region.end, '0x5000');
  assert.equal(handle.region, atlas.roots.get('handle2').region);
  assert.notDeepEqual(handle.position, atlas.objects.get('c').position);
  assert.notDeepEqual(handle.position, atlas.roots.get('handle2').position);
  assert.equal(atlas.roots.get('stack').region.id, 'thread');
  assert.equal(atlas.roots.get('static').region.id, 'low');
  assert.match(atlas.roots.get('static').placement, /managed object/);
  assert.match(atlas.roots.get('register').placement, /no usable slot/);
  assert.match(atlas.roots.get('unknown').placement, /unknown address/);
  const original = layout(fixture()).native.reduce((n, r) => n + r.value.size, 0);
  const remaining = atlas.native.reduce((n, r) => n + r.value.size, 0);
  const pages = [...atlas.rootRegions.values()].filter(r => r.start).reduce((n, r) => n + Number(BigInt(r.end) - BigInt(r.start)), 0);
  assert.equal(remaining + pages, original);
  assert.ok(handle.position.every((v, axis) => Math.abs(v - handle.region.position[axis]) <= handle.region.size[axis] / 2));
});
test('an unmapped root address bucket does not swallow an adjacent captured mapping', () => {
  const data = fixture();
  data.nativeAreas.push({ start: '0x7000', end: '0x7400', size: 1024, state: 'committed', owners: [] });
  data.roots = [{ id: 'outside', address: '0x7800', kind: 'Strong', target: 'a' }];
  const atlas = layout(data), region = atlas.roots.get('outside').region;
  assert.equal(region.value.mapped, false);
  assert.equal(region.start, '0x7400');
  assert.ok(atlas.native.some(fragment => fragment.start === '0x7000' && fragment.end === '0x7400'));
});
test('direct object links connect box surfaces without a region trunk and show self-references', () => {
  const atlas = layout(fixture()), a = atlas.objects.get('a'), b = atlas.objects.get('b');
  const route = directReferenceRoute(a, b);
  assert.equal(route.length, 4);
  assert.ok(Math.abs(Math.max(...route[0].map((v, axis) => Math.abs(v - a.position[axis]))) - a.side / 2) < 1e-9);
  assert.ok(Math.abs(Math.max(...route.at(-1).map((v, axis) => Math.abs(v - b.position[axis]))) - b.side / 2) < 1e-9);
  assert.ok(route.every(point => point.every(Number.isFinite)));
  assert.ok(route.every(point => point.every((v, axis) => Math.abs(v - a.region.position[axis]) <= a.region.size[axis] / 2)));
  assert.equal(unbundledReference({ source: a, target: b, kind: 'reference' }, 'bundled'), true);
  assert.equal(unbundledReference({ source: a, target: atlas.objects.get('c'), kind: 'reference' }, 'bundled'), false);
  const loop = directReferenceRoute(a, a);
  assert.deepEqual(loop[0], loop[3]); assert.notDeepEqual(loop[1], loop[2]);
});

test('array references retain exact slot addresses and distinct internal inlets, including more than 4096 slots', () => {
  const data = fixture();
  data.architecture = 'X64';
  data.objects[0] = { ...data.objects[0], type: 'System.Object[]', size: 65560 };
  data.objects.splice(1, 1); data.threads = []; data.nativeAreas = [];
  data.segments[0].end = '0x11018';
  const atlas = layout(data), array = atlas.objects.get('a'), target = atlas.objects.get('c');
  const first = { kind: 'reference', offset: 8 }, second = { kind: 'reference', offset: 16 };
  assert.equal(arraySlotAddress(array, first), '0x1010');
  assert.equal(arraySlotAddress({ address: '0xf000000000001000', size: 64, type: 'System.Object[]' }, first, 'X64'), '0xf000000000001010');
  assert.equal(arraySlotAddress({ address: '0x1000', size: 64, type: 'System.Object[]' }, { kind: 'reference', offset: 4 }, 'X86'), '0x1008');
  assert.equal(arraySlotAddress(array, { kind: 'dependent', offset: -1 }), null);
  assert.equal(arraySlotAddress(array, { kind: 'reference', offset: array.bytes }), null);
  assert.equal(arraySlotAddress({ ...array, pointerSize: null }, first), null);
  const source1 = referenceSource(array, first), source2 = referenceSource(array, second);
  assert.notDeepEqual(source1.anchor, source2.anchor);
  assert.deepEqual(referenceRoute(source1, target, 'array>target').inlet[0], source1.anchor);
  assert.ok(source1.anchor.every((v, axis) => Math.abs(v - array.position[axis]) < array.side / 2));
  const group = bundleReferences([{ source: source1, target, kind: 'reference' }, { source: source2, target, kind: 'reference' }])[0];
  assert.equal(group.inlets.size, 2);
  const points = new Set();
  for (let i = 0; i < 8192; i++) points.add(arraySlotPosition(`0x${(0x1010n + BigInt(i) * 8n).toString(16)}`, array).join(','));
  assert.equal(points.size, 8192, 'Addressed slots must not collapse onto a fixed 4096-cell lattice.');
  data.roots = [{ id: 'static-slot', address: '0x1010', target: 'c', kind: 'Static' }];
  const withRoot = layout(data), root = withRoot.roots.get('static-slot');
  assert.match(root.placement, /inside the array/);
  assert.deepEqual(root.anchor, arraySlotPosition('0x1010', withRoot.objects.get('a')));
});
