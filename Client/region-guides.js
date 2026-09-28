import { Vector3 } from 'three';
import { bytes } from './graph.js';

export function regionFloorText(region) {
  const generation = (region.value.kind ?? 'Unknown').replace(/^Generation(\d+)$/, 'Gen $1');
  const span = Number(BigInt(region.end) - BigInt(region.start));
  return `${region.physicalLabel} / ${generation} / Heap ${region.value.heap ?? '?'}\n${bytes(span)} address span`;
}

export function orientPlanarLabel(label, camera) {
  const options = label.userData.label;
  label.rotation.set(camera.position.y < label.position.y ? Math.PI / 2 : -Math.PI / 2, 0, options.angle ?? 0);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const baseline = new Vector3(1, 0, 0).applyQuaternion(label.quaternion);
  const alignment = baseline.dot(right);
  if (Math.abs(alignment) > 0.15) options.flipped = alignment < 0;
  if (options.flipped) label.rotateZ(Math.PI);
}

export function regionRulers(region, frontClearance = 0) {
  const low = region.position.map((value, axis) => value - region.size[axis] / 2);
  const high = region.position.map((value, axis) => value + region.size[axis] / 2);
  const offset = Math.min(1.4, Math.max(0.4, Math.min(...region.size) * 0.035));
  const starts = [
    [low[0], low[1] - 0.1, high[2] + offset + frontClearance],
    [low[0] - offset, low[1], low[2] - offset],
    [high[0] + offset, low[1] - 0.1, low[2]],
  ];
  return ['X', 'Y', 'Z'].map((axis, i) => {
    const start = starts[i], end = [...start]; end[i] += region.size[i];
    const labelPosition = start.map((value, coordinate) => (value + end[coordinate]) / 2);
    if (i === 0) labelPosition[2] += offset;
    else labelPosition[0] += i === 1 ? -offset : offset;
    return { axis, start, end, length: region.size[i], labelPosition,
      color: ['#e2aaaa', '#add4a2', '#9fbdee'][i] };
  });
}
