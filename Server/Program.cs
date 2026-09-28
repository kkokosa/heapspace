using System.Net;
using System.Text.Json;
using Heapscape;

if (args.Length > 0 && args[0] == "--analyze")
{
    try
    {
        if (args.Length != 4) throw new ArgumentException("Usage: --analyze <dump> <output.json> <previews:true|false>");
        var snapshot = new DumpAnalyzer().Analyze(args[1], bool.Parse(args[3]));
        await using var output = File.Create(args[2]);
        await JsonSerializer.SerializeAsync(output, snapshot, Format.Json);
        return 0;
    }
    catch (Exception ex)
    {
        // This is the worker process boundary; a bad dump must produce a failed job, not empty success.
        Console.Error.WriteLine($"{ex.GetType().Name}: {ex.Message}");
        return 1;
    }
}

var builder = WebApplication.CreateBuilder(args);
int port = builder.Configuration.GetValue("Heapscape:Port", 5077);
if (port is < 0 or > 65535) throw new ArgumentOutOfRangeException(nameof(port), "Port must be between 0 and 65535.");
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = DumpJobs.MaxUpload);
builder.Services.AddSingleton<DumpJobs>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<DumpJobs>());
var app = builder.Build();
app.Use(async (context, next) =>
{
    string host = context.Request.Host.Host;
    if ((host != "127.0.0.1" && host != "localhost" && host != "[::1]") ||
        context.Connection.RemoteIpAddress is not { } address || !IPAddress.IsLoopback(address))
    {
        context.Response.StatusCode = 403;
        return;
    }
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        string origin = context.Request.Headers.Origin.ToString();
        string ownOrigin = $"{context.Request.Scheme}://{context.Request.Host}";
        if (context.Request.Headers["X-Heapscape"] != "1" ||
            (origin.Length > 0 && !string.Equals(origin, ownOrigin, StringComparison.OrdinalIgnoreCase)) ||
            context.Request.Headers["Sec-Fetch-Site"] == "cross-site")
        {
            context.Response.StatusCode = 403;
            await context.Response.WriteAsJsonAsync(new { error = "Same-origin Heapscape requests only." });
            return;
        }
    }
    await next(context);
});
app.Use(async (context, next) =>
{
    if (context.Request.Path == "/" && !File.Exists(Path.Combine(app.Environment.WebRootPath ?? "wwwroot", "index.html")))
    {
        context.Response.StatusCode = 503;
        await context.Response.WriteAsync("Frontend not built. Run npm ci and npm run build in the Heapscape repository root.");
        return;
    }
    await next(context);
});
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", () => new { status = "ready", maxUpload = DumpJobs.MaxUpload });
app.MapGet("/api/dumps", (DumpJobs jobs) => jobs.List());
app.MapPost("/api/dumps", async (HttpRequest request, DumpJobs jobs, CancellationToken token) =>
{
    if (request.ContentType != "application/octet-stream")
        return Results.BadRequest(new { error = "Upload the dump as application/octet-stream." });
    if (request.ContentLength is 0 or > DumpJobs.MaxUpload)
        return Results.BadRequest(new { error = "Dump must contain data and be no larger than 2 GiB." });
    string name = Path.GetFileName(request.Query["name"].ToString());
    if (name.Length == 0 || name.Length > 240)
        return Results.BadRequest(new { error = "Supply a filename (at most 240 characters)." });
    bool previews = request.Query["previews"] == "true";
    try
    {
        var job = await jobs.Upload(request.Body, name, previews, token);
        return Results.Accepted($"/api/dumps/{job.Id}", job.Status());
    }
    catch (InvalidDataException ex) { return Results.BadRequest(new { error = ex.Message }); }
    catch (InvalidOperationException ex) { return Results.Conflict(new { error = ex.Message }); }
});
app.MapGet("/api/dumps/{id:guid}", (Guid id, DumpJobs jobs) =>
    jobs.Get(id) is { } job ? Results.Ok(job.Status()) : Results.NotFound());
app.MapGet("/api/dumps/{id:guid}/graph", (Guid id, DumpJobs jobs) =>
{
    var job = jobs.Get(id);
    if (job is null) return Results.NotFound();
    if (job.State != "ready") return Results.Conflict(new { error = "Analysis is not ready." });
    return Results.File(job.GraphPath, "application/json");
});
app.MapDelete("/api/dumps/{id:guid}", async (Guid id, DumpJobs jobs) =>
    await jobs.Remove(id) ? Results.NoContent() : Results.NotFound());
await app.RunAsync();
return 0;
