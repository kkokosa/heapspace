import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { renderLayers, transparentSurface } from './rendering.js';
import { unbundledReference } from './spatial.js';

export function sampleGoldenReferences(records, mode, limit = 96) {
  const count = Math.min(limit, records.length), bundles = new Set(), result = [];
  for (let i = 0; i < count; i++) {
    const record = records[Math.floor(i * records.length / count)];
    if (!unbundledReference(record, mode)) {
      const key = `${record.source.region.id}>${record.target.region.id}:${record.kind}`;
      if (bundles.has(key)) continue;
      bundles.add(key);
    }
    result.push(record);
  }
  return result;
}

export function pulseProgress(head, tailFraction, index, segments) {
  return Math.max(0, head - tailFraction * index / segments);
}

export class GoldenSignals {
  constructor(flows, theme, texture) {
    this.flows = flows; this.theme = theme;
    this.count = flows.length * theme.packets;
    this.segments = theme.trail;
    this.lengths = flows.map(flow => flow.curve.getLength());
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.count * 3), 3));
    this.heads = new THREE.Points(geometry, new THREE.PointsMaterial({
      ...transparentSurface, color: new THREE.Color(3, 2.2, 0.7), size: theme.signalSize,
      sizeAttenuation: false, map: texture, alphaTest: 0.01, blending: THREE.AdditiveBlending,
    }));
    this.positions = new Float32Array(this.count * this.segments * 6);
    const colors = new Float32Array(this.positions.length);
    const gold = new THREE.Color('#ffb629').multiplyScalar(1.8);
    for (let pulse = 0; pulse < this.count; pulse++) for (let i = 0; i < this.segments; i++) {
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        const fade = (1 - (i + endpoint) / this.segments) ** 1.6;
        colors.set([gold.r * fade, gold.g * fade, gold.b * fade], (pulse * this.segments + i) * 6 + endpoint * 3);
      }
    }
    const trailGeometry = new LineSegmentsGeometry().setPositions(this.positions).setColors(colors);
    this.trails = new LineSegments2(trailGeometry, new LineMaterial({
      ...transparentSurface, color: '#ffffff', vertexColors: true, linewidth: theme.pulseWidth,
      blending: THREE.AdditiveBlending, opacity: 0.9,
    }));
    for (const object of [this.heads, this.trails]) {
      object.frustumCulled = false; object.renderOrder = renderLayers.signals;
      object.userData.referenceGlow = true; object.userData.goldenSignal = true;
    }
  }

  set visible(value) { this.heads.visible = value; this.trails.visible = value; }

  update(time, camera, viewportHeight = 1000) {
    let pulse = 0, offset = 0;
    for (let flowIndex = 0; flowIndex < this.flows.length; flowIndex++) {
      const flow = this.flows[flowIndex], length = Math.max(0.001, this.lengths[flowIndex]);
      for (let packet = 0; packet < this.theme.packets; packet++) {
        const progress = ((time + flow.phase + packet / this.theme.packets) % 1 + 1) % 1;
        const head = flow.curve.getPointAt(progress);
        this.heads.geometry.attributes.position.setXYZ(pulse++, head.x, head.y, head.z);
        const worldPerPixel = camera ? 2 * camera.position.distanceTo(head) *
          Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / viewportHeight : length / 1000;
        const tailFraction = Math.min(0.045, worldPerPixel * 22 / length);
        let previous = head;
        for (let i = 1; i <= this.segments; i++) {
          const point = flow.curve.getPointAt(pulseProgress(progress, tailFraction, i, this.segments));
          this.positions[offset] = previous.x; this.positions[offset + 1] = previous.y; this.positions[offset + 2] = previous.z;
          this.positions[offset + 3] = point.x; this.positions[offset + 4] = point.y; this.positions[offset + 5] = point.z;
          offset += 6; previous = point;
        }
      }
    }
    this.heads.geometry.attributes.position.needsUpdate = true;
    this.trails.geometry.attributes.instanceStart.data.needsUpdate = true;
  }
}
