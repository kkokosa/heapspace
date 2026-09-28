import test from 'node:test';
import assert from 'node:assert/strict';
import { indexGraph, retainingPath, selectObjects, selectReferences, heapKind, neighborhood, percentage, displayCoverage } from '../Client/graph.js';
import { layout } from '../Client/spatial.js';

const segment = { id: 'segment', kind: 'Generation2', start: '0xffffffffffffff00', end: '0xfffffffffffffff0' };
function fixture() {
  return {
    segments: [segment],
    objects: ['0xffffffffffffffd0', '0xffffffffffffff90', '0xffffffffffffff50'].map((id, ordinal) => ({ id, address: id, size: 32, segment: 'segment', ordinal })),
    edges: [
      { source: '0xffffffffffffffd0', target: '0xffffffffffffff90', kind: 'reference' },
      { source: '0xffffffffffffff90', target: '0xffffffffffffff50', kind: 'dependent' },
      { source: '0xffffffffffffff50', target: '0xffffffffffffffd0', kind: 'reference' },
    ],
    roots: [{ id: 'weak', address: '0x5000', target: '0xffffffffffffff50', strong: false },
      { id: 'strong', address: '0x5008', target: '0xffffffffffffffd0', strong: true }],
  };
}
test('64-bit addresses stay exact and weak handles do not start retaining paths', () => {
  const data = fixture(), index = indexGraph(data);
  assert.equal(index.objects.size, 3);
  const path = retainingPath(data.objects[2].id, index);
  assert.equal(path.root.id, 'strong');
  assert.equal(path.edges.length, 2);
  assert.equal(path.edges[1].kind, 'dependent');
  data.roots = data.roots.filter(r => !r.strong);
  assert.equal(retainingPath(data.objects[2].id, indexGraph(data)).root, null);
});
test('transitive neighborhoods are breadth-first, bidirectional, cycle-safe, and preserve directed edges', () => {
  const data = {
    segments: [segment], roots: [],
    objects: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, segment: segment.id })),
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' },
      { source: 'd', target: 'a' }, { source: 'c', target: 'e' }, { source: 'e', target: 'c' }],
  };
  const index = indexGraph(data);
  assert.deepEqual([...neighborhood('a', index, 0).ids], ['a']);
  assert.deepEqual([...neighborhood('a', index, 1).ids], ['a', 'b', 'd']);
  const result = neighborhood('a', index, 2);
  assert.deepEqual([...result.ids], ['a', 'b', 'd', 'c']);
  assert.equal(result.distances.get('c'), 2);
  assert.ok(result.edges.includes(data.edges[2]));
  assert.equal(neighborhood('a', index, 5).ids.size, 5);
  assert.equal(neighborhood('a', index, 5).edges.length, 5);
  const limited = neighborhood('a', index, 5, 2);
  assert.equal(limited.ids.size, 2);
  assert.equal(limited.limited, true);
  assert.equal(neighborhood('a', index, 5, 2000, 1).limited, true);
  data.edges.push({ source: 'b', target: 'uncaptured' });
  assert.equal(neighborhood('a', indexGraph(data), 2).missing, 1);
  assert.ok(selectObjects(data, index, 2, 'all', 'a', result.ids).length <= 2);
});
test('path search reports explicit traversal limits', () => {
  const data = fixture();
  assert.equal(retainingPath(data.objects[2].id, indexGraph(data), 1).limited, true);
});
test('a full edge budget is explicitly reported even at an adjacency-list boundary', () => {
  const data = { objects: [{ id: 'a' }, { id: 'b' }], segments: [], roots: [],
    edges: [...Array.from({ length: 5999 }, () => ({ source: 'a', target: 'a' })),
      { source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
  const result = neighborhood('a', indexGraph(data), 1);
  assert.equal(result.edges.length, 6000);
  assert.equal(result.limited, true);
});
test('display budget, filtering, and selection are bounded', () => {
  const data = fixture(), index = indexGraph(data);
  assert.ok(selectObjects(data, index, 2, 'all', data.objects[2].id).length <= 2);
  assert.equal(selectObjects(data, index, 2, 'LOH', null).length, 0);
  assert.equal(selectObjects(data, index, 2, 'SOH', data.objects[2].id)[0].id, data.objects[2].id);
  assert.equal(heapKind({ kind: 'Pinned' }), 'POH');
});
test('layout is stable independent of display selection and has distinct object slots', () => {
  const data = fixture(), atlas = layout(data);
  const positions = data.objects.map(o => atlas.objectPosition(o));
  assert.equal(new Set(positions.map(p => p.join(','))).size, 3);
  assert.deepEqual(layout(data).objectPosition(data.objects[1]), positions[1]);
});
test('overview sampling includes complete object-reference pairs instead of only isolated nodes', () => {
  const data = {
    segments: [segment], roots: [],
    objects: Array.from({ length: 80 }, (_, i) => ({ id: String(i), segment: segment.id })),
    edges: Array.from({ length: 40 }, (_, i) => ({ source: String(i * 2), target: String(i * 2 + 1) })),
  };
  const selected = selectObjects(data, indexGraph(data), 10, 'all', null);
  const ids = new Set(selected.map(object => object.id));
  assert.ok(selected.length <= 10);
  assert.ok(data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).length >= 2);
});
test('class-based focus samples across matching regions and fills the remaining budget without duplicates', () => {
  const data = {
    segments: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, kind: i % 2 ? 'Large' : 'Generation2' })),
    objects: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), segment: `s${Math.floor(i / 100)}` })),
    edges: [], roots: [],
  };
  const index = indexGraph(data), matches = new Set(data.objects.filter((_, i) => i % 2 === 0).map(object => object.id).reverse());
  const selected = selectObjects(data, index, 10, 'all', null, matches);
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map(object => object.segment)).size, 10);
  assert.ok(selected.every(object => matches.has(object.id)));
  const filtered = selectObjects(data, index, 5, 'LOH', null, matches);
  assert.equal(new Set(filtered.map(object => object.segment)).size, 5);
  assert.ok(filtered.every(object => index.segments.get(object.segment).kind === 'Large'));
  const context = selectObjects(data, index, 600, 'all', null, matches);
  assert.equal(new Set(context.map(object => object.id)).size, 600);
  assert.equal(context.filter(object => matches.has(object.id)).length, 500);
  assert.equal(selectObjects(data, index, 'all', 'all', null, matches).length, 1000);
});
test('visible reference caps sample the whole eligible edge list and report omitted endpoints', () => {
  const edges = Array.from({ length: 90 }, (_, i) => ({ source: String(i), target: String(i + 1) }));
  const ids = new Set(Array.from({ length: 91 }, (_, i) => String(i)));
  const selection = selectReferences(edges, ids, 3);
  assert.deepEqual(selection.edges.map(edge => edge.source), ['0', '30', '60']);
  assert.equal(selection.eligible, 90);
  assert.equal(selection.limited, true);
  const partial = selectReferences(edges, new Set(['0', '1', '2']), 3);
  assert.equal(partial.edges.length, 2);
  assert.equal(partial.hiddenEndpoints, 88);
  assert.equal(partial.limited, false);
});

