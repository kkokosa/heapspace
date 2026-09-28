import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ReferenceBloomPass } from './reference-bloom.js';
import { GoldenSignals, sampleGoldenReferences } from './golden-signals.js';
import { heapKind, selectObjects, selectReferences, neighborhood, resolveSite, siteKey } from './graph.js';
import { layout, bundleReferences, pipeRadius, referenceRoute, directReferenceRoute, referenceSource, unbundledReference, regionLabel } from './spatial.js';
import { getTheme, signalPixels, typeColor, sizeColor } from './themes.js';
import { matchingReachability } from './reachability.js';
import { referenceArrows, referenceArrowGeometry } from './reference-arrows.js';
import { regionFloorText, regionRulers, orientPlanarLabel } from './region-guides.js';
import { rootTypes } from './root-provenance.js';
import { applyRootStripes } from './root-colors.js';
import { cardState } from './cards.js';
import { semanticDescriptor, semanticMaterials, applySemanticSurface } from './semantic-materials.js';
import { renderLayers, transparentSurface, arrayOpacity, applyArrayAlpha, CurveLineBuffer,
  labelOpacity, labelsOverlap, addTubeCenters, applyTubeWidth } from './rendering.js';

export class Atlas {
  constructor(container, onSelect, onHover, onFlight, onDeselect, onFlightSpeed) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onDeselect = onDeselect;
    this.onFlightSpeed = onFlightSpeed;
    this.slowFlight = false;
    this.theme = getTheme();
    this.signalsEnabled = true; this.signalSpeed = 1; this.signalTime = 0;
    this.referenceWidth = { value: 1.5 }; this.wideLineMaterials = [];
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#071019');
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100000);
    this.camera.layers.enable(1);
    this.camera.position.set(400, 460, 760);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer?.setSize(innerWidth, innerHeight);
    this.renderer.domElement.tabIndex = 0;
    container.append(this.renderer.domElement);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.flight = new PointerLockControls(this.camera, this.renderer.domElement);
    this.flight.addEventListener('lock', () => {
      this.renderer.domElement.focus({ preventScroll: true });
      this.orbit.enabled = false; this.lastHover = -Infinity; onFlight(true);
    });
    this.flight.addEventListener('unlock', () => {
      this.orbit.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(80));
      this.orbit.enabled = true; this.keys.clear(); onFlight(false);
    });
    this.scene.add(new THREE.AmbientLight('#c7dfee', 2.4));
    const sun = new THREE.DirectionalLight('#e3fff8', 3);
    sun.position.set(200, 600, 400); this.scene.add(sun);
    this.grid = new THREE.GridHelper(5000, 250, ...this.theme.grid);
    this.grid.position.y = -6; this.scene.add(this.grid);
    this.content = new THREE.Group(); this.scene.add(this.content);
    this.selection = new THREE.Group(); this.scene.add(this.selection);
    this.keys = new Set(); this.speed = 130; this.pickables = []; this.lastHover = 0;
    this.sitePickables = []; this.labels = []; this.lastLabels = -Infinity;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.6;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) {
        if (this.flight.isLocked) e.preventDefault();
        return;
      }
      if (e.ctrlKey || this.keys.has('KeyR')) e.preventDefault();
      this.down = [e.clientX, e.clientY];
    });
    canvas.addEventListener('click', e => {
      if (e.button !== 0 || (!this.flight.isLocked && (!this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 5))) return;
      const item = this.pick(e);
      if (item) onSelect(item);
      else onDeselect();
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointermove', e => {
      this.lastCursor = { clientX: e.clientX, clientY: e.clientY };
      if (this.flight.isLocked || performance.now() - this.lastHover < 90) return;
      this.lastHover = performance.now(); onHover(this.pick(e), e);
    });
    canvas.addEventListener('pointerleave', e => { if (!this.flight.isLocked) onHover(null, e); });
    canvas.addEventListener('wheel', e => {
      if (this.flight.isLocked) this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.8 : 1.25), 5, 20000);
    });
    addEventListener('keydown', e => this.handleKeyDown(e));
    addEventListener('keyup', e => this.handleKeyUp(e));
    addEventListener('blur', () => {
      this.keys.clear();
      this.onFlightSpeed?.(this.flightSpeedMode());
    });
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer?.setSize(innerWidth, innerHeight);
    });
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  handleKeyDown(event) {
    if (event.code === 'Escape') {
      if (this.flight.isLocked) this.flight.unlock();
      this.keys.clear(); this.onDeselect(); return;
    }
    const target = event.target;
    const textEntry = target?.isContentEditable || target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes(target.type);
    // Flight can start from panel controls without a scene click, but never consumes text entry.
    if (event.code === 'KeyF' && !event.ctrlKey && !event.metaKey && !event.altKey &&
      !event.isComposing && !event.defaultPrevented && (this.flight.isLocked || !textEntry)) {
      event.preventDefault();
      if (!event.repeat) this.toggleFlight();
      return;
    }
    if (!this.flight.isLocked && (['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName) || target?.isContentEditable)) return;
    if (!this.flight.isLocked && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(event.code)) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
    }
    if (event.code === 'KeyG' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat && this.selectedPosition) this.focus(this.selectedPosition);
      return;
    }
    if (event.code === 'Space') {
      if (!this.flight.isLocked || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      if (!event.repeat) {
        this.slowFlight = !this.slowFlight;
        this.onFlightSpeed?.(this.flightSpeedMode());
      }
      return;
    }
    if (this.flight.isLocked && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyR'].includes(event.code))
      event.preventDefault();
    if (event.code === 'KeyX') {
      event.preventDefault();
      if (!event.repeat) this.onDeselect();
      return;
    }
    this.keys.add(event.code);
    if (this.flight.isLocked && (event.code === 'ShiftLeft' || event.code === 'ShiftRight'))
      this.onFlightSpeed?.(this.flightSpeedMode());
    if (event.code === 'ControlLeft' || event.code === 'ControlRight' || event.code === 'KeyR') this.refreshCursorHover();
  }

  handleKeyUp(event) {
    if (this.flight.isLocked && event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) event.preventDefault();
    this.keys.delete(event.code);
    if (this.flight.isLocked && (event.code === 'ShiftLeft' || event.code === 'ShiftRight'))
      this.onFlightSpeed?.(this.flightSpeedMode());
    if (event.code === 'ControlLeft' || event.code === 'ControlRight' || event.code === 'KeyR') this.refreshCursorHover();
  }

  flightSpeedMode() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 'fast' : this.slowFlight ? 'slow' : 'normal';
  }

  toggleFlight() {
    if (this.flight.isLocked) this.flight.unlock();
    else this.flight.lock();
  }

  refreshCursorHover() {
    this.lastHover = -Infinity;
    if (!this.flight.isLocked && this.lastCursor) this.onHover(this.pick(this.lastCursor), this.lastCursor);
  }

  updateFlightHover(now) {
    if (!this.flight.isLocked || now - this.lastHover < 100) return;
    this.lastHover = now;
    const cursor = { clientX: innerWidth / 2, clientY: innerHeight / 2 };
    this.onHover(this.pick(cursor), cursor);
  }

  setTheme(id = 'atlas') {
    const theme = getTheme(id);
    if (this.theme === theme) return;
    this.theme = theme;
    if (this.scene) this.scene.background = new THREE.Color(theme.background);
    if (this.grid) {
      this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose();
      this.grid = new THREE.GridHelper(5000, 250, ...theme.grid);
      this.grid.position.y = -6; this.scene.add(this.grid);
    }
    this.setBloom(this.bloomEnabled ?? true);
  }

  setBloom(enabled = true) {
    this.bloomEnabled = enabled;
    if (!this.renderer) return;
    const bloom = enabled ? this.theme.bloom : null;
    if (!bloom) {
      if (this.composer) {
        for (const pass of this.composer.passes) pass.dispose();
        this.composer.dispose(); this.composer = null;
      }
      this.renderer.toneMapping = this.theme.bloom ? THREE.ReinhardToneMapping : THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1;
      return;
    }
    if (this.composer) return;
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1;
    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(1);
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new ReferenceBloomPass(this.scene, this.camera, bloom));
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  setAnimation(enabled, speed = 1) {
    this.signalsEnabled = enabled;
    this.signalSpeed = THREE.MathUtils.clamp(speed, 0.25, 3);
    if (this.particles) this.particles.visible = enabled;
    if (this.goldenSignals) this.goldenSignals.visible = enabled;
  }

  setConnectionWidth(width = 1.5) {
    this.referenceWidth ??= { value: 1.5 };
    this.referenceWidth.value = THREE.MathUtils.clamp(width, 0.5, 3);
    for (const material of this.wideLineMaterials ?? []) material.linewidth = this.referenceWidth.value * 2;
  }

  pick(event) {
    this.camera.updateMatrixWorld();
    this.content.updateMatrixWorld(true);
    const x = this.flight.isLocked ? 0 : event.clientX / innerWidth * 2 - 1;
    const y = this.flight.isLocked ? 0 : 1 - event.clientY / innerHeight * 2;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    this.raycaster.layers.enable(1);
    const sitesOnly = event.ctrlKey || this.keys?.has('ControlLeft') || this.keys?.has('ControlRight') || this.keys?.has('KeyR');
    if (!sitesOnly) {
      const control = this.raycaster.intersectObjects((this.uiPickables ?? []).filter(mesh => mesh.visible && mesh.material.opacity > 0), false)[0];
      if (control) return control.object.userData.item;
    }
    const candidates = (sitesOnly ? this.sitePickables ?? [] : this.pickables).filter(mesh => mesh.visible && mesh.material.opacity > 0);
    const hit = this.raycaster.intersectObjects(candidates, false)[0];
    if (!hit) return null;
    if (hit.object.userData.cardMap) {
      const { info, columns, rows } = hit.object.userData.cardMap;
      if (!info.count || !hit.uv) return { kind: 'cardMap', value: info };
      const column = Math.min(columns - 1, Math.floor(hit.uv.x * columns));
      const row = Math.min(rows - 1, Math.floor(hit.uv.y * rows));
      const index = row * columns + column;
      if (index >= info.count) return index < hit.object.userData.cardMap.displayCount ? { kind: 'cardMap', value: info } : null;
      return { kind: 'card', value: { segment: info.segment, index, dirty: cardState(info, index) } };
    }
    return hit.instanceId === undefined ? hit.object.userData.item : hit.object.userData.items[hit.instanceId];
  }

  disposeContent() {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.content.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(m); if (m.map) textures.add(m.map);
        }
      }
    });
    for (const item of [...geometries, ...materials, ...textures]) item.dispose();
    this.content.clear(); this.pickables = []; this.sitePickables = []; this.uiPickables = []; this.siteItems = new Map();
    this.labels = []; this.lastLabels = -Infinity; this.regionGuideMaterials = [];
    this.wideLineMaterials = [];
    this.flows = []; this.particles = null; this.goldenSignals = null; this.contextMaterials = []; this.arrayBatches = [];
    this.mark(null);
  }

  label(text, position, color = '#a4c2d1', width = 36, opacity = 1, options = {}) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const font = '600 28px "Segoe UI", sans-serif';
    const lines = text.split('\n');
    context.font = font;
    canvas.width = Math.ceil(Math.min(1024, Math.max(...lines.map(line => context.measureText(line).width)) + 48));
    canvas.height = 68 + (lines.length - 1) * 34;
    context.font = font;
    const borderless = options.planar || options.kind === 'dimension';
    if (!borderless) {
      context.fillStyle = this.theme.background; context.strokeStyle = color; context.lineWidth = 2;
      context.beginPath(); context.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 11); context.fill(); context.stroke();
      context.fillStyle = color; context.fillRect(12, 15, 4, canvas.height - 30);
    } else {
      context.shadowColor = '#000000'; context.shadowBlur = 4;
    }
    context.fillStyle = '#f1fbff';
    lines.forEach((line, i) => context.fillText(line, 26, 44 + i * 34));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = options.planar
      ? new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ ...transparentSurface,
        map: texture, side: THREE.DoubleSide, toneMapped: false, opacity }))
      : new THREE.Sprite(new THREE.SpriteMaterial({ ...transparentSurface, map: texture,
        depthTest: false, sizeAttenuation: false, toneMapped: false, opacity: Math.max(0.45, opacity) }));
    sprite.renderOrder = options.planar ? renderLayers.guides : renderLayers.labels;
    if (options.planar) {
      sprite.rotation.set(-Math.PI / 2, 0, options.angle ?? 0);
      sprite.scale.set(width, width * canvas.height / canvas.width, 1);
    } else sprite.layers.set(1);
    sprite.position.set(...position);
    sprite.userData.label = { text, width, aspect: canvas.width / canvas.height, baseOpacity: Math.max(0.45, opacity), borderless, ...options };
    this.content.add(sprite); this.labels.push(sprite);
    return sprite;
  }

  regionFrame(region, color, text, opacity = 0.4) {
    const box = new THREE.BoxGeometry(...region.size), geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    const outline = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ ...transparentSurface, color, opacity }));
    outline.renderOrder = renderLayers.guides;
    outline.position.set(...region.position); outline.userData.guide = region.kind;
    this.content.add(outline);
    if (text) {
      const label = this.label(text, [region.position[0], region.top + 2, region.position[2]], color,
        Math.max(region.kind === 'rootRegion' ? 9 : 20, Math.min(48, region.size[0] * 1.5)), Math.min(1, opacity * 3));
      if (label) label.userData.regionId = region.id;
    }
  }

  regionBase(region, color, settings, ghost) {
    const bottom = region.position[1] - region.size[1] / 2;
    let plaqueDepth = 0;
    if (settings.floorLabels !== false) for (const sign of [1, -1]) {
      const plaque = this.label(regionFloorText(region),
        [region.position[0], bottom - 0.15, region.position[2] + sign * (region.size[2] / 2 + 0.6)],
        color, Math.min(48, region.size[0] * 0.88), 0.9,
        { planar: true, angle: sign === 1 ? 0 : Math.PI, kind: 'floor', minPixels: 45 });
      if (plaque) {
        plaqueDepth = Math.max(plaqueDepth, plaque.scale.y + 0.6);
        plaque.position.z += sign * plaque.scale.y / 2;
        plaque.userData.regionId = region.id; plaque.userData.contextLabel = ghost;
      }
    }
    if (settings.dimensions === false) return;
    const rulers = regionRulers(region, plaqueDepth), positions = [], colors = [];
    const colorValue = new THREE.Color(), transform = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0);
    const material = new THREE.MeshBasicMaterial({ ...transparentSurface, opacity: ghost ? this.contextOpacity : 0.5 });
    const heads = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6), material, 6);
    rulers.forEach((ruler, i) => {
      colorValue.set(ruler.color);
      positions.push(...ruler.start, ...ruler.end);
      colors.push(...colorValue.toArray(), ...colorValue.toArray());
      const direction = new THREE.Vector3().subVectors(new THREE.Vector3(...ruler.end), new THREE.Vector3(...ruler.start)).normalize();
      const length = Math.min(0.8, ruler.length * 0.06);
      for (const [side, point] of [[-1, ruler.start], [1, ruler.end]]) {
        const outward = direction.clone().multiplyScalar(side);
        transform.position.set(...point).addScaledVector(outward, -length / 2);
        transform.quaternion.setFromUnitVectors(up, outward); transform.scale.set(length * 0.28, length, length * 0.28);
        transform.updateMatrix(); const instance = i * 2 + (side === 1 ? 1 : 0);
        heads.setMatrixAt(instance, transform.matrix); heads.setColorAt(instance, colorValue);
      }
    });
    const lineMaterial = new THREE.LineBasicMaterial({ ...transparentSurface, vertexColors: true, opacity: ghost ? this.contextOpacity : 0.4 });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      .setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)), lineMaterial);
    const group = new THREE.Group();
    group.userData.regionRulers = { region: region.id, units: 'visual axes, not byte distances', rulers };
    heads.renderOrder = lines.renderOrder = renderLayers.guides;
    heads.computeBoundingSphere(); group.add(lines, heads); this.content.add(group);
    if (ghost) this.contextMaterials.push(material, lineMaterial);
    this.regionGuideMaterials.push({ materials: [material, lineMaterial], position: new THREE.Vector3(...region.position), ghost, regionId: region.id });
  }

  gapOutlines(gaps) {
    const cube = new THREE.BoxGeometry(1, 1, 1), edges = new THREE.EdgesGeometry(cube);
    cube.dispose();
    const template = edges.attributes.position.array;
    for (const kind of ['free', 'unrepresented']) {
      const items = gaps.filter(gap => gap.kind === kind);
      if (!items.length) continue;
      const positions = new Float32Array(items.length * template.length);
      let cursor = 0;
      for (const gap of items) for (let i = 0; i < template.length; i += 3) {
        positions[cursor++] = gap.position[0] + template[i] * gap.side;
        positions[cursor++] = gap.position[1] + template[i + 1] * gap.side;
        positions[cursor++] = gap.position[2] + template[i + 2] * gap.side;
      }
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = kind === 'free'
        ? new THREE.LineBasicMaterial({ ...transparentSurface, color: '#a5adb8', opacity: 0.35 })
        : new THREE.LineDashedMaterial({ ...transparentSurface, color: '#737d8b', opacity: 0.16, dashSize: 0.35, gapSize: 0.25 });
      const lines = new THREE.LineSegments(geometry, material);
      if (kind === 'unrepresented') lines.computeLineDistances();
      lines.userData.gapKind = kind; lines.userData.gapCount = items.length;
      lines.renderOrder = renderLayers.guides; this.content.add(lines);
    }
    edges.dispose();
  }

  drawCards(data, settings) {
    let shown = 0, dirty = 0, unavailable = 0;
    for (const info of data.cardRegions ?? []) {
      if (info.status === 'not-applicable' || info.status === 'decoded' && info.totalCount === 0) continue;
      const region = this.layout.segments.get(info.segment);
      if (!region || settings.heap !== 'all' && heapKind(region.value) !== settings.heap) continue;
      const tableSelected = settings.cardSelection?.segments?.has(info.segment) ?? false;
      const ghost = this.focusActive && settings.cardSelection?.info?.segment !== info.segment && !tableSelected;
      const count = info.count + (info.totalCount > info.count ? 1 : 0) || 1;
      const columns = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns);
      const pixels = new Uint8Array(columns * rows * 4);
      for (let i = 0; i < count; i++) {
        const enabled = cardState(info, i);
        const selected = tableSelected && enabled || settings.cardSelection?.info?.segment === info.segment && settings.cardSelection.index === i;
        const color = new THREE.Color(selected ? '#ffffff' : enabled === null ? '#7a7c87' : enabled ? '#f5c05c' : '#294858');
        color.convertLinearToSRGB();
        const offset = i * 4;
        pixels[offset] = Math.round(color.r * 255); pixels[offset + 1] = Math.round(color.g * 255);
        pixels[offset + 2] = Math.round(color.b * 255); pixels[offset + 3] = 255;
        if (enabled) dirty++;
      }
      if (info.status !== 'decoded') unavailable++;
      shown += info.count;
      const texture = new THREE.DataTexture(pixels, columns, rows, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace; texture.magFilter = texture.minFilter = THREE.NearestFilter; texture.needsUpdate = true;
      const material = new THREE.MeshBasicMaterial({ ...transparentSurface, map: texture, opacity: ghost ? this.contextOpacity : 0.7, side: THREE.DoubleSide });
      if (ghost) this.contextMaterials.push(material);
      material.onBeforeCompile = shader => {
        shader.uniforms.cardGrid = { value: new THREE.Vector2(columns, rows) };
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec2 cardGrid;')
          .replace('#include <map_fragment>', `#include <map_fragment>
vec2 cardCell = vMapUv * cardGrid;
vec2 edgeDistance = abs(fract(cardCell) - 0.5);
float gridLine = max(smoothstep(0.45, 0.5, edgeDistance.x), smoothstep(0.45, 0.5, edgeDistance.y));
float gridVisible = 1.0 - smoothstep(0.2, 0.65, max(fwidth(cardCell.x), fwidth(cardCell.y)));
diffuseColor.rgb *= 1.0 - gridLine * gridVisible * 0.65;`);
      };
      material.customProgramCacheKey = () => 'gc-card-grid';
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(region.size[0] * 0.88, region.size[2] * 0.88), material);
      plane.rotation.x = -Math.PI / 2; plane.position.set(region.position[0], region.top + 5, region.position[2]);
      plane.renderOrder = renderLayers.glass;
      plane.userData.cardMap = { info, columns, rows, displayCount: count, context: Boolean(ghost) };
      this.content.add(plane);
      if (!ghost) this.pickables.push(plane);
      const label = this.label(`Cards / ${region.physicalLabel}\n${info.count ? `${info.dirtyRuns.reduce((n, run) => n + run.count, 0)} dirty / ${info.count}` : info.status}`,
        [plane.position.x, plane.position.y + 2, plane.position.z], '#e6bf75', Math.min(35, region.size[0]));
      if (label) label.userData.contextLabel = ghost;
      if (info.count && ['decoded', 'truncated'].includes(info.status)) {
        const toggle = this.label(`${tableSelected ? '[x]' : '[ ]'} Scan Gen ${settings.cardGeneration ?? 0}`,
          [region.position[0] - region.size[0] * 0.44, plane.position.y + 2, region.position[2] + region.size[2] * 0.44],
          tableSelected ? '#fff0a8' : '#e6bf75', Math.min(24, region.size[0]), 0.95,
          { kind: 'cardTableToggle', minPixels: 0, maxPixels: 150, cullBelowPixels: 55 });
        if (toggle) {
          toggle.userData.item = { kind: 'cardTableToggle', value: { segment: info.segment, generation: settings.cardGeneration ?? 0, active: tableSelected } };
          toggle.userData.regionId = region.id;
          this.uiPickables.push(toggle);
        }
      }
    }
    return { shown, dirty, unavailable };
  }

  updateLabels(now = performance.now()) {
    if (!this.camera || !this.labels?.length || now - this.lastLabels < 100) return;
    this.lastLabels = now;
    this.camera.updateMatrixWorld();
    const pixelsPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const candidates = [];
    for (const sprite of this.labels) {
      const view = sprite.position.clone().applyMatrix4(this.camera.matrixWorldInverse);
      const projected = sprite.position.clone().project(this.camera);
      sprite.visible = false;
      if (view.z >= -this.camera.near || projected.z < -1 || projected.z > 1 ||
        Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.1) continue;
      const label = sprite.userData.label;
      if (label.planar) {
        orientPlanarLabel(sprite, this.camera);
        sprite.updateMatrixWorld();
        const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]
          .map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(sprite.matrixWorld).project(this.camera));
        if (corners.some(point => point.z < -1 || point.z > 1)) continue;
        const xs = corners.map(point => (point.x + 1) * innerWidth / 2), ys = corners.map(point => (1 - point.y) * innerHeight / 2);
        const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
        if (width < label.minPixels || height < 8) continue;
        candidates.push({ sprite, depth: -view.z, distance: view.length(), x: Math.min(...xs), y: Math.min(...ys), width, height,
          polygon: xs.map((x, i) => [x, ys[i]]) });
        continue;
      }
      const width = THREE.MathUtils.clamp(label.width * pixelsPerUnit / -view.z, label.minPixels ?? 110, label.maxPixels ?? 230);
      if (width < (label.cullBelowPixels ?? 0)) continue;
      const height = width / label.aspect;
      sprite.scale.set(width / pixelsPerUnit, height / pixelsPerUnit, 1);
      const x = (projected.x + 1) * innerWidth / 2, y = (1 - projected.y) * innerHeight / 2;
      candidates.push({ sprite, depth: -view.z, distance: view.length(), x: x - width / 2, y: y - height / 2, width, height });
    }
    candidates.sort((a, b) => Number(b.sprite.userData.label.kind === 'cardTableToggle') - Number(a.sprite.userData.label.kind === 'cardTableToggle') ||
      Number(b.sprite.userData.item?.value.active ?? false) - Number(a.sprite.userData.item?.value.active ?? false) ||
      Number(b.sprite.userData.regionId === this.activeLabelRegion) -
      Number(a.sprite.userData.regionId === this.activeLabelRegion) ||
      Number(a.sprite.userData.label.kind === 'dimension') - Number(b.sprite.userData.label.kind === 'dimension') || a.depth - b.depth);
    const placed = [];
    const nearest = candidates.reduce((minimum, candidate) => Math.min(minimum, candidate.distance), Infinity);
    const extent = Math.hypot(...(this.layout?.size ?? [200, 200, 200]));
    for (const guide of this.regionGuideMaterials ?? []) {
      const alpha = guide.ghost ? this.contextOpacity : labelOpacity(this.camera.position.distanceTo(guide.position),
        nearest, extent, 1, guide.regionId === this.activeLabelRegion) * 0.45;
      for (const material of guide.materials) material.opacity = alpha;
    }
    for (const candidate of candidates) {
      if (placed.some(other => labelsOverlap(candidate, other))) continue;
      const label = candidate.sprite.userData.label;
      const alpha = candidate.sprite.userData.contextLabel ? this.contextOpacity :
        labelOpacity(candidate.distance, nearest, extent, label.baseOpacity ?? 1,
          candidate.sprite.userData.regionId === this.activeLabelRegion || candidate.sprite.userData.item?.value.active === true);
      if (alpha === 0) continue;
      candidate.sprite.material.opacity = label.opacityReady
        ? THREE.MathUtils.lerp(candidate.sprite.material.opacity, alpha, 0.35) : alpha;
      label.opacityReady = true;
      candidate.sprite.visible = true; placed.push(candidate);
    }
  }

  setContextOpacity(opacity) {
    this.contextOpacity = THREE.MathUtils.clamp(opacity, 0, 0.5);
    for (const material of this.contextMaterials ?? []) material.opacity = this.contextOpacity;
  }

  lines(positions, color, opacity = 0.35) {
    if (!positions.length) return;
    const geometry = new LineSegmentsGeometry().setPositions(positions);
    const material = new LineMaterial({ ...transparentSurface, color, opacity, linewidth: this.referenceWidth.value * 2 });
    material.color.multiplyScalar(this.theme.linkIntensity ?? 1);
    this.wideLineMaterials.push(material);
    const lines = new LineSegments2(geometry, material);
    lines.userData.referenceGlow = true;
    lines.renderOrder = renderLayers.connections; this.content.add(lines);
  }

  mark(position, size = [1, 1, 1], kind = 'object') {
    for (const child of this.selection.children) { child.geometry.dispose(); child.material.dispose(); }
    this.selection.clear();
    this.selectedPosition = position; this.selectedSize = size; this.selectionKind = kind;
    if (!position) return;
    if (kind === 'site') {
      const radius = Math.max(...size) * 0.7;
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius * 1.13, 32),
        new THREE.MeshBasicMaterial({ ...transparentSurface, color: '#ffffff', depthTest: false, toneMapped: false, side: THREE.DoubleSide }));
      ring.position.set(...position); ring.renderOrder = renderLayers.selection; ring.userData.billboard = true;
      ring.layers.set(1);
      this.selection.add(ring); return;
    }
    const box = new THREE.BoxGeometry(...size.map(v => v + 0.25));
    const geometry = new THREE.EdgesGeometry(box); box.dispose();
    const outline = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    outline.renderOrder = renderLayers.selection;
    outline.layers.set(1);
    outline.position.set(...position); this.selection.add(outline);
  }

  siteMarkers(items, ghost, kind) {
    if (!items.length) return;
    const partitions = items.length > 10000 ? Map.groupBy(items, item => item.regionId).values() : [items];
    for (const batch of partitions) {
      const material = new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.28, metalness: 0.22,
        transparent: ghost, opacity: ghost ? this.contextOpacity : 1, depthWrite: !ghost,
      });
      if (ghost) this.contextMaterials.push(material);
      const geometry = new THREE.SphereGeometry(1, kind === 'root' ? 10 : 8, kind === 'root' ? 6 : 4);
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      const transform = new THREE.Object3D(), color = new THREE.Color();
      batch.forEach((item, i) => {
        transform.position.set(...item.position); transform.scale.setScalar(item.size[0] / 2); transform.updateMatrix();
        mesh.setMatrixAt(i, transform.matrix);
        color.set(item.key === this.activeSiteKey ? '#ffffff' : item.color);
        mesh.setColorAt(i, color);
        this.siteItems.set(item.key, item);
      });
      mesh.userData.items = batch;
      mesh.userData.siteKind = kind;
      if (kind === 'slot') mesh.userData.arraySlots = batch.map(item => ({ object: item.value.edge.source, address: item.value.address, position: item.position }));
      if (ghost) mesh.renderOrder = renderLayers.glass;
      mesh.computeBoundingSphere(); this.content.add(mesh); this.sitePickables.push(mesh);
      if (!ghost && kind === 'root') this.pickables.push(mesh);
    }
  }

  drawReferenceArrows(records, mode, colors, groups) {
    let count = 0;
    const bundles = new Map(groups.map(group => [group.key, group]));
    for (let start = 0; start < records.length; start += 5000) {
      const arrows = [];
      for (const record of records.slice(start, start + 5000)) {
        const group = bundles.get(`${record.source.region.id}>${record.target.region.id}:${record.kind}`);
        for (const arrow of referenceArrows(record, mode)) {
          const source = arrow.role === 'outgoing', endpoint = source ? record.source : record.target;
          const branch = (source ? group?.inlets : group?.outlets)?.get(endpoint.anchorId ?? endpoint.id ?? endpoint.position.join(','));
          const radius = arrow.internal ? arrow.length * 0.28 :
            Math.max(arrow.length * 0.34, pipeRadius(branch?.count ?? 1) * 1.65);
          arrows.push({ ...arrow, radius, kind: record.kind });
        }
      }
      if (!arrows.length) continue;
      const material = applyTubeWidth(new THREE.MeshStandardMaterial({
        ...transparentSurface, roughness: 0.38, metalness: 0.15, emissive: '#ffffff', emissiveIntensity: 0.06,
      }), this.referenceWidth);
      const mesh = new THREE.InstancedMesh(referenceArrowGeometry(), material, arrows.length);
      const transform = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), color = new THREE.Color();
      const tint = new THREE.Color('#ffffff');
      arrows.forEach((arrow, i) => {
        transform.position.set(...arrow.position);
        transform.quaternion.setFromUnitVectors(up, direction.set(...arrow.direction));
        transform.scale.set(arrow.radius, arrow.length, arrow.radius);
        transform.updateMatrix(); mesh.setMatrixAt(i, transform.matrix); mesh.setColorAt(i, color.set(colors[arrow.kind]).lerp(tint, 0.3));
      });
      mesh.userData.referenceArrows = { count: arrows.length, references: Math.min(5000, records.length - start) };
      mesh.userData.referenceArrows.internal = arrows.reduce((count, arrow) => count + Number(arrow.internal), 0);
      mesh.renderOrder = renderLayers.signals; mesh.computeBoundingSphere();
      mesh.boundingSphere.radius += Math.max(...arrows.map(arrow => arrow.radius)) * 2;
      this.content.add(mesh);
      count += arrows.length;
    }
    return count;
  }

  streams(records, detailed, mode = 'bundled') {
    const direct = records.filter(record => unbundledReference(record, mode));
    const groups = bundleReferences(records.filter(record => !unbundledReference(record, mode)));
    this.referenceBounds = new THREE.Box3();
    for (const group of groups)
      for (const points of [group.trunk, ...[...group.inlets.values(), ...group.outlets.values()].map(branch => branch.points)])
        for (const point of points) this.referenceBounds.expandByPoint(new THREE.Vector3(...point));
    this.streamStats = { references: records.length, trunks: groups.length, directLinks: direct.length,
      localLinks: direct.filter(record => record.source.region.id === record.target.region.id).length,
      inlets: groups.reduce((n, group) => n + group.inlets.size, 0), outlets: groups.reduce((n, group) => n + group.outlets.size, 0) };
    this.streamStats.representedReferences = direct.length + groups.reduce((count, group) => count + group.count, 0);
    const curveSegments = records.length > 100000 ? 4 : records.length > 20000 ? 8 : 24;
    this.streamStats.curveSegments = curveSegments;
    const colors = { ...this.theme.streams, finalization: '#ead371', fReachable: '#ffad89' };
    this.streamStats.arrows = detailed ? this.drawReferenceArrows(records, mode, colors, groups) : 0;
    const tubes = new Map(), filaments = new Map();
    const branchCurve = points => new THREE.CubicBezierCurve3(...points.map(p => new THREE.Vector3(...p)));
    const trunkCurve = branchCurve;
    const addTube = (curve, radius, kind, segments = 20, trunk = false) => {
      const key = this.theme.semantic ? `${kind}:${trunk ? 'trunk' : 'branch'}` : kind;
      if (!tubes.has(key)) tubes.set(key, { kind, trunk, parts: [] });
      const geometry = new THREE.TubeGeometry(curve, segments, radius, 5, false);
      tubes.get(key).parts.push(addTubeCenters(geometry, curve, segments));
    };
    const addFilament = (curve, kind) => {
      if (!filaments.has(kind)) filaments.set(kind, new CurveLineBuffer());
      filaments.get(kind).add(curve, curveSegments);
    };
    let trunkCount = 0, branchCount = 0;
    for (const group of groups) {
      const trunk = trunkCurve(group.trunk);
      if (trunkCount++ < 240) addTube(trunk, pipeRadius(group.count), group.kind, 20, true);
      else addFilament(trunk, group.kind);
      for (const branch of [...group.inlets.values(), ...group.outlets.values()]) {
        const curve = branchCurve(branch.points);
        if (detailed && branchCount++ < 500) addTube(curve, pipeRadius(branch.count), group.kind, 24);
        else addFilament(curve, group.kind);
      }
    }
    let directCount = 0;
    for (const record of direct) {
      const points = directReferenceRoute(record.source, record.target), curve = branchCurve(points);
      for (const point of points) this.referenceBounds.expandByPoint(new THREE.Vector3(...point));
      if (directCount++ < 500) addTube(curve, pipeRadius(1), record.kind, 24);
      else addFilament(curve, record.kind);
    }
    for (const { kind, trunk, parts } of tubes.values()) {
      const geometry = mergeGeometries(parts);
      parts.forEach(part => part.dispose());
      const material = applyTubeWidth(new THREE.MeshStandardMaterial({
        ...transparentSurface,
        color: this.theme.semantic ? '#081322' : colors[kind], emissive: colors[kind],
        emissiveIntensity: this.theme.tubeGlow * (this.theme.semantic && !trunk ? 0.65 : 1),
        roughness: 0.4, metalness: 0.15, opacity: this.theme.semantic ? trunk ? 0.8 : 0.42 : detailed ? 0.9 : 0.72,
      }), this.referenceWidth);
      geometry.computeBoundingSphere(); geometry.boundingSphere.radius += 3;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.referenceGlow = true;
      mesh.renderOrder = renderLayers.connections; this.content.add(mesh);
    }
    this.streamStats.lineSegments = 0;
    for (const [kind, buffer] of filaments) {
      this.streamStats.lineSegments += buffer.segmentCount;
      for (const positions of buffer.buffers()) this.lines(positions, colors[kind], this.theme.branchOpacity);
    }
    const ports = new Map();
    for (const group of groups) for (const port of [group.ports.source, group.ports.target]) ports.set(port.id, port);
    for (const port of ports.values()) {
      const radius = Math.min(1.2, Math.max(0.25, Math.min(...port.region.size) * 0.06));
      const collar = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.12, 6, 16),
        new THREE.MeshStandardMaterial({ ...transparentSurface, color: this.theme.generations[port.region.value?.kind] ?? colors.reference,
          emissive: this.theme.bloom ? colors.reference : '#000000', emissiveIntensity: this.theme.bloom ? 1.5 : 0,
          roughness: 0.35, metalness: 0.25, opacity: 0.75 }));
      collar.position.set(...port.junction);
      collar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...port.normal));
      collar.renderOrder = renderLayers.guides;
      collar.userData.routingPort = { id: port.id, face: port.face, position: port.junction, region: port.region.id };
      collar.userData.referenceGlow = true;
      this.content.add(collar);
    }
    this.streamStats.ports = ports.size;
    // Animate actual source/target pairs, not arbitrary combinations of a bundle's endpoints.
    const flowCount = Math.min(records.length, 96);
    const signalRecords = this.theme.goldenPulses ? sampleGoldenReferences(records, mode) :
      Array.from({ length: flowCount }, (_, i) => records[Math.floor(i * records.length / flowCount)]);
    for (let i = 0; i < signalRecords.length; i++) {
      const record = signalRecords[i];
      let curve;
      if (unbundledReference(record, mode)) {
        curve = branchCurve(directReferenceRoute(record.source, record.target));
      } else {
        const key = `${record.source.region.id}>${record.target.region.id}:${record.kind}`;
        const route = referenceRoute(record.source, record.target, key);
        curve = new THREE.CurvePath();
        curve.add(branchCurve(route.inlet)); curve.add(trunkCurve(route.trunk)); curve.add(branchCurve(route.outlet));
      }
      this.flows.push({ curve, source: record.source.id, target: record.target.id, slotAddress: record.source.slotAddress,
        phase: i * 0.173, color: colors[record.kind] });
    }
    if (this.flows.length) {
      const texture = new THREE.DataTexture(signalPixels(this.theme.signalShape), 16, 16, THREE.RGBAFormat);
      texture.magFilter = this.theme.signalShape === 'bit' ? THREE.NearestFilter : THREE.LinearFilter;
      texture.needsUpdate = true;
      if (this.theme.goldenPulses) {
        this.goldenSignals = new GoldenSignals(this.flows, this.theme, texture);
        this.particles = this.goldenSignals.heads;
        this.content.add(this.goldenSignals.heads, this.goldenSignals.trails);
        this.goldenSignals.visible = this.signalsEnabled;
        this.updateSignals(0);
        return groups.length;
      }
      const geometry = new THREE.BufferGeometry();
      const perFlow = this.theme.packets * this.theme.trail;
      const colors = [];
      for (const flow of this.flows) for (let packet = 0; packet < this.theme.packets; packet++)
        for (let tail = 0; tail < this.theme.trail; tail++)
          colors.push(...new THREE.Color(this.theme.semantic && packet % 3 === 0 ? this.theme.streams.strong : flow.color)
            .multiplyScalar((1 - tail / this.theme.trail) ** 2 * (this.theme.linkIntensity ?? 1)).toArray());
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.flows.length * perFlow * 3), 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this.particles = new THREE.Points(geometry, new THREE.PointsMaterial({
        ...transparentSurface,
        size: this.theme.signalSize, sizeAttenuation: false, map: texture, vertexColors: true, transparent: true,
        alphaTest: 0.01, opacity: 0.95, depthWrite: false,
        blending: this.theme.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      this.particles.renderOrder = renderLayers.signals;
      this.particles.userData.referenceGlow = true;
      this.particles.frustumCulled = false; this.content.add(this.particles);
      this.particles.visible = this.signalsEnabled;
      this.updateSignals(0);
    }
    return groups.length;
  }

  show(data, index, settings, selected) {
    this.disposeContent();
    this.setTheme(settings.theme);
    this.setBloom(settings.bloom ?? true);
    this.setAnimation(settings.signals ?? true, settings.signalSpeed ?? 1);
    this.setConnectionWidth(settings.connectionWidth ?? 1.5);
    if (this.data !== data || this.reserved !== settings.reserved || this.physical !== Boolean(settings.physical)) {
      this.layout = layout(data, { reserved: settings.reserved, physical: Boolean(settings.physical) });
      this.reserved = settings.reserved;
      this.physical = Boolean(settings.physical);
    }
    this.data = data; this.index = index;
    this.contextOpacity = settings.contextOpacity ?? 0.05;
    const rootRecords = index.allRoots ?? data.roots;
    const allObjects = settings.budget === 'all', allReferences = settings.referenceBudget === 'all';
    const referenceLimit = allReferences ? Infinity : 6000, rootLimit = allReferences ? Infinity : 4000;
    const site = resolveSite(settings.site, index);
    const batch = settings.selectedObjects?.size ? settings.selectedObjects : null;
    const cardFocus = settings.cardSelection;
    const seeds = batch ?? selected;
    this.activeSiteKey = site?.key ?? null;
    const siteOwner = site?.kind === 'root' ? this.layout.roots.get(site.root.id)?.ownerObject : site?.source;
    const siteSource = site?.kind === 'slot' ? referenceSource(this.layout.objects.get(site.source), site.edge) : null;
    if (siteSource && !siteSource.slotAddress) throw new RangeError('This reference has no valid captured array-slot address.');
    const siteIds = new Set([siteOwner, site?.target].filter(id => index.objects.has(id)));
    const neighborhoodGraph = settings.routes ?? (cardFocus ? {
      ids: new Set([...cardFocus.sources, ...cardFocus.reachable]),
      edges: [...cardFocus.contributing.map(item => item.edge),
        ...[...cardFocus.reachable].flatMap(id => (index.outgoing.get(id) ?? []).filter(edge => cardFocus.reachable.has(edge.target)))],
      limited: false, missing: 0,
    } : site ? {
      ids: siteIds, edges: site.kind === 'slot' ? [site.edge] : [], limited: false,
      missing: index.objects.has(site.target) ? 0 : 1,
    } : seeds ? neighborhood(seeds, index, settings.depth ?? 1,
      allObjects ? data.objects.length : Math.min(settings.budget, 2000),
      allObjects || allReferences ? Infinity : 100000, referenceLimit) : null);
    const explicitSelection = Boolean(selected || site || batch || cardFocus);
    const gcRequested = !explicitSelection && Boolean(settings.highlightGc && settings.reachability);
    const highlightState = settings.highlightState ?? 'unreachable';
    const analysisUnavailable = gcRequested && highlightState === 'unreachable' && !settings.reachability.complete;
    const gcFocus = gcRequested && !analysisUnavailable;
    const gcMatches = gcFocus ? matchingReachability(settings.reachability, Number(settings.gcGeneration ?? 0), highlightState) : null;
    const focusIds = gcFocus ? gcMatches : neighborhoodGraph?.ids;
    const hasSelection = explicitSelection || gcFocus;
    const priorities = batch ? new Set([...batch, ...neighborhoodGraph.ids]) : focusIds;
    const sampled = selectObjects(data, index, settings.budget, settings.heap,
      site ? siteOwner ?? site.target : batch ? batch.values().next().value : selected, priorities);
    const isolated = gcFocus || Boolean(explicitSelection && settings.isolate);
    this.focusActive = isolated;
    const visible = isolated ? sampled.filter(object => focusIds.has(object.id)) : sampled;
    const context = isolated ? sampled.filter(object => !focusIds.has(object.id)) : [];
    const shown = new Set(visible.map(o => o.id));
    const focused = hasSelection ? new Set([...focusIds].filter(id => shown.has(id))) : shown;
    const selectedRoots = settings.routes ? settings.routes.roots.filter(root => !root.permanent && !root.synthetic && focused.has(root.target)) :
      cardFocus ? [] : site ? site.kind === 'root' ? [site.root] : [] : rootRecords.filter(root => focused.has(root.target));
    const activeRootIds = new Set(selectedRoots.map(root => root.id));
    this.activeLabelRegion = site ? site.kind === 'root' ? this.layout.roots.get(site.root.id)?.region.id : siteSource.region.id :
      selected ? this.layout.objects.get(selected)?.region.id : null;
    const bounds = new THREE.Box3();
    const include = region => {
      const center = new THREE.Vector3(...region.position), half = new THREE.Vector3(...region.size).multiplyScalar(0.5);
      bounds.expandByPoint(center.clone().sub(half)); bounds.expandByPoint(center.clone().add(half));
    };
    for (const heap of this.layout.gcHeaps.values()) {
      if (!heap.children.some(region => settings.heap === 'all' || heapKind(region.value) === settings.heap)) continue;
      this.regionFrame(heap, '#a3c5d7',
        `Heap ${heap.value.heap ?? '?'}\n${heap.children.length} regions/segments`, 0.12);
      include(heap);
    }
    let labels = 0;
    const focusedRegions = isolated ? new Set([...focused].map(id => index.objects.get(id).segment)) : null;
    for (const segment of data.segments) {
      if (settings.heap !== 'all' && heapKind(segment) !== settings.heap) continue;
      const p = this.layout.segments.get(segment.id);
      const color = this.theme.generations[segment.kind] ?? '#657b95';
      const label = regionLabel(p, this.physical);
      this.regionFrame(p, color, labels++ < 150 ? label : null, this.physical ? 0.48 : 0.23);
      this.regionBase(p, color, settings, isolated && !focusedRegions.has(segment.id));
      include(p);
    }
    const regionGaps = this.layout.gaps.filter(gap => settings.heap === 'all' || heapKind(gap.region.value) === settings.heap);
    const outlinedGaps = settings.gaps === false ? [] : [...regionGaps].sort((a, b) => b.bytes - a.bytes).slice(0, 5000);
    this.gapOutlines(outlinedGaps);
    const dummy = new THREE.Object3D(), color = new THREE.Color(), selectionTint = new THREE.Color('#ffffff');
    const typeColors = new Map();
    const arrayObjects = visible.filter(object => this.layout.objects.get(object.id).isArray);
    const solidObjects = visible.filter(object => !this.layout.objects.get(object.id).isArray);
    const batches = [];
    for (const [items, ghost, arrays] of [[solidObjects, false, false], [arrayObjects, false, true], [context, true, false]]) {
      const partitions = items.length > 40000 ? Map.groupBy(items, object => object.segment).values() : [items];
      for (const partition of partitions) batches.push([partition, ghost, arrays]);
    }
    for (const [items, ghost, arrays] of batches) {
      if (!items.length) continue;
      const material = new THREE.MeshStandardMaterial({ roughness: this.theme.semantic ? 0.32 : 0.45, metalness: this.theme.semantic ? 0.12 : 0.25,
        transparent: ghost || arrays, opacity: ghost ? this.contextOpacity : 1, depthWrite: !ghost && !arrays,
        emissive: this.theme.objectGlow, emissiveIntensity: this.theme.objectGlowIntensity, wireframe: this.theme.wireframe });
      if (ghost) this.contextMaterials.push(material);
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
      items.forEach((object, i) => {
        dummy.position.set(...this.layout.objectPosition(object));
        dummy.scale.setScalar(this.layout.objectSide(object)); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        if (object.id === selected && !this.theme.semantic) color.set('#ffffff');
        else if ((settings.color ?? 'type') === 'type') {
          if (!typeColors.has(object.type)) typeColors.set(object.type, new THREE.Color(typeColor(object.type, this.theme)));
          color.copy(typeColors.get(object.type));
        }
        else if (settings.color === 'size') sizeColor(object.size, color);
        else color.set(this.theme.generations[object.generation] ?? this.theme.generations.Unknown);
        if (batch?.has(object.id)) color.lerp(selectionTint, 0.45);
        const entry = settings.reachability?.objects.get(object.id);
        const mask = entry?.rootMasks?.[Number(settings.gcGeneration ?? 0)] ?? 0;
        if (settings.color === 'reachability') {
          const first = rootTypes.find(type => mask & type.bit);
          color.set(first?.color ?? (entry?.eligible?.[Number(settings.gcGeneration ?? 0)] ? '#ff6756' : '#8794a8'));
        }
        mesh.setColorAt(i, color);
      });
      mesh.userData.items = items.map(value => ({ kind: 'object', value }));
      mesh.userData.layer = ghost ? 'context' : 'foreground';
      if (ghost || arrays) mesh.renderOrder = renderLayers.glass;
      if (arrays) {
        const alpha = new THREE.InstancedBufferAttribute(new Float32Array(items.length).fill(1), 1);
        mesh.geometry.setAttribute('arrayAlpha', alpha);
        applyArrayAlpha(material);
        const depthMaterial = applyArrayAlpha(new THREE.MeshBasicMaterial({
          colorWrite: false, depthWrite: true, alphaTest: 1, wireframe: this.theme.wireframe,
        }));
        const depth = new THREE.InstancedMesh(mesh.geometry, depthMaterial, items.length);
        depth.instanceMatrix = mesh.instanceMatrix; depth.userData.arrayDepthPrepass = true;
        depth.computeBoundingSphere(); this.content.add(depth);
        this.arrayBatches.push({ mesh, depth, alpha, objects: items.map(object => this.layout.objects.get(object.id)) });
      }
      if (this.theme.semantic) {
        applySemanticSurface(material, mesh.geometry, items.map(object => semanticDescriptor(object, {
          previewsIncluded: Boolean(data.previewsIncluded), referenceCount: index.outgoing.get(object.id)?.length ?? 0,
        })));
      }
      if (settings.color === 'reachability') applyRootStripes(material, mesh.geometry, items.map(object => {
        const entry = settings.reachability?.objects.get(object.id);
        return entry?.rootMasks?.[Number(settings.gcGeneration ?? 0)] ?? 0;
      }));
      mesh.computeBoundingSphere(); this.content.add(mesh);
      if (!ghost) this.pickables.unshift(mesh);
    }
    if (selected && index.objects.has(selected)) {
      const object = index.objects.get(selected);
      this.mark(this.layout.objectPosition(object), Array(3).fill(this.layout.objectSide(object)));
    }

    const records = [];
    let edgeCount = 0, rootCount = 0, unresolvedArraySlots = 0;
    const edges = explicitSelection ? neighborhoodGraph.edges : data.edges;
    const references = selectReferences(edges, shown, referenceLimit);
    if (settings.edges) for (const edge of references.edges) {
      const source = referenceSource(this.layout.objects.get(edge.source), edge);
      if (source.isArray && edge.kind === 'reference' && !source.slotAddress) unresolvedArraySlots++;
      records.push({ source, target: this.layout.objects.get(edge.target), kind: edge.kind, edge });
      edgeCount++;
    }
    for (const region of this.layout.threads.values()) {
      const thread = region.value;
      const threadRoots = rootRecords.filter(root => root.thread === thread.id);
      const ghost = isolated && !threadRoots.some(root => activeRootIds.has(root.id));
      const material = new THREE.MeshStandardMaterial({ ...transparentSurface, color: thread.finalizer ? '#e1b56f' : '#426c7d',
        opacity: ghost ? this.contextOpacity : 0.25, depthWrite: false });
      if (ghost) this.contextMaterials.push(material);
      const box = new THREE.Mesh(new THREE.BoxGeometry(...region.size), material);
      box.renderOrder = renderLayers.glass;
      box.position.set(...region.position);
      box.userData.item = { kind: 'thread', value: thread, position: region.position, size: region.size };
      this.content.add(box);
      if (!ghost) this.pickables.push(box);
      include(region);
      this.regionFrame(region, '#90cdd8', `STACK t${thread.osId ?? thread.id} / ${threadRoots.length} roots`, ghost ? 0.06 : 0.45);
    }
    if (settings.finalization !== false) for (const region of this.layout.finalizers.values()) {
      const ghost = isolated && !selectedRoots.some(root => this.layout.roots.get(root.id)?.region.id === region.id);
      const ready = region.value.phase === 'ready', color = ready ? '#ffad89' : '#e9cf77';
      const material = new THREE.MeshStandardMaterial({ ...transparentSurface, color, wireframe: region.empty,
        opacity: ghost ? this.contextOpacity : region.empty ? 0.5 : 0.18, roughness: 0.55 });
      if (ghost) this.contextMaterials.push(material);
      const box = new THREE.Mesh(new THREE.BoxGeometry(...region.size), material);
      box.position.set(...region.position); box.renderOrder = renderLayers.glass;
      box.userData.item = { kind: 'finalizerQueue', value: region.value, position: region.position, size: region.size };
      box.userData.context = ghost;
      this.content.add(box); if (!ghost) this.pickables.push(box); include(region);
      this.regionFrame(region, color, `${region.value.title} / Heap ${region.value.heap}\n${region.empty ? 'empty (0 slots)' : `${region.value.entries.length} captured slots`}`, 0.35);
      const label = this.labels.at(-1);
      if (label?.userData.regionId === region.id) label.userData.contextLabel = ghost;
    }
    for (const region of this.layout.rootRegions.values()) {
      const active = !isolated || region.value.roots.some(root => activeRootIds.has(root.id));
      const label = region.start ? `ROOT SLOTS / ${region.value.roots.length}` : 'UNLOCATED ROOTS';
      if (settings.roots) this.regionFrame(region, '#d4b17d', label, active ? 0.5 : 0.05);
      include(region);
    }
    if (settings.roots) {
      const prioritized = [...selectedRoots, ...rootRecords.filter(root => !activeRootIds.has(root.id))].slice(0, allReferences ? rootRecords.length : 10000);
      for (const ghost of [false, true]) {
        const roots = prioritized.filter(root => (isolated && !activeRootIds.has(root.id)) === ghost);
        this.siteMarkers(roots.map(root => {
          const location = this.layout.roots.get(root.id);
          const owner = this.layout.objects.get(location.ownerObject);
          const spacing = owner?.isArray && owner.pointerSize
            ? owner.side * 0.9 / Math.ceil(Math.cbrt(Math.ceil(owner.bytes / owner.pointerSize)))
            : location.region.kind === 'finalizerQueue' ? location.region.side / Math.ceil(Math.cbrt(location.region.bytes / location.region.pointerSize))
            : Math.min(...location.region.size) / 16;
          const diameter = Math.max(0.08, Math.min(0.5, spacing * 0.65));
          return { kind: 'root', value: root, site: { kind: 'root', id: root.id }, key: `root:${root.id}`,
            position: location.position, size: [diameter, diameter, diameter], placement: location.placement,
            regionId: location.region.id, color: location.region.value.phase === 'ready' ? '#ffad89' :
              root.finalization || /Finaliz/.test(root.kind) ? '#ead371' : root.strong ? this.theme.streams.strong : this.theme.streams.weak };
        }), ghost, 'root');
      }
      const roots = hasSelection ? selectedRoots : rootRecords;
      for (const root of roots) {
        if (rootCount >= rootLimit) break;
        if (!shown.has(root.target)) continue;
        const source = this.layout.roots.get(root.id);
        if (source) {
          records.push({ source, target: this.layout.objects.get(root.target), kind: source.region.value.phase === 'ready' ? 'fReachable' :
            root.finalization ? 'finalization' : root.strong ? 'strong' : 'weak' });
          rootCount++;
        }
      }
    }
    const cardStats = settings.cards ? this.drawCards(data, settings) : { shown: 0, dirty: 0, unavailable: 0 };
    let nativeCount = 0;
    if (settings.native) {
      const areas = this.layout.native.slice(0, 5000);
      nativeCount = areas.length;
      const material = new THREE.MeshStandardMaterial({ ...transparentSurface, opacity: isolated ? this.contextOpacity : 0.32, roughness: 0.7 });
      if (isolated) this.contextMaterials.push(material);
      const nativeMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, areas.length);
      nativeMesh.renderOrder = renderLayers.glass;
      areas.forEach((region, i) => {
        const area = region.value;
        dummy.position.set(...region.position);
        dummy.scale.set(...region.size); dummy.updateMatrix();
        nativeMesh.setMatrixAt(i, dummy.matrix);
        color.set(this.theme.semantic ? semanticMaterials.native.color :
          area.owners.some(o => o.includes('GC ')) ? '#50638b' : area.kind === 'image' ? '#688f88' : area.state === 'reserved' ? '#525363' : '#9e7965');
        nativeMesh.setColorAt(i, color);
        include(region);
      });
      nativeMesh.userData.items = areas.map(region => ({ kind: 'native', value: region.value, position: region.position, size: region.size }));
      nativeMesh.computeBoundingSphere(); this.content.add(nativeMesh);
      if (!isolated) this.pickables.push(nativeMesh);
    }
    const slotRecords = new Map(records.filter(record => record.source.slotAddress).map(record => [record.source.anchorId, record]));
    if (site && settings.edges && siteOwner) {
      for (const edge of (index.outgoing.get(siteOwner) ?? []).slice(0, referenceLimit)) {
        const source = referenceSource(this.layout.objects.get(siteOwner), edge);
        if (source.slotAddress) slotRecords.set(source.anchorId, { source, edge });
      }
    }
    const slots = [...slotRecords.values()].map(record => {
        const slot = record.source;
        const columns = Math.ceil(Math.cbrt(Math.ceil(slot.bytes / slot.pointerSize)));
        const diameter = Math.max(0.08, Math.min(0.32, slot.side * 0.9 / columns * 0.32));
        const selection = { kind: 'slot', edge: record.edge };
        return { kind: 'slot', value: { edge: record.edge, address: slot.slotAddress }, site: selection,
          key: siteKey(selection), position: slot.anchor, size: [diameter, diameter, diameter],
          regionId: slot.region.id, color: this.theme.streams.reference };
    });
    for (const ghost of [false, true]) {
      const items = slots.filter(item => Boolean(site && item.key !== site.key) === ghost);
      this.siteMarkers(items, ghost, 'slot');
    }
    const bundles = this.streams(records, hasSelection, settings.linkMode);
    this.selectedObjectBounds = new THREE.Box3();
    let selectedCount = 0;
    for (const id of batch ?? []) {
      if (!shown.has(id)) continue;
      const object = this.layout.objects.get(id), center = new THREE.Vector3(...object.position);
      const half = new THREE.Vector3().setScalar(object.side / 2);
      this.selectedObjectBounds.expandByPoint(center.clone().sub(half));
      this.selectedObjectBounds.expandByPoint(center.clone().add(half));
      selectedCount++;
    }
    if (batch && !this.selectedObjectBounds.isEmpty())
      this.mark(this.selectedObjectBounds.getCenter(new THREE.Vector3()).toArray(), this.selectedObjectBounds.getSize(new THREE.Vector3()).toArray());
    if (site) {
      const marker = this.siteItems.get(site.key);
      const position = marker?.position ?? (site.kind === 'root' ? this.layout.roots.get(site.root.id).position : siteSource.anchor);
      this.mark(position, marker?.size ?? [0.2, 0.2, 0.2], 'site');
    }
    this.updateArrayTransparency();
    this.updateLabels();
    this.bounds = bounds;
    this.neighborhoodBounds = this.referenceBounds.clone();
    for (const id of focused) {
      const object = this.layout.objects.get(id), half = new THREE.Vector3().setScalar(object.side / 2);
      const center = new THREE.Vector3(...object.position);
      this.neighborhoodBounds.expandByPoint(center.clone().sub(half));
      this.neighborhoodBounds.expandByPoint(center.clone().add(half));
    }
    return { visible: visible.length, context: context.length, edges: edgeCount, roots: rootCount, native: nativeCount,
      nativeTotal: this.layout.native.length, bundles, references, neighborhood: neighborhoodGraph,
      localLinks: this.streamStats.localLinks, arraySlots: slots.length, unresolvedArraySlots,
      allObjects, allReferences, curveSegments: this.streamStats.curveSegments, site, selectedCount, cardStats, rootRecords: rootRecords.length,
      analysisFocus: gcFocus, analysisUnavailable, analysisMatches: gcMatches?.size ?? 0, analysisShown: gcFocus ? visible.length : 0,
      arrows: this.streamStats.arrows,
      physical: this.physical, physicalRanges: this.layout.segments.size, gcHeapContainers: this.layout.gcHeaps.size,
      gaps: { total: regionGaps.length, outlined: outlinedGaps.length,
        freeBytes: regionGaps.reduce((sum, gap) => sum + (gap.kind === 'free' ? gap.bytes : 0), 0),
        unrepresentedBytes: regionGaps.reduce((sum, gap) => sum + (gap.kind === 'unrepresented' ? gap.bytes : 0), 0) } };
  }

  overview(bounds = this.bounds) {
    if (!bounds || bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const distance = Math.max(35, size.length() * 0.85);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(distance * 0.38, distance * 0.8, distance));
    this.camera.lookAt(center);
    this.lastLabels = -Infinity; this.updateLabels();
  }

  focus(position, size = this.selectedSize ?? [1, 1, 1]) {
    const distance = Math.max(this.selectionKind === 'site' ? 1 : 7, ...size) * 2;
    this.orbit.target.set(...position);
    this.camera.position.set(position[0] + distance * 0.5, position[1] + distance * 0.6, position[2] + distance);
    this.camera.lookAt(this.orbit.target);
    this.speed = Math.max(8, distance * 1.5);
    this.lastLabels = -Infinity; this.updateLabels();
  }

  advanceFlight(delta) {
    const mode = this.flightSpeedMode();
    const step = delta * this.speed * (mode === 'fast' ? 4 : mode === 'slow' ? 0.1 : 1);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const movement = forward.multiplyScalar(Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')))
      .addScaledVector(right, Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')));
    movement.y += Number(this.keys.has('KeyE')) - Number(this.keys.has('KeyQ'));
    if (movement.lengthSq() > 1) movement.normalize();
    this.camera.position.addScaledVector(movement, step);
  }

  advanceOrbit(delta) {
    if (this.flight?.isLocked) return;
    const horizontal = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const vertical = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const rotation = Number(this.keys.has('KeyQ')) - Number(this.keys.has('KeyE'));
    if (!horizontal && !vertical && !rotation) return;
    const distance = this.camera.position.distanceTo(this.orbit.target);
    const pan = new THREE.Vector3(horizontal, vertical, 0);
    if (pan.lengthSq() > 1) pan.normalize();
    pan.applyQuaternion(this.camera.quaternion).multiplyScalar(Math.max(1, distance) * delta * 0.5);
    this.camera.position.add(pan); this.orbit.target.add(pan);
    if (rotation) {
      const offset = this.camera.position.clone().sub(this.orbit.target)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation * delta * 0.9);
      this.camera.position.copy(this.orbit.target).add(offset); this.camera.lookAt(this.orbit.target);
    }
    return true;
  }

  updateArrayTransparency() {
    if (!this.camera) return;
    const cameraPosition = this.camera.position.toArray();
    for (const batch of this.arrayBatches ?? []) {
      let changed = false;
      batch.objects.forEach((object, i) => {
        const alpha = Math.fround(arrayOpacity(cameraPosition, object));
        if (batch.alpha.array[i] !== alpha) { batch.alpha.array[i] = alpha; changed = true; }
      });
      if (changed) batch.alpha.needsUpdate = true;
    }
  }

  updateSignals(delta) {
    if (!this.particles || !this.signalsEnabled) return;
    this.signalTime = (this.signalTime ?? 0) + delta * this.theme.signalSpeed * this.signalSpeed;
    if (this.goldenSignals) {
      this.goldenSignals.update(this.signalTime, this.camera, typeof innerHeight === 'number' ? innerHeight : 1000);
      return;
    }
    const positions = this.particles.geometry.attributes.position;
    let index = 0;
    for (const flow of this.flows) for (let packet = 0; packet < this.theme.packets; packet++)
      for (let tail = 0; tail < this.theme.trail; tail++) {
        const progress = ((this.signalTime + flow.phase + packet / this.theme.packets - tail * 0.012) % 1 + 1) % 1;
        const point = flow.curve.getPoint(progress);
        positions.setXYZ(index++, point.x, point.y, point.z);
      }
    positions.needsUpdate = true;
  }

  frame() {
    const delta = Math.min(this.clock.getDelta(), 0.08);
    if (this.flight.isLocked) this.advanceFlight(delta);
    else {
      const moved = this.advanceOrbit(delta); this.orbit.update();
      if (moved && this.lastCursor && performance.now() - this.lastHover >= 100) {
        this.lastHover = performance.now(); this.onHover(this.pick(this.lastCursor), this.lastCursor);
      }
    }
    for (const child of this.selection.children) if (child.userData.billboard) child.quaternion.copy(this.camera.quaternion);
    this.updateArrayTransparency();
    this.updateSignals(delta);
    this.updateFlightHover(performance.now());
    this.updateLabels();
    if (this.composer) {
      const mask = this.camera.layers.mask, clear = this.renderer.autoClear, background = this.scene.background;
      try {
        this.camera.layers.set(0);
        this.composer.render(delta);
        this.camera.layers.set(1); this.renderer.autoClear = false; this.scene.background = null;
        this.renderer.render(this.scene, this.camera);
      } finally {
        this.camera.layers.mask = mask; this.renderer.autoClear = clear; this.scene.background = background;
      }
    } else this.renderer.render(this.scene, this.camera);
  }
}
