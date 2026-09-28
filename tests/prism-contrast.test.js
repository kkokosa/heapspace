import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ReferenceBloomPass } from '../Client/reference-bloom.js';
import { GoldenSignals, pulseProgress, sampleGoldenReferences } from '../Client/golden-signals.js';
import { getTheme, signalPixels } from '../Client/themes.js';
import { semanticDescriptor } from '../Client/semantic-materials.js';
import { Atlas } from '../Client/scene.js';
import { indexGraph } from '../Client/graph.js';

test('reference bloom masks object emission while preserving solid and array-depth occluders, then restores state', () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  scene.background = new THREE.Color('#123456');
  const geometry = new THREE.BoxGeometry();
  const object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ emissive: '#ffffff', emissiveIntensity: 10 }));
  const glass = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false }));
  const depth = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }));
  const reference = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#00ffff' }));
  reference.userData.referenceGlow = true;
  scene.add(object, glass, depth, reference);
  const originals = scene.children.map(item => item.material), background = scene.background;
  const pass = new ReferenceBloomPass(scene, camera, getTheme('prism').bloom);
  const target = {}, clearColor = new THREE.Color('#234567');
  let currentTarget = target, composed = false;
  const renderer = {
    autoClear: false,
    getRenderTarget: () => currentTarget,
    setRenderTarget: value => { currentTarget = value; },
    getClearColor: value => value.copy(clearColor),
    getClearAlpha: () => 0.5,
    setClearColor() {},
    render() {
      assert.equal(object.material, pass.blackMesh);
      assert.equal(object.material.depthWrite, true);
      assert.equal(glass.visible, false);
      assert.equal(depth.material, originals[2]);
      assert.equal(reference.material, originals[3]);
      assert.equal(scene.background.getHex(), 0);
    },
  };
  pass.bloom.render = () => {};
  pass.quad.render = () => { composed = true; };
  const read = { texture: {} }, write = {};
  pass.render(renderer, write, read, 0, false);
  assert.equal(composed, true);
  assert.equal(pass.uniforms.baseTexture.value, read.texture);
  assert.equal(pass.uniforms.glowTexture.value, pass.bloom.renderTargetsHorizontal[0].texture);
  assert.equal(scene.background, background);
  assert.equal(glass.visible, true);
  assert.deepEqual(scene.children.map(item => item.material), originals);
  assert.equal(renderer.autoClear, false);
  renderer.render = () => { throw new Error('render failure'); };
  assert.throws(() => pass.render(renderer, write, read, 0, false), /render failure/);
  assert.equal(scene.background, background); assert.equal(glass.visible, true);
  assert.deepEqual(scene.children.map(item => item.material), originals);
  pass.dispose(); geometry.dispose(); originals.forEach(material => material.dispose());
});

test('golden pulses use real arc-length paths, stay behind their heads, and do not wrap tails across endpoints', () => {
  const curve = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
  const texture = new THREE.DataTexture(signalPixels('glow'), 16, 16, THREE.RGBAFormat);
  const pulses = new GoldenSignals([{ curve, phase: 0, source: 'a', target: 'b' }], getTheme('prism'), texture);
  pulses.update(0.001, null);
  assert.ok([...pulses.positions].every(Number.isFinite));
  assert.equal(pulses.heads.geometry.attributes.position.count, getTheme('prism').packets);
  const firstHead = pulses.heads.geometry.attributes.position.getX(0);
  for (const x of pulses.positions.slice(0, pulses.segments * 6).filter((_, i) => i % 3 === 0)) {
    assert.ok(x >= 0 && x <= firstHead + 1e-6);
  }
  assert.equal(pulseProgress(0.01, 0.1, 6, 6), 0);
  assert.ok(pulses.heads.material.color.r > pulses.heads.material.color.b);
  pulses.visible = false;
  assert.equal(pulses.heads.visible, false); assert.equal(pulses.trails.visible, false);
  pulses.heads.geometry.dispose(); pulses.heads.material.dispose();
  pulses.trails.geometry.dispose(); pulses.trails.material.dispose(); texture.dispose();
});

test('many references sharing a trunk do not stack into one continuous golden beam', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const records = Array.from({ length: 1000 }, (_, i) => ({
    source: { id: `source${i}`, region: a }, target: { id: `target${i}`, region: b }, kind: 'reference',
  }));
  const bundled = sampleGoldenReferences(records, 'bundled');
  assert.equal(bundled.length, 1);
  assert.ok(records.includes(bundled[0]));
  assert.equal(sampleGoldenReferences(records, 'direct').length, 96);
  assert.deepEqual(sampleGoldenReferences([], 'bundled'), []);
});

test('Prism native boxes stay plain and only reference geometry is tagged as a glow source', () => {
  const data = {
    architecture: 'X64', previewsIncluded: false,
    segments: [{ id: 's', start: '0x1000', end: '0x2000', kind: 'Generation2' }],
    objects: [
      { id: 'a', address: '0x1000', segment: 's', type: 'System.String', size: 40 },
      { id: 'b', address: '0x1028', segment: 's', type: 'Node', size: 32 },
    ],
    edges: [{ source: 'b', target: 'a', kind: 'reference', offset: 0 }],
    roots: [], threads: [],
    nativeAreas: [{ start: '0x4000', end: '0x5000', size: 4096, kind: 'private', state: 'committed', protection: 'rw', owners: [] }],
  };
  const view = Object.create(Atlas.prototype);
  view.content = new THREE.Group(); view.selection = new THREE.Group(); view.pickables = []; view.label = () => {};
  view.show(data, indexGraph(data), { budget: 100, heap: 'all', theme: 'prism', edges: true, native: true }, null);
  const native = view.content.children.find(item => item.userData.items?.[0]?.kind === 'native');
  assert.equal(native.geometry.attributes.semanticData, undefined);
  assert.equal(native.material.userData.semanticSurface, undefined);
  assert.match(semanticDescriptor(data.nativeAreas[0], { native: true }).pattern, /plain amber/);
  const objects = view.content.children.filter(item => item.userData.layer === 'foreground');
  assert.ok(objects.every(item => !item.userData.referenceGlow && item.material.userData.semanticSurface));
  assert.ok(view.content.children.some(item => item.userData.referenceGlow));
  assert.ok(view.goldenSignals);
  view.setAnimation(false);
  assert.equal(view.goldenSignals.trails.visible, false);
  view.disposeContent();
});
