export const rootTypes = [
  { key: 'stack', label: 'Stack / register', color: '#58baff' },
  { key: 'static', label: 'Static storage', color: '#bf87ed' },
  { key: 'threadStatic', label: 'Thread-static storage', color: '#f194d0' },
  { key: 'strong', label: 'Strong handle', color: '#63d5ad' },
  { key: 'pinned', label: 'Pinned handle', color: '#efb760' },
  { key: 'asyncPinned', label: 'Async-pinned handle', color: '#ee916a' },
  { key: 'refCounted', label: 'Ref-counted handle', color: '#91c866' },
  { key: 'finalization', label: 'Finalization', color: '#ead371' },
  { key: 'frozen', label: 'Frozen / permanent', color: '#b4dfed' },
  { key: 'older', label: 'Older-generation boundary', color: '#acafc7' },
  { key: 'other', label: 'Other retaining root', color: '#c8a9a0' },
].map((type, index) => ({ ...type, bit: 1 << index }));
const bits = Object.fromEntries(rootTypes.map(type => [type.key, type.bit]));

export function rootTypeBit(root) {
  const kind = root.kind.toLowerCase();
  if (kind.includes('threadstatic')) return bits.threadStatic;
  if (kind.includes('static')) return bits.static;
  if (kind.includes('finaliz')) return bits.finalization;
  if (kind.includes('async') && kind.includes('pin')) return bits.asyncPinned;
  if (kind.includes('pin')) return bits.pinned;
  if (kind.includes('refcount')) return bits.refCounted;
  if (kind.includes('stack')) return bits.stack;
  if (kind.includes('strong') || kind.includes('sizedref')) return bits.strong;
  return bits.other;
}

export function rootTypeNames(mask) {
  return rootTypes.filter(type => (mask & type.bit) !== 0).map(type => type.label);
}

function propagate(index, initial, seeds) {
  const masks = new Map(initial), queue = [], queued = new Set();
  const add = (id, bits) => {
    if (!index.objects.has(id) || !bits) return;
    const old = masks.get(id) ?? 0, next = old | bits;
    if (old === next) return;
    masks.set(id, next);
    if (!queued.has(id)) { queued.add(id); queue.push(id); }
  };
  for (const [id, mask] of seeds) add(id, mask);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]; queued.delete(id);
    for (const edge of index.outgoing.get(id) ?? []) {
      if (edge.kind === 'reference' || edge.kind === 'dependent') add(edge.target, masks.get(id));
    }
  }
  return masks;
}

export function buildRootProvenance(data, index, ranks, retainingRoots) {
  const seeds = retainingRoots.map(root => [root.target, rootTypeBit(root)]);
  for (const id of data.finalizableObjects ?? []) seeds.push([id, bits.finalization]);
  for (const object of data.objects) if (ranks.get(object.id) === Infinity) seeds.push([object.id, bits.frozen]);
  const base = propagate(index, [], seeds);
  const generations = [0, 1].map(generation => {
    const boundary = [];
    for (const edge of data.edges) {
      const source = ranks.get(edge.source), target = ranks.get(edge.target);
      if ((edge.kind === 'reference' || edge.kind === 'dependent') &&
          Number.isFinite(source) && source > generation && Number.isFinite(target) && target <= generation)
        boundary.push([edge.target, bits.older]);
    }
    return propagate(index, base, boundary);
  });
  generations.push(base);
  return generations;
}
