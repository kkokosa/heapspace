import { ConeGeometry, CubicBezierCurve3, Float32BufferAttribute, Vector3 } from 'three';
import { directReferenceRoute, referenceRoute, unbundledReference } from './spatial.js';

export function referenceArrowGeometry() {
  const geometry = new ConeGeometry(1, 1, 8);
  const positions = geometry.attributes.position, centers = new Float32Array(positions.count * 3);
  // Reuse the pipe-width shader, scaling only the cone's radius around its local Y axis.
  for (let i = 0; i < positions.count; i++) centers[i * 3 + 1] = positions.getY(i);
  geometry.setAttribute('tubeCenter', new Float32BufferAttribute(centers, 3));
  return geometry;
}

export function referenceArrows(record, mode) {
  const direct = unbundledReference(record, mode);
  const route = direct ? null : referenceRoute(record.source, record.target,
    `${record.source.region.id}>${record.target.region.id}:${record.kind}`);
  const paths = direct ? [directReferenceRoute(record.source, record.target)] : [route.inlet, route.outlet];
  const curves = paths.map(points => {
    const curve = new CubicBezierCurve3(...points.map(point => new Vector3(...point)));
    curve.arcLengthDivisions = 12;
    return curve;
  });
  const result = [];
  for (const [role, endpoint, curve] of [
    ['outgoing', record.source, curves[0]], ['incoming', record.target, curves.at(-1)],
  ]) {
    const pathLength = curve.getLength();
    if (pathLength < 1e-8) continue;
    const internal = role === 'outgoing' && endpoint.slotCellSize > 0;
    const normalLength = Math.min(Math.max(endpoint.side * 0.4, 0.12), 0.8, pathLength * 0.25);
    const length = internal ? Math.min(normalLength * 0.25, endpoint.slotCellSize * 0.4, 0.16) : normalLength;
    const offset = Math.min(0.2, length * 0.8 / pathLength);
    const u = role === 'outgoing' ? offset : 1 - offset;
    const position = curve.getPointAt(u), direction = curve.getTangentAt(u);
    if (direction.lengthSq() < 1e-12) continue;
    result.push({ role, endpoint: endpoint.id, position: position.toArray(), direction: direction.normalize().toArray(), length, internal });
  }
  return result;
}
