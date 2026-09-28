using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;

namespace MemoryFlight;

public sealed class DumpJob(Guid id, string name, string directory)
{
    public Guid Id { get; } = id;
    public string Name { get; } = name;
    public string Directory { get; } = directory;
    public string DumpPath => Path.Combine(Directory, "input.dmp");
    public string GraphPath => Path.Combine(Directory, "graph.json");
    public volatile string State = "uploading";
    public string? Error;
    public CancellationTokenSource Cancellation { get; } = new();
    public Task Work { get; set; } = Task.CompletedTask;
    public object Status() => new { Id, Name, State, Error };
}

public sealed class DumpJobs(ILogger<DumpJobs> logger) : IHostedService
{
    public const long MaxUpload = 2L * 1024 * 1024 * 1024;
    private readonly ConcurrentDictionary<Guid, DumpJob> jobs = new();
    private readonly SemaphoreSlim admission = new(1, 1);
    private readonly string root = Path.Combine(Path.GetTempPath(), "MemoryFlight", Guid.NewGuid().ToString("N"));

    public Task StartAsync(CancellationToken token)
    {
        Directory.CreateDirectory(root);
        return Task.CompletedTask;
    }

    public DumpJob? Get(Guid id) => jobs.GetValueOrDefault(id);
    public object[] List() => jobs.Values.Select(job => job.Status()).ToArray();

    public async Task<DumpJob> Upload(Stream body, string name, bool previews, CancellationToken token)
    {
        if (!await admission.WaitAsync(0, token))
            throw new InvalidOperationException("Another dump operation is in progress. Wait for the upload or cleanup to finish, then retry.");
        DumpJob? job = null;
        try
        {
            var active = jobs.Values.FirstOrDefault(j => j.State is "analyzing" or "uploading");
            if (active is not null)
                throw new InvalidOperationException($"\"{active.Name}\" is still {active.State}. Wait for it to finish, or cancel it before uploading another dump.");
            Guid id = Guid.NewGuid();
            job = new(id, name, Path.Combine(root, id.ToString("N")));
            Directory.CreateDirectory(job.Directory);
            jobs[id] = job;
            await using (var file = new FileStream(job.DumpPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, true))
            {
                byte[] buffer = new byte[128 * 1024];
                long total = 0;
                int read;
                while ((read = await body.ReadAsync(buffer, token)) > 0)
                {
                    total += read;
                    if (total > MaxUpload) throw new InvalidDataException("Dump exceeds the 2 GiB upload limit.");
                    await file.WriteAsync(buffer.AsMemory(0, read), token);
                }
                if (total < 32) throw new InvalidDataException("Dump is too short to contain a valid header.");
            }
            job.State = "analyzing";
            job.Work = RunWorker(job, previews);
            return job;
        }
        catch
        {
            if (job is not null)
            {
                jobs.TryRemove(job.Id, out _);
                DeleteFiles(job);
                job.Cancellation.Dispose();
            }
            throw;
        }
        finally { admission.Release(); }
    }

    private async Task RunWorker(DumpJob job, bool previews)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(job.Cancellation.Token);
        timeout.CancelAfter(TimeSpan.FromMinutes(10));
        using var process = new Process();
        process.StartInfo = new(Environment.ProcessPath ?? throw new InvalidOperationException("Executable path unavailable."))
        {
            UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true, CreateNoWindow = true
        };
        if (Path.GetFileNameWithoutExtension(process.StartInfo.FileName).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            process.StartInfo.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        foreach (string arg in new[] { "--analyze", job.DumpPath, job.GraphPath, previews.ToString() })
            process.StartInfo.ArgumentList.Add(arg);
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Could not start dump worker.");
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync(timeout.Token);
            string error = await stderr;
            await stdout;
            if (process.ExitCode != 0 || !File.Exists(job.GraphPath))
                throw new InvalidDataException($"Worker exited {process.ExitCode}. {error.Trim()} Matching local runtime/DAC and host architecture are required. Symbols are not downloaded.");
            job.State = "ready";
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            job.Error = job.Cancellation.IsCancellationRequested ? "Analysis cancelled." : "Analysis exceeded the ten-minute limit.";
            job.State = "failed";
            logger.LogWarning("{Reason}", job.Error);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Dump worker failed for {JobId}", job.Id);
            job.Error = ex.Message;
            job.State = "failed";
        }
    }

    public async Task<bool> Remove(Guid id)
    {
        await admission.WaitAsync();
        try
        {
            if (!jobs.TryGetValue(id, out var job)) return false;
            await job.Cancellation.CancelAsync();
            await job.Work;
            DeleteFiles(job);
            jobs.TryRemove(id, out _);
            job.Cancellation.Dispose();
            return true;
        }
        finally { admission.Release(); }
    }

    private static void DeleteFiles(DumpJob job)
    {
        File.Delete(job.DumpPath);
        File.Delete(job.GraphPath);
        Directory.Delete(job.Directory);
    }

    public async Task StopAsync(CancellationToken token)
    {
        foreach (Guid id in jobs.Keys) await Remove(id);
        Directory.Delete(root);
    }
}
