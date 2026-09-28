import { Color, InstancedBufferAttribute } from 'three';
import { rootTypes } from './root-provenance.js';

export function applyRootStripes(material, geometry, masks) {
  geometry.setAttribute('rootTypeMask', new InstancedBufferAttribute(new Float32Array(masks), 1));
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.uniforms.rootColors = { value: rootTypes.map(type => new Color(type.color)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float rootTypeMask;\nflat varying float vRootMask;\nvarying vec2 vRootUv;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRootMask = rootTypeMask;
vec3 rootNormal = abs(normal);
vRootUv = (rootNormal.x > 0.5 ? position.yz : rootNormal.y > 0.5 ? position.xz : position.xy) + 0.5;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
flat varying float vRootMask;
varying vec2 vRootUv;
uniform vec3 rootColors[${rootTypes.length}];`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float rootCount = 0.0;
for (int i = 0; i < ${rootTypes.length}; i++) rootCount += mod(floor(vRootMask / exp2(float(i))), 2.0);
if (rootCount > 0.0) {
  float stripe = mod(floor((vRootUv.x + vRootUv.y) * 8.0), rootCount);
  float current = 0.0;
  for (int i = 0; i < ${rootTypes.length}; i++) {
    if (mod(floor(vRootMask / exp2(float(i))), 2.0) > 0.5) {
      if (abs(current - stripe) < 0.5) diffuseColor.rgb = rootColors[i];
      current += 1.0;
    }
  }
}`);
  };
  material.customProgramCacheKey = () => `${key}:root-stripes`;
  material.userData.rootStripes = true;
}
