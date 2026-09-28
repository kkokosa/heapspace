import { buildRootProvenance, rootTypeNames } from './root-provenance.js';

export const reachabilityPalette = {
  reachable: '#5ed6b3', unreachable: '#ff6756', unknown: '#8794a8',
};

export function collectionGeneration(object) {
  if (object.generation === 'Generation0') return 0;
  if (object.generation === 'Generation1') return 1;
  if (['Generation2', 'Large', 'Pinned'].includes(object.generation)) return 2;
  if (object.generation === 'Frozen') return Infinity;
  return null;
}

export function retainingRoot(root) {
  return root.strong === true && !root.annotation && !/^Weak/.test(root.kind) && root.kind !== 'Dependent';
}

function trace(seeds, index) {
  const marked = new Set(), queue = [];
  for (const id of seeds) if (index.objects.has(id) && !marked.has(id)) { marked.add(id); queue.push(id); }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const edge of index.outgoing.get(queue[cursor]) ?? []) {
      if (edge.kind !== 'reference' && edge.kind !== 'dependent') continue;
      // A dependent edge is traversed only after its primary has been marked.
      if (index.objects.has(edge.target) && !marked.has(edge.target)) { marked.add(edge.target); queue.push(edge.target); }
    }
  }
  return marked;
}

export function analyzeReachability(data, index) {
  const reasons = [];
  if (!data.reachabilityMetadataIncluded)
    reasons.push('This snapshot needs reanalysis to capture reachability/finalization metadata.');
  if (!data.heapVerifiedForReachability) reasons.push('The complete heap was not verified for reachability.');
  if (data.objectsTruncated || data.objects.length !== data.objectsWalked) reasons.push('The captured object graph is sampled or incomplete.');
  if (data.edgesTruncated) reasons.push('Reference enumeration was capped.');
  if (data.rootsTruncated) reasons.push('Root enumeration was capped.');
  if (data.invalidObjects > 0 || data.heapVerificationIssues > 0) reasons.push('Invalid or unverified heap objects were encountered.');
  if (data.finalizableObjectsTruncated || data.invalidFinalizableObjects > 0) reasons.push('Finalization enumeration is incomplete.');
  if (data.runtimes?.some(runtime => !runtime.canWalkHeap)) reasons.push('CLR heap structures were not walkable.');
  const ranks = new Map(data.objects.map(object => [object.id, collectionGeneration(object)]));
  if ([...ranks.values()].some(rank => rank === null)) reasons.push('Some object generations are unknown.');
  const roots = data.roots.filter(retainingRoot);
  const unresolvedRoots = roots.filter(root => !index.objects.has(root.target)).length;
  if (unresolvedRoots) reasons.push(`${unresolvedRoots} retaining roots have unresolved or uncaptured targets.`);
  let missingEdges = 0, olderToYounger = 0, unsupportedEdges = 0;
  for (const edge of data.edges) {
    if (!index.objects.has(edge.source) || !index.objects.has(edge.target)) missingEdges++;
    if (edge.kind !== 'reference' && edge.kind !== 'dependent') unsupportedEdges++;
    const source = ranks.get(edge.source), target = ranks.get(edge.target);
    if (edge.kind === 'reference' && Number.isFinite(source) && Number.isFinite(target) && source > target) olderToYounger++;
  }
  if (missingEdges) reasons.push(`${missingEdges} references have uncaptured endpoints.`);
  if (unsupportedEdges) reasons.push('The graph contains unsupported reference kinds.');
  const finalizable = new Set(data.finalizableObjects ?? []);
  if (!Array.isArray(data.finalizableObjects)) reasons.push('Finalizable-object registrations were not captured.');
  if ([...finalizable].some(id => !index.objects.has(id))) reasons.push('Some registered finalizable objects are outside the captured graph.');
  const complete = reasons.length === 0;
  const permanent = data.objects.filter(object => ranks.get(object.id) === Infinity).map(object => object.id);
  const rootSeeds = roots.map(root => root.target);
  const reachable = trace([...rootSeeds, ...permanent], index);
  const finalizerProtected = complete ? trace([...reachable, ...finalizable], index) : reachable;
  const retained = complete ? [0, 1].map(generation => trace([
    ...finalizerProtected,
    ...data.objects.filter(object => ranks.get(object.id) === null || ranks.get(object.id) > generation).map(object => object.id),
  ], index)) : [reachable, reachable];
  retained.push(finalizerProtected);
  const objects = new Map();
  const provenance = buildRootProvenance(data, index, ranks, roots);
  const collections = [0, 1, 2].map(() => ({ reachable: 0, unreachable: 0, unknown: 0, outside: 0, multiRoot: 0 }));
  const counts = { reachable: 0, permanent: 0, unreachable: 0, finalization: 0, unknown: 0, candidates: [0, 0, 0] };
  for (const object of data.objects) {
    const rank = ranks.get(object.id);
    const state = rank === Infinity ? 'permanent' : reachable.has(object.id) ? 'reachable' :
      !complete ? 'unknown' : finalizerProtected.has(object.id) ? 'finalization' : 'unreachable';
    counts[state]++;
    const eligibility = [0, 1, 2].map(generation =>
      state === 'unknown' ? null : rank !== null && rank <= generation && !retained[generation].has(object.id));
    eligibility.forEach((eligible, generation) => { if (eligible) counts.candidates[generation]++; });
    const earliest = eligibility.findIndex(Boolean);
    const entry = {
      state, generation: rank, eligible: eligibility, earliest: earliest < 0 ? null : earliest,
      registeredFinalizable: finalizable.has(object.id),
      retainedByOlder: [0, 1, 2].map(generation => state === 'unreachable' && rank <= generation && retained[generation].has(object.id)),
      rootMasks: provenance.map(masks => masks.get(object.id) ?? 0),
    };
    objects.set(object.id, entry);
    collections.forEach((collection, generation) => {
      collection[collectionState(entry, generation)]++;
      const mask = entry.rootMasks[generation];
      if (collectionState(entry, generation) !== 'outside' && mask && (mask & (mask - 1)) !== 0) collection.multiRoot++;
    });
  }
  return { objects, counts, collections, complete, reasons, olderToYounger, finalizableCount: finalizable.size };
}

