using System.Diagnostics;
using System.Text.Json;

if (args.Length != 4 || !Uri.TryCreate(args[0], UriKind.Absolute, out var url) || !url.IsLoopback)
    throw new ArgumentException("Usage: LoadClient <loopback-url> <seconds> <concurrency> <result.json>");
int seconds = int.Parse(args[1]), concurrency = int.Parse(args[2]);
if (seconds is < 1 or > 300 || concurrency is < 1 or > 64)
    throw new ArgumentException("Use 1-300 seconds and 1-64 workers.");
using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
long completed = 0, failed = 0;
var stopwatch = Stopwatch.StartNew();
await Task.WhenAll(Enumerable.Range(0, concurrency).Select(async _ =>
{
    while (stopwatch.Elapsed.TotalSeconds < seconds)
    {
        try
        {
            using var response = await client.GetAsync(url);
            if (response.IsSuccessStatusCode) Interlocked.Increment(ref completed);
            else Interlocked.Increment(ref failed);
        }
        catch (HttpRequestException ex) { Interlocked.Increment(ref failed); Console.Error.WriteLine(ex.Message); }
        catch (TaskCanceledException ex) { Interlocked.Increment(ref failed); Console.Error.WriteLine(ex.Message); }
    }
}));
await File.WriteAllTextAsync(args[3], JsonSerializer.Serialize(new
{
    url = url.ToString(), concurrency, seconds = stopwatch.Elapsed.TotalSeconds, completed, failed,
    requestsPerSecond = completed / stopwatch.Elapsed.TotalSeconds
}, new JsonSerializerOptions { WriteIndented = true }));
return completed > 0 && failed == 0 ? 0 : 1;
