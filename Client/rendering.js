import { Vector3, Float32BufferAttribute } from 'three';

export const renderLayers = { glass: 10, guides: 15, connections: 20, signals: 25, selection: 30, labels: 40 };
export const transparentSurface = { transparent: true, depthWrite: false, depthTest: true };

export function labelOpacity(distance, nearest, sceneExtent, base = 1, selected = false) {
  if (selected) return Math.max(0.9, base);
  const scale = Math.max(120, sceneExtent * 0.9);
  const relative = Math.min(1, (nearest + scale * 0.08) / (distance + scale * 0.08));
  return base * (0.18 + 0.82 * Math.exp(-distance / scale) * relative ** 1.5);
}

export function labelsOverlap(a, b, padding = 4) {
  if (a.x > b.x + b.width + padding || b.x > a.x + a.width + padding ||
      a.y > b.y + b.height + padding || b.y > a.y + a.height + padding) return false;
  const corners = label => label.polygon ?? [[label.x, label.y], [label.x + label.width, label.y],
    [label.x + label.width, label.y + label.height], [label.x, label.y + label.height]];
  const left = corners(a), right = corners(b);
  // Ground-plane plaques are skewed quads: their bounding rectangles can overlap while the text does not.
  for (const polygon of [left, right]) for (let i = 0; i < polygon.length; i++) {
    const point = polygon[i], next = polygon[(i + 1) % polygon.length];
    const nx = point[1] - next[1], ny = next[0] - point[0], margin = padding * Math.hypot(nx, ny);
    const p = left.map(([x, y]) => x * nx + y * ny), q = right.map(([x, y]) => x * nx + y * ny);
    if (Math.max(...p) + margin < Math.min(...q) || Math.max(...q) + margin < Math.min(...p)) return false;
  }
  return true;
}

export function addTubeCenters(geometry, curve, segments) {
  const centers = new Float32Array(geometry.attributes.position.count * 3);
  const ringSize = geometry.attributes.position.count / (segments + 1), point = new Vector3();
  for (let i = 0; i <= segments; i++) {
    curve.getPointAt(i / segments, point);
    for (let ring = 0; ring < ringSize; ring++) {
      const offset = (i * ringSize + ring) * 3;
      centers[offset] = point.x; centers[offset + 1] = point.y; centers[offset + 2] = point.z;
    }
  }
  geometry.setAttribute('tubeCenter', new Float32BufferAttribute(centers, 3));
  return geometry;
}

export function applyTubeWidth(material, width) {
  material.onBeforeCompile = shader => {
    shader.uniforms.referenceWidth = width;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 tubeCenter;\nuniform float referenceWidth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = tubeCenter + (transformed - tubeCenter) * referenceWidth;');
  };
  material.customProgramCacheKey = () => 'memoryflight-tube-width';
  return material;
}

export function arrayOpacity(cameraPosition, object) {
  const half = object.side / 2;
  let squaredDistance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(0, Math.abs(cameraPosition[axis] - object.position[axis]) - half);
    squaredDistance += gap * gap;
  }
  const distance = Math.sqrt(squaredDistance);
  const t = Math.min(1, distance / Math.max(12, object.side * 5));
  return 0.18 + 0.82 * t * t * (3 - 2 * t);
}

// One per-instance alpha drives both the color pass and the opaque-only depth prepass.
export function applyArrayAlpha(material) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float arrayAlpha;\nflat varying float vArrayAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvArrayAlpha = arrayAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nflat varying float vArrayAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vArrayAlpha;');
  };
  material.customProgramCacheKey = () => `memoryflight-array-alpha-flat:${material.type}`;
  return material;
}

// Typed chunks avoid millions of nested JS arrays when rendering every captured reference.
export class CurveLineBuffer {
  constructor(segmentsPerChunk = 32768) {
    this.capacity = segmentsPerChunk * 6;
    this.chunks = []; this.current = null; this.used = 0; this.segmentCount = 0;
    this.previous = new Vector3(); this.next = new Vector3();
  }

  add(curve, segments) {
    curve.getPoint(0, this.previous);
    for (let i = 1; i <= segments; i++) {
      curve.getPoint(i / segments, this.next);
      if (!this.current || this.used === this.capacity) {
        this.current = new Float32Array(this.capacity); this.chunks.push(this.current); this.used = 0;
      }
      const values = this.current, offset = this.used;
      values[offset] = this.previous.x; values[offset + 1] = this.previous.y; values[offset + 2] = this.previous.z;
      values[offset + 3] = this.next.x; values[offset + 4] = this.next.y; values[offset + 5] = this.next.z;
      this.used += 6; this.segmentCount++; this.previous.copy(this.next);
    }
  }

  buffers() {
    return this.chunks.map((chunk, i) => i === this.chunks.length - 1 ? chunk.subarray(0, this.used) : chunk);
  }
}
