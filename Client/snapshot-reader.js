import { JSONParser } from '@streamparser/json';

// Full heaps can exceed the engine's single-string limit. Parse bytes incrementally, not response.json().
export async function readSnapshot(chunks, onProgress = () => {}) {
  const parser = new JSONParser({ paths: ['$', '$.objects.*', '$.edges.*', '$.roots.*', '$.finalizableObjects.*'] });
  const ids = new Map(), strings = new Map();
  const intern = value => {
    if (typeof value !== 'string') return value;
    if (!strings.has(value)) strings.set(value, value);
    return strings.get(value);
  };
  let snapshot, received = 0, reported = 0;
  parser.onValue = ({ value, key, parent, stack }) => {
    if (stack.length === 0) { snapshot = value; return; }
    const collection = stack.at(-1).key;
    if (collection === 'objects') {
      ids.set(value.id, value.id);
      value.type = intern(value.type); value.segment = intern(value.segment); value.generation = intern(value.generation);
    } else if (collection === 'edges') {
      value.source = ids.get(value.source) ?? value.source;
      value.target = ids.get(value.target) ?? value.target;
      value.kind = intern(value.kind); value.label = intern(value.label);
    } else if (collection === 'roots') {
      value.target = ids.get(value.target) ?? value.target;
      value.dependentTarget = ids.get(value.dependentTarget) ?? value.dependentTarget;
    } else if (collection === 'finalizableObjects') parent[key] = ids.get(value) ?? value;
  };
  for await (const chunk of chunks) {
    parser.write(chunk);
    received += chunk.byteLength;
    if (received - reported >= 8 * 1024 * 1024) { reported = received; onProgress(received); }
  }
  if (!parser.isEnded) parser.end();
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.objects) || !Array.isArray(snapshot.edges) ||
    !Array.isArray(snapshot.roots) || !Array.isArray(snapshot.segments))
    throw new TypeError('Invalid memory snapshot: missing object graph arrays.');
  return snapshot;
}
