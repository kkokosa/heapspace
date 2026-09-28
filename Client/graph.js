import { retainingRoot } from './reachability.js';

export const palette = {
  Generation0: '#63e4bb', Generation1: '#57bcee', Generation2: '#8d96f3',
  Large: '#efa36c', Pinned: '#e985ba', Frozen: '#d1e8ef', Unknown: '#a5aab0',
};

export function heapKind(segment) {
  if (segment.kind === 'Large') return 'LOH';
  if (segment.kind === 'Pinned') return 'POH';
  if (segment.kind === 'Frozen') return 'Frozen';
  return 'SOH';
}

export function bytes(value) {
  if (value < 1024) return `${value} B`;
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`;
}

export function percentage(part, total) {
  if (total === 0) return 'n/a';
  const value = part / total * 100;
  if (part > 0 && value < 0.1) return '<0.1%';
  if (part < total && value >= 99.95) return '>99.9%';
  return `${value.toFixed(1)}%`;
}

export function displayCoverage(data, shown, contextOpacity) {
  const objectCount = shown.visible + (contextOpacity > 0 ? shown.context : 0);
  return {
    objects: {
      rendered: objectCount, captured: data.objects.length, walked: data.objectsWalked,
      capturedPercent: percentage(objectCount, data.objects.length),
      walkedPercent: percentage(objectCount, data.objectsWalked),
    },
    references: {
      rendered: shown.edges, captured: data.edges.length, percent: percentage(shown.edges, data.edges.length),
      eligiblePercent: percentage(shown.edges, shown.references.eligible),
      totalUnknown: Boolean(data.objectsTruncated || data.edgesTruncated || data.invalidObjects > 0),
    },
    roots: { rendered: shown.roots, captured: shown.rootRecords ?? data.roots.length,
      percent: percentage(shown.roots, shown.rootRecords ?? data.roots.length) },
  };
}

export function indexGraph(data) {
  const objects = new Map(data.objects.map(o => [o.id, o]));
  const segments = new Map(data.segments.map(s => [s.id, s]));
  const outgoing = new Map(), incoming = new Map(), roots = new Map();
  const append = (map, id, item) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(item);
  };
  for (const edge of data.edges) {
    append(outgoing, edge.source, edge);
    append(incoming, edge.target, edge);
  }
  const allRoots = [...data.roots, ...finalizationRoots(data)];
  for (const root of allRoots) if (root.target) append(roots, root.target, root);
  const rootsById = new Map(allRoots.map(root => [root.id, root]));
  return { objects, segments, outgoing, incoming, roots, rootsById, allRoots, finalizable: new Set(data.finalizableObjects ?? []) };
}

export function siteKey(site) {
  if (!site) return null;
  if (site.kind === 'root') return `root:${site.id}`;
  if (site.kind === 'slot') return `slot:${site.edge.source}:${site.edge.offset}:${site.edge.target}`;
  throw new RangeError('Unknown root/slot selection kind.');
}

export function resolveSite(site, index) {
  if (!site) return null;
  if (site.kind === 'root') {
    const root = index.rootsById.get(site.id);
    if (!root) throw new RangeError('This root is no longer present in the captured graph.');
    return { kind: 'root', key: siteKey(site), root, target: root.target };
  }
  if (site.kind === 'slot') {
    const edge = site.edge;
    if (edge.kind !== 'reference' || !index.outgoing.get(edge.source)?.includes(edge))
      throw new RangeError('This array reference is no longer present in the captured graph.');
    return { kind: 'slot', key: siteKey(site), edge, source: edge.source, target: edge.target };
  }
  throw new RangeError('Unknown root/slot selection kind.');
}

export function neighborhood(selected, index, depth = 1, maxObjects = 2000, maxScans = 100000, maxEdges = 6000) {
  const ids = new Set(), distances = new Map(), missing = new Set();
  const seeds = selected instanceof Set ? selected : [selected];
  for (const id of seeds) if (index.objects.has(id)) { ids.add(id); distances.set(id, 0); }
  if (!ids.size) return { ids, distances, edges: [], limited: false, missing: 0 };
  maxObjects = Math.max(maxObjects, ids.size);
  let scans = 0, limited = false;
  const traversals = typeof depth === 'number' ? [{ directions: [index.outgoing, index.incoming], limit: depth }] :
    [{ directions: [index.incoming], limit: depth.incoming }, { directions: [index.outgoing], limit: depth.outgoing }];
  for (const traversal of traversals) {
    const queue = [...seeds].filter(id => index.objects.has(id)), visited = new Map(queue.map(id => [id, 0]));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i], distance = visited.get(id);
      if (distance >= traversal.limit) continue;
      for (const direction of traversal.directions) {
        for (const edge of direction.get(id) ?? []) {
          if (++scans > maxScans) { limited = true; break; }
          const other = direction === index.incoming ? edge.source : edge.target;
          if (visited.has(other)) continue;
          if (!index.objects.has(other)) { missing.add(other); continue; }
          if (!ids.has(other) && ids.size >= maxObjects) { limited = true; continue; }
          ids.add(other); visited.set(other, distance + 1);
          distances.set(other, Math.min(distances.get(other) ?? Infinity, distance + 1)); queue.push(other);
        }
        if (scans > maxScans) break;
      }
      if (scans > maxScans) break;
    }
    if (scans > maxScans) break;
  }
  const edges = [];
  let edgeScans = 0;
  for (const id of ids) {
    for (const edge of index.outgoing.get(id) ?? []) {
      if (++edgeScans > maxScans) { limited = true; break; }
      if (!ids.has(edge.target)) continue;
      if (edges.length >= maxEdges) { limited = true; break; }
      edges.push(edge);
    }
    if (edgeScans > maxScans || edges.length >= maxEdges) { limited = true; break; }
  }
  return { ids, distances, edges, limited, missing: missing.size };
}

export function findObjects(data, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return data.objects.filter(object =>
    [object.type, object.address, object.preview ?? ''].some(value => value.toLowerCase().includes(needle)));
}

export function selectObjects(data, index, budget, filter, selected, priorities) {
  const candidates = data.objects.filter(o => filter === 'all' || heapKind(index.segments.get(o.segment)) === filter);
  if (budget === 'all' || budget >= candidates.length) return candidates;
  const chosen = new Map();
  const add = id => {
    if (chosen.size >= budget) return;
    const object = index.objects.get(id);
    if (object && (filter === 'all' || heapKind(index.segments.get(object.segment)) === filter))
      chosen.set(id, object);
  };
  if (selected) {
    add(selected);
    if (priorities) for (const id of priorities) add(id);
    else for (const edge of [...(index.outgoing.get(selected) ?? []), ...(index.incoming.get(selected) ?? [])].slice(0, Math.min(500, budget - 1))) {
        add(edge.source); add(edge.target);
      }
  } else if (priorities) {
    // Analysis focus represents a whole class, not one object's neighborhood or an address prefix.
    const matches = candidates.filter(object => priorities.has(object.id));
    const count = Math.min(budget, matches.length);
    for (let i = 0; i < count; i++) add(matches[Math.floor(i * matches.length / count)].id);
  } else if (candidates.length > budget) {
    // Reserve part of an overview sample for complete reference pairs, not disconnected endpoints.
    const ids = new Set(candidates.map(object => object.id));
    const pairBudget = Math.floor(budget * 0.4), samples = Math.min(data.edges.length, pairBudget);
    for (let i = 0; i < samples; i++) {
      const edge = data.edges[Math.floor(i * data.edges.length / samples)];
      if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
      const needed = Number(!chosen.has(edge.source)) + Number(edge.target !== edge.source && !chosen.has(edge.target));
      if (chosen.size + needed > pairBudget) continue;
      add(edge.source); add(edge.target);
    }
  }
  const available = Math.max(0, budget - chosen.size);
  const remaining = candidates.filter(object => !chosen.has(object.id));
  // Sample the remaining heap without collisions that silently underfill the display budget.
  for (let i = 0; i < available && remaining.length; i++)
    add(remaining[Math.floor(i * remaining.length / available)].id);
  return [...chosen.values()];
}

export function selectReferences(edges, visible, limit = 6000) {
  const eligible = [], seen = new Set();
  let hiddenEndpoints = 0;
  for (const edge of edges) {
    if (seen.has(edge)) continue;
    seen.add(edge);
    if (!visible.has(edge.source) || !visible.has(edge.target)) { hiddenEndpoints++; continue; }
    eligible.push(edge);
  }
  const count = Math.min(limit, eligible.length);
  const selected = Array.from({ length: count }, (_, i) => eligible[Math.floor(i * eligible.length / count)]);
  return { edges: selected, eligible: eligible.length, hiddenEndpoints, limited: eligible.length > limit };
}

// A path is evidence only within the captured graph; weak handles never start paths.
export function retainingPath(target, index, maxVisited = 100000) {
  const queue = [target], next = new Map(), seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const root = (index.roots.get(id) ?? []).find(retainingSource) ?? implicitSource(id, index);
    if (root) {
      const edges = [];
      let current = id;
      while (current !== target) {
        const edge = next.get(current);
        edges.push(edge);
        current = edge.target;
      }
      return { root, edges, limited: false };
    }
    for (const edge of index.incoming.get(id) ?? []) {
      if (!retainingEdge(edge) || !index.objects.has(edge.source)) continue;
      if (seen.has(edge.source)) continue;
      if (seen.size >= maxVisited) return { root: null, edges: [], limited: true };
      seen.add(edge.source); next.set(edge.source, edge); queue.push(edge.source);
    }
  }
  return { root: null, edges: [], limited: false };
}
const retainingEdge = edge => edge.kind === 'reference' || edge.kind === 'dependent';
const retainingSource = root => retainingRoot(root) || root.finalization === true && !root.annotation;
function implicitSource(id, index) {
  if (index.objects.get(id)?.generation === 'Frozen')
    return { id: `permanent:${id}`, target: id, kind: 'Frozen', label: 'Permanent allocation', permanent: true, strong: true };
  if (index.finalizable?.has(id) && !(index.roots.get(id) ?? []).some(root => /Finaliz/.test(root.kind)))
    return { id: `registered:${id}`, target: id, kind: 'FinalizationRegistration',
      label: 'Registered finalization (conservative retention; no captured slot)', finalization: true, synthetic: true };
  return null;
}

// All root-to-target routes are a finite subgraph; enumerating walks through cycles would be unbounded.
export function retainingRoutes(target, index) {
  if (!index.objects.has(target)) throw new RangeError('Target object is not captured.');
  const ancestors = new Set([target]), queue = [target], missing = new Set();
  for (let i = 0; i < queue.length; i++) for (const edge of index.incoming.get(queue[i]) ?? []) {
    if (!retainingEdge(edge) || ancestors.has(edge.source)) continue;
    if (!index.objects.has(edge.source)) { missing.add(edge.source); continue; }
    ancestors.add(edge.source); queue.push(edge.source);
  }
  const roots = [];
  for (const id of ancestors) {
    for (const root of index.roots.get(id) ?? []) if (retainingSource(root)) roots.push(root);
    const implicit = implicitSource(id, index);
    if (implicit) roots.push(implicit);
  }
  const ids = new Set(roots.map(root => root.target)), forward = [...ids], edges = [];
  for (let i = 0; i < forward.length; i++) for (const edge of index.outgoing.get(forward[i]) ?? []) {
    if (!retainingEdge(edge) || !ancestors.has(edge.target)) continue;
    edges.push(edge);
    if (!ids.has(edge.target)) { ids.add(edge.target); forward.push(edge.target); }
  }
  ids.add(target);
  return { target, ids, roots, edges, limited: false, missing: missing.size };
}
import { finalizationRoots } from './finalization.js';
