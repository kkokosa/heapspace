using System.Globalization;
using Microsoft.Diagnostics.Runtime;

namespace Heapscape;

public sealed class DumpAnalyzer
{
    private readonly Snapshot snapshot = new();
    private readonly HashSet<(int Runtime, ulong Slot, ulong Object, ClrRootKind Kind)> rootIdentities = [];

    public Snapshot Analyze(string path, bool previews)
    {
        snapshot.PreviewsIncluded = previews;
        snapshot.FreeRangesIncluded = true;
        snapshot.ReachabilityMetadataIncluded = true;
        snapshot.HeapVerifiedForReachability = true;
        snapshot.Name = Path.GetFileName(path);
        using var target = DataTarget.LoadDump(path, new DataTargetOptions
        {
            // A dump must not cause network requests for symbols or paths chosen by its producer.
            SymbolPaths = [],
        });
        snapshot.Architecture = target.DataReader.Architecture.ToString();
        snapshot.Platform = target.DataReader.TargetPlatform.ToString();
        if (target.ClrVersions.Length == 0)
            throw new InvalidDataException("No CLR found. Use a full dump of a running .NET process.");
        foreach (var module in target.EnumerateModules())
            snapshot.Modules.Add(new(Path.GetFileName(module.FileName ?? "unknown"),
                Format.Hex(module.ImageBase), Format.Hex(checked(module.ImageBase + (ulong)Math.Max(0, module.ImageSize))), module.IsManaged));

        for (int index = 0; index < target.ClrVersions.Length; index++)
        {
            using var runtime = target.ClrVersions[index].CreateRuntime();
            AnalyzeRuntime(runtime, index);
        }
        var map = NativeMap.Read(path);
        snapshot.NativeMapSource = map.Source;
        snapshot.NativeAreas = map.Areas;
        LabelNativeAreas();
        snapshot.Warnings.Add("Heap walks describe a snapshot, not liveness. Unrooted objects are not automatically leaks. Corrupt or uncaptured memory may be unwalkable.");
        snapshot.Warnings.Add("Static/thread-static field labels are annotations, not independent retaining roots (collectible type lifetimes are conditional). Only ClrMD's GC-root enumeration starts retaining paths. Unavailable metadata can prevent field naming.");
        snapshot.Warnings.Add("Only CLR-known threads have stack traces/roots here. Native-only threads, malloc block boundaries, and arbitrary native-to-managed pointer ownership are not inferred.");
        snapshot.Warnings.Add("Region layouts preserve uncovered address spans as byte-proportional volumes. Only ClrMD IsFree ranges are classified as confirmed GC free space; other gaps can contain alignment, allocation contexts, or omitted/unwalkable objects. Shelf folding is not a linear byte-distance map.");
        if (snapshot.InvalidFreeRanges > 0) snapshot.Warnings.Add($"{snapshot.InvalidFreeRanges:N0} invalid free-block spans were excluded from free-range classification.");
        if (snapshot.InvalidObjects > 0) snapshot.Warnings.Add($"{snapshot.InvalidObjects:N0} invalid object candidates encountered during careful heap walking.");
        if (snapshot.HeapVerificationIssues > 0) snapshot.Warnings.Add($"{snapshot.HeapVerificationIssues:N0} objects failed ClrMD heap verification. Absence of a root path is not proof of unreachability.");
        if (snapshot.FinalizableObjectsTruncated || snapshot.InvalidFinalizableObjects > 0)
            snapshot.Warnings.Add("Finalization metadata is incomplete; collection eligibility cannot be established.");
        snapshot.Warnings.Add("Reachability predicts candidates within a verified captured graph, not guaranteed reclamation by the next GC. Registered finalizable objects and their descendants are conservatively protected; suppression/resurrection and concurrent runtime activity are not simulated.");
        return snapshot;
    }

