// ClrMD's all-object range contains the ready-root range; partition it rather than drawing both in full.
export function finalizationAreas(data) {
  const result = [];
  for (const queue of data.finalizationQueues ?? []) {
    const start = BigInt(queue.storage.start), end = BigInt(queue.storage.end);
    const readyStart = BigInt(queue.ready.start), readyEnd = BigInt(queue.ready.end);
    if (end < start || readyStart < start || readyEnd < readyStart || readyEnd > end)
      throw new RangeError(`Invalid finalization queue boundaries: ${queue.id}`);
    const pieces = readyStart === readyEnd
      ? [{ phase: 'registered', start, end }, { phase: 'ready', start: readyStart, end: readyEnd }]
      : [
        ...(start < readyStart ? [{ phase: 'registered', start, end: readyStart }] : []),
        { phase: 'ready', start: readyStart, end: readyEnd },
        ...(readyEnd < end ? [{ phase: 'registered', suffix: '-tail', start: readyEnd, end }] : []),
      ];
    if (!pieces.some(piece => piece.phase === 'registered'))
      pieces.unshift({ phase: 'registered', start, end: start });
    const areas = pieces.map(piece => ({
      ...queue, id: `${queue.id}:${piece.phase}${piece.suffix ?? ''}`, queueId: queue.id, phase: piece.phase,
      storage: { start: `0x${piece.start.toString(16)}`, end: `0x${piece.end.toString(16)}` },
      fullStorage: queue.storage, empty: piece.start === piece.end, entries: [],
      title: piece.phase === 'ready' ? 'fReachable queue' : `Finalizer queue${piece.suffix ? ' (tail)' : ''}`,
    }));
    for (const entry of queue.entries) {
      const slot = BigInt(entry.address);
      const area = areas.find(area => !area.empty && slot >= BigInt(area.storage.start) && slot < BigInt(area.storage.end));
      if (!area || entry.ready !== (area.phase === 'ready'))
        throw new RangeError(`Finalization slot classification disagrees with its reported range: ${entry.address}`);
      area.entries.push(entry);
    }
    result.push(...areas);
  }
  return result;
}

export function finalizationRoots(data) {
  const existing = new Set((data.roots ?? []).filter(root => /Finaliz/i.test(root.kind)).map(root => `${root.address}:${root.target}`));
  const result = [];
  for (const queue of finalizationAreas(data)) for (const entry of queue.entries) {
    if (!entry.target || existing.has(`${entry.address}:${entry.target}`)) continue;
    result.push({
      id: entry.id, address: entry.address, target: entry.target, kind: entry.ready ? 'FinalizerQueue' : 'FinalizationRegistration',
      label: entry.ready ? 'ready finalization queue slot' : 'registered finalization slot (conservative retention)',
      strong: entry.ready, annotation: false, pinned: false, interior: false, thread: null,
      finalization: true, queueId: queue.queueId,
    });
  }
  return result;
}
