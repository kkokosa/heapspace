import { palette } from './graph.js';
import { semanticCategory, semanticMaterials } from './semantic-materials.js';
import { Color } from 'three';

export const themes = {
  atlas: {
    name: 'Atlas', background: '#071019', grid: ['#244453', '#122633'], generations: palette,
    typeColors: ['#69c9be', '#7eace0', '#a393dd', '#cb96bb', '#cfb181', '#94bd95'],
    objectGlow: '#000000', objectGlowIntensity: 0, wireframe: false,
    streams: { reference: '#68cbd9', dependent: '#ffb85e', strong: '#f6c780', weak: '#c887a4' },
    tubeGlow: 0.35, branchOpacity: 0.42, signalSize: 5, packets: 3, trail: 4, signalSpeed: 0.13,
    signalShape: 'dot', additive: false,
  },
  matrix: {
    name: 'Matrix', background: '#010904', grid: ['#268946', '#0b3019'],
    typeColors: ['#42f58a', '#8bdd63', '#25c999', '#bfdc75', '#66d6b3', '#66ac54'],
    generations: { Generation0: '#39ff88', Generation1: '#bcff63', Generation2: '#24b87f',
      Large: '#e4ffad', Pinned: '#74dfcd', Frozen: '#e3fff0', Unknown: '#718c7a' },
    objectGlow: '#0b5b27', objectGlowIntensity: 0.5, wireframe: true,
    streams: { reference: '#49ff82', dependent: '#daff62', strong: '#e9ffc7', weak: '#74a995' },
    tubeGlow: 1.3, branchOpacity: 0.55, signalSize: 8, packets: 6, trail: 6, signalSpeed: 0.21,
    signalShape: 'bit', additive: true,
  },
  neon: {
    name: 'Neon Circuit', background: '#08051b', grid: ['#753997', '#21153c'],
    typeColors: ['#55e9f4', '#7cafff', '#a987ff', '#d289f4', '#f075c1', '#99cff4'],
    generations: { Generation0: '#53fff2', Generation1: '#7d9aff', Generation2: '#c895ff',
      Large: '#ffc36b', Pinned: '#ff69c7', Frozen: '#e5f9ff', Unknown: '#a9a1bc' },
    objectGlow: '#25164c', objectGlowIntensity: 0.45, wireframe: false,
    streams: { reference: '#4deaff', dependent: '#ff5cd8', strong: '#ffcd79', weak: '#b497ee' },
    tubeGlow: 1.5, branchOpacity: 0.5, signalSize: 9, packets: 5, trail: 8, signalSpeed: 0.17,
    signalShape: 'glow', additive: true,
  },
  prism: {
    name: 'Prism', background: '#060719', grid: ['#454273', '#17172f'],
    typeColors: ['#ed83e7', '#59dbf0', '#a78bed', '#779eee', '#f2c46d', '#66d8c7'],
    generations: { Generation0: '#55edcc', Generation1: '#7bcbff', Generation2: '#b399ff',
      Large: '#ffd083', Pinned: '#f299d8', Frozen: '#d5ecff', Unknown: '#8797a9' },
    objectGlow: '#0e0b20', objectGlowIntensity: 0.2, wireframe: false, semantic: true,
    streams: { reference: '#35d6f5', dependent: '#bc6ef4', strong: '#ffc35b', weak: '#9c76cc' },
    tubeGlow: 1.8, linkIntensity: 1.15, branchOpacity: 0.5,
    signalSize: 8, packets: 4, trail: 6, signalSpeed: 0.18, signalShape: 'glow', additive: true, goldenPulses: true, pulseWidth: 3.2,
    bloom: { strength: 0.32, radius: 0.35, threshold: 0.85 },
  },
};

export function getTheme(id = 'atlas') {
  if (!Object.hasOwn(themes, id)) throw new RangeError(`Unknown theme: ${id}`);
  return themes[id];
}

export function typeColor(name = '<unknown>', theme = getTheme()) {
  let hash = 2166136261;
  for (const character of name) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  const color = theme.semantic ? semanticMaterials[semanticCategory(name)].color : theme.typeColors[hash % theme.typeColors.length];
  const shade = 0.82 + ((hash >>> 12) & 255) / 255 * 0.28;
  return `#${[1, 3, 5].map(i => Math.min(255, Math.round(parseInt(color.slice(i, i + 2), 16) * shade)).toString(16).padStart(2, '0')).join('')}`;
}

export function sizeColor(size, color = new Color()) {
  return color.setHSL(Math.max(0, 0.6 - Math.log2(size + 1) / 48), 0.7, 0.6);
}

export function signalPixels(shape, size = 16) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const radius = Math.hypot(u - 0.5, v - 0.5);
    const bit = Math.abs(u - 0.5) < 0.09 && v > 0.15 && v < 0.85 ||
      v > 0.75 && v < 0.85 && u > 0.28 && u < 0.72 ||
      v > 0.15 && v < 0.25 && u > 0.32 && u < 0.58;
    const alpha = shape === 'bit' ? (bit ? 1 : 0) :
      shape === 'glow' ? Math.max(0, Math.exp(-radius * radius * 22) - 0.01) :
        Math.max(0, 1 - radius * 2);
    const i = (y * size + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255; pixels[i + 3] = Math.round(alpha * 255);
  }
  return pixels;
}
