import { referenceSlotAddress, compareAddress } from './spatial.js';
import { collectionGeneration } from './reachability.js';

export function cardState(info, index) {
  if (!Number.isInteger(index) || index < 0 || index >= info.count || !['decoded', 'truncated'].includes(info.status)) return null;
  let low = 0, high = info.dirtyRuns.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (info.dirtyRuns[mid].start <= index) low = mid + 1;
    else high = mid;
  }
  const run = info.dirtyRuns[low - 1];
  return Boolean(run && index < run.start + run.count);
}

export function indexCards(data, index) {
  const regions = new Map((data.cardRegions ?? []).map(info => [info.segment, info]));
  const references = new Map(), byRegion = new Map();
  const objects = Map.groupBy(data.objects, object => object.segment);
  for (const members of objects.values()) members.sort((a, b) => compareAddress(a.address, b.address));
  for (const edge of data.edges) {
    const source = index.objects.get(edge.source);
    if (!source) continue;
    const info = regions.get(source.segment);
    if (!info?.cardSize || !info.count) continue;
    const slot = referenceSlotAddress(source, edge, data.architecture);
    if (slot === null || BigInt(slot) < BigInt(info.start)) continue;
    const card = Number((BigInt(slot) - BigInt(info.start)) / BigInt(info.cardSize));
    if (card >= info.count) continue;
    const key = `${info.segment}:${card}`;
    if (!references.has(key)) {
      references.set(key, []);
      if (!byRegion.has(info.segment)) byRegion.set(info.segment, new Map());
      byRegion.get(info.segment).set(card, references.get(key));
    }
    references.get(key).push({ edge, slot });
  }
  return { regions, references, byRegion, objects };
}

function contributions(slots, index, generation) {
  return slots.filter(({ edge }) => {
    const source = index.objects.get(edge.source), target = index.objects.get(edge.target);
    const from = collectionGeneration(source), to = target ? collectionGeneration(target) : null;
    return Number.isFinite(from) && from > generation && Number.isFinite(to) && to <= generation;
  });
}

function descendants(contributing, index, generation) {
  const reachable = new Set(contributing.map(item => item.edge.target)), queue = [...reachable];
  for (let i = 0; i < queue.length; i++) for (const edge of index.outgoing.get(queue[i]) ?? []) {
    if (edge.kind !== 'reference' && edge.kind !== 'dependent') continue;
    const target = index.objects.get(edge.target), rank = target ? collectionGeneration(target) : null;
    if (rank === null || rank > generation || reachable.has(edge.target)) continue;
    reachable.add(edge.target); queue.push(edge.target);
  }
  return reachable;
}

function scanCandidates(info, cards, generation, first = 0, last = info.count - 1) {
  const sources = new Set();
  const low = BigInt(info.start) + BigInt(first) * BigInt(info.cardSize);
  const high = BigInt(info.start) + BigInt(last + 1) * BigInt(info.cardSize);
  const objects = cards.objects.get(info.segment) ?? [];
  let begin = 0, end = objects.length;
  while (begin < end) {
    const mid = (begin + end) >>> 1, object = objects[mid];
    if (BigInt(object.address) + BigInt(object.size) <= low) begin = mid + 1;
    else end = mid;
  }
  for (let i = begin; i < objects.length; i++) {
    const object = objects[i], start = BigInt(object.address), finish = start + BigInt(object.size);
    if (start >= high) break;
    const rank = collectionGeneration(object);
    if (!Number.isFinite(rank) || rank <= generation) continue;
    const from = Number(((start > low ? start : low) - BigInt(info.start)) / BigInt(info.cardSize));
    const to = Number(((finish < high ? finish : high) - 1n - BigInt(info.start)) / BigInt(info.cardSize));
    let a = 0, b = info.dirtyRuns.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (info.dirtyRuns[mid].start <= to) a = mid + 1; else b = mid;
    }
    const run = info.dirtyRuns[a - 1];
    if (run && run.start + run.count > from) sources.add(object.id);
  }
  return sources;
}

export function cardEvidence(selection, cards, index, generation) {
  const info = cards.regions.get(selection.segment);
  if (!info || cardState(info, selection.index) === null) throw new RangeError('This card was not decoded from the dump.');
  const dirty = cardState(info, selection.index);
  const slots = cards.references.get(`${selection.segment}:${selection.index}`) ?? [];
  const contributing = dirty ? contributions(slots, index, generation) : [];
  const start = BigInt(info.start) + BigInt(selection.index) * BigInt(info.cardSize);
  return { info, index: selection.index, generation, dirty, slots, contributing,
    sources: dirty ? scanCandidates(info, cards, generation, selection.index, selection.index) : new Set(),
    reachable: descendants(contributing, index, generation),
    start: `0x${start.toString(16)}`, end: `0x${(start + BigInt(info.cardSize)).toString(16)}` };
}

export function cardTableEvidence(segments, cards, index, generation) {
  const sources = new Set(), contributing = [], tables = [];
  let dirtyCards = 0;
  for (const segment of segments) {
    const info = cards.regions.get(segment);
    if (!info?.count || !['decoded', 'truncated'].includes(info.status)) throw new RangeError('This card table has no decoded cards.');
    tables.push(info);
    dirtyCards += info.dirtyRuns.reduce((count, run) => count + run.count, 0);
    for (const id of scanCandidates(info, cards, generation)) sources.add(id);
    for (const [card, slots] of cards.byRegion.get(segment) ?? [])
      if (cardState(info, card)) for (const item of contributions(slots, index, generation)) contributing.push(item);
  }
  return { segments: new Set(segments), generation, tables, dirtyCards, sources, contributing,
    reachable: descendants(contributing, index, generation) };
}
