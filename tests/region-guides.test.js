import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';
import { layout, referenceSource, arrayCellSize, packBoxes } from '../Client/spatial.js';
import { referenceArrows } from '../Client/reference-arrows.js';
import { regionFloorText, regionRulers, orientPlanarLabel } from '../Client/region-guides.js';
import { labelsOverlap } from '../Client/rendering.js';

const region = { id: 's', kind: 'segment', physicalLabel: 'Region 29', position: [10, 25, 30], size: [20, 40, 60],
  start: '0x1000', end: '0x11000',
  value: { kind: 'Generation2', heap: 2 } };

test('projected ground plaques do not hide each other merely because their bounding rectangles overlap', () => {
  const a = { x: 0, y: 0, width: 100, height: 60, polygon: [[0, 0], [100, 50], [100, 60], [0, 10]] };
  const b = { x: 0, y: 30, width: 100, height: 60, polygon: [[0, 30], [100, 80], [100, 90], [0, 40]] };
  assert.equal(labelsOverlap(a, b), false);
  assert.equal(labelsOverlap(a, a), true);
  assert.equal(labelsOverlap({ x: 5, y: 5, width: 20, height: 20 }, { x: 10, y: 10, width: 20, height: 20 }), true);
  assert.equal(labelsOverlap({ x: 0, y: 0, width: 20, height: 20 }, { x: 100, y: 100, width: 20, height: 20 }), false);
});

test('bottom-anchored rulers measure exact X/Y/Z scene extents, not fabricated byte offsets', () => {
  assert.equal(regionFloorText(region), 'Region 29 / Gen 2 / Heap 2\n64.0 KiB address span');
  const rulers = regionRulers(region), bottom = 5;
  rulers.forEach((ruler, i) => {
    assert.equal(ruler.axis, 'XYZ'[i]);
    assert.equal(new THREE.Vector3(...ruler.start).distanceTo(new THREE.Vector3(...ruler.end)), region.size[i]);
    assert.equal(ruler.text, undefined);
    assert.equal(ruler.equivalentBytes, undefined);
    assert.ok(ruler.start[1] <= bottom);
    if (i !== 1) assert.equal(ruler.start[1], ruler.end[1]);
  });
  assert.equal(rulers[1].end[1], 45);
});

test('only the real region address span carries byte quantities, never a hypothetical axis cube', () => {
  assert.match(regionFloorText(region), /64\.0 KiB address span/);
  for (const ruler of regionRulers(region)) assert.equal(ruler.text, undefined);
});

test('planar text faces above/below viewers without reflection and chooses a readable baseline', () => {
  const label = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial());
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  for (const angle of [0, Math.PI / 2, Math.PI]) for (const y of [8, -8]) for (const sign of [-1, 1]) {
    label.userData.label = { angle };
    camera.position.set(5 * sign, y, 12 * sign); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    orientPlanarLabel(label, camera); label.updateMatrixWorld();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(label.quaternion);
    assert.ok(normal.y * y > 0);
    const a = new THREE.Vector3(-0.3, -0.3, 0).applyMatrix4(label.matrixWorld).project(camera);
    const b = new THREE.Vector3(0.3, -0.3, 0).applyMatrix4(label.matrixWorld).project(camera);
    const c = new THREE.Vector3(-0.3, 0.3, 0).applyMatrix4(label.matrixWorld).project(camera);
    assert.ok(b.x > a.x, 'letters run left to right');
    assert.ok((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0, 'glyphs are never mirrored');
  }
  label.geometry.dispose(); label.material.dispose();
});

test('address-ordered shelves advance X then Z then Y; object-center Y alone is not address order', () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, size: [1, 1, 1] }));
  const packed = packBoxes(items), positions = [...packed.slots.values()].map(slot => slot.position);
  let rows = 0, layers = 0;
  for (let i = 1; i < positions.length; i++) {
    const previous = positions[i - 1], current = positions[i];
    if (current[1] > previous[1]) {
      layers++; assert.equal(current[0], 0.5); assert.equal(current[2], 0.5);
    } else if (current[2] > previous[2]) {
      rows++; assert.equal(current[0], 0.5);
    } else assert.ok(current[0] > previous[0]);
  }
  assert.ok(rows > 0 && layers > 0);
  const unequal = packBoxes([{ id: 'first', size: [1, 8, 1] }, { id: 'second', size: [1, 1, 1] }]);
  assert.ok(unequal.slots.get('first').position[1] > unequal.slots.get('second').position[1]);
});

