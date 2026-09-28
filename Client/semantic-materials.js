import { InstancedBufferAttribute } from 'three';
import { isArrayType } from './spatial.js';

export const semanticMaterials = {
  string: { id: 0, label: 'String', color: '#ed83e7', pattern: 'diagonal crystalline bands' },
  array: { id: 1, label: 'Array', color: '#59dbf0', pattern: 'luminous cell grid' },
  object: { id: 2, label: 'Object', color: '#a78bed', pattern: 'granular crystal' },
  scalar: { id: 3, label: 'Known scalar/value', color: '#779eee', pattern: 'ordered data dashes' },
  native: { id: 4, label: 'Native mapping', color: '#f2c46d', pattern: 'plain amber - no material pattern' },
  unknown: { id: 5, label: 'Unknown type', color: '#66d8c7', pattern: 'soft contour bands' },
};

const scalarTypes = new Set(['System.Boolean', 'System.Char', 'System.Byte', 'System.SByte',
  'System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64',
  'System.IntPtr', 'System.UIntPtr', 'System.Single', 'System.Double', 'System.Decimal',
  'System.DateTime', 'System.DateTimeOffset', 'System.TimeSpan', 'System.Guid']);

export function semanticCategory(type) {
  if (type === 'System.String') return 'string';
  if (isArrayType(type)) return 'array';
  if (scalarTypes.has(type)) return 'scalar';
  return !type || type === '<unknown>' ? 'unknown' : 'object';
}

function hash(text) {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.codePointAt(0), 16777619) >>> 0;
  return value / 4294967295;
}

export function semanticDescriptor(object, { previewsIncluded = false, referenceCount = 0, native = false } = {}) {
  if (!Number.isFinite(object.size) || object.size < 0) throw new RangeError('Semantic materials require a valid captured byte size.');
  const category = native ? 'native' : semanticCategory(object.type);
  const material = semanticMaterials[category];
  const preview = !native && previewsIncluded && typeof object.preview === 'string' ? object.preview : null;
  const metadata = native ? `${object.kind}|${object.state}|${object.protection}|${object.size}` :
    `${object.type}|${object.size}|${referenceCount}`;
  const seed = hash(`${metadata}|${preview ?? ''}`);
  const density = Math.min(18, Math.max(4, Math.round(3 + Math.log2(object.size + 1) * 0.6 + Math.log2(referenceCount + 1) * 0.3)));
  return { ...material, category, seed, density, previewUsed: preview !== null,
    basis: native ? 'plain category color; no data-driven surface pattern' :
      `type, byte size and captured reference count${preview !== null ? '; captured preview also contributes' : '; no content preview used'}` };
}

export function applySemanticSurface(material, geometry, descriptors) {
  const values = new Float32Array(descriptors.length * 4);
  descriptors.forEach((descriptor, i) => values.set([descriptor.id, descriptor.seed, descriptor.density, Number(descriptor.previewUsed)], i * 4));
  geometry.setAttribute('semanticData', new InstancedBufferAttribute(values, 4));
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 semanticData;
varying vec2 vSemanticUv;
flat varying vec4 vSemanticData;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec3 semanticNormal = abs(normal);
vSemanticUv = (semanticNormal.x > 0.5 ? position.yz : semanticNormal.y > 0.5 ? position.xz : position.xy) + 0.5;
vSemanticData = semanticData;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vSemanticUv;
flat varying vec4 vSemanticData;
float semanticHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + vSemanticData.y);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float semanticLine(float coordinate) {
  float distanceToLine = abs(fract(coordinate + 0.5) - 0.5);
  return 1.0 - smoothstep(0.015, max(0.035, fwidth(coordinate) * 0.65), distanceToLine);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
vec2 semanticUv = vSemanticUv;
float semanticDensity = vSemanticData.z;
vec2 semanticCell = floor(semanticUv * semanticDensity);
float semanticNoise = semanticHash(semanticCell);
float semanticPattern;
if (vSemanticData.x < 0.5) {
  semanticPattern = semanticLine((semanticUv.x + semanticUv.y) * semanticDensity + vSemanticData.y * 3.0);
} else if (vSemanticData.x < 1.5) {
  semanticPattern = max(semanticLine(semanticUv.x * semanticDensity), semanticLine(semanticUv.y * semanticDensity));
} else if (vSemanticData.x < 2.5) {
  vec2 spark = fract(semanticUv * semanticDensity * 2.0) - 0.5;
  semanticPattern = (1.0 - smoothstep(0.02, 0.19, length(spark))) * step(0.60, semanticHash(floor(semanticUv * semanticDensity * 2.0)));
} else if (vSemanticData.x < 3.5) {
  vec2 dash = abs(fract(semanticUv * semanticDensity) - 0.5);
  semanticPattern = (1.0 - smoothstep(0.22, 0.32, dash.x)) * (1.0 - smoothstep(0.045, 0.12, dash.y)) * step(0.28, semanticNoise);
} else if (vSemanticData.x < 4.5) {
  semanticPattern = 0.0;
} else {
  semanticPattern = semanticLine(length(semanticUv - 0.5) * semanticDensity + vSemanticData.y);
}
float semanticBorderDistance = min(min(semanticUv.x, 1.0 - semanticUv.x), min(semanticUv.y, 1.0 - semanticUv.y));
float semanticBorder = 1.0 - smoothstep(0.012, max(0.03, fwidth(semanticBorderDistance)), semanticBorderDistance);
vec2 semanticCornerDelta = min(semanticUv, 1.0 - semanticUv);
float semanticCorner = exp(-length(semanticCornerDelta) * 22.0);
float semanticInnerRim = exp(-semanticBorderDistance * 28.0);
diffuseColor.rgb *= 0.27 + semanticNoise * (0.16 + vSemanticData.w * 0.05) + semanticPattern * 0.12;
totalEmissiveRadiance += (diffuseColor.rgb * (semanticPattern * 1.45 + semanticBorder * 2.4 +
  semanticInnerRim * 0.5 + semanticCorner * 0.8) + vec3(0.1) * semanticBorder) * diffuseColor.a;
roughnessFactor = mix(roughnessFactor, 0.24, max(semanticPattern, semanticBorder));`);
  };
  material.customProgramCacheKey = () => `${previousKey}:memoryflight-semantic-v2`;
  material.userData.semanticSurface = true;
  return material;
}
