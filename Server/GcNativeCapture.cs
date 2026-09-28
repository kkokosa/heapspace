using System.Buffers.Binary;
using Microsoft.Diagnostics.Runtime;

namespace Heapscape;

public static class GcNativeCapture
{
    public const int CardSize = 256;
    public const int MaxCards = 1_000_000;

    public static void Capture(ClrRuntime runtime, int runtimeIndex, Snapshot snapshot)
    {
        snapshot.GcNativeMetadataIncluded = true;
        int cardsRemaining = MaxCards - snapshot.CardRegions.Sum(region => region.Count);
        foreach (var heap in runtime.Heap.SubHeaps)
        {
            var storage = heap.FinalizerQueueObjects;
            var ready = heap.FinalizerQueueRoots;
            var entries = new List<FinalizationEntryInfo>();
            int unreadable = 0;
            int width = runtime.DataTarget.DataReader.PointerSize;
            if (storage.End < storage.Start || (storage.End - storage.Start) % (ulong)width != 0 ||
                ready.Start < storage.Start || ready.End > storage.End || ready.End < ready.Start)
            {
                unreadable++;
            }
            else
            {
                for (ulong slot = storage.Start; slot < storage.End; slot += (ulong)width)
                {
                    if (!runtime.DataTarget.DataReader.ReadPointer(slot, out ulong target))
                    {
                        unreadable++; continue;
                    }
                    string? id = null;
                    if (target != 0)
                    {
                        var obj = runtime.Heap.GetObject(target);
                        if (obj.IsValid) id = Format.ObjectId(runtimeIndex, target);
                        else unreadable++;
                    }
                    entries.Add(new($"finalizer:r{runtimeIndex}:h{heap.Index}:{Format.Hex(slot)}", Format.Hex(slot),
                        id, slot >= ready.Start && slot < ready.End));
                }
            }
            snapshot.FinalizationQueues.Add(new($"finalization:r{runtimeIndex}:h{heap.Index}", runtimeIndex, heap.Index,
                new(Format.Hex(storage.Start), Format.Hex(storage.End)), new(Format.Hex(ready.Start), Format.Hex(ready.End)),
                entries, false, unreadable));
            snapshot.InvalidFinalizableObjects += unreadable;
            foreach (var segment in heap.Segments)
            {
                string id = $"r{runtimeIndex}:s{Format.Hex(segment.Start)}";
                CardRegionInfo info;
                if (segment.Kind == GCSegmentKind.Frozen)
                    info = Unavailable(id, "not-applicable", "Frozen memory is outside ordinary generational card scanning.");
                else if (snapshot.Architecture != "X64" || snapshot.Platform != "WINDOWS" ||
                    runtime.ClrInfo.Version.Major != 10 || runtime.ClrInfo.Version.Minor != 0)
                    info = Unavailable(id, "unsupported", "Card decoding is verified only for Windows x64 CoreCLR 10.0 (256-byte cards, little-endian uint32 words).");
                else
                    info = ReadCards(runtime, segment, id, cardsRemaining);
                cardsRemaining -= info.Count;
                snapshot.CardRegions.Add(info);
            }
        }
        if (snapshot.CardRegions.Any(region => region.Status is "unsupported" or "unreadable" or "truncated"))
            snapshot.Warnings.Add("Some card maps are unsupported, unreadable, or capped. Unknown card states are not treated as clean.");
    }

    private static CardRegionInfo Unavailable(string id, string status, string reason) =>
        new(id, 0, "0x0", 0, 0, "0x0", status, reason, []);

    private static CardRegionInfo ReadCards(ClrRuntime runtime, ClrSegment segment, string id, int remaining)
    {
        var heap = segment.SubHeap;
        if (segment.End < segment.Start || heap.CardTable == 0 || segment.Start < heap.LowestAddress || segment.End > heap.HighestAddress)
            return Unavailable(id, "unreadable", "Missing card-table base or inconsistent heap address bounds.");
        ulong first = segment.Start / CardSize;
        ulong total = segment.End == segment.Start ? 0 : segment.End / CardSize + (segment.End % CardSize == 0 ? 0UL : 1UL) - first;
        if (total > int.MaxValue) return Unavailable(id, "unsupported", "Region exceeds bounded card indexing.");
        int count = (int)Math.Min(total, (ulong)Math.Max(0, remaining));
        ulong start = first * CardSize;
        if (count == 0)
            return new(id, CardSize, Format.Hex(start), 0, (int)total, "0x0", total == 0 ? "decoded" : "truncated",
                total == 0 ? null : "Card display data reached the capture limit.", []);
        ulong word = first / 32;
        if (word > (ulong.MaxValue - heap.CardTable) / 4) return Unavailable(id, "unreadable", "Card-table address overflow.");
        ulong address = heap.CardTable + word * 4;
        int wordCount = checked(((int)(first % 32) + count + 31) / 32);
        byte[] buffer = new byte[checked(wordCount * 4)];
        if (runtime.DataTarget.DataReader.Read(address, buffer) != buffer.Length)
            return new(id, CardSize, Format.Hex(start), 0, (int)total, Format.Hex(address), "unreadable",
                "The dump does not contain the complete card-word range.", []);
        var runs = DecodeRuns(buffer, (int)(first % 32), count);
        return new(id, CardSize, Format.Hex(start), count, (int)total, Format.Hex(address), count == (int)total ? "decoded" : "truncated",
            count == (int)total ? null : "Card capture limit reached; remaining cards are unknown.", runs);
    }

    public static List<CardRunInfo> DecodeRuns(ReadOnlySpan<byte> words, int firstBit, int count)
    {
        if (firstBit is < 0 or > 31 || count < 0 || (long)firstBit + count > (long)words.Length / 4 * 32)
            throw new InvalidDataException("Card-word bounds do not cover the requested bits.");
        var runs = new List<CardRunInfo>();
        int run = -1;
        for (int i = 0; i < count; i++)
        {
            int bit = firstBit + i;
            uint word = BinaryPrimitives.ReadUInt32LittleEndian(words.Slice(bit / 32 * 4, 4));
            bool dirty = (word & (1u << (bit % 32))) != 0;
            if (dirty && run < 0) run = i;
            if (!dirty && run >= 0) { runs.Add(new(run, i - run)); run = -1; }
        }
        if (run >= 0) runs.Add(new(run, count - run));
        return runs;
    }
}
