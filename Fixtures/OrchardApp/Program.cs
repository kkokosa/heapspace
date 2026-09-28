using System.Security.Cryptography;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:ShellName"] = "Default",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:SiteName"] = "MemoryFlight Orchard fixture",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:SiteTimeZone"] = "Etc/UTC",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:AdminUsername"] = "fixtureadmin",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:AdminEmail"] = "fixture@example.invalid",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:AdminPassword"] = $"Aa1!{Convert.ToHexString(RandomNumberGenerator.GetBytes(24))}",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:DatabaseProvider"] = "Sqlite",
    ["OrchardCore:OrchardCore_AutoSetup:Tenants:0:RecipeName"] = "Blog",
});
builder.Services.AddOrchardCms().AddSetupFeatures("OrchardCore.AutoSetup");
var app = builder.Build();
app.UseStaticFiles();
app.UseOrchardCore();
app.Run();
