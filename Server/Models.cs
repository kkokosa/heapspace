using System.Text.Json;

namespace MemoryFlight;

public static class Format
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static string Hex(ulong value) => $"0x{value:x}";
    public static string ObjectId(int runtime, ulong address) => $"r{runtime}:{Hex(address)}";
}

public sealed class Snapshot
{
    public int SchemaVersion { get; set; } = 5;
    public string Name { get; set; } = "";
    public string Architecture { get; set; } = "";
    public string Platform { get; set; } = "";
    public string NativeMapSource { get; set; } = "";
    public long ObjectsWalked { get; set; }
    public ulong ObjectBytes { get; set; }
    public long FreeBlocks { get; set; }
    public ulong FreeBytes { get; set; }
    public bool FreeRangesIncluded { get; set; }
    public bool FreeRangesTruncated { get; set; }
    public long InvalidFreeRanges { get; set; }
    public long InvalidObjects { get; set; }
    public bool ObjectsTruncated { get; set; }
    public bool EdgesTruncated { get; set; }
    public bool RootsTruncated { get; set; }
    public bool PreviewsIncluded { get; set; }
    public bool ReachabilityMetadataIncluded { get; set; }
    public bool HeapVerifiedForReachability { get; set; }
    public long HeapVerificationIssues { get; set; }
    public bool FinalizableObjectsTruncated { get; set; }
    public long InvalidFinalizableObjects { get; set; }
    public bool GcNativeMetadataIncluded { get; set; }
    public List<string> Warnings { get; set; } = [];
    public List<RuntimeInfo> Runtimes { get; set; } = [];
    public List<SegmentInfo> Segments { get; set; } = [];
    public List<ObjectInfo> Objects { get; set; } = [];
    public List<FreeRangeInfo> FreeRanges { get; set; } = [];
    public List<EdgeInfo> Edges { get; set; } = [];
    public List<RootInfo> Roots { get; set; } = [];
    public List<string> FinalizableObjects { get; set; } = [];
    public List<GcHeapInfo> GcHeaps { get; set; } = [];
    public List<FinalizationQueueInfo> FinalizationQueues { get; set; } = [];
    public List<CardRegionInfo> CardRegions { get; set; } = [];
    public List<ThreadInfo> Threads { get; set; } = [];
    public List<NativeArea> NativeAreas { get; set; } = [];
    public List<ModuleArea> Modules { get; set; } = [];
    public List<ClrNativeArea> ClrNativeHeaps { get; set; } = [];
}

public sealed record RuntimeInfo(int Id, string Version, bool ServerGc, bool CanWalkHeap);
public sealed record AddressRange(string Start, string End);
public sealed record SegmentInfo(string Id, int Runtime, int Heap, string Kind, string Start, string End,
    AddressRange Committed, AddressRange Reserved, AddressRange Gen0, AddressRange Gen1, AddressRange Gen2);
public sealed record ObjectInfo(string Id, string Address, string Type, ulong Size, string Segment,
    string Generation, ulong Offset, int Ordinal, string? Preview);
public sealed record FreeRangeInfo(string Segment, string Start, string End, ulong Size, string Generation);
public sealed record EdgeInfo(string Source, string Target, string Kind, string Label, int Offset);
public sealed record RootInfo(string Id, string? Target, string Address, string Kind, string Label,
    bool Strong, bool Pinned, bool Interior, string? Thread, string? DependentTarget = null, bool Annotation = false);
public sealed record ThreadInfo(string Id, int Runtime, uint OsId, int ManagedId, string StackStart,
    string StackEnd, bool Alive, bool Finalizer, List<string> Frames);
public sealed record NativeArea(string Start, string End, ulong Size, string State, string Kind,
    string Protection, List<string> Owners);
public sealed record ModuleArea(string Name, string Start, string End, bool Managed);
public sealed record ClrNativeArea(int Runtime, string Kind, string State, string Start, string End);
public sealed record GcHeapInfo(int Runtime, int Heap, bool HasRegions, string CardTable, string LowestAddress, string HighestAddress);
public sealed record FinalizationEntryInfo(string Id, string Address, string? Target, bool Ready);
public sealed record FinalizationQueueInfo(string Id, int Runtime, int Heap, AddressRange Storage, AddressRange Ready,
    List<FinalizationEntryInfo> Entries, bool Truncated, int UnreadableSlots);
public sealed record CardRunInfo(int Start, int Count);
public sealed record CardRegionInfo(string Segment, int CardSize, string Start, int Count, int TotalCount,
    string TableAddress, string Status, string? Reason, List<CardRunInfo> DirtyRuns);
