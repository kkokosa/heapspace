using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Heapscape.Fixtures;

public sealed class DemoNode(string name)
{
    public string Name = name;
    public List<DemoNode> Links = [];
    public byte[] Payload = new byte[192];
}

public sealed class FixtureGraph : IDisposable
{
    public static FixtureGraph? StaticRoot;
    [ThreadStatic] public static DemoNode? ThreadRoot;
    public DemoNode[] Mature;
    public DemoNode[] Middle;
    public DemoNode[] Young;
    public byte[] Large = new byte[180_000];
    public byte[] PinnedHeap = GC.AllocateArray<byte>(32_768, pinned: true);
    public ConditionalWeakTable<DemoNode, DemoNode> Dependent = new();
    public IntPtr NativeBuffer;
    private readonly GCHandle strong;
    private readonly GCHandle pinned;
    private readonly GCHandle weak;
    private readonly GCHandle weakLong;

    public FixtureGraph()
    {
        Mature = Create("mature", 400);
        Mature[0].Links.Add(Mature[0]);
        Mature[0].Links.Add(Mature[^1]);
        Dependent.Add(Mature[0], new DemoNode("conditional-secondary"));
        strong = GCHandle.Alloc(new DemoNode("strong-handle"), GCHandleType.Normal);
        pinned = GCHandle.Alloc(new byte[4096], GCHandleType.Pinned);
        weak = GCHandle.Alloc(Mature[1], GCHandleType.Weak);
        weakLong = GCHandle.Alloc(Mature[2], GCHandleType.WeakTrackResurrection);
        NativeBuffer = Marshal.AllocHGlobal(2 * 1024 * 1024);
        for (int i = 0; i < 2 * 1024 * 1024; i += 4096) Marshal.WriteByte(NativeBuffer, i, 0x4d);
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        Middle = Create("middle", 150);
        GC.Collect(0, GCCollectionMode.Forced, blocking: true);
        Young = Create("young", 120);
        ThreadRoot = new DemoNode("thread-static-root");
        Mature[0].Links.Add(Middle[0]);
        Middle[0].Links.Add(Young[0]);
        StaticRoot = this;
    }

    public static DemoNode[] Create(string prefix, int count)
    {
        var nodes = Enumerable.Range(0, count).Select(i => new DemoNode($"{prefix}-{i:0000}")).ToArray();
        for (int i = 1; i < nodes.Length; i++) nodes[i - 1].Links.Add(nodes[i]);
        return nodes;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void WaitWithStackRoots()
    {
        var local = new DemoNode("stack-only-root");
        using var ready = new ManualResetEventSlim();
        if (Environment.GetEnvironmentVariable("HEAPSCAPE_READY_FILE") is { } readyPath)
            File.WriteAllText(readyPath, "ready");
        Console.WriteLine("HEAPSCAPE_READY");
        ready.Wait();
        GC.KeepAlive(local);
        GC.KeepAlive(this);
    }

    public void Dispose()
    {
        strong.Free(); pinned.Free(); weak.Free(); weakLong.Free();
        Marshal.FreeHGlobal(NativeBuffer);
        StaticRoot = null; ThreadRoot = null;
    }
}
