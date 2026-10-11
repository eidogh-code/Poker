using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PokerApp;

/// <summary>Окно игры: WebView2 показывает встроенные в exe файлы по адресу https://poker.app/.</summary>
internal sealed class MainForm : Form
{
    private const string Origin = "https://poker.app/";
    private const string RuntimeDownloadUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    private static readonly Color Room = Color.FromArgb(0x24, 0x15, 0x20);
    private static readonly Size DefaultClientSize = new(1440, 900);

    private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Room };
    private bool fullscreen;
    private FormWindowState stateBeforeFullscreen;
    private Rectangle boundsBeforeFullscreen;

    public MainForm()
    {
        Text = "Покер";
        BackColor = Room;
        MinimumSize = new Size(1100, 720);
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath);
        Controls.Add(web);
        RestoreWindow();

        HandleCreated += (_, _) => NativeMethods.StyleTitleBar(Handle, Room);
        Shown += async (_, _) => await InitBrowserAsync();
        FormClosing += (_, _) => RememberWindow();
    }

    private void RestoreWindow()
    {
        var saved = WindowSettings.Load();
        StartPosition = FormStartPosition.Manual;
        if (saved is not null)
        {
            Bounds = saved.Bounds;
            if (saved.Maximized) WindowState = FormWindowState.Maximized;
            return;
        }
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(Point.Empty, DefaultClientSize);
        var size = new Size(Math.Min(DefaultClientSize.Width, area.Width), Math.Min(DefaultClientSize.Height, area.Height));
        Bounds = new Rectangle(area.X + (area.Width - size.Width) / 2, area.Y + (area.Height - size.Height) / 2, size.Width, size.Height);
        if (size != DefaultClientSize) WindowState = FormWindowState.Maximized;
    }

    private void RememberWindow()
    {
        var bounds = fullscreen ? boundsBeforeFullscreen : (WindowState == FormWindowState.Normal ? Bounds : RestoreBounds);
        var maximized = fullscreen ? stateBeforeFullscreen == FormWindowState.Maximized : WindowState == FormWindowState.Maximized;
        WindowSettings.From(bounds, maximized).Save();
    }

    private async Task InitBrowserAsync()
    {
        if (WebAssets.IsEmpty)
        {
            Fail("Файлы игры не найдены внутри приложения. Пересоберите его скриптом build.ps1.");
            return;
        }
        try
        {
            var userData = Path.Combine(WindowSettings.DataDir, "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            OfferRuntimeInstall();
            return;
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException or UnauthorizedAccessException)
        {
            Fail($"Не удалось запустить движок отображения (WebView2): {ex.Message}");
            return;
        }

        var core = web.CoreWebView2;
        ConfigureSettings(core.Settings);
        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.WebMessageReceived += OnWebMessage;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) e.Cancel = true; };
        core.Navigate(Origin + "index.html");
        web.Focus();
    }

    private static void ConfigureSettings(CoreWebView2Settings s)
    {
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = false;
#endif
        s.AreDefaultContextMenusEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var env = web.CoreWebView2.Environment;
        var path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath);
        if (path is "" or "/") path = "index.html";
        var stream = WebAssets.Open(path);
        e.Response = stream is null
            ? env.CreateWebResourceResponse(null, 404, "Not Found", "")
            : env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {WebAssets.ContentType(path)}");
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string message;
        try { message = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; } // пришёл не текст — не наше сообщение

        switch (message)
        {
            case "quit": Close(); break;
            case "fullscreen": SetFullscreen(!fullscreen); break;
            case "escape": if (fullscreen) SetFullscreen(false); break;
        }
    }

    private void SetFullscreen(bool on)
    {
        if (on == fullscreen) return;
        fullscreen = on;
        if (on)
        {
            stateBeforeFullscreen = WindowState;
            boundsBeforeFullscreen = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = boundsBeforeFullscreen;
            WindowState = stateBeforeFullscreen;
        }
    }

    private void OfferRuntimeInstall()
    {
        var answer = MessageBox.Show(this,
            "Для работы игры нужен компонент Microsoft Edge WebView2 Runtime. Он бесплатный и обычно уже есть в Windows 10 и 11.\n\nОткрыть страницу загрузки?",
            "Покер", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (answer == DialogResult.Yes)
            Process.Start(new ProcessStartInfo(RuntimeDownloadUrl) { UseShellExecute = true });
        Close();
    }

    private void Fail(string text)
    {
        MessageBox.Show(this, text, "Покер", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }
}
