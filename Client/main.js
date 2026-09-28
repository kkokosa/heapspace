import './style.css';
import { Atlas } from './scene.js';
import { bytes, indexGraph, retainingPath, retainingRoutes, percentage, displayCoverage, resolveSite, siteKey, findObjects } from './graph.js';
import { getTheme } from './themes.js';
import { arraySlotAddress, gcHeapId, regionLabel } from './spatial.js';
import { semanticMaterials } from './semantic-materials.js';
import { analyzeReachability, reachableBy, rootHoverText } from './reachability.js';
import { indexCards, cardEvidence, cardTableEvidence } from './cards.js';
import { readSnapshot } from './snapshot-reader.js';

const $ = id => document.getElementById(id);
let data, index, selected, job, request, atlas, uploadController;
let selectedSite = null;
let selectedObjects = null;
let selectedQuery = '';
let inspectedItem = null;
let operation = 0;
let lastShown = null;
let gcAnalysis = null;
let cardIndex = null, selectedCard = null, selectedCardEvidence = null;
let selectedCardTables = new Set(), selectedRoutes = null;
let incomingDepth = 1, outgoingDepth = 1;
let dumpBusy = false;
const status = (message, error = false) => {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  $('app-error').textContent = error ? message : '';
  $('app-error').hidden = !error;
};
const element = (tag, text, className) => {
  const item = document.createElement(tag); item.textContent = text;
  if (className) item.className = className;
  return item;
};
function settings() {
  return { budget: $('budget').value === 'all' ? 'all' : Number($('budget').value),
    referenceBudget: $('reference-budget').value, heap: 'all', color: $('color').value,
    edges: true, roots: true, native: true, reserved: $('reserved').checked, gaps: true,
    isolate: true, depth: { incoming: incomingDepth, outgoing: outgoingDepth }, contextOpacity: 0.05,
    theme: $('theme').value, signals: true, signalSpeed: 3,
    linkMode: 'bundled', connectionWidth: 1.5,
    bloom: true, physical: true, site: selectedSite, selectedObjects,
    reachability: gcAnalysis, gcGeneration: provenanceScope(), highlightGc: $('unreachable').checked,
    highlightState: $('highlight-state').value, cards: true, finalization: true,
    cardSelection: selectedCardEvidence, cardGeneration: cardScope(), routes: selectedRoutes,
    floorLabels: true, dimensions: false };
}
function provenanceScope() {
  return $('unreachable').checked ? Number($('gc-generation').value) : 2;
}
function cardScope() {
  return $('unreachable').checked ? Number($('gc-generation').value) : 0;
}
function clearGraphModes() {
  selectedCard = null; selectedCardEvidence = null; selectedCardTables.clear(); selectedRoutes = null;
}
function render() {
  if (!data || !atlas) return;
  gcAnalysis ??= analyzeReachability(data, index);
  if (selectedCard || selectedCardTables.size) {
    cardIndex ??= indexCards(data, index);
    selectedCardEvidence = selectedCard ? cardEvidence(selectedCard, cardIndex, index, cardScope()) :
      cardTableEvidence(selectedCardTables, cardIndex, index, cardScope());
    selectedObjects = new Set([...selectedCardEvidence.sources, ...selectedCardEvidence.reachable]);
  }
  const shown = lastShown = atlas.show(data, index, settings(), selected);
  updateCoverage();
  updateReachability();
  $('neighborhood-status').textContent = selectedCardEvidence
    ? `${selectedCardEvidence.sources.size.toLocaleString()} source scan candidates overlap dirty cards; ${selectedCardEvidence.reachable.size.toLocaleString()} captured condemned-generation objects are reachable through their dirty old-to-young slots. ${shown.selectedCount.toLocaleString()} highlighted objects rendered. This is nonexclusive attribution, not proof they have no other retaining path.`
    : selectedRoutes
    ? `All captured retaining routes: ${selectedRoutes.roots.length.toLocaleString()} sources, ${selectedRoutes.ids.size.toLocaleString()} objects, ${selectedRoutes.edges.length.toLocaleString()} references; ${shown.visible.toLocaleString()} route objects shown. Cycles are merged, not enumerated as infinitely many paths.`
    : shown.site
    ? `Individual ${shown.site.kind === 'root' ? 'root/handle record' : 'array reference slot'} selected.${shown.neighborhood.missing ? ' Its target is unresolved or outside the captured graph; no connection can be drawn.' : ' Only its connection is highlighted.'} Inspect the target to expand its object neighborhood.`
    : shown.analysisUnavailable
    ? 'Unreachable highlighting is unavailable for this incomplete/unverified graph. The overview is unchanged; choose Unknown to inspect objects without recovered retention paths.'
    : shown.analysisFocus
    ? `${shown.analysisShown.toLocaleString()} ${$('highlight-state').value} objects emphasized for Gen ${$('gc-generation').value}; nonmatches are faint context. No graph expansion is applied to this analysis focus.`
    : shown.neighborhood
    ? `${selectedObjects ? `${selectedObjects.size.toLocaleString()} search matches selected; ${shown.selectedCount.toLocaleString()} rendered. ` : ''}${shown.neighborhood.ids.size.toLocaleString()} objects; incoming ${incomingDepth} hop(s), outgoing ${outgoingDepth} hop(s).${shown.neighborhood.limited ? ' LIMITED by node/edge/scan budget.' : ''}${shown.neighborhood.missing ? ` ${shown.neighborhood.missing} referenced endpoints are outside the captured graph.` : ''} Context obeys the visible-object budget.`
    : 'Select an object to explore its reference neighborhood.';
}
function updateReachability() {
  const highlighting = $('unreachable').checked;
  $('highlight-options').hidden = !highlighting;
  $('gc-generation').disabled = $('highlight-state').disabled = !highlighting;
  $('reachability-options').hidden = !data;
  $('reachability-capture').hidden = !data || !gcAnalysis;
  if (!data || !gcAnalysis) {
    $('reachability-status').textContent = 'Open a dump to analyze reachability.';
    for (const option of $('highlight-state').options) option.textContent = option.value[0].toUpperCase() + option.value.slice(1);
    return;
  }
  const scope = provenanceScope(), counts = gcAnalysis.collections[scope];
  $('reachability-capture').classList.toggle('partial', !gcAnalysis.complete);
  $('reachability-capture').textContent = `Captured ${data.objects.length.toLocaleString()} / ${data.objectsWalked.toLocaleString()} objects (${percentage(data.objects.length, data.objectsWalked)}). ${gcAnalysis.complete ? 'Verified graph.' : '\nPartial / unverified graph. Unreachable unavailable; use Unknown.'}`;
  for (const option of $('highlight-state').options) {
    const name = option.value[0].toUpperCase() + option.value.slice(1);
    option.textContent = option.value === 'unreachable' && !gcAnalysis.complete ? `${name} (unavailable)` :
      `${name} (${counts[option.value].toLocaleString()}${option.value === 'reachable' && !gcAnalysis.complete ? ' proven' : ''})`;
  }
  $('reachability-status').textContent = `Captured objects, Gen ${scope}: ${counts.reachable.toLocaleString()} reachable, ${gcAnalysis.complete ? `${counts.unreachable.toLocaleString()} unreachable` : 'unreachable unavailable'}, ${counts.unknown.toLocaleString()} unknown; ${counts.outside.toLocaleString()} outside this collection${scope === 2 ? ' (frozen / permanent)' : ' (older generations or frozen)'}. ${counts.multiRoot.toLocaleString()} objects have multiple observed retention-source types (striped).${gcAnalysis.complete ? ' Complete verified captured graph.' : ` Missing paths are not proof of death. ${gcAnalysis.reasons.join(' ')} Reachable means a retention path was recovered; Unknown may include live and dead objects. Displaying All captured does not recover omitted objects or paths.`} Finalization and older-generation boundaries are included in reachability.`;
  if ($('unreachable').checked) $('reachability-status').textContent += lastShown?.analysisUnavailable
    ? ' Unreachable highlighting is unavailable; the overview remains visible instead of treating missing evidence as an empty dead-object set. Select Unknown to inspect objects without recovered paths.'
    : lastShown?.analysisFocus
    ? ` Showing ${lastShown.analysisShown.toLocaleString()} of ${lastShown.analysisMatches.toLocaleString()} ${$('highlight-state').value} matches at full intensity; all other objects are dimmed.${lastShown.analysisShown < lastShown.analysisMatches ? ' Heap filters and the visible-object budget limit this view; matching objects are sampled across the captured heap, not expanded from one object.' : ''}${lastShown.analysisMatches === 0 ? ' No matches for this choice in the captured collection scope.' : ''}`
    : ' An explicit object/root/card selection currently takes focus. Change the highlight choice to focus the full matching set.';
}
function updateCoverage() {
  if (!data || !lastShown) return;
  const shown = lastShown, opacity = 0.05;
  const coverage = displayCoverage(data, shown, opacity);
  const { objects, references, roots } = coverage;
  for (const option of $('budget').options) {
    if (option.value === 'all') { option.textContent = 'All captured (100%)'; continue; }
    const budget = Number(option.value), count = Math.min(budget, objects.captured);
    option.textContent = `${budget.toLocaleString()} (up to ${percentage(count, objects.walked)} of walked)`;
  }
  for (const option of $('reference-budget').options) {
    option.textContent = option.value === 'all' ? 'All eligible (100%)' :
      `6,000 object (${percentage(Math.min(6000, references.captured), references.captured)}) / 4,000 root links`;
  }
  $('full-display-warning').hidden = !shown.allObjects && !shown.allReferences;
  $('counts').textContent = `${objects.rendered.toLocaleString()} / ${objects.captured.toLocaleString()} captured objects (${objects.capturedPercent}) | ${shown.edges.toLocaleString()} / ${references.captured.toLocaleString()} refs (${references.percent}) | ${shown.bundles} streams | ${shown.roots} root links`;
  $('object-budget-status').textContent = `Rendered: ${objects.rendered.toLocaleString()} / ${objects.walked.toLocaleString()} walked heap objects (${objects.walkedPercent}); ${objects.capturedPercent} of ${objects.captured.toLocaleString()} captured.${shown.allObjects ? ' No object display cap; filters and context opacity still apply.' : ''}${shown.context ? opacity > 0 ? ` Includes ${shown.context.toLocaleString()} faint context objects.` : ` ${shown.context.toLocaleString()} context objects are hidden at zero opacity.` : ''}${data.objectsTruncated ? ' Analysis sampled the heap; the captured graph is partial. All captured does not recover omitted heap objects.' : ''}${data.invalidObjects ? ' Unwalkable/invalid objects are not included in the walked count.' : ''}`;
  const scope = `${shown.edges.toLocaleString()} / ${references.captured.toLocaleString()} captured object references (${references.percent}) drawn; ${references.eligiblePercent} of ${shown.references.eligible.toLocaleString()} eligible in this view.`;
  $('reference-status').textContent = `${scope}${shown.allReferences ? ' No reference display cap. All eligible links are represented.' : ''}${references.totalUnknown ? ' Total heap reference count is unknown: analysis was sampled, capped, or incomplete.' : ''}${shown.references.limited ? ' Display capped at 6,000 references.' : ''}${shown.references.hiddenEndpoints ? ` ${shown.references.hiddenEndpoints.toLocaleString()} references in the current scope have an endpoint outside the visible set.` : ''}${selected || selectedSite || selectedObjects ? ' Selection/depth further restricts the scope.' : ''}${!selectedRoutes && !selectedCardEvidence && (selected || selectedObjects) && incomingDepth === 0 && outgoingDepth === 0 ? ' Depth 0 excludes unselected objects.' : ''}${shown.curveSegments < 24 ? ` Dense-graph line detail: ${shown.curveSegments} segments per curve; this does not omit references.` : ''} ${shown.arraySlots} addressed array slots.${shown.unresolvedArraySlots ? ` ${shown.unresolvedArraySlots} array references have unavailable/invalid offsets.` : ''}`;
  $('root-status').textContent = `${roots.rendered.toLocaleString()} / ${roots.captured.toLocaleString()} root/handle/queue source records have drawn links (${roots.percent}). ${shown.allReferences ? 'No source-link display cap; target visibility and selection still apply.' : 'Source links are separate from object references and capped at 4,000.'}${data.rootsTruncated ? ' Root analysis is also incomplete.' : ''}`;
  $('card-status').hidden = false;
  $('card-status').textContent = data.gcNativeMetadataIncluded
    ? `${shown.cardStats.shown.toLocaleString()} card cells shown; ${shown.cardStats.dirty.toLocaleString()} dirty (amber), ${shown.cardStats.unavailable} unavailable maps. Card sheets fade with other context during focus. Their Scan toggles remain available to combine tables. Source candidates overlap dirty card memory; descendant targets are separate, nonexclusive retention evidence.`
    : 'Card/queue memory metadata is missing. Reanalyze with the updated analyzer; no card states are guessed.';
  $('gap-status').textContent = `${bytes(shown.gaps.freeBytes)} confirmed GC free space (solid gray); ${bytes(shown.gaps.unrepresentedBytes)} uncaptured/unclassified address spans (dashed gray). ${shown.gaps.outlined.toLocaleString()} / ${shown.gaps.total.toLocaleString()} gap volumes outlined; every gap reserves space.${data.freeRangesIncluded ? data.freeRangesTruncated || data.invalidFreeRanges ? ' Free-range classification is incomplete.' : '' : ' This older snapshot has no free-block ranges, so gaps are not assumed free.'}`;
  const heaps = new Set(data.segments.map(gcHeapId)).size;
  $('physical-layout-status').textContent = shown.physical
    ? `${shown.physicalRanges} reported regions/segments in ${shown.gcHeapContainers} GC-heap containers. Region numbers identify separate allocation units; generations may span several units or share one classic segment. This is virtual memory, not RAM-page placement.`
    : `${data.segments.length} ClrMD regions/segments across ${heaps} GC heaps. Boundaries are already preserved; enable physical organization for heap containers and explicit Region labels.`;
}
function load(snapshot, name) {
  data = snapshot; index = indexGraph(data); selected = null; selectedSite = null; selectedObjects = null;
  gcAnalysis = analyzeReachability(data, index);
  cardIndex = null; clearGraphModes();
  $('welcome').hidden = true;
  $('warnings').replaceChildren();
  for (const message of [
    `${name} | ${data.platform} ${data.architecture} | runtime ${data.runtimes.map(r => `${r.version} (${r.serverGc ? 'server' : 'workstation'} GC)`).join(', ')}`,
    `Walked ${data.objectsWalked.toLocaleString()} objects / ${bytes(data.objectBytes)}. Free blocks: ${data.freeBlocks.toLocaleString()} / ${bytes(data.freeBytes)}. Captured: ${data.objects.length.toLocaleString()} objects, ${data.edges.length.toLocaleString()} edges, ${data.roots.length.toLocaleString()} root/handle records.`,
    `Native map: ${data.nativeMapSource}. ${data.clrNativeHeaps.length} CLR-native heap ranges identified (JIT/loader/handle heaps, where available). Managed regions, stacks and native mapping fragments share one address-sorted packing. Native fragments exclude addresses already represented by managed object ranges and stack boxes. Ownership labels describe the original mapping's overlaps, not exclusive fragment ownership.`,
    'Box volume is proportional to bytes at 32 bytes per cubic scene unit, with a minimum side of 0.9. Objects, stack extents and native fragments use the same scale, without a maximum size cap. Selection adds an outline, never inflates the object. Region wireframes are packing guides, not measured allocations.',
    'Physical GC region / segment grouping is always enabled and uses real ClrMD segment IDs and boundaries. Labels use Region N/Gen N and Heap N/address; runtime IDs stay in the underlying identity/grouping. A generation can occupy several regions; a classic ephemeral segment can contain several generations. No fixed-size subdivision is guessed.',
    'Physical-mode heap containers are visual groups, not additional allocations or one contiguous address interval. Objects and preserved gap volumes keep their exact sizes and within-segment layout. References and root slots follow the moved physical units; native ranges remain separately represented. This describes virtual GC organization, not physical RAM pages.',
    'Regions are sorted by exact virtual address and packed across x/z/y; unmapped gaps BETWEEN regions are condensed. WITHIN each region, every leading/inter-object/trailing address span reserves byte-proportional volume in address order. Small visual gutters and shelf slack are additional; Euclidean distance is still not linear pointer distance.',
    'Borderless floor labels give the actual region address span and remain readable from above/below. The arrows label only X width, Y height, and Z depth, not hypothetical byte quantities. Address order advances along +X, then +Z rows, then +Y layers; wrapping resets earlier axes, and variable object heights mean center Y alone is not address order.',
    'Solid neutral-gray gap outlines identify authoritative ClrMD IsFree ranges. Darker dashed-gray outlines identify other uncovered spans, which may contain sampled-out objects, alignment, allocation contexts or unwalkable memory. Up to 5,000 largest gap outlines are always shown; all gap volumes participate in packing.',
    data.freeRangesIncluded ? `Free-range metadata: ${data.freeRanges.length.toLocaleString()} ranges captured${data.freeRangesTruncated || data.invalidFreeRanges ? '; classification is partial' : ''}.` :
      'This older snapshot lacks free-range metadata. Its address gaps are preserved but unclassified; reanalysis with the updated analyzer identifies confirmed GC free blocks.',
    'Incoming and outgoing depth controls live in the object/group inspector and traverse each direction independently (0-5 hops). Defaults cap exploration at 2,000 objects, 6,000 edges and 100,000 scans per phase. Full-object/reference display modes remove their corresponding limits; direction/depth remain intentional scope limits.',
    'Retaining-path queries run on demand against the indexed graph. All retaining routes are the finite union of captured source-to-target branches, with shared nodes and cycles merged; not an enumeration of infinitely many walks. Weak handles/annotations are not seeds. Finalization is conservative, and permanent/registered sources without slots do not receive fabricated addresses.',
    'Choose All captured (100%) for objects and All eligible (100%) for references to remove display caps. This does not repeat analysis or recover omitted heap objects/references; missing endpoints cannot be drawn. Enable both, clear selection/filters and use nonzero context opacity for the broadest available graph. Dense views use simpler line tessellation without omitting eligible edges.',
    'Object budget percentages use all successfully walked heap objects; rendered coverage also reports the percentage of captured objects. Counts refer to objects included in the scene, not only pixels inside the camera view. Faint context counts unless its opacity is zero. Reference percentages use captured object-to-object edges, not root links; when analysis is sampled/capped/incomplete, the total heap reference count is unknown.',
    'Selection always keeps unrelated displayed objects, stacks, roots, cards and native memory as non-pickable 5% context, without moving or resizing them. Press Escape outside the dump dialog to clear selection.',
    'Same-region references always use short paths between facing object surfaces or actual array slots, constrained to that region; they never visit an outside regional trunk. Only inter-region references bundle. Each directed region-pair/reference-kind bundle has ONE trunk, with unique array-slot inlets kept separate. Trunk area grows with reference count up to the radius cap; it does not mean bytes or distinct retaining paths.',
    'Inter-region bundles choose the closest pair of six face-center ports (+/- X, Y, Z), then use outward-facing junctions and smooth branches/trunks. Small collars identify used routing ports, not GC roots. The choice minimizes port-to-port distance in this layout, not a global obstacle-avoidance or heap-address distance.',
    'Array source slots use object address + target pointer size + ClrMD data-relative byte offset. The exact address is shown in reference labels. Pointer-sized cells are folded into a cubic grid inside the array box, including header offsets; this is address-grounded placement, not a literal physical 3D array. Root slots inside arrays use the same mapping. Dependent handles have no fabricated array slot.',
    'Approaching a foreground array fades its shell toward 18% opacity. Fully opaque far arrays still participate in solid-object occlusion; revealed arrays and other transparent surfaces do not write depth. Connections/signals draw after glass, but still respect opaque objects. Array slot markers and animated packets share the same internal reference anchors.',
    'Object type coloring is the default. Each type name hashes to a deterministic shade within the current theme palette; colors are not unique IDs. Common-type swatches are shown in the legend; region outlines continue to identify generations.',
    'Inter-region object and root links always use bundled streams; same-region references use direct local arcs. Overview sampling reserves part of the node budget for complete reference pairs. Eligible object edges are sampled across the whole graph, not just its first segment.',
    'Prism is the default; Atlas, Matrix, Neon Circuit and Prism change presentation only. Addresses, byte sizes, topology, weak/dependent semantics and selection are unchanged. Signals always animate at the chosen speed along actual reference paths, not observed allocations or runtime traffic.',
    'Signals use denser packet trains and longer trails. Connection width is fixed at 1.5x; nominal relative thickness of aggregate trunks represents reference count, not retained bytes.',
    'Prism adds procedural managed-object surfaces: string stripes, array grids, granular objects and known scalar data-dashes. Native mappings stay plain amber. Pattern variation uses captured metadata and only uses previews when enabled during analysis; this is not a raw-byte map.',
    'Prism object illumination stays on faces, inner rims, edges and corners. Only references, routing ports and signal pulses feed the bloom pass; solid objects and opaque far arrays still occlude reference glow. Labels and selection remain crisp. Bloom can be disabled independently.',
    'Prism signals are golden pulses with warm-white heads and tapered directional tails traveling along actual reference paths inside cool streams. Tails shorten at the source rather than wrapping across endpoints. This remains illustrative animation of a static graph, not measured runtime traffic.',
    'Default display limits are 6,000 object edges, 4,000 root links and 10,000 root-slot markers; All captured references removes those limits. Native fragments remain capped at 5,000. Up to 240 trunks and 500 branches/arcs use tubes; every further piece uses batched lines with 24, 8 or 4 segments depending on graph density. Up to 96 actual paths carry animated packets/trails.',
    'Handle markers use their reported source-slot address, not the target object address. CLR StaticVar/ThreadStaticVar records may instead identify a storage-object anchor. Native root-address pages are 4 KiB buckets, not inferred allocation boundaries. Native/stack offsets use a quantized address lattice; managed-array slots lie inside the array, while other managed-object slots project onto its face. Roots without usable addresses are explicitly thread-associated or unlocated.',
    'Stack roots have labeled stack-range frames. Weak links (muted/pink in Atlas) are weak handles or named-field annotations, not independent retaining roots. Dependent edges (orange in Atlas) retain a secondary only if their primary is live. The link legend follows the current theme. Stack traces are capped at 64 frames.',
    'Region labels keep readable screen-size limits but fade smoothly with absolute and relative distance. The selected region remains emphasized; overlapping labels are suppressed. Labels remain non-pickable and do not write depth. Shaded beads distinguish roots from array-reference slots.',
    'Ctrl-click targets a single rendered root or array-reference slot through container shells. A single-site selection highlights only its connection. X or clicking the same site clears it; right-drag is reserved for orbit-mode panning. Inspect target expands the ordinary object neighborhood.',
    'No symbols are downloaded. Only analyze trusted dumps; this process isolation is not a security sandbox. Clear removes temporary dump and graph files; an abrupt process kill can leave files in the OS temp Heapscape folder.',
    'Root types are also shown on object hover for the selected collection generation. Root-provenance stripes compose with Prism material textures and array opacity instead of replacing those surfaces. Partial capture labels report observed categories, not an exhaustive root set.',
    'Collection scope is shown only under Highlight objects. Normal root provenance uses the full root graph; card scans use Gen 0 by default and report their scope. Card source candidates overlap dirty source memory, while young descendants follow captured dirty old-to-young slots. Per-table Scan toggles combine multiple tables without asserting exclusive retention or an exact live-GC scan trace.',
    'Unreachable analysis is unavailable for incomplete/unverified graphs; choosing it leaves the overview visible instead of suggesting a proven empty set. Unknown may include live and dead objects. Full GC changes collection scope, not capture completeness. On a complete verified graph, reachable and unreachable partition collectible objects; frozen/permanent objects remain outside collection. Increasing the rendering budget cannot recover omitted paths.',
    'Only focused views add 3D cones near reference sources and targets. The source cone points away along the real curve; the target cone points toward the target. Cones cover drawn references (subject to reference-budget limits), do not replace edges, and are not interactive markers.',
    'Internal array-source cones, including roots stored in arrays, are sized to pointer cells and limited to a quarter of the ordinary source length. They do not grow to the pipe minimum radius. Incoming target cones and external object arrows retain normal sizing.',
    'Gen 0/1 models conservatively include uncollected older generations and finalization registrations. Weak handles and field annotations do not seed provenance. Suppression, resurrection, mutation and concurrent GC prevent unconditional next-GC predictions. Partial captures may omit additional root types.',
    'Finalizer queue and fReachable queue cubes are separate logical sections of the same ClrMD-reported native slot storage. The ready-root range becomes fReachable; the remaining registered range is not yet ready. Empty sections have labeled zero-byte wireframe markers, not fabricated allocations. Each slot/reference originates in its own section; native mappings exclude only the real ranges.',
    'Card grids decode verified Windows x64 CoreCLR 10.0 card words: one bit per 256 source bytes, 32 bits per little-endian word, using the biased ClrSubHeap.CardTable base. Frozen memory is not applicable. Unsupported, unreadable, or uncaptured card states are unknown, not clean. Capture is capped at one million card cells.',
    'Card sheets project over the covered region; they are not additional allocations. Selecting a dirty card follows captured slots from uncollected older objects into condemned younger objects and their in-scope descendants. This is a nonexclusive retaining path, not proof the card alone causes survival or that all objects covered by it are live.',
    ...data.warnings,
  ]) $('warnings').append(element('p', message));
  deselect(false); render(); atlas.overview(); search();
}
function deselect(redraw = true) {
  const hadSelection = Boolean(selected || selectedSite || selectedObjects || selectedCard || $('unreachable').checked);
  if (redraw) $('unreachable').checked = false;
  selected = null; selectedSite = null; selectedObjects = null; selectedQuery = ''; atlas?.mark(null);
  clearGraphModes();
  inspectedItem = null;
  $('tooltip').hidden = true;
  $('details').replaceChildren(element('p', 'Nothing selected.', 'muted'),
    element('p', 'Click a box to inspect. Ctrl-click or R+click picks one root/slot. F toggles flight, G focuses, Space toggles slow flight, Shift holds fast flight, and X clears selection.'));
  $('neighborhood-status').textContent = 'Select an object to explore its reference neighborhood.';
  if (redraw && hadSelection) render();
}
function selectItem(item) {
  if (item.kind === 'cardTableToggle') { toggleCardTable(item.value.segment); return; }
  if (item.kind === 'card') { selectCard(item.value); return; }
  if (item.site) { selectSite(item.site); return; }
  if (item.kind === 'object') {
    if (selected === item.value.id) deselect();
    else selectObject(item.value.id);
    return;
  }
  function selectCard(selection) {
    if (selectedCard?.segment === selection.segment && selectedCard.index === selection.index) { deselect(); return; }
    cardIndex ??= indexCards(data, index);
    let evidence;
    try { evidence = cardEvidence(selection, cardIndex, index, cardScope()); }
    catch (error) { status(error.message, true); return; }
    clearGraphModes();
    selected = null; selectedSite = null; selectedCard = selection; selectedCardEvidence = evidence;
    selectedObjects = new Set([...evidence.sources, ...evidence.reachable]); selectedQuery = `Card ${evidence.start}`;
    if ($('budget').value !== 'all' && selectedObjects.size > Number($('budget').value)) $('budget').value = 'all';
    render(); inspect({ kind: 'card', value: selectedCardEvidence });
  }
  deselect();
  if (item.position) atlas.mark(item.position, item.size);
  inspect(item);
}
function toggleCardTable(segment) {
  cardIndex ??= indexCards(data, index);
  const next = new Set(selectedCardTables);
  if (next.has(segment)) next.delete(segment); else next.add(segment);
  if (!next.size) { deselect(); return; }
  let evidence;
  try { evidence = cardTableEvidence(next, cardIndex, index, cardScope()); }
  catch (error) { status(error.message, true); return; }
  clearGraphModes();
  selected = null; selectedSite = null; selectedCardTables = next; selectedCardEvidence = evidence;
  selectedObjects = new Set([...evidence.sources, ...evidence.reachable]); selectedQuery = 'Card scan candidates';
  render(); inspect({ kind: 'cardTables', value: selectedCardEvidence });
  atlas.refreshCursorHover();
}
function selectSite(site, focus = false) {
  let resolved;
  try { resolved = resolveSite(site, index); }
  catch (error) { status(`Cannot select this root/slot: ${error.message}`, true); return; }
  if (siteKey(selectedSite) === resolved.key) { deselect(); return; }
  clearGraphModes();
  selected = null; selectedObjects = null; selectedSite = site;
  render();
  if (resolved.kind === 'root') inspect({ kind: 'root', value: resolved.root });
  else inspect({ kind: 'slot', value: { edge: resolved.edge, address: arraySlotAddress(index.objects.get(resolved.source), resolved.edge, data.architecture) } });
  if (focus && atlas.selectedPosition) atlas.focus(atlas.selectedPosition);
}
function facts(values, className) {
  const dl = document.createElement('dl');
  if (className) dl.className = className;
  for (const [key, value] of Object.entries(values)) {
    const parts = [element('dt', key), element('dd', String(value ?? 'unavailable'))];
    if (className) {
      const field = element('div', '', 'fact'); field.append(...parts); dl.append(field);
    } else dl.append(...parts);
  }
  $('details').append(dl);
  return dl;
}
function link(text, detail, callback, container = $('details')) {
  const button = element('button', text, 'ref');
  if (detail) button.append(element('small', detail));
  button.addEventListener('click', callback);
  container.append(button);
}
function depthControls() {
  const controls = element('div', '', 'reference-depths');
  for (const direction of ['incoming', 'outgoing']) {
    const label = element('label', `${direction === 'incoming' ? 'Incoming' : 'Outgoing'} depth`);
    const input = element('select', ''); input.id = `${direction}-depth`;
    for (let value = 0; value <= 5; value++) {
      const option = element('option', String(value)); option.value = String(value); input.append(option);
    }
    input.value = String(direction === 'incoming' ? incomingDepth : outgoingDepth);
    input.addEventListener('change', () => {
      if (direction === 'incoming') incomingDepth = Number(input.value); else outgoingDepth = Number(input.value);
      selectedRoutes = null; render(); inspect(inspectedItem);
    });
    label.append(input); controls.append(label);
  }
  $('details').append(controls);
}
function selectObject(id, focus = false) {
  const object = index.objects.get(id);
  if (!object) {
    status(`Object ${id} is outside the captured graph, invalid, or omitted by the analysis cap.`, true);
    return;
  }
  clearGraphModes();
  selected = id; selectedSite = null; selectedObjects = null;
  render(); inspect({ kind: 'object', value: object });
  if (focus) atlas.focus(atlas.layout.objectPosition(object));
}
function rootDetails(root) {
  const location = atlas.layout.roots.get(root.id);
  $('details').append(element('p', `${root.kind}: ${root.label}`));
  facts({ 'reported address': root.address, placement: location?.placement, 'address region': location?.region.id,
    retaining: root.finalization && !root.strong ? 'registered finalization (conservative GC retention)' :
      root.annotation ? 'not asserted - field annotation' : root.strong, pinned: root.pinned, interior: root.interior, thread: root.thread, target: root.target, dependent: root.dependentTarget });
  if (root.target) link('Inspect target', root.target, () => selectObject(root.target, true));
  if (location?.region.kind === 'finalizerQueue')
    link('Inspect queue section', location.region.value.title, () => jumpRegion(location.region.id));
  if (location) link('Focus root slot', root.address, () => {
    const marker = atlas.siteItems.get(`root:${root.id}`);
    atlas.mark(location.position, marker?.size ?? [0.3, 0.3, 0.3], 'site'); atlas.focus(location.position);
  });
}
function inspect(item) {
  inspectedItem = item;
  const value = item.value;
  $('details').replaceChildren(element('h3', item.kind === 'object' ? value.type : item.kind === 'native' ? 'Virtual memory range' :
    item.kind === 'rootGroup' ? `${value.kind}` : item.kind === 'root' ? `${value.kind} root slot` :
      item.kind === 'slot' ? 'Array reference slot' : item.kind === 'objects' ? `${value.ids.size.toLocaleString()} selected objects` :
        item.kind === 'gap' ? value.kind === 'free' ? 'Confirmed GC free range' : 'Uncaptured / unclassified range' :
          item.kind === 'cardTables' ? `${value.tables.length} card table${value.tables.length === 1 ? '' : 's'} selected` :
          item.kind === 'card' ? `${value.dirty ? 'Dirty' : 'Clean'} GC card` : item.kind === 'cardMap' ? 'GC card map' :
            item.kind === 'finalizerQueue' ? `${value.title} / Heap ${value.heap}` :
          item.kind === 'gcHeap' ? `Heap ${value.value.heap ?? '?'}` :
            item.kind === 'segment' && atlas.layout.physical ? regionLabel(atlas.layout.segments.get(value.id), true).split('\n')[0] : value.id));
  if (item.kind === 'object') {
    const outgoing = index.outgoing.get(value.id) ?? [], incoming = index.incoming.get(value.id) ?? [];
    const roots = index.roots.get(value.id) ?? [];
    const region = atlas.layout.segments.get(value.segment);
    const essential = facts({ address: value.address, bytes: value.size.toLocaleString(),
      generation: value.generation.replace(/^Generation(\d+)$/, 'Gen $1'),
      segment: `${region.physicalLabel} / Heap ${region.value.heap ?? '?'}` }, 'paired-facts');
    const regionLink = element('a', `${region.physicalLabel} / Heap ${region.value.heap ?? '?'}`, 'region-reference');
    regionLink.href = '#'; regionLink.dataset.regionId = region.id;
    regionLink.addEventListener('click', event => { event.preventDefault(); jumpRegion(region.id); });
    essential.querySelectorAll('dd')[3].replaceChildren(regionLink);
    const reach = reachableBy(gcAnalysis, value.id, provenanceScope());
    const provenance = element('dl', '', 'object-reachability'), sources = element('dd', '', `reach-${reach.state.replace(' ', '-')}`);
    if (reach.types.length) {
      const list = element('ul', '', 'reachable-types');
      for (const type of reach.types) list.append(element('li', type));
      sources.append(list);
    } else sources.textContent = reach.state === 'not reachable' ? 'Not reachable' : 'Unknown - incomplete capture';
    provenance.append(element('dt', 'Reachable by'), sources); $('details').append(provenance);
    if (value.preview !== null && value.preview !== undefined) facts({ preview: value.preview });
    depthControls();
    link('Focus object [G]', null, () => atlas.focus(atlas.layout.objectPosition(value)));
    link('Frame reference neighborhood', 'Fit highlighted objects and their pipes, without the faint background', () => atlas.overview(atlas.neighborhoodBounds));
    link('Find one retaining path', 'On demand; captured retaining sources only', () => {
      const path = retainingPath(value.id, index);
      if (!path.root) {
        $('details').append(element('p', path.limited ? 'Search limit reached. No conclusion about liveness.' : 'No path found in the captured graph. This does not prove the object is dead or leaked.'));
        return;
      }
      $('details').append(element('h3', `Path from ${path.root.kind}`), element('p', path.root.label));
      const ids = [path.root.target, ...path.edges.map(e => e.target)];
      for (let i = 0; i < Math.min(ids.length, 100); i++) {
        const id = ids[i];
        link(index.objects.get(id)?.type ?? id, i === 0 ? 'root target' : path.edges[i - 1].label, () => selectObject(id, true));
      }
      if (ids.length > 100) $('details').append(element('p', `Showing 100 of ${ids.length} path nodes.`));
    });
    link('Show all retaining routes', 'Combined graph of every captured retaining source, with cycles merged', () => {
      try {
        selectedRoutes = retainingRoutes(value.id, index);
        render(); inspect(item); atlas.overview(atlas.neighborhoodBounds);
      } catch (error) { status(error.message, true); }
    });
    if (selectedRoutes) {
      const routes = element('details', '', 'retaining-routes'); routes.open = true;
      routes.append(element('summary', `${selectedRoutes.roots.length.toLocaleString()} retaining sources`),
        element('p', `${lastShown.visible.toLocaleString()} / ${selectedRoutes.ids.size.toLocaleString()} route objects shown; ${selectedRoutes.edges.length.toLocaleString()} captured references. Shared branches and cycles are merged, not enumerated as individual paths.`, 'muted'));
      if (!gcAnalysis.complete) routes.append(element('p', 'Partial capture: additional routes may be missing.', 'muted'));
      for (const root of selectedRoutes.roots.slice(0, 80))
        link(root.kind, root.label, () => root.permanent || root.synthetic ? selectObject(root.target, true) : selectSite({ kind: 'root', id: root.id }, true), routes);
      if (selectedRoutes.roots.length > 80) routes.append(element('p', 'Showing the first 80 source records; the route graph includes all captured sources.'));
      $('details').append(routes);
    }
    $('details').append(element('h2', `Direct roots / handles (${roots.length})`));
    for (const root of roots.slice(0, 40)) link(`${root.kind}${root.finalization ? ' [finalization]' : root.annotation ? ' [field annotation]' : root.strong ? '' : ' [weak / conditional]'}`,
      `${root.address} ${root.label}`, () => selectSite({ kind: 'root', id: root.id }));
    if (roots.length > 40) $('details').append(element('p', `Showing first 40 of ${roots.length} records.`));
    for (const [title, edges, incomingDirection] of [['Outgoing', outgoing, false], ['Incoming', incoming, true]]) {
      $('details').append(element('h2', `${title} (${edges.length})`));
      for (const edge of edges.slice(0, 80)) {
        const id = incomingDirection ? edge.source : edge.target;
        const source = index.objects.get(edge.source);
        const slot = source ? arraySlotAddress(source, edge, data.architecture) : null;
        link(index.objects.get(id)?.type ?? `${id} [not captured]`,
          `${edge.kind}: ${edge.label}${slot ? ` | source slot ${slot} (Ctrl-click selects slot)` : ''}`,
          event => event.ctrlKey && slot ? selectSite({ kind: 'slot', edge }, true) : selectObject(id, true));
      }
      if (edges.length > 80) $('details').append(element('p', `Showing first 80 of ${edges.length} references.`));
    }
  } else if (item.kind === 'objects') {
    const matches = [...value.ids].map(id => index.objects.get(id));
    facts({ search: value.query, selected: matches.length.toLocaleString(),
      'combined object bytes': bytes(matches.reduce((sum, object) => sum + object.size, 0)),
      scope: 'all matching captured objects, not just the first 40 results; depth controls expand their combined neighborhood' });
    depthControls();
    link('Frame selected objects [G]', null, () => atlas.overview(atlas.selectedObjectBounds));
    link('Frame combined references', null, () => atlas.overview(atlas.neighborhoodBounds));
    link('Clear selection [X]', null, () => deselect());
    $('details').append(element('p', `First ${Math.min(40, matches.length)} selected objects:`, 'muted'));
    for (const object of matches.slice(0, 40)) link(object.type, object.address, () => selectObject(object.id, true));
  } else if (item.kind === 'segment') {
    const region = atlas.layout.segments.get(value.id);
    facts({ runtime: value.runtime, heap: value.heap, kind: value.kind, start: value.start, end: value.end,
      committed: `${value.committed.start} - ${value.committed.end}`, reserved: `${value.reserved.start} - ${value.reserved.end}`,
      gen0: `${value.gen0.start} - ${value.gen0.end}`, gen1: `${value.gen1.start} - ${value.gen1.end}`, gen2: `${value.gen2.start} - ${value.gen2.end}` });
    facts({ 'region address span': bytes(Number(BigInt(region.end) - BigInt(region.start))),
      'address order': '+X along each row, then +Z to the next row, then +Y to the next layer; X/Z reset when wrapping.',
      'ruler interpretation': 'X is width, Y is height, and Z is depth. These are visual axes, not byte distances; only the address-span label measures region memory.' });
    cardTableFacts(value.runtime, value.heap);
    if (atlas.layout.physical) {
      facts({ 'physical unit': region.physicalLabel, 'captured objects': region.capturedObjects,
        'generation membership (captured)': [...region.generationCounts].map(([generation, count]) => `${generation}: ${count.toLocaleString()}`).join('\n') || 'no captured objects' });
      link('Inspect owning GC heap', `Heap ${region.value.heap ?? '?'}`, () => jumpRegion(region.heapContainer.id));
    }
    facts({ 'confirmed free bytes': bytes(region.freeBytes), 'other uncovered bytes': bytes(region.unrepresentedBytes),
      'address-gap volumes': region.gaps.length, classification: data.freeRangesIncluded ? 'ClrMD free ranges + unclassified remainder' : 'legacy snapshot: free-block ranges unavailable' });
    const gaps = [...region.gaps].sort((a, b) => b.bytes - a.bytes);
    $('details').append(element('h2', `Address gaps (${gaps.length.toLocaleString()})`));
    for (const gap of gaps.slice(0, 80)) link(`${gap.kind === 'free' ? 'GC free' : 'Unrepresented'}: ${bytes(gap.bytes)}`,
      `${gap.start} - ${gap.end}`, () => inspect({ kind: 'gap', value: gap }));
    if (gaps.length > 80) $('details').append(element('p', 'Showing the 80 largest gaps; every gap still reserves its full volume.'));
  } else if (item.kind === 'gcHeap') {
    facts({ runtime: value.value.runtime, 'GC heap': value.value.heap, 'physical regions / segments': value.children.length,
      'captured objects': value.capturedObjects,
      'generation membership (captured)': [...value.generationCounts].map(([generation, count]) => `${generation}: ${count.toLocaleString()}`).join('\n'),
      interpretation: 'visual grouping of reported CLR allocation units; not an additional allocation or one contiguous address range' });
    cardTableFacts(value.value.runtime, value.value.heap);
    $('details').append(element('h2', 'Physical regions / segments'));
    for (const region of value.children.slice(0, 120))
      link(regionLabel(region, true).split('\n')[0], `Heap ${region.value.heap ?? '?'}/${region.start} - ${region.end}`, () => jumpRegion(region.id));
    if (value.children.length > 120) $('details').append(element('p', 'Showing the first 120 physical units; the region selector includes all of them.'));
  } else if (item.kind === 'finalizerQueue') {
    facts({ 'section range': `${value.storage.start} - ${value.storage.end}`,
      'section bytes': Number(BigInt(value.storage.end) - BigInt(value.storage.start)),
      'captured slots': value.entries.length, state: value.empty ? 'empty; wireframe marker, not an allocated-memory volume' :
        value.phase === 'ready' ? 'ready for finalization (fReachable)' : 'registered for finalization',
      'shared queue storage': `${value.fullStorage.start} - ${value.fullStorage.end}`,
      'unreadable slots (whole queue)': value.unreadableSlots, truncated: value.truncated,
      semantics: value.phase === 'ready' ? 'strong GC roots pending finalizer execution' :
        'finalizer registrations, not the ready-root queue; conservative finalization retention still applies' });
    link('Frame queue sections', null, () => {
      const sections = [...atlas.layout.finalizers.values()].filter(section => section.value.queueId === value.queueId);
      const low = [0, 1, 2].map(axis => Math.min(...sections.map(section => section.position[axis] - section.size[axis] / 2)));
      const high = [0, 1, 2].map(axis => Math.max(...sections.map(section => section.position[axis] + section.size[axis] / 2)));
      atlas.focus(low.map((minimum, axis) => (minimum + high[axis]) / 2), low.map((minimum, axis) => high[axis] - minimum));
    });
    for (const section of atlas.layout.finalizers.values())
      if (section.value.queueId === value.queueId && section.id !== value.id)
        link(`Inspect ${section.value.title}`, section.empty ? 'empty' : `${section.value.entries.length} captured slots`, () => jumpRegion(section.id));
    for (const entry of value.entries.slice(0, 100)) {
      const root = (index.allRoots ?? data.roots).find(root => root.address === entry.address && root.target === entry.target && /Finaliz/.test(root.kind));
      if (root) link(entry.ready ? 'Ready finalizer' : 'Registered finalizer', `${entry.address} -> ${entry.target}`, () => selectSite({ kind: 'root', id: root.id }));
      else $('details').append(element('p', `${entry.address}: ${entry.target ?? 'empty / unavailable'}`));
    }
  } else if (item.kind === 'cardTables') {
    facts({ 'scan scope': `Gen ${value.generation}`, 'selected tables': value.tables.length,
      'dirty cards': value.dirtyCards, 'source scan candidates': value.sources.size, 'young descendants via dirty slots': value.reachable.size,
      'card coverage': value.tables.some(table => table.status === 'truncated') ? 'Partial capture; additional scan candidates are unknown' : 'All selected card cells decoded',
      'highlighted objects shown': `${lastShown.selectedCount.toLocaleString()} / ${new Set([...value.sources, ...value.reachable]).size.toLocaleString()}`,
      interpretation: 'Source objects overlap dirty card memory, including those with no captured young target. Descendants are observed old-to-young retention paths, not exclusive causality or a trace of a live GC.' });
    link('Frame scan candidates', null, () => atlas.overview(atlas.selectedObjectBounds));
    for (const table of value.tables) link(`Stop scanning ${atlas.layout.segments.get(table.segment).physicalLabel}`, null, () => toggleCardTable(table.segment));
    if (!gcAnalysis?.complete) $('details').append(element('p', 'Graph capture is incomplete; additional scan sources and young descendants may be missing.'));
  } else if (item.kind === 'cardMap') {
    facts({ region: value.segment, status: value.status, reason: value.reason, 'captured cards': value.count, 'total cards': value.totalCount });
  } else if (item.kind === 'card') {
    facts({ 'source address range': `${value.start} - ${value.end}`, enabled: value.dirty, 'scan scope': `Gen ${value.generation}`, 'card size': value.info.cardSize,
      'table memory': value.info.tableAddress, 'captured pointer slots': value.slots.length,
      'source scan candidates': value.sources.size, 'contributing old-to-young slots': value.contributing.length, 'reachable condemned objects': value.reachable.size,
      interpretation: 'Source candidates overlap dirty memory; target descendants follow captured old-to-young slots. This is not exclusive causality or a trace of objects actually scanned by a live GC.' });
    link('Toggle whole card table scan', null, () => toggleCardTable(value.info.segment));
    link('Frame card region', null, () => jumpRegion(value.info.segment));
    if (value.reachable.size) link('Frame card referents', null, () => atlas.overview(atlas.selectedObjectBounds));
    for (const { edge, slot } of value.contributing.slice(0, 100))
      link(index.objects.get(edge.target)?.type ?? edge.target, `${slot} -> ${edge.target}`, () => selectObject(edge.target, true));
    if (!gcAnalysis?.complete) $('details').append(element('p', 'Graph capture is incomplete; additional referents may be missing.'));
  } else if (item.kind === 'gap') {
    facts({ start: value.start, end: value.end, bytes: value.bytes, region: value.segment,
      'region offset': `+0x${(BigInt(value.start) - BigInt(value.region.start)).toString(16)}`,
      evidence: value.kind === 'free' ? 'ClrMD identified a free object covering this address range' :
        'No captured object/free-block metadata covers this range; it may be omitted allocation, alignment, allocation-context space or unavailable data',
      layout: 'byte-proportional reserved volume; visual gutters are separate' });
    link('Frame this gap', null, () => { atlas.mark(value.position, value.size); atlas.focus(value.position, value.size); });
    link('Inspect containing region', value.segment, () => jumpRegion(value.segment));
  } else if (item.kind === 'native') {
    facts({ start: value.start, end: value.end, 'displayed fragment': bytes(value.size), 'original mapping': `${value.mappingStart} - ${value.mappingEnd} (${bytes(value.mappingSize)})`, state: value.state, kind: value.kind, protection: value.protection, 'original mapping overlap labels': value.owners.join('\n') });
  } else if (item.kind === 'thread') {
    facts({ 'OS thread': value.osId, 'managed thread': value.managedId, alive: value.alive, finalizer: value.finalizer, start: value.stackStart, end: value.stackEnd });
    $('details').append(element('pre', value.frames.join('\n')));
    const roots = data.roots.filter(r => r.thread === value.id);
    $('details').append(element('h2', `${roots.length} stack / thread-static roots`));
    for (const root of roots.slice(0, 100)) link(root.kind, `${root.address} -> ${root.target ?? 'unresolved interior root'}`,
      () => selectSite({ kind: 'root', id: root.id }));
    if (roots.length > 100) $('details').append(element('p', `Showing first 100 of ${roots.length} records.`));
  } else if (item.kind === 'rootGroup') {
    facts({ start: value.start ?? 'unavailable', end: value.end ?? 'unavailable', 'known native mapping': value.mapped ?? false });
    $('details').append(element('p', `${value.roots.length} records. Displaying first 100. Address buckets are not inferred allocation boundaries. Weak/dependent handles do not independently keep objects alive.`));
    for (const root of value.roots.slice(0, 100)) link(root.address, root.target ?? 'unresolved / null',
      () => selectSite({ kind: 'root', id: root.id }));
  } else if (item.kind === 'root') {
    rootDetails(value);
    link('Frame selected root connection', null, () => atlas.overview(atlas.neighborhoodBounds));
  } else if (item.kind === 'slot') {
    const edge = value.edge;
    facts({ 'source slot': value.address, 'source array': edge.source, 'reference offset': edge.offset,
      target: edge.target, 'target type': index.objects.get(edge.target)?.type ?? 'not captured',
      semantics: 'one captured array reference; not independently classified as a GC root' });
    link('Focus selected slot [G]', value.address, () => atlas.focus(atlas.selectedPosition));
    link('Frame selected slot connection', null, () => atlas.overview(atlas.neighborhoodBounds));
    link('Inspect source array', null, () => selectObject(edge.source, true));
    link('Inspect target', null, () => selectObject(edge.target, true));
  }
  if (item.position) link('Focus selection [G]', null, () => atlas.focus(item.position, item.size));
}
function cardTableFacts(runtime, heap) {
  const info = data.gcHeaps?.find(item => item.runtime === runtime && item.heap === heap);
  if (!info) return;
  facts({ 'card-table indexing base': info.cardTable === '0x0' ? 'not reported' : info.cardTable,
    'reported heap address bounds': `${info.lowestAddress} - ${info.highestAddress}`,
    'card-table view': 'decoded region grids are always shown; this indexing base is not an allocation start' });
}
function layoutRegion(id) {
  return atlas?.layout?.segments.get(id) ?? atlas?.layout?.threads.get(id) ??
    atlas?.layout?.rootRegions.get(id) ?? atlas?.layout?.gcHeaps.get(id) ?? atlas?.layout?.finalizers.get(id);
}
function jumpRegion(id, redraw = true) {
  const region = layoutRegion(id);
  if (!region) return;
  deselect(false); if (redraw) render();
  atlas.mark(region.position, region.size); atlas.focus(region.position, region.size);
  atlas.activeLabelRegion = id; atlas.lastLabels = -Infinity;
  atlas.updateLabels();
  inspect({ kind: region.kind === 'rootRegion' ? 'rootGroup' : region.kind,
    value: region.kind === 'gcHeap' ? region :
      region.kind === 'rootRegion' ? { ...region.value, start: region.start, end: region.end } : region.value });
}
function search() {
  $('results').replaceChildren();
  $('results').scrollTop = 0; $('find-panel').scrollTop = 0;
  $('select-matches').disabled = true;
  $('select-matches').textContent = 'Select all results';
  if (!data) { $('search-status').textContent = 'Open a dump to find objects.'; return; }
  const query = $('search').value.trim();
  if (!query) { $('search-status').textContent = 'Search all captured types, addresses and available previews.'; return; }
  const matches = findObjects(data, query);
  $('search-status').textContent = `${matches.length.toLocaleString()} matches; showing up to 40. Select all includes every matching captured object.`;
  $('select-matches').disabled = matches.length === 0;
  $('select-matches').textContent = `Select all ${matches.length.toLocaleString()} results`;
  for (const object of matches.slice(0, 40)) {
    const result = element('button', object.type, 'result');
    result.append(element('small', `${object.address} | ${object.generation} | ${bytes(object.size)}`));
    result.addEventListener('click', () => selectObject(object.id, true));
    $('results').append(result);
  }
}
function selectMatches() {
  if (!data) return;
  const query = $('search').value.trim(), matches = findObjects(data, query);
  if (!matches.length) { search(); return; }
  clearGraphModes(); selected = null; selectedSite = null; selectedQuery = query;
  selectedObjects = new Set(matches.map(object => object.id));
  const raisedBudget = $('budget').value !== 'all' && matches.length > Number($('budget').value);
  if (raisedBudget) $('budget').value = 'all';
  render(); inspect({ kind: 'objects', value: { ids: selectedObjects, query: selectedQuery } });
  atlas.overview(atlas.selectedObjectBounds);
  status(`Selected all ${matches.length.toLocaleString()} matching captured objects.${raisedBudget ? ' Object budget raised to All captured so no matches are omitted.' : ''}`);
}
async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { 'X-Heapscape': '1', ...init.headers } });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).error ?? text; } catch { /* HTTP errors can be plain text. */ }
    throw new Error(`${response.status}: ${message || response.statusText}`);
  }
  return response;
}
function setDumpBusy(busy, uploading = false) {
  dumpBusy = busy;
  $('dump').disabled = busy; $('previews').disabled = busy;
  $('clear').disabled = !busy || !uploading;
  for (const button of $('saved').querySelectorAll('button')) button.disabled = busy;
}
async function clear() {
  ++operation;
  request?.abort(); uploadController?.abort();
  if (job) {
    await api(`/api/dumps/${job}`, { method: 'DELETE' });
    job = null;
  }
  data = null; index = null; selected = null; selectedSite = null; selectedObjects = null; selectedQuery = ''; inspectedItem = null;
  gcAnalysis = null; cardIndex = null; clearGraphModes(); updateReachability();
  lastShown = null;
  atlas?.disposeContent();
  if (atlas) { atlas.data = null; atlas.index = null; atlas.layout = null; }
  $('welcome').hidden = false; $('clear').disabled = true; $('dump').disabled = false;
  setDumpBusy(false);
  $('dump').value = ''; $('progress').hidden = true;
  $('details').replaceChildren(element('p', 'Dump cleared.'));
  $('neighborhood-status').textContent = 'Select an object to explore its reference neighborhood.';
  $('reference-status').textContent = 'Open a dump to see object reference coverage.';
  $('object-budget-status').textContent = 'Open a dump to see object coverage.';
  $('root-status').textContent = 'Root-link coverage is counted separately from object references.';
  $('gap-status').textContent = 'Region layouts preserve gaps between object addresses.';
  $('physical-layout-status').textContent = 'Opt-in: group reported regions/segments by runtime and GC heap. These are virtual-memory allocations, not physical RAM pages.';
  for (const option of $('budget').options) option.textContent = option.value === 'all' ? 'All captured (100%)' : Number(option.value).toLocaleString();
  $('reference-budget').options[0].textContent = '6,000 object / 4,000 root links';
  $('full-display-warning').hidden = true;
  $('warnings').textContent = 'Only analyze trusted dumps on a trusted local machine.';
  search(); $('counts').textContent = 'No dump loaded';
  status('Ready. Dump and analysis removed from server storage.');
  await refreshJobs();
}
async function refreshJobs() {
  const jobs = await (await api('/api/dumps')).json();
  $('saved').replaceChildren();
  for (const saved of jobs) {
    const row = element('div', '', 'saved-job');
    if (saved.state === 'ready') {
      const open = element('button', `Open ${saved.name}`, 'result');
      open.dataset.jobId = saved.id;
      open.disabled = dumpBusy;
      open.addEventListener('click', async () => {
        if (dumpBusy) return;
        const current = ++operation;
        setDumpBusy(true);
        try {
          uploadController?.abort();
          uploadController = new AbortController();
          job = saved.id;
          const response = await api(`/api/dumps/${job}/graph`, { signal: uploadController.signal });
          const snapshot = await readSnapshot(response.body, received => {
            if (current === operation) status(`Loading complete object graph... ${bytes(received)} received.`);
          });
          if (current !== operation) return;
          load(snapshot, saved.name);
          $('clear').disabled = true;
          status(`Loaded ${saved.name}.`);
          $('dump-dialog').close();
        } catch (error) { if (error.name !== 'AbortError') status(error.message, true); }
        finally { if (current === operation) setDumpBusy(false); }
      });
      row.append(open);
    } else row.append(element('p', `${saved.name}: ${saved.state}${saved.error ? ` - ${saved.error}` : ''}`, 'muted'));
    const remove = element('button', `Remove ${saved.name}`, 'result');
    remove.disabled = dumpBusy;
    remove.addEventListener('click', async () => {
      try {
        if (job === saved.id) await clear();
        else { await api(`/api/dumps/${saved.id}`, { method: 'DELETE' }); await refreshJobs(); }
      } catch (error) { status(error.message, true); }
    });
    row.append(remove); $('saved').append(row);
  }
}
async function upload(file) {
  if (!file) return;
  if (dumpBusy) { status('A dump operation is already in progress.', true); return; }
  if (file.size > 2 * 1024 ** 3 || file.size < 32) { status('Select a valid dump between 32 bytes and 2 GiB.', true); return; }
  uploadController?.abort();
  job = null;
  const current = ++operation;
  $('saved').replaceChildren();
  setDumpBusy(true, true); $('progress').hidden = false;
  status(`Uploading ${file.name} (${bytes(file.size)})...`);
  try {
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); request = xhr;
      xhr.open('POST', `/api/dumps?name=${encodeURIComponent(file.name)}&previews=${$('previews').checked}`);
      xhr.setRequestHeader('X-Heapscape', '1'); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable) $('progress').value = e.loaded / e.total * 100; };
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText);
          xhr.status === 202 ? resolve(result) : reject(new Error(result.error ?? xhr.statusText));
        } catch (error) { reject(error); }
      };
      xhr.onerror = () => reject(new Error('Upload failed. Is the local server running?'));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      xhr.send(file);
    });
    if (current !== operation) {
      await api(`/api/dumps/${result.id}`, { method: 'DELETE' });
      return;
    }
    job = result.id; request = null;
    $('progress').removeAttribute('value'); status('Analyzing in an isolated ClrMD worker...');
    uploadController = new AbortController();
    while (current === operation) {
      const state = await (await api(`/api/dumps/${job}`, { signal: uploadController.signal })).json();
      if (state.state === 'failed') throw new Error(state.error);
      if (state.state === 'ready') {
        status('Loading the object graph...');
        const response = await api(`/api/dumps/${job}/graph`, { signal: uploadController.signal });
        const snapshot = await readSnapshot(response.body, received => {
          if (current === operation) status(`Loading complete object graph... ${bytes(received)} received.`);
        });
        if (current !== operation) return;
        load(snapshot, file.name);
        status(`Loaded ${file.name}. ${snapshot.objectsTruncated || snapshot.edgesTruncated || snapshot.rootsTruncated ? 'Partial graph: see coverage.' : 'Select an object to follow its references.'}`);
        $('dump-dialog').close();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  } catch (error) {
    if (current === operation && error.name !== 'AbortError') status(error.message, true);
  } finally {
    if (current === operation) {
      request = null;
      $('progress').hidden = true; $('dump').value = ''; setDumpBusy(false);
      await refreshJobs();
    }
  }
}
function updateFlightSpeed(mode = atlas?.flightSpeedMode() ?? 'normal') {
  $('flight-hint').dataset.speed = mode;
  $('flight-hint').textContent = `${mode[0].toUpperCase() + mode.slice(1)} flight | Space toggle slow | Hold Shift fast | R+click root or slot | G focus | X clears | F flight`;
  $('navigation').textContent = atlas?.flight.isLocked
    ? `${mode.toUpperCase()} | SPACE toggle slow | SHIFT fast | G focus | F flight`
    : 'WASD pan | Q/E rotate | G focus | F flight';
}
try {
  atlas = new Atlas($('viewport'), selectItem, (item, event) => {
    $('tooltip').hidden = !item;
    $('crosshair').dataset.hit = item ? 'true' : 'false';
    if (!item) return;
    $('tooltip').replaceChildren();
    const heading = item.kind === 'object' ? `${item.value.type} | ${bytes(item.value.size)} | ${item.value.address}` :
      item.kind === 'card' ? `Card ${item.value.index}: ${item.value.dirty ? 'DIRTY' : 'clean'} | ${item.value.segment}` :
      item.kind === 'cardMap' ? `Card map: ${item.value.status}` :
      item.kind === 'cardTableToggle' ? `${item.value.active ? 'Stop' : 'Highlight'} dirty-card scan candidates / Gen ${item.value.generation}` :
      item.kind === 'root' ? `${item.value.kind} slot | ${item.value.address}` :
      item.kind === 'slot' ? `Array slot ${item.value.address} -> ${index.objects.get(item.value.edge.target)?.type ?? item.value.edge.target}` :
      item.kind === 'native' ? `${item.value.kind} | ${bytes(item.value.size)} | ${item.value.start}` : item.value.kind ?? item.value.id;
    $('tooltip').append(element('div', heading));
    if (item.kind === 'object') $('tooltip').append(element('div',
      rootHoverText(gcAnalysis, item.value.id, provenanceScope()), 'tooltip-root-types'));
    const bounds = $('tooltip').getBoundingClientRect();
    $('tooltip').style.left = `${Math.max(8, Math.min(event.clientX + 16, innerWidth - bounds.width - 8))}px`;
    $('tooltip').style.top = `${Math.max(8, Math.min(event.clientY + 16, innerHeight - bounds.height - 8))}px`;
  }, flying => {
    $('crosshair').hidden = !flying;
    $('flight-hint').hidden = !flying;
    $('fly').textContent = flying ? 'Leave flight [F / Esc]' : 'Enter flight [F]';
    updateFlightSpeed();
    $('tooltip').hidden = true;
  }, deselect, updateFlightSpeed);
} catch (error) {
  status(`WebGL initialization failed: ${error.message}`, true);
  $('dump').disabled = true; $('fly').disabled = true;
}
function applyTheme() {
  const theme = getTheme($('theme').value);
  document.documentElement.dataset.theme = $('theme').value;
  $('material-legend-section').hidden = !theme.semantic;
  $('legend-panel').hidden = !theme.semantic;
  $('material-legend').replaceChildren();
  if (theme.semantic) {
    for (const [category, descriptor] of Object.entries(semanticMaterials)) {
      const row = element('div', '', 'material-card');
      row.dataset.material = category; row.style.setProperty('--material-color', descriptor.color);
      const description = element('span', descriptor.label);
      description.append(element('small', descriptor.pattern));
      row.append(element('span', '', 'material-swatch'), description);
      $('material-legend').append(row);
    }
  }
  atlas?.setTheme($('theme').value);
  render();
  if (inspectedItem) inspect(inspectedItem);
}
function applyMotion() {
  document.documentElement.dataset.motion = 'on';
  atlas?.setAnimation(true, 3);
}
applyTheme(); applyMotion();
$('theme').addEventListener('change', applyTheme);
for (const id of ['unreachable', 'gc-generation', 'highlight-state']) $(id).addEventListener('change', () => {
  if (id === 'unreachable' || (id === 'gc-generation' || id === 'highlight-state') && $('unreachable').checked) deselect(false);
  updateReachability(); render();
  if (selectedCard) inspect({ kind: 'card', value: selectedCardEvidence });
  else if (selectedCardTables.size) inspect({ kind: 'cardTables', value: selectedCardEvidence });
  else if (inspectedItem) inspect(inspectedItem);
  atlas?.refreshCursorHover();
});
for (const id of ['budget', 'reference-budget']) $(id).addEventListener('change', () => { render(); if (inspectedItem) inspect(inspectedItem); });
$('color').addEventListener('change', () => { render(); if (inspectedItem) inspect(inspectedItem); });
$('explore').addEventListener('toggle', () => { if (!$('explore').open) $('controls').scrollTop = 0; });
$('find-objects').addEventListener('toggle', () => { if (!$('find-objects').open) $('find-panel').scrollTop = 0; });
$('reserved').addEventListener('change', () => { deselect(false); render(); atlas?.overview(); });
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 180); });
$('select-matches').addEventListener('click', selectMatches);
$('dump').addEventListener('change', e => upload(e.target.files[0]).catch(error => status(error.message, true)));
$('clear').addEventListener('click', () => clear().catch(error => status(error.message, true)));
$('home').addEventListener('click', () => atlas?.overview());
$('deselect').addEventListener('click', () => deselect());
$('fly').addEventListener('click', () => {
  if (!atlas) return;
  atlas.toggleFlight();
});
$('open-dump').addEventListener('click', () => {
  if (atlas?.flight.isLocked) atlas.flight.unlock();
  $('dump-dialog').showModal();
  refreshJobs().catch(error => status(error.message, true));
});
$('close-dump').addEventListener('click', () => $('dump-dialog').close());
for (const event of ['keydown', 'keyup']) $('dump-dialog').addEventListener(event, event => event.stopPropagation());
$('legends').addEventListener('toggle', () => { if (!$('legends').open) $('legend-panel').scrollTop = 0; });
refreshJobs().catch(error => status(`Cannot contact local server: ${error.message}`, true));