    private void AnalyzeRuntime(ClrRuntime runtime, int index)
    {
        var heap = runtime.Heap;
        snapshot.Runtimes.Add(new(index, runtime.ClrInfo.Version.ToString(), heap.IsServer, heap.CanWalkHeap));
        if (!heap.CanWalkHeap)
            throw new InvalidDataException($"Runtime {index} heap cannot be walked. Capture a full dump at a stable point.");
        foreach (var subHeap in heap.SubHeaps)
            snapshot.GcHeaps.Add(new(index, subHeap.Index, subHeap.HasRegions, Format.Hex(subHeap.CardTable),
                Format.Hex(subHeap.LowestAddress), Format.Hex(subHeap.HighestAddress)));
        var types = new Dictionary<ulong, ClrType>();
        foreach (var segment in heap.Segments)
        {
            string segmentId = $"r{index}:s{Format.Hex(segment.Start)}";
            snapshot.Segments.Add(new(segmentId, index, segment.SubHeap.Index, segment.Kind.ToString(),
                Format.Hex(segment.Start), Format.Hex(segment.End), Range(segment.CommittedMemory),
                Range(segment.ReservedMemory), Range(segment.Generation0), Range(segment.Generation1), Range(segment.Generation2)));
            int ordinal = 0;
            foreach (var obj in segment.EnumerateObjects(carefully: true))
            {
                if (!obj.IsValid) { snapshot.InvalidObjects++; continue; }
                if (obj.IsFree)
                {
                    snapshot.FreeBlocks++; snapshot.FreeBytes += obj.Size;
                    if (obj.Size == 0 || obj.Address < segment.Start || obj.Address > segment.End || obj.Size > segment.End - obj.Address)
                        snapshot.InvalidFreeRanges++;
                    else
                        snapshot.FreeRanges.Add(new(segmentId, Format.Hex(obj.Address), Format.Hex(obj.Address + obj.Size),
                            obj.Size, segment.GetGeneration(obj.Address).ToString()));
                    continue;
                }
                snapshot.ObjectsWalked++;
                snapshot.ObjectBytes += obj.Size;
                var type = obj.Type!;
                types.TryAdd(type.MethodTable, type);
                snapshot.Objects.Add(new(Format.ObjectId(index, obj.Address), Format.Hex(obj.Address),
                    type.Name ?? "<unknown>", obj.Size, segmentId, segment.GetGeneration(obj.Address).ToString(),
                    obj.Address - segment.Start, checked(ordinal++), Preview(obj)));
                if (heap.IsObjectCorrupted(obj.Address, out _)) snapshot.HeapVerificationIssues++;
                foreach (var reference in obj.EnumerateReferencesWithFields(carefully: true, considerDependantHandles: false))
                    snapshot.Edges.Add(new(Format.ObjectId(index, obj.Address), Format.ObjectId(index, reference.Object.Address),
                        "reference", reference.Field?.Name ?? $"array/reference offset +{reference.Offset}", reference.Offset));
            }
        }
        if (snapshot.InvalidObjects > 0 || snapshot.HeapVerificationIssues > 0) snapshot.HeapVerifiedForReachability = false;
        foreach (var obj in heap.EnumerateFinalizableObjects())
        {
            if (!obj.IsValid) { snapshot.InvalidFinalizableObjects++; continue; }
            snapshot.FinalizableObjects.Add(Format.ObjectId(index, obj.Address));
        }
        GcNativeCapture.Capture(runtime, index, snapshot);
        foreach (var thread in runtime.Threads)
        {
            string id = $"r{index}:t{thread.OSThreadId}";
            snapshot.Threads.Add(new(id, index, thread.OSThreadId, thread.ManagedThreadId,
                Format.Hex(Math.Min(thread.StackBase, thread.StackLimit)), Format.Hex(Math.Max(thread.StackBase, thread.StackLimit)),
                thread.IsAlive, thread.IsFinalizer, thread.EnumerateStackTrace().Take(64).Select(f => f.ToString() ?? "<unknown frame>").ToList()));
            if (!thread.IsAlive) continue;
            foreach (var root in thread.EnumerateStackRoots())
                AddRoot(root, index, "Stack", root is ClrStackRoot stack
                    ? $"{stack.StackFrame} {stack.RegisterName} +{stack.RegisterOffset}"
                    : "stack root", true, id, heap);
        }
        foreach (var handle in runtime.EnumerateHandles())
        {
            string? dependent = handle.Dependent.IsNull ? null : Format.ObjectId(index, handle.Dependent.Address);
            AddRoot(handle, index, handle.HandleKind.ToString(), $"handle ({handle.HandleKind}), refcount {handle.ReferenceCount}",
                handle.IsStrong, null, heap, dependent);
            if (dependent is not null && !handle.Object.IsNull)
                snapshot.Edges.Add(new(Format.ObjectId(index, handle.Object.Address), dependent, "dependent", "dependent handle (conditional)", -1));
        }
        foreach (var root in heap.EnumerateFinalizerRoots())
            AddRoot(root, index, "FinalizerQueue", "ready for finalization (not all registered finalizable objects)", true, null, heap);
        // ClrMD also supplies async-pinned children and runtime-specific static-storage roots.
        foreach (var root in heap.EnumerateRoots())
            AddRoot(root, index, root.RootKind.ToString(), $"ClrMD GC root: {root.RootKind}", true, null, heap);
        foreach (var area in runtime.EnumerateClrNativeHeaps())
            snapshot.ClrNativeHeaps.Add(new(index, area.Kind.ToString(), area.State.ToString(),
                Format.Hex(area.MemoryRange.Start), Format.Hex(area.MemoryRange.End)));

        // Field labels augment GC roots; they must not turn weak handles into strong roots.
        foreach (var type in types.Values)
        {
            foreach (var field in type.StaticFields.Where(f => f.IsObjectReference))
            foreach (var domain in runtime.AppDomains)
            {
                if (!field.IsInitialized(domain)) continue;
                var obj = field.ReadObject(domain);
                if (!obj.IsValid) continue;
                AddAnnotation(index, obj, field.GetAddress(domain), "Static", $"{type.Name}.{field.Name}", null);
            }
            foreach (var field in type.ThreadStaticFields.Where(f => f.IsObjectReference))
            foreach (var thread in runtime.Threads)
            {
                if (!field.IsInitialized(thread)) continue;
                var obj = field.ReadObject(thread);
                if (!obj.IsValid) continue;
                AddAnnotation(index, obj, field.GetAddress(thread), "ThreadStatic", $"{type.Name}.{field.Name}", $"r{index}:t{thread.OSThreadId}");
            }
        }
    }

