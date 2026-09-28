export const BYTES_PER_CUBIC_UNIT = 32;
export const MIN_BOX_SIDE = 0.9;

export function boxSide(bytes) {
  return Math.max(MIN_BOX_SIDE, Math.cbrt(Number(bytes) / BYTES_PER_CUBIC_UNIT));
}

export function compareAddress(a, b) {
  const left = BigInt(a), right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isArrayType(type = '') {
  return /\[[,\s*0-9:]*\]$/.test(type);
}

export function pointerSize(architecture) {
  if (['X64', 'Arm64', 'S390x', 'LoongArch64', 'Ppc64le', 'RiscV64'].includes(architecture)) return 8;
  if (['X86', 'Arm', 'Armv6', 'Wasm'].includes(architecture)) return 4;
  return null;
}

export function referenceSlotAddress(object, edge, architecture) {
  const width = object.pointerSize ?? pointerSize(architecture);
  if (edge.kind !== 'reference' || !width ||
      !Number.isSafeInteger(edge.offset) || edge.offset < 0) return null;
  const offset = BigInt(width) + BigInt(edge.offset);
  if (offset + BigInt(width) > BigInt(object.bytes ?? object.size)) return null;
  return `0x${(BigInt(object.address) + offset).toString(16)}`;
}

export function arraySlotAddress(object, edge, architecture) {
  return (object.isArray ?? isArrayType(object.type)) ? referenceSlotAddress(object, edge, architecture) : null;
}

export function arrayCellSize(object) {
  const width = object.pointerSize;
  if (width !== 4 && width !== 8) throw new RangeError('Array cell sizing requires a known pointer size.');
  const columns = Math.ceil(Math.cbrt(Number((BigInt(object.bytes) + BigInt(width) - 1n) / BigInt(width))));
  return object.side * 0.9 / columns;
}

export function arraySlotPosition(address, object) {
  const width = object.pointerSize;
  if (width !== 4 && width !== 8) throw new RangeError('Array slot placement requires a known pointer size.');
  const bytes = BigInt(object.bytes), offset = BigInt(address) - BigInt(object.address);
  if (offset < 0n || offset + BigInt(width) > bytes) throw new RangeError('Array slot lies outside the object.');
  const columns = Math.ceil(Math.cbrt(Number((bytes + BigInt(width) - 1n) / BigInt(width))));
  const cell = Number(offset / BigInt(width));
  const coordinates = [cell % columns, Math.floor(cell / (columns * columns)), Math.floor(cell / columns) % columns];
  return coordinates.map((value, axis) => object.position[axis] + ((value + 0.5) / columns - 0.5) * object.side * 0.9);
}

export function referenceSource(object, edge) {
  const address = arraySlotAddress(object, edge);
  return address === null ? object : { ...object, anchor: arraySlotPosition(address, object),
    anchorId: `${object.id}@${address}`, slotAddress: address, slotCellSize: arrayCellSize(object) };
}

// Address order follows x, then z shelves, then y floors. Sizes never change to fit.
export function packBoxes(items, gap = 0.25) {
  const volume = items.reduce((sum, item) => sum + item.size.reduce((v, side) => v * (side + gap), 1), 0);
  const largest = items.reduce((max, item) => Math.max(max, item.size[0], item.size[2]), 1);
  const width = Math.max(Math.cbrt(volume) * 1.4, largest);
  const slots = new Map();
  let x = 0, y = 0, z = 0, rowDepth = 0, floorHeight = 0;
  const extent = [0, 0, 0];
  for (const item of items) {
    const [w, h, d] = item.size;
    if (x > 0 && x + w > width) {
      x = 0; z += rowDepth + gap; rowDepth = 0;
    }
    if (z > 0 && z + d > width) {
      x = 0; y += floorHeight + gap; z = 0; rowDepth = 0; floorHeight = 0;
    }
    slots.set(item.id, { position: [x + w / 2, y + h / 2, z + d / 2], size: [...item.size] });
    extent[0] = Math.max(extent[0], x + w);
    extent[1] = Math.max(extent[1], y + h);
    extent[2] = Math.max(extent[2], z + d);
    x += w + gap; rowDepth = Math.max(rowDepth, d); floorHeight = Math.max(floorHeight, h);
  }
  return { slots, size: extent };
}

export function regionSpans(segment, objects, freeRanges = []) {
  const start = BigInt(segment.start), end = BigInt(segment.end);
  if (end < start) throw new RangeError(`Invalid region bounds: ${segment.id}`);
  const entries = [
    ...objects.map(object => ({ id: object.id, kind: 'object', start: object.address,
      end: `0x${(BigInt(object.address) + BigInt(object.size)).toString(16)}`, bytes: object.size, object })),
    ...freeRanges.map(range => ({ id: `gap:${segment.id}:${range.start}`, kind: 'free', start: range.start,
      end: range.end, bytes: Number(BigInt(range.end) - BigInt(range.start)), generation: range.generation })),
  ].sort((a, b) => compareAddress(a.start, b.start));
  const result = [];
  let cursor = start;
  const addUnknown = end => {
    result.push({ id: `gap:${segment.id}:0x${cursor.toString(16)}`, kind: 'unrepresented',
      start: `0x${cursor.toString(16)}`, end: `0x${end.toString(16)}`, bytes: Number(end - cursor) });
  };
  for (const entry of entries) {
    const low = BigInt(entry.start), high = BigInt(entry.end);
    if (low < start || high > end || high <= low || low < cursor)
      throw new RangeError(`Overlapping or out-of-bounds ${entry.kind} span in ${segment.id}: ${entry.start} - ${entry.end}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new RangeError(`Invalid byte span in ${segment.id}`);
    if (low > cursor) addUnknown(low);
    result.push(entry); cursor = high;
  }
  if (cursor < end) addUnknown(end);
  return result;
}

function mergedRanges(ranges) {
  ranges.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const merged = [];
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = end > last[1] ? end : last[1];
    else merged.push([start, end]);
  }
  return merged;
}

export function subtractRanges(start, end, blockers) {
  const parts = [];
  let cursor = start;
  for (const [low, high] of blockers) {
    if (high <= cursor) continue;
    if (low >= end) break;
    if (low > cursor) parts.push([cursor, low < end ? low : end]);
    if (high > cursor) cursor = high;
    if (cursor >= end) break;
  }
  if (cursor < end) parts.push([cursor, end]);
  return parts;
}

function containing(sorted, address) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (BigInt(sorted[mid].start) <= address) low = mid + 1;
    else high = mid;
  }
  const item = sorted[low - 1];
  return item && address < BigInt(item.end) ? item : null;
}

// Fold a byte offset into a 16-by-16-by-16 Morton lattice, retaining exact addresses in metadata.
export function addressPosition(address, region) {
  const span = BigInt(region.end) - BigInt(region.start);
  const offset = BigInt(address) - BigInt(region.start);
  if (span <= 0n || offset < 0n || offset >= span) throw new RangeError('Address is outside its region.');
  const cell = Number(offset * 4096n / span);
  const axes = [0, 0, 0];
  for (let bit = 0; bit < 4; bit++)
    for (let axis = 0; axis < 3; axis++) axes[axis] |= ((cell >> (bit * 3 + axis)) & 1) << bit;
  return axes.map((value, axis) => region.position[axis] + ((value + 0.5) / 16 - 0.5) * region.size[axis]);
}

export function gcHeapId(segment) {
  return `gc-heap:r${segment.runtime ?? '?'}:h${segment.heap ?? '?'}`;
}

export function regionLabel(region, physical = false) {
  const generation = (region.value.kind ?? 'Unknown').replace(/^Generation(\d+)$/, 'Gen $1');
  const heap = `Heap ${region.value.heap ?? '?'}`;
  return physical ? `${region.physicalLabel}/${generation}\n${heap}/${region.start}` : `${heap}/${generation}`;
}

function organizeGcHeaps(regions) {
  const heaps = new Map();
  for (const region of regions) {
    if (region.kind !== 'segment') continue;
    const id = gcHeapId(region.value);
    if (!heaps.has(id)) heaps.set(id, { id, kind: 'gcHeap', start: region.start,
      value: { runtime: region.value.runtime ?? null, heap: region.value.heap ?? null }, children: [] });
    const heap = heaps.get(id);
    heap.children.push(region); region.heapContainer = heap;
  }
  for (const heap of heaps.values()) {
    const packed = packBoxes(heap.children, 12);
    heap.size = packed.size.map(side => side + 12);
    heap.capturedObjects = heap.children.reduce((total, child) => total + child.capturedObjects, 0);
    heap.generationCounts = new Map();
    for (const region of heap.children) {
      region.heapOffset = packed.slots.get(region.id).position.map((value, axis) => value + 6 - heap.size[axis] / 2);
      for (const [generation, count] of region.generationCounts)
        heap.generationCounts.set(generation, (heap.generationCounts.get(generation) ?? 0) + count);
    }
  }
  return heaps;
}

export function layout(data, { reserved = false, physical = false } = {}) {
  const objects = new Map(), segments = new Map(), threads = new Map(), native = [], rootRegions = new Map(), roots = new Map(), gaps = [], finalizers = new Map();
  const rootRecords = [...(data.roots ?? []), ...finalizationRoots(data)];
  const groups = Map.groupBy(data.objects, object => object.segment);
  const freeGroups = Map.groupBy(data.freeRangesIncluded ? data.freeRanges ?? [] : [], range => range.segment);
  const regions = [], blockers = [];
  const segmentOrder = [...data.segments].sort((a, b) => compareAddress(a.start, b.start) || a.id.localeCompare(b.id));
  for (const [physicalIndex, segment] of segmentOrder.entries()) {
    const members = [...(groups.get(segment.id) ?? [])].sort((a, b) => compareAddress(a.address, b.address));
    const spans = regionSpans(segment, members, freeGroups.get(segment.id) ?? []);
    const boxes = spans.map(span => ({ id: span.id, size: Array(3).fill(
      span.kind === 'object' ? boxSide(span.bytes) : Math.cbrt(span.bytes / BYTES_PER_CUBIC_UNIT)) }));
    const packed = packBoxes(boxes);
    const size = packed.size.map(side => Math.max(3, side + 3));
    const region = { id: segment.id, start: segment.start, end: segment.end, size, kind: 'segment', value: segment };
    region.physicalLabel = `Region ${physicalIndex + 1}`;
    region.physicalIndex = physicalIndex + 1;
    region.capturedObjects = members.length;
    region.generationCounts = new Map();
    for (const object of members) {
      const generation = object.generation ?? 'Unknown';
      region.generationCounts.set(generation, (region.generationCounts.get(generation) ?? 0) + 1);
    }
    region.spans = [];
    region.gaps = [];
    region.freeBytes = 0; region.unrepresentedBytes = 0;
    regions.push(region);
    segments.set(segment.id, region);
    blockers.push([BigInt(segment.start), BigInt(segment.end)]);
    for (const span of spans) {
      const slot = packed.slots.get(span.id), position = slot.position.map((v, axis) => v + 1.5 - size[axis] / 2);
      if (span.kind === 'object') {
        const object = span.object;
        const placed = { id: object.id, address: object.address, start: span.start, end: span.end,
          bytes: object.size, type: object.type, kind: 'object',
          isArray: isArrayType(object.type), pointerSize: pointerSize(data.architecture),
          position, side: slot.size[0], size: slot.size, region };
        objects.set(object.id, placed); region.spans.push(placed);
      } else {
        const placed = { ...span, segment: segment.id, position, side: slot.size[0], size: slot.size, region };
        region.spans.push(placed); region.gaps.push(placed); gaps.push(placed);
        if (span.kind === 'free') region.freeBytes += span.bytes;
        else region.unrepresentedBytes += span.bytes;
      }
    }
  }
  for (const thread of data.threads ?? []) {
    const start = BigInt(thread.stackStart), end = BigInt(thread.stackEnd);
    if (end <= start) continue;
    const side = boxSide(end - start);
    const region = { id: thread.id, start: thread.stackStart, end: thread.stackEnd, size: [side, side, side], kind: 'thread', value: thread };
    regions.push(region); threads.set(thread.id, region); blockers.push([start, end]);
  }
  for (const queue of finalizationAreas(data)) {
    const start = BigInt(queue.storage.start), end = BigInt(queue.storage.end);
    const side = queue.empty ? MIN_BOX_SIDE : boxSide(end - start);
    const region = { id: queue.id, start: queue.storage.start, end: queue.storage.end, address: queue.storage.start,
      bytes: Number(end - start), side, pointerSize: pointerSize(data.architecture),
      size: [side, side, side], kind: 'finalizerQueue', value: queue, empty: queue.empty };
    regions.push(region); finalizers.set(queue.id, region);
    if (!queue.empty) blockers.push([start, end]);
  }
  const knownRegions = regions.filter(r => BigInt(r.end) > BigInt(r.start)).sort((a, b) => compareAddress(a.start, b.start));
  const mappings = [...(data.nativeAreas ?? [])].sort((a, b) => compareAddress(a.start, b.start));
  const knownRanges = mergedRanges([...blockers]);
  const mappedRanges = mergedRanges([...knownRanges, ...mappings.map(mapping => [BigInt(mapping.start), BigInt(mapping.end)])]);
  for (const root of rootRecords) {
    const address = BigInt(root.address);
    if (address === 0n || containing(knownRegions, address)) continue;
    const mapping = containing(mappings, address);
    const page = address & ~4095n;
    const start = mapping && BigInt(mapping.start) > page ? BigInt(mapping.start) : page;
    const end = mapping && BigInt(mapping.end) < page + 4096n ? BigInt(mapping.end) : page + 4096n;
    const part = subtractRanges(start, end, mapping ? knownRanges : mappedRanges).find(([a, b]) => a <= address && address < b);
    if (!part) continue;
    const id = `root-page:0x${part[0].toString(16)}`;
    if (!rootRegions.has(id)) {
      const side = boxSide(part[1] - part[0]);
      rootRegions.set(id, { id, start: `0x${part[0].toString(16)}`, end: `0x${part[1].toString(16)}`,
        size: [side, side, side], kind: 'rootRegion', value: { kind: 'Root slots', roots: [], mapped: Boolean(mapping), owners: mapping?.owners ?? [] } });
    }
    rootRegions.get(id).value.roots.push(root);
  }
  for (const region of rootRegions.values()) {
    regions.push(region); blockers.push([BigInt(region.start), BigInt(region.end)]);
  }
  const excluded = mergedRanges(blockers);
  for (const area of data.nativeAreas ?? []) {
    if (!reserved && area.state === 'reserved') continue;
    // Managed objects and stack blocks already represent these addresses. Keep only the remainder.
    for (const [start, end] of subtractRanges(BigInt(area.start), BigInt(area.end), excluded)) {
      const value = { ...area, start: `0x${start.toString(16)}`, end: `0x${end.toString(16)}`,
        size: Number(end - start), mappingStart: area.start, mappingEnd: area.end, mappingSize: area.size };
      const side = boxSide(end - start);
      const region = { id: `native:${value.start}`, start: value.start, end: value.end, size: [side, side, side], kind: 'native', value };
      regions.push(region); native.push(region);
    }
  }
  regions.sort((a, b) => compareAddress(a.start, b.start) || a.id.localeCompare(b.id));
  const gcHeaps = physical ? organizeGcHeaps(regions) : new Map();
  const topLevel = physical ? [...regions.filter(region => region.kind !== 'segment'), ...gcHeaps.values()]
    .sort((a, b) => compareAddress(a.start, b.start) || a.id.localeCompare(b.id)) : regions;
  const packed = packBoxes(topLevel, 5);
  const origin = [packed.size[0] / 2, 0, packed.size[2] / 2];
  for (const region of topLevel) {
    region.position = packed.slots.get(region.id).position.map((value, axis) => value - origin[axis]);
    region.top = region.position[1] + region.size[1] / 2;
  }
  regions.forEach((region, order) => {
    region.order = order;
    if (region.heapContainer)
      region.position = region.heapOffset.map((value, axis) => value + region.heapContainer.position[axis]);
    region.top = region.position[1] + region.size[1] / 2;
  });
  for (const region of segments.values()) for (const span of region.spans)
    span.position = span.position.map((v, axis) => v + region.position[axis]);
  native.sort((a, b) => a.order - b.order);
  const addressRegions = regions.filter(r => BigInt(r.end) > BigInt(r.start));
  const objectRanges = new Map();
  for (const [id, members] of groups)
    objectRanges.set(id, members.map(o => ({ start: o.address, end: `0x${(BigInt(o.address) + BigInt(o.size)).toString(16)}`, object: objects.get(o.id) }))
      .sort((a, b) => compareAddress(a.start, b.start)));
  let unknownRegion;
  for (const root of rootRecords) {
    const address = BigInt(root.address);
    let region = address === 0n ? null : containing(addressRegions, address);
    let position, slotCellSize, ownerObject = null, placement = 'reported slot address (quantized within its address range)';
    if (region?.kind === 'finalizerQueue' && region.pointerSize) {
      position = arraySlotPosition(address, region);
      placement = `exact ${region.value.title} slot, folded inside the reported section range`;
    } else if (region) {
      const objectRange = region.kind === 'segment' ? containing(objectRanges.get(region.id) ?? [], address) : null;
      if (objectRange) {
        const object = objectRange.object;
        ownerObject = object.id;
        if (object.isArray && object.pointerSize && address + BigInt(object.pointerSize) <= BigInt(objectRange.end)) {
          position = arraySlotPosition(address, object);
          slotCellSize = arrayCellSize(object);
          placement = 'reported array slot/anchor inside the array, folded by pointer-sized byte offsets';
        } else {
          position = addressPosition(address, { ...objectRange, position: object.position, size: Array(3).fill(object.side) });
          position[1] = object.position[1] + object.side / 2 + 0.35;
          placement = 'reported slot within a managed object, projected onto its top face';
        }
      } else {
        const gap = region.kind === 'segment' ? containing(region.spans, address) : null;
        if (gap) {
          position = addressPosition(address, gap);
          placement = gap.kind === 'free'
            ? 'reported address overlaps a confirmed GC free range; snapshot/root metadata may be inconsistent'
            : 'reported address inside an uncaptured/unclassified span; no containing object metadata';
        } else position = addressPosition(address, region);
      }
    } else if (threads.has(root.thread)) {
      region = threads.get(root.thread);
      position = [region.position[0], region.top + 0.5, region.position[2]];
      placement = 'thread-associated; no usable slot address';
    } else {
      unknownRegion ??= { id: 'unlocated-roots', position: [0, 3, packed.size[2] / 2 + 12], size: [6, 6, 6], top: 6,
        kind: 'rootRegion', value: { kind: 'Unlocated roots', roots: [], mapped: false } };
      region = unknownRegion; region.value.roots.push(root);
      position = [...region.position]; placement = 'unknown address; semantic marker only';
    }
    if (root.kind === 'StaticVar' || root.kind === 'ThreadStaticVar')
      placement = `CLR static-storage anchor, not a handle slot; ${placement}`;
    roots.set(root.id, { id: root.id, position, anchor: position, side: 0.6, region, placement, ownerObject, slotCellSize });
  }
  if (unknownRegion) rootRegions.set(unknownRegion.id, unknownRegion);
  return {
    regions, objects, segments, threads, native, rootRegions, roots, gaps, finalizers, gcHeaps, physical, size: packed.size,
    objectPosition: object => objects.get(object.id).position,
    objectSide: object => objects.get(object.id).side,
  };
}

function pointOnFace(object, other) {
  if (object.anchor) return [...object.anchor];
  const direction = other.map((value, axis) => value - object.position[axis]);
  const extent = Math.max(...direction.map(Math.abs));
  return extent > 0 ? object.position.map((value, axis) => value + direction[axis] / extent * object.side / 2)
    : [object.position[0], object.position[1] + object.side / 2, object.position[2]];
}

export function regionPorts(region) {
  const clearance = Math.min(2, Math.max(0.2, Math.min(...region.size) * 0.05));
  const ports = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const normal = [0, 0, 0]; normal[axis] = sign;
    const entry = [...region.position]; entry[axis] += sign * region.size[axis] / 2;
    const junction = entry.map((value, coordinate) => value + normal[coordinate] * clearance);
    ports.push({ id: `${region.id}:${'xyz'[axis]}${sign > 0 ? '+' : '-'}`, face: `${'xyz'[axis]}${sign > 0 ? '+' : '-'}`,
      region, normal, entry, junction, clearance });
  }
  return ports;
}

export function nearestRegionPorts(source, target) {
  const sources = regionPorts(source), targets = regionPorts(target);
  let pair, minimum = Infinity;
  for (const a of sources) for (const b of targets) {
    const squared = a.entry.reduce((sum, value, axis) => sum + (value - b.entry[axis]) ** 2, 0);
    if (squared < minimum) { minimum = squared; pair = { source: a, target: b }; }
  }
  const distance = Math.hypot(...pair.source.junction.map((value, axis) => value - pair.target.junction[axis]));
  const handle = Math.min(24, distance * 0.35);
  pair.trunk = [
    pair.source.junction,
    pair.source.junction.map((value, axis) => value + pair.source.normal[axis] * handle),
    pair.target.junction.map((value, axis) => value + pair.target.normal[axis] * handle),
    pair.target.junction,
  ];
  return pair;
}

export function referenceRoute(source, target, key, ports = nearestRegionPorts(source.region, target.region)) {
  if (source.region.id === target.region.id) throw new RangeError('Same-region references must use a local direct route.');
  const start = pointOnFace(source, ports.source.entry), end = pointOnFace(target, ports.target.entry);
  const mix = (a, b) => a.map((value, axis) => value + (b[axis] - value) * 0.35);
  const inlet = [start, mix(start, ports.source.entry), ports.source.entry, ports.source.junction];
  const outlet = [ports.target.junction, ports.target.entry, mix(end, ports.target.entry), end];
  return { inlet, trunk: ports.trunk, outlet, ports, key };
}

export function pipeRadius(count) {
  return Math.min(0.7, 0.06 * Math.sqrt(count));
}

export function directReferenceRoute(source, target) {
  const start = pointOnFace(source, target.anchor ?? target.position);
  const end = pointOnFace(target, source.anchor ?? source.position);
  const delta = end.map((value, axis) => value - start[axis]);
  const distance = Math.hypot(...delta);
  if (source.region.id === target.region.id) {
    const region = source.region;
    const clamp = point => point.map((value, axis) => Math.min(region.position[axis] + region.size[axis] / 2 - 0.01,
      Math.max(region.position[axis] - region.size[axis] / 2 + 0.01, value)));
    if (distance < 0.001) {
      const radius = Math.min(Math.max(source.side * 0.3, 0.25), Math.min(...region.size) * 0.1);
      return [start, clamp([start[0] + radius, start[1] + radius, start[2]]),
        clamp([end[0] - radius, end[1] + radius, end[2]]), end];
    }
    const normal = Math.hypot(delta[0], delta[2]) > 0.001 ? [-delta[2], 0, delta[0]] : [1, 0, 0];
    const length = Math.hypot(...normal), bend = Math.min(0.75, distance * 0.1);
    const control = fraction => clamp(start.map((value, axis) => value + delta[axis] * fraction + normal[axis] / length * bend));
    return [start, control(1 / 3), control(2 / 3), end];
  }
  const rise = Math.max(1.5, Math.min(24, distance * 0.3));
  const height = Math.max(start[1], end[1]) + rise;
  return distance < 0.001
    ? [start, [start[0] + rise, height, start[2]], [end[0] - rise, height, end[2]], end]
    : [start, [start[0] + delta[0] * 0.25, height, start[2] + delta[2] * 0.25],
      [end[0] - delta[0] * 0.25, height, end[2] - delta[2] * 0.25], end];
}

export function unbundledReference(record, mode) {
  return record.source.region.id === record.target.region.id ||
    mode === 'direct' && (record.kind === 'reference' || record.kind === 'dependent');
}

export function bundleReferences(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.source.region.id}>${record.target.region.id}:${record.kind}`;
    if (!groups.has(key)) groups.set(key, { key, kind: record.kind, count: 0, inlets: new Map(), outlets: new Map(),
      ports: nearestRegionPorts(record.source.region, record.target.region) });
    const group = groups.get(key), route = referenceRoute(record.source, record.target, key, group.ports);
    group.count++; group.trunk = route.trunk;
    for (const [branches, endpoint, points] of [[group.inlets, record.source, route.inlet], [group.outlets, record.target, route.outlet]]) {
      const id = endpoint.anchorId ?? endpoint.id ?? endpoint.position.join(',');
      if (!branches.has(id)) branches.set(id, { id, points, count: 0 });
      branches.get(id).count++;
    }
  }
  return [...groups.values()];
}
import { finalizationRoots, finalizationAreas } from './finalization.js';
