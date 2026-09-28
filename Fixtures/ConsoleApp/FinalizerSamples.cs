using System.Runtime.CompilerServices;

internal sealed class FinalizerSamples(string name)
{
    private static readonly ManualResetEventSlim Entered = new();
    private static readonly ManualResetEventSlim Release = new();
    public string Name = name;

    ~FinalizerSamples()
    {
        Entered.Set();
        Release.Wait();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Allocate(string name) => _ = new FinalizerSamples(name);

    public static void Prepare()
    {
        Allocate("running-finalizer");
        GC.Collect();
        if (!Entered.Wait(TimeSpan.FromSeconds(10)))
            throw new InvalidOperationException("Could not park the fixture finalizer thread.");
        Allocate("queued-finalizer");
        GC.Collect();
    }
}