    private void AddAnnotation(int runtime, ClrObject obj, ulong address, string kind, string label, string? thread)
    {
        snapshot.Roots.Add(new($"root{snapshot.Roots.Count}", Format.ObjectId(runtime, obj.Address), Format.Hex(address),
            kind, label, false, false, false, thread, Annotation: true));
    }

    private void AddRoot(ClrRoot root, int runtime, string kind, string label, bool strong, string? thread, ClrHeap heap, string? dependent = null)
    {
        var obj = root.Object;
        if (root.IsInterior && !obj.IsValid && heap.Runtime.DataTarget.DataReader.ReadPointer(root.Address, out ulong pointer) && pointer != ulong.MaxValue)
        {
            var candidate = heap.FindPreviousObjectOnSegment(pointer + 1, carefully: true);
            if (candidate.IsValid && pointer >= candidate.Address && pointer - candidate.Address < candidate.Size)
                obj = candidate;
        }
        if (!rootIdentities.Add((runtime, root.Address, obj.Address, root.RootKind))) return;
        snapshot.Roots.Add(new($"root{snapshot.Roots.Count}", obj.IsValid ? Format.ObjectId(runtime, obj.Address) : null,
            Format.Hex(root.Address), kind, label, strong, root.IsPinned, root.IsInterior, thread, dependent));
    }

    private string? Preview(ClrObject obj)
    {
        if (!snapshot.PreviewsIncluded) return null;
        if (obj.Type?.IsString == true) return obj.AsString(160);
        if (obj.IsArray) return $"array length: {obj.AsArray().Length}";
        return null;
    }

    private void LabelNativeAreas()
    {
        var labels = new List<(ulong Start, ulong End, string Label)>();
        foreach (var s in snapshot.Segments)
        {
            labels.Add((Parse(s.Committed.Start), Parse(s.Committed.End), $"GC committed {s.Id}"));
            labels.Add((Parse(s.Reserved.Start), Parse(s.Reserved.End), $"GC reserved {s.Id}"));
        }
        foreach (var t in snapshot.Threads)
            labels.Add((Parse(t.StackStart), Parse(t.StackEnd), $"stack {t.Id}"));
        foreach (var m in snapshot.Modules)
            labels.Add((Parse(m.Start), Parse(m.End), $"module {m.Name}"));
        foreach (var h in snapshot.ClrNativeHeaps)
            labels.Add((Parse(h.Start), Parse(h.End), $"CLR native r{h.Runtime} {h.Kind} ({h.State})"));
        foreach (var area in snapshot.NativeAreas)
        {
            ulong start = Parse(area.Start), end = Parse(area.End);
            foreach (var label in labels)
                if (label.Start < label.End && start < label.End && label.Start < end)
                    area.Owners.Add($"overlaps {label.Label}");
            if (area.Owners.Count == 0) area.Owners.Add("unclassified native/OS mapping");
        }
    }

    private static ulong Parse(string hex) => ulong.Parse(hex.AsSpan(2), NumberStyles.HexNumber);
    private static AddressRange Range(MemoryRange range) => new(Format.Hex(range.Start), Format.Hex(range.End));
}
