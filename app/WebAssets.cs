using System.Reflection;

namespace PokerApp;

/// <summary>Файлы игры, встроенные в exe как ресурсы с именами вида "web/js/ui.js".</summary>
internal static class WebAssets
{
    private const string Prefix = "web/";

    private static readonly Assembly Assembly = typeof(WebAssets).Assembly;

    private static readonly Dictionary<string, string> ResourceByPath = Assembly
        .GetManifestResourceNames()
        .Where(name => name.StartsWith(Prefix, StringComparison.Ordinal))
        .ToDictionary(name => name[Prefix.Length..].Replace('\\', '/'), name => name, StringComparer.OrdinalIgnoreCase);

    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".woff2"] = "font/woff2",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".ico"] = "image/x-icon",
    };

    public static bool IsEmpty => ResourceByPath.Count == 0;

    public static Stream? Open(string path)
    {
        var key = path.Replace('\\', '/').TrimStart('/');
        return ResourceByPath.TryGetValue(key, out var name) ? Assembly.GetManifestResourceStream(name) : null;
    }

    public static string ContentType(string path) =>
        ContentTypes.TryGetValue(Path.GetExtension(path), out var type) ? type : "application/octet-stream";
}
