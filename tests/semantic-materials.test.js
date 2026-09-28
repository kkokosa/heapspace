import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { semanticCategory, semanticDescriptor, applySemanticSurface } from '../Client/semantic-materials.js';
import { applyArrayAlpha } from '../Client/rendering.js';
import { typeColor, getTheme } from '../Client/themes.js';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';

test('semantic categories identify known metadata without guessing custom value types', () => {
  assert.equal(semanticCategory('System.String'), 'string');
  assert.equal(semanticCategory('System.String[]'), 'array');
  assert.equal(semanticCategory('System.Object[,]'), 'array');
  assert.equal(semanticCategory('System.Int32'), 'scalar');
  assert.equal(semanticCategory('MyApplication.CustomStruct'), 'object');
  assert.equal(semanticCategory('<unknown>'), 'unknown');
  assert.equal(semanticDescriptor({ size: 4096, kind: 'private', state: 'committed', protection: 'rw' }, { native: true }).category, 'native');
});

test('content variation reads previews only when the snapshot opted in', () => {
  const a = { type: 'System.String', size: 64, preview: 'same-length-A' };
  const b = { ...a, preview: 'same-length-B' };
  assert.equal(semanticDescriptor(a).seed, semanticDescriptor(b).seed);
  assert.notEqual(semanticDescriptor(a, { previewsIncluded: true }).seed, semanticDescriptor(b, { previewsIncluded: true }).seed);
  assert.equal(semanticDescriptor(a).previewUsed, false);
  assert.equal(semanticDescriptor(a, { previewsIncluded: true }).previewUsed, true);
  assert.equal(semanticDescriptor({ ...a, preview: null }, { previewsIncluded: true }).previewUsed, false);
  const guarded = { type: 'System.String', size: 64, get preview() { throw new Error('Preview must not be read.'); } };
  assert.doesNotThrow(() => semanticDescriptor(guarded));
  assert.equal(semanticDescriptor(a).seed, semanticDescriptor({ ...a, address: '0xfffffffffffff' }).seed);
  assert.notEqual(semanticDescriptor(a, { referenceCount: 1 }).seed, semanticDescriptor(a, { referenceCount: 2 }).seed);
});

test('semantic shader composes with array fading rather than replacing its hook', () => {
  const material = applyArrayAlpha(new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false }));
  const geometry = new THREE.BoxGeometry();
  applySemanticSurface(material, geometry, [semanticDescriptor({ type: 'System.Object[]', size: 128 })]);
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>' };
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /vArrayAlpha/);
  assert.match(shader.vertexShader, /semanticData/);
  assert.match(shader.fragmentShader, /diffuseColor.a \*= vArrayAlpha/);
  assert.match(shader.fragmentShader, /semanticPattern/);
  assert.equal(geometry.attributes.semanticData.count, 1);
  assert.match(material.customProgramCacheKey(), /array-alpha.*semantic/);
  assert.equal(material.depthWrite, false);
  material.dispose(); geometry.dispose();
});

test('Prism is optional and preserves object transforms, array depth handling and reference topology', () => {
  const data = {
    architecture: 'X64', previewsIncluded: false,
    segments: [{ id: 's', start: '0x1000', end: '0x2000', kind: 'Generation2', heap: 0 }],
    objects: [
      { id: 'a', address: '0x1000', segment: 's', type: 'System.Object[]', generation: 'Generation2', size: 64, preview: null },
      { id: 'b', address: '0x1040', segment: 's', type: 'System.String', generation: 'Generation2', size: 40, preview: null },
    ],
    edges: [{ source: 'a', target: 'b', kind: 'reference', offset: 8 }],
    roots: [], threads: [], nativeAreas: [],
  };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  const settings = { budget: 100, heap: 'all', edges: true, roots: true, native: true };
  const index = indexGraph(data);
  view.show(data, index, settings, null);
  const before = data.objects.map(object => [...view.layout.objectPosition(object)]);
  const result = view.show(data, index, { ...settings, theme: 'prism' }, null);
  assert.equal(result.edges, 1);
  assert.deepEqual(data.objects.map(object => view.layout.objectPosition(object)), before);
  const surfaces = view.content.children.filter(mesh => mesh.userData.layer === 'foreground');
  assert.equal(surfaces.length, 2);
  assert.ok(surfaces.every(mesh => mesh.material.userData.semanticSurface && mesh.geometry.attributes.semanticData));
  assert.equal(view.arrayBatches[0].depth.material.colorWrite, false);
  assert.equal(view.arrayBatches[0].mesh.material.depthWrite, false);
  assert.notEqual(typeColor('System.String', getTheme('prism')), typeColor('System.Object[]', getTheme('prism')));
  view.show(data, index, settings, null);
  assert.ok(view.content.children.filter(mesh => mesh.userData.layer === 'foreground').every(mesh => !mesh.geometry.attributes.semanticData));
  view.disposeContent();
});