test('coverage distinguishes walked objects, captured graph, current view, and hidden context', () => {
  const data = { objects: Array(100), objectsWalked: 400, edges: Array(200), roots: Array(20),
    objectsTruncated: true, edgesTruncated: false, invalidObjects: 0 };
  const shown = { visible: 10, context: 30, edges: 5, roots: 2, references: { eligible: 10 } };
  const coverage = displayCoverage(data, shown, 0.05);
  assert.equal(coverage.objects.rendered, 40);
  assert.equal(coverage.objects.walkedPercent, '10.0%');
  assert.equal(coverage.objects.capturedPercent, '40.0%');
  assert.equal(coverage.references.percent, '2.5%');
  assert.equal(coverage.references.eligiblePercent, '50.0%');
  assert.equal(coverage.references.totalUnknown, true);
  assert.equal(coverage.roots.percent, '10.0%');
  assert.equal(displayCoverage(data, shown, 0).objects.rendered, 10);
  assert.equal(displayCoverage(data, { ...shown, edges: 0, roots: 0 }, 0).references.percent, '0.0%');
  assert.equal(displayCoverage({ ...data, objectsTruncated: false }, shown, 0).references.totalUnknown, false);
  assert.equal(displayCoverage({ ...data, objectsTruncated: false, edgesTruncated: true }, shown, 0).references.totalUnknown, true);
  assert.equal(displayCoverage({ ...data, objectsTruncated: false, invalidObjects: 1 }, shown, 0).references.totalUnknown, true);
});

test('percentage labels avoid division by zero and false zero/full-coverage rounding', () => {
  assert.equal(percentage(0, 0), 'n/a');
  assert.equal(percentage(0, 20), '0.0%');
  assert.equal(percentage(1, 1000000), '<0.1%');
  assert.equal(percentage(999999, 1000000), '>99.9%');
  assert.equal(percentage(20, 20), '100.0%');
  const coverage = displayCoverage({ objects: [], objectsWalked: 0, edges: [], roots: [] },
    { visible: 0, context: 0, edges: 0, roots: 0, references: { eligible: 0 } }, 0);
  assert.equal(coverage.references.percent, 'n/a');
  assert.equal(coverage.objects.walkedPercent, 'n/a');
});