test('floor plaques are horizontal depth-tested meshes; rulers and labels never enter picking', () => {
  const previous = globalThis.document;
  let borders = 0;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    measureText: text => ({ width: text.length * 15 }), beginPath() {}, roundRect() {}, fill() {}, stroke() { borders++; },
    fillRect() {}, fillText() {},
  }) }) };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.labels = []; view.pickables = [];
  view.contextMaterials = []; view.regionGuideMaterials = []; view.contextOpacity = 0.05;
  view.theme = { background: '#071019' };
  try {
    view.regionBase(region, '#ffffff', {}, false);
    const plaques = view.labels.filter(label => label.userData.label.kind === 'floor');
    assert.equal(plaques.length, 2);
    for (const plaque of plaques) {
      assert.equal(plaque.geometry.type, 'PlaneGeometry');
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(plaque.quaternion);
      assert.ok(normal.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9);
      assert.ok(plaque.position.y < 5);
      assert.equal(plaque.material.depthTest, true);
      assert.equal(plaque.material.depthWrite, false);
      assert.ok(!view.pickables.includes(plaque));
      assert.equal(plaque.layers.mask, 1);
    }
    assert.equal(view.labels.filter(label => label.userData.label.kind === 'dimension').length, 0);
    const rulers = view.content.children.find(child => child.userData.regionRulers);
    assert.equal(rulers.userData.regionRulers.rulers.length, 3);
    assert.equal(rulers.userData.regionRulers.units, 'visual axes, not byte distances');
    assert.equal(borders, 0);
    assert.ok(view.labels.every(label => label.userData.label.borderless));
    assert.equal(rulers.children.find(child => child.isInstancedMesh).count, 6);
    const front = plaques[0], xRuler = rulers.userData.regionRulers.rulers[0];
    assert.ok(xRuler.start[2] > front.position.z + front.scale.y / 2, 'the X ruler must sit beyond the floor plaque, not underneath it');
    assert.equal(view.pickables.length, 0);
    globalThis.innerWidth = 800; globalThis.innerHeight = 600;
    view.camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 10000);
    view.camera.position.copy(plaques[0].position).add(new THREE.Vector3(0, 20, 20));
    view.camera.lookAt(plaques[0].position);
    view.lastLabels = -Infinity; const size = plaques[0].scale.clone();
    view.updateLabels(0);
    assert.equal(plaques[0].visible, true);
    view.camera.position.add(new THREE.Vector3(0, 3000, 3000)); view.camera.lookAt(plaques[0].position);
    view.updateLabels(1000);
    assert.equal(plaques[0].visible, false);
    assert.deepEqual(plaques[0].scale.toArray(), size.toArray());
  } finally { view.disposeContent(); globalThis.document = previous; }
});

test('floor/ruler toggles preserve object placement and dim unrelated measurement guides', () => {
  const data = { architecture: 'X64', roots: [], threads: [], nativeAreas: [], edges: [],
    segments: [{ id: 'a', start: '0x1000', end: '0x1020', kind: 'Generation0' },
      { id: 'b', start: '0x2000', end: '0x2020', kind: 'Generation2' }],
    objects: [{ id: 'a', segment: 'a', address: '0x1000', size: 32, type: 'Node', generation: 'Generation0' },
      { id: 'b', segment: 'b', address: '0x2000', size: 32, type: 'Node', generation: 'Generation2' }] };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const index = indexGraph(data), settings = { budget: 100, heap: 'all', isolate: true };
  view.show(data, index, settings, 'a');
  const positions = data.objects.map(object => [...view.layout.objectPosition(object)]);
  const other = view.content.children.find(child => child.userData.regionRulers?.region === 'b');
  assert.ok(other.children.every(child => child.material.opacity === 0.05 && !child.material.depthWrite));
  view.setContextOpacity(0);
  assert.ok(other.children.every(child => child.material.opacity === 0));
  view.show(data, index, { ...settings, floorLabels: false, dimensions: false }, 'a');
  assert.equal(view.content.children.filter(child => child.userData.regionRulers).length, 0);
  assert.deepEqual(data.objects.map(object => view.layout.objectPosition(object)), positions);
  view.disposeContent();
});

test('internal array and root-slot cones scale to pointer cells while target and ordinary cones stay unchanged', () => {
  const data = { architecture: 'X64', segments: [{ id: 's', start: '0x1000', end: '0x3000', kind: 'Pinned' }],
    objects: [{ id: 'array', address: '0x1000', size: 4096, type: 'System.Object[]', segment: 's' },
      { id: 'target', address: '0x2000', size: 32, type: 'Node', segment: 's' }],
    roots: [{ id: 'root', address: '0x1010', target: 'target', kind: 'Strong', strong: true }] };
  const placed = layout(data), array = placed.objects.get('array'), target = placed.objects.get('target');
  const source = referenceSource(array, { kind: 'reference', offset: 8 });
  assert.equal(source.slotCellSize, arrayCellSize(array));
  for (const origin of [source, placed.roots.get('root')]) {
    assert.ok(origin.slotCellSize > 0);
    const record = { source: origin, target, kind: 'reference' };
    const small = referenceArrows(record, 'direct');
    const ordinary = referenceArrows({ ...record, source: { ...origin, slotCellSize: undefined } }, 'direct');
    assert.equal(small.length, 2);
    assert.equal(small[0].internal, true);
    assert.ok(small[0].length <= ordinary[0].length * 0.25);
    assert.ok(small[0].length <= origin.slotCellSize * 0.4);
    assert.ok(small[0].length * 0.28 * 3 * 2 < origin.slotCellSize, 'even maximum pipe width cannot grow the head beyond its slot cell');
    assert.deepEqual(small[1], ordinary[1]);
  }
});
