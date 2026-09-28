using System.Text.Json;
using MemoryFlight;
using Microsoft.Diagnostics.Runtime;
using System.Buffers.Binary;

int checks = 0;
var snapshots = new Dictionary<string, Snapshot>(StringComparer.OrdinalIgnoreCase);
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    checks++;
}
string temp = Path.Combine(Path.GetTempPath(), $"memoryflight-check-{Guid.NewGuid():N}.dmp");
try
{
    using (var writer = new BinaryWriter(File.Create(temp)))
    {
        writer.Write(0x504d444dU); writer.Write(0U);
        writer.Write(1U); writer.Write(32U);
        writer.Write(new byte[16]);
        writer.Write(16U); writer.Write(64U); writer.Write(44U);
        writer.Write(16U); writer.Write(48U); writer.Write(1UL);
        writer.Write(0xffff000000000000UL); writer.Write(0xffff000000000000UL);
        writer.Write(4U); writer.Write(0U); writer.Write(4096UL);
        writer.Write(0x1000U); writer.Write(4U); writer.Write(0x20000U); writer.Write(0U);
    }
    var map = NativeMap.Read(temp);
    Check(map.Areas.Count == 1, "Native region count");
    Check(map.Areas[0].Start == "0xffff000000000000", "Native addresses must retain all 64 bits");
    Check(map.Areas[0].End == "0xffff000000001000", "Native range end");
    Check(map.Areas[0].State == "committed" && map.Areas[0].Kind == "private", "Native mapping classification");
    using (var stream = File.OpenWrite(temp)) stream.SetLength(60);
    bool rejected = false;
    try { NativeMap.Read(temp); } catch (InvalidDataException) { rejected = true; }
    Check(rejected, "Truncated metadata must fail explicitly");
}
finally { File.Delete(temp); }

byte[] cardWords = new byte[8];
BinaryPrimitives.WriteUInt32LittleEndian(cardWords, 0x80000001);
BinaryPrimitives.WriteUInt32LittleEndian(cardWords.AsSpan(4), 3);
Check(GcNativeCapture.DecodeRuns(cardWords, 31, 3).SequenceEqual([new CardRunInfo(0, 3)]), "Dirty bits cross little-endian card-word boundaries");
Check(GcNativeCapture.DecodeRuns(cardWords, 1, 4).Count == 0, "Clean card bits are not inferred dirty");

