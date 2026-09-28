using MemoryFlight.Fixtures;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<FixtureGraph>();
var app = builder.Build();
app.MapGet("/", () => "MemoryFlight ASP.NET fixture");
app.MapGet("/work", async (FixtureGraph graph) =>
{
    var request = FixtureGraph.Create("request", 16);
    await Task.Delay(40);
    lock (graph.Mature[0].Links)
    {
        if (graph.Mature[0].Links.Count > 96) graph.Mature[0].Links.RemoveRange(3, 32);
        graph.Mature[0].Links.Add(request[0]);
    }
    return new { request = request[0].Name, retained = graph.Mature.Length };
});
app.Services.GetRequiredService<FixtureGraph>();
app.Run();
