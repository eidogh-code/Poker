using System.Text.Json;
using System.Text.Json.Serialization;

namespace PokerApp;

/// <summary>Положение и размер окна между запусками: %LOCALAPPDATA%\PokerNight\window.json.</summary>
internal sealed record WindowSettings(int X, int Y, int Width, int Height, bool Maximized)
{
    public static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PokerNight");

    private static readonly string FilePath = Path.Combine(DataDir, "window.json");

    [JsonIgnore]
    public Rectangle Bounds => new(X, Y, Width, Height);

    public static WindowSettings? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var saved = JsonSerializer.Deserialize<WindowSettings>(File.ReadAllText(FilePath));
            return saved is not null && saved.IsVisibleOnSomeScreen() ? saved : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null; // повреждённый или недоступный файл — просто откроемся по умолчанию
        }
    }

    public static WindowSettings From(Rectangle bounds, bool maximized) =>
        new(bounds.X, bounds.Y, bounds.Width, bounds.Height, maximized);

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Не удалось запомнить окно — на игру это не влияет.
        }
    }

    private bool IsVisibleOnSomeScreen() =>
        Width >= 400 && Height >= 300 &&
        Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(Bounds));
}