foreach (string file in args)
{
    if (file.EndsWith(".dmp", StringComparison.OrdinalIgnoreCase))
    {
        using var target = DataTarget.LoadDump(file, new DataTargetOptions { SymbolPaths = [] });
        int slots = 0, objectArraySlots = 0;
        for (int runtimeIndex = 0; runtimeIndex < target.ClrVersions.Length; runtimeIndex++)
        {
            var info = target.ClrVersions[runtimeIndex];
            using var runtime = info.CreateRuntime();
            if (snapshots.TryGetValue(Path.GetFileName(file), out var captured) && captured.FreeRangesIncluded)
            {
                if (captured.SchemaVersion >= 5)
                {
                    var exportedObjects = captured.Objects.Where(obj => obj.Id.StartsWith($"r{runtimeIndex}:", StringComparison.Ordinal))
                        .ToDictionary(obj => obj.Id);
                    long references = 0;
                    foreach (var segment in runtime.Heap.Segments)
                    foreach (var candidate in segment.EnumerateObjects(carefully: true))
                    {
                        if (!candidate.IsValid || candidate.IsFree) continue;
                        Check(exportedObjects.Remove(Format.ObjectId(runtimeIndex, candidate.Address), out var exportedObject) &&
                            exportedObject.Size == candidate.Size && exportedObject.Generation == segment.GetGeneration(candidate.Address).ToString(),
                            "Every ClrMD object is captured with its exact size and generation, including beyond the old cap");
                        references += candidate.EnumerateReferencesWithFields(carefully: true, considerDependantHandles: false).LongCount();
                    }
                    Check(exportedObjects.Count == 0, "Complete graph contains no invented objects");
                    Check(references == captured.Edges.LongCount(edge => edge.Kind == "reference" &&
                        edge.Source.StartsWith($"r{runtimeIndex}:", StringComparison.Ordinal)),
                        "Every ClrMD field/array reference is captured, including beyond the old edge cap");
                }
                if (captured.ReachabilityMetadataIncluded)
                {
                    foreach (var heap in runtime.Heap.SubHeaps)
                    {
                        var evidence = captured.GcHeaps.Single(item => item.Runtime == runtimeIndex && item.Heap == heap.Index);
                        Check(evidence.CardTable == Format.Hex(heap.CardTable), "Card-table pointer matches ClrMD");
                        Check(evidence.LowestAddress == Format.Hex(heap.LowestAddress) && evidence.HighestAddress == Format.Hex(heap.HighestAddress),
                            "Card-table heap bounds match ClrMD");
                    }
                    if (!captured.FinalizableObjectsTruncated)
                    {
                        var expected = runtime.Heap.EnumerateFinalizableObjects().Where(obj => obj.IsValid)
                            .Select(obj => Format.ObjectId(runtimeIndex, obj.Address)).ToHashSet();
                        var exportedFinalizers = captured.FinalizableObjects.Where(id => id.StartsWith($"r{runtimeIndex}:", StringComparison.Ordinal)).ToHashSet();
                        Check(expected.SetEquals(exportedFinalizers), "Finalizable registrations match actual ClrMD enumeration");
                    }
                }
                if (captured.GcNativeMetadataIncluded)
                {
                    byte[] wordBytes = new byte[4];
                    foreach (var heap in runtime.Heap.SubHeaps)
                    {
                        var queue = captured.FinalizationQueues.Single(item => item.Runtime == runtimeIndex && item.Heap == heap.Index);
                        Check(queue.Storage.Start == Format.Hex(heap.FinalizerQueueObjects.Start) && queue.Storage.End == Format.Hex(heap.FinalizerQueueObjects.End),
                            "Finalization storage matches the DAC range");
                        Check(queue.Ready.Start == Format.Hex(heap.FinalizerQueueRoots.Start) && queue.Ready.End == Format.Hex(heap.FinalizerQueueRoots.End),
                            "fReachable storage matches ClrMD's ready-root range");
                        foreach (var entry in queue.Entries.Where(entry => entry.Target is not null))
                        {
                            ulong slot = Convert.ToUInt64(entry.Address[2..], 16);
                            Check(entry.Ready == (slot >= heap.FinalizerQueueRoots.Start && slot < heap.FinalizerQueueRoots.End),
                                "Finalization slot readiness matches the reported fReachable bounds");
                            Check(target.DataReader.ReadPointer(slot, out ulong pointer) && entry.Target == Format.ObjectId(runtimeIndex, pointer),
                                "Finalization source slot holds the exported object pointer");
                        }
                    }
                    foreach (var card in captured.CardRegions.Where(item => item.Status is "decoded" or "truncated" && item.Count > 0))
                    {
                        var segment = runtime.Heap.Segments.FirstOrDefault(segment => card.Segment == $"r{runtimeIndex}:s{Format.Hex(segment.Start)}");
                        if (segment is null) continue;
                        for (int i = 0; i < card.Count; i += Math.Max(1, card.Count / 128))
                        {
                            ulong objectAddress = Convert.ToUInt64(card.Start[2..], 16) + (ulong)i * 256;
                            ulong bit = objectAddress / 256;
                            ulong address = segment.SubHeap.CardTable + bit / 32 * 4;
                            Check(target.DataReader.Read(address, wordBytes) == 4, "Card word exists in source dump");
                            bool dirty = (BinaryPrimitives.ReadUInt32LittleEndian(wordBytes) & (1u << (int)(bit % 32))) != 0;
                            Check(dirty == card.DirtyRuns.Any(run => i >= run.Start && i < run.Start + run.Count),
                                "Exported card state matches the actual GC card bit");
                        }
                    }
                }
                var exported = captured.FreeRanges.Where(range => range.Segment.StartsWith($"r{runtimeIndex}:", StringComparison.Ordinal))
                    .ToDictionary(range => (range.Segment, range.Start));
                foreach (var segment in runtime.Heap.Segments)
                foreach (var candidate in segment.EnumerateObjects(carefully: true))
                {
                    if (!candidate.IsValid || !candidate.IsFree) continue;
                    string segmentId = $"r{runtimeIndex}:s{Format.Hex(segment.Start)}";
                    if (exported.Remove((segmentId, Format.Hex(candidate.Address)), out var range))
                        Check(range.Size == candidate.Size && range.End == Format.Hex(candidate.Address + candidate.Size),
                            "Exported free range matches the actual ClrMD free object");
                    else
                        Check(captured.FreeRangesTruncated || captured.InvalidFreeRanges > 0, "Every real free block is exported unless explicitly limited");
                }
                Check(exported.Count == 0, "No invented free ranges in the snapshot");
            }
            foreach (var obj in runtime.Heap.EnumerateObjects(carefully: true))
            {
                if (!obj.IsValid || obj.IsFree || !obj.IsArray) continue;
                foreach (var reference in obj.EnumerateReferencesWithFields(carefully: true, considerDependantHandles: false))
                {
                    Check(reference.Offset >= 0, "Array reference has a data-relative byte offset");
                    ulong offset = checked((ulong)target.DataReader.PointerSize + (ulong)reference.Offset);
                    Check(offset + (ulong)target.DataReader.PointerSize <= obj.Size, "Reference slot is inside the array");
                    ulong slot = checked(obj.Address + offset);
                    Check(target.DataReader.ReadPointer(slot, out ulong pointer) && pointer == reference.Object.Address,
                        $"Array slot {Format.Hex(slot)} must contain the reported target {Format.Hex(reference.Object.Address)}");
                    slots++;
                    if (obj.Type?.Name == "System.Object[]") objectArraySlots++;
                    if (slots >= 10000) break;
                }
                if (slots >= 10000) break;
            }
        }
        Check(slots > 0 && objectArraySlots > 0, "Real dump contains verified reference-array and object[] slots");
        Console.WriteLine($"{Path.GetFileName(file)}: verified {slots:N0} array slots ({objectArraySlots:N0} object[] slots); source + pointer size + ClrMD offset");
        continue;
    }
    await using var stream = File.OpenRead(file);
    var data = await JsonSerializer.DeserializeAsync<Snapshot>(stream, Format.Json)
        ?? throw new InvalidDataException("Empty snapshot");
    snapshots[data.Name] = data;
    Check(data.Objects.Count > 0, "Real dump contains objects");
    Check(data.Edges.Count > 0, "Real dump contains references");
    Check(data.Threads.Count > 0, "Real dump contains CLR threads");
    Check(data.Roots.Any(r => r.Kind == "Stack"), "Real dump contains stack roots");
    Check(data.Roots.Any(r => r.Strong), "Real dump contains retaining roots");
    Check(data.Roots.Where(r => r.Annotation).All(r => !r.Strong), "Field annotations must not assert unconditional retention");
    Check(data.NativeAreas.Count > 0, "Real dump contains native mappings");
    Check(data.Objects.All(o => o.Address.StartsWith("0x")), "Object addresses use hex strings");
    Check(data.Objects.Select(o => o.Id).Distinct().Count() == data.Objects.Count, "Object identity must be unique");
    var ids = data.Objects.Select(o => o.Id).ToHashSet();
    Check(data.Edges.All(e => ids.Contains(e.Source) || e.Kind == "dependent"), "Reference sources are captured objects");
    if (data.FreeRangesIncluded)
    {
        Check(data.SchemaVersion < 5 || !data.FreeRangesTruncated, "Full analyses do not truncate free ranges");
        ulong freeBytes = 0;
        var segments = data.Segments.ToDictionary(segment => segment.Id);
        foreach (var range in data.FreeRanges)
        {
            ulong low = Convert.ToUInt64(range.Start[2..], 16), high = Convert.ToUInt64(range.End[2..], 16);
            Check(high > low && high - low == range.Size, "Free range has exact byte bounds");
            Check(segments.TryGetValue(range.Segment, out var segment) &&
                low >= Convert.ToUInt64(segment.Start[2..], 16) && high <= Convert.ToUInt64(segment.End[2..], 16),
                "Free range is contained by its region");
            freeBytes += range.Size;
        }
        Check(data.FreeRangesTruncated || data.InvalidFreeRanges > 0 || freeBytes == data.FreeBytes,
            "Complete free-range bytes match the heap-walk total");
    }
    if (data.SchemaVersion >= 5)
    {
        Check(data.Objects.Count == data.ObjectsWalked, "Every walked object must be captured");
        Check(!data.ObjectsTruncated && !data.EdgesTruncated && !data.RootsTruncated && !data.FinalizableObjectsTruncated,
            "Complete graph capture must not silently sample objects, references, roots or finalization registrations");
        Check(data.FinalizationQueues.All(queue => !queue.Truncated), "Finalization source slots must not be capped");
        Check(data.Edges.All(edge => ids.Contains(edge.Source) && ids.Contains(edge.Target)),
            "Every reference endpoint in the complete fixture must be captured");
        Check(data.Roots.Where(root => root.Strong && !root.Annotation && root.Kind != "Dependent")
            .All(root => root.Target is not null && ids.Contains(root.Target)), "Every retaining root target must be captured");
        Check(data.FinalizableObjects.All(ids.Contains), "Every finalizable registration target must be captured");
    }
    if (Path.GetFileName(file).StartsWith("console", StringComparison.OrdinalIgnoreCase))
    {
        Check(data.Objects.Count(o => o.Type == "MemoryFlight.Fixtures.DemoNode") >= 670, "Console fixture node population");
        Check(data.Objects.Any(o => o.Generation == "Large"), "LOH recovered");
        Check(data.Objects.Any(o => o.Generation == "Pinned"), "POH recovered");
        Check(data.Objects.Any(o => o.Generation == "Generation0"), "Gen0 recovered");
        Check(data.Objects.Any(o => o.Generation == "Generation1"), "Gen1 recovered");
        Check(data.Objects.Any(o => o.Generation == "Generation2"), "Gen2 recovered");
        Check(data.Roots.Any(r => r.Kind == "Pinned" && r.Pinned), "Pinned handle recovered");
        Check(data.Roots.Any(r => r.Kind == "WeakShort" && !r.Strong), "Weak-short handle is not a retaining root");
        Check(data.Roots.Any(r => r.Kind == "WeakLong" && !r.Strong), "Weak-long handle is not a retaining root");
        Check(data.Edges.Any(e => e.Kind == "dependent"), "ConditionalWeakTable dependency recovered");
        Check(data.Roots.Any(r => r.Kind == "Static" && r.Label.EndsWith(".StaticRoot")), "Named static root recovered");
        Check(data.Roots.Any(r => r.Kind == "ThreadStatic" && r.Label.EndsWith(".ThreadRoot")), "Named thread-static root recovered");
        Check(data.Roots.Any(r => r.Kind == "FinalizerQueue"), "Ready-for-finalization roots recovered");
        Check(data.Objects.Any(o => o.Preview == "stack-only-root"), "Stack-local content recovered");
    }
    Console.WriteLine($"{Path.GetFileName(file)}: {data.Objects.Count:N0} objects, {data.Edges.Count:N0} references, {data.Roots.Count:N0} roots/handles, {data.NativeAreas.Count:N0} VM ranges");
}
Console.WriteLine($"PASS: {checks} checks");