export function collectionState(entry, generation = 0) {
  if (entry.generation !== null && entry.generation > generation) return 'outside';
  if (entry.generation === null) return 'unknown';
  if (entry.rootMasks?.[generation]) return 'reachable';
  return entry.eligible[generation] === true ? 'unreachable' : 'unknown';
}

export function matchingReachability(analysis, generation, state) {
  const result = new Set();
  if (!analysis) return result;
  for (const [id, entry] of analysis.objects) if (collectionState(entry, generation) === state) result.add(id);
  return result;
}

export function reachableBy(analysis, id, generation = 2) {
  const entry = analysis?.objects.get(id);
  const types = rootTypeNames(entry?.rootMasks?.[generation] ?? 0);
  if (types.length) return { state: 'reachable', types };
  return { state: analysis?.complete && entry?.state === 'unreachable' ? 'not reachable' : 'unknown', types };
}

export function rootHoverText(analysis, id, generation) {
  const entry = analysis?.objects.get(id);
  if (!entry) return `Root types (Gen ${generation}): unavailable`;
  const names = rootTypeNames(entry.rootMasks[generation]);
  const prefix = `Root types (Gen ${generation}${analysis.complete ? '' : ', observed/partial'})`;
  if (names.length) return `${prefix}: ${names.join(', ')}`;
  if (entry.state === 'unknown') return `${prefix}: unknown; no path recovered`;
  return `${prefix}: no captured retaining path${collectionState(entry, generation) === 'outside' ? '; outside this collection' : ''}`;
}

export function reachabilityColor(entry, generation = 0, highlight = 'unreachable') {
  if (!entry) return null;
  const state = collectionState(entry, generation === 'all' ? 2 : Number(generation));
  return state === 'unknown' ? reachabilityPalette.unknown : state === highlight ? reachabilityPalette[state] : null;
}

export function collectionExplanation(entry, generation) {
  if (entry.state === 'permanent') return 'Frozen allocation: not collected.';
  if (entry.generation > generation) return 'Outside the condemned generation.';
  if (entry.state === 'unknown') return collectionState(entry, generation) === 'reachable'
    ? 'Reachable through an observed retention source in the captured graph; additional root types may be missing.'
    : 'Unknown: capture/verification is incomplete. No recovered path does not mean unreachable.';
  if (entry.state === 'reachable') return 'Reachable from a retaining root or permanent allocation.';
  if (entry.state === 'finalization') return 'Conservatively protected by registered finalization or its descendants.';
  if (entry.retainedByOlder[generation]) return 'Retained by references from generations not collected in this cycle.';
  return 'Collection candidate in this snapshot; not a guarantee about the next live GC.';
}
