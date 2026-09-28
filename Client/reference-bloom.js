import { Color, MeshBasicMaterial, LineBasicMaterial, ShaderMaterial, WebGLRenderTarget, HalfFloatType, Vector2 } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// Only reference geometry emits bloom. Solid objects and far-array depth passes still occlude it.
export class ReferenceBloomPass extends Pass {
  constructor(scene, camera, settings) {
    super();
    this.scene = scene; this.camera = camera;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), settings.strength, settings.radius, settings.threshold);
    this.blackMesh = new MeshBasicMaterial({ color: '#000000' });
    this.blackLine = new LineBasicMaterial({ color: '#000000' });
    this.black = new Color('#000000');
    this.uniforms = { baseTexture: { value: null }, glowTexture: { value: null } };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D glowTexture; varying vec2 vUv;
void main() { vec4 base = texture2D(baseTexture, vUv); gl_FragColor = vec4(base.rgb + texture2D(glowTexture, vUv).rgb, base.a); }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.target.setSize(width, height); this.bloom.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer, delta, maskActive) {
    const background = this.scene.background, target = renderer.getRenderTarget();
    const clear = renderer.autoClear, clearColor = renderer.getClearColor(new Color()), clearAlpha = renderer.getClearAlpha();
    const restored = [];
    try {
      this.scene.background = this.black;
      this.scene.traverse(object => {
        if (!object.material || !object.visible || !object.layers.test(this.camera.layers) || object.userData.referenceGlow) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.every(material => material.colorWrite === false)) return;
        restored.push({ object, material: object.material, visible: object.visible });
        if (materials.some(material => material.transparent || !material.depthWrite)) object.visible = false;
        else object.material = object.isLine ? this.blackLine : this.blackMesh;
      });
      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
      this.bloom.render(renderer, writeBuffer, this.target, delta, maskActive);
    } finally {
      for (const entry of restored) {
        entry.object.material = entry.material; entry.object.visible = entry.visible;
      }
      this.scene.background = background; renderer.autoClear = clear;
      renderer.setClearColor(clearColor, clearAlpha); renderer.setRenderTarget(target);
    }
    this.uniforms.baseTexture.value = readBuffer.texture;
    // This target contains only the blur, before UnrealBloomPass adds it to its input.
    this.uniforms.glowTexture.value = this.bloom.renderTargetsHorizontal[0].texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose(); this.bloom.dispose();
    this.blackMesh.dispose(); this.blackLine.dispose(); this.material.dispose(); this.quad.dispose();
  }
}
