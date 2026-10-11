using System.Runtime.InteropServices;

namespace PokerApp;

/// <summary>Тёмный заголовок окна в цвет стола (Windows 10 20H1+ / Windows 11).</summary>
internal static class NativeMethods
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaCaptionColor = 35;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public static void StyleTitleBar(IntPtr hwnd, Color caption)
    {
        var dark = 1;
        DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));
        var colorRef = caption.R | (caption.G << 8) | (caption.B << 16); // COLORREF: 0x00BBGGRR
        DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref colorRef, sizeof(int)); // на Windows 10 просто игнорируется
    }
}
