using System.ComponentModel;
using System.Runtime.InteropServices;

namespace EFTToolbox.Overlay;

internal static class Native
{
    internal const uint WmClose = 0x0010, WmDestroy = 0x0002, WmSize = 0x0005;
    internal const uint WmDisplayChange = 0x007E, WmDpiChanged = 0x02E0;
    internal const uint WmNcHitTest = 0x0084, WmMouseActivate = 0x0021, WmContextMenu = 0x007B, WmCaptureChanged = 0x0215;
    // The cursor a window shows is decided here, not by the hit test that only precedes it.
    internal const uint WmSetCursor = 0x0020;
    internal const uint WmLButtonDown = 0x0201, WmLButtonUp = 0x0202, WmMouseMove = 0x0200, WmMouseWheel = 0x020A;
    internal const uint WmRButtonDown = 0x0204, WmRButtonUp = 0x0205;
    internal const uint ExStyle = 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008 | 0x00200000;
    // The recognition panel is clickable, so it drops WS_EX_TRANSPARENT and keeps the rest: layered,
    // never activating, tool window, topmost, no redirection bitmap.
    internal const uint PanelExStyle = 0x00080000 | 0x08000000 | 0x00000080 | 0x00000008 | 0x00200000;
    internal delegate nint WindowProc(nint hwnd, uint message, nuint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WindowClass
    {
        internal uint Size, Style;
        internal WindowProc Proc;
        internal int ClassExtra, WindowExtra;
        internal nint Instance, Icon, Cursor, Background;
        internal string? Menu;
        internal string Name;
        internal nint SmallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect { internal int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MonitorInfo
    {
        internal uint Size;
        internal Rect Monitor, Work;
        internal uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Luid { internal uint LowPart; internal int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigPathSourceInfo { internal Luid AdapterId; internal uint Id, ModeInfoIdx, StatusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigRational { internal uint Numerator, Denominator; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigPathTargetInfo
    {
        internal Luid AdapterId;
        internal uint Id, ModeInfoIdx, OutputTechnology, Rotation, Scaling;
        internal DisplayConfigRational RefreshRate;
        internal uint ScanLineOrdering;
        [MarshalAs(UnmanagedType.Bool)] internal bool TargetAvailable;
        internal uint StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigPathInfo { internal DisplayConfigPathSourceInfo SourceInfo; internal DisplayConfigPathTargetInfo TargetInfo; internal uint Flags; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigDeviceInfoHeader { internal uint Type, Size; internal Luid AdapterId; internal uint Id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct DisplayConfigSourceDeviceName
    {
        internal DisplayConfigDeviceInfoHeader Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string ViewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DisplayConfigSdrWhiteLevel { internal DisplayConfigDeviceInfoHeader Header; internal uint SdrWhiteLevel; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Message
    {
        internal nint Hwnd;
        internal uint Id;
        internal nuint WParam;
        internal nint LParam;
        internal uint Time;
        internal int X, Y;
        internal uint Private;
    }

    internal static void Check(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    [DllImport("user32", SetLastError = true)]
    internal static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("kernel32", CharSet = CharSet.Unicode)]
    internal static extern nint GetModuleHandle(string? name);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern ushort RegisterClassEx(ref WindowClass windowClass);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool UnregisterClass(string name, nint instance);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern nint CreateWindowEx(uint exStyle, string className, string title,
        uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    internal static extern nint DefWindowProc(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32")]
    internal static extern bool DestroyWindow(nint hwnd);
    [DllImport("user32")]
    internal static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32", SetLastError = true)]
    internal static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32", SetLastError = true)]
    internal static extern bool SetLayeredWindowAttributes(nint hwnd, uint key, byte alpha, uint flags);
    [DllImport("user32")]
    internal static extern nint MonitorFromPoint(long point, uint flags);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);
    [DllImport("user32", SetLastError = true)]
    internal static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32")]
    internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    internal static extern bool PeekMessage(out Message message, nint hwnd, uint min, uint max, uint remove);
    [DllImport("user32")]
    internal static extern bool TranslateMessage(ref Message message);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    internal static extern nint DispatchMessage(ref Message message);
    [DllImport("user32")]
    internal static extern uint MsgWaitForMultipleObjectsEx(uint count, nint handles, uint milliseconds, uint wakeMask, uint flags);

    [DllImport("user32")] internal static extern bool PostMessage(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32", SetLastError = true)] internal static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [DllImport("user32")] internal static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32")] internal static extern nint MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32", SetLastError = true)] internal static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);
    [DllImport("user32", SetLastError = true)] internal static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] DisplayConfigPathInfo[] paths, ref uint modeCount, nint modes, nint topologyId);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern int DisplayConfigGetDeviceInfo(ref DisplayConfigSourceDeviceName request);
    [DllImport("user32", SetLastError = true)] internal static extern int DisplayConfigGetDeviceInfo(ref DisplayConfigSdrWhiteLevel request);
    [DllImport("user32")] internal static extern nint SetCapture(nint hwnd);
    [DllImport("user32")] internal static extern bool ReleaseCapture();
    [DllImport("user32")] internal static extern bool GetCursorPos(out CursorPoint point);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern nint LoadCursor(nint instance, nint name);
    [DllImport("user32")] internal static extern nint SetCursor(nint cursor);
    internal static readonly nint SizeNWSE = 32642, SizeNESW = 32643, SizeWE = 32644, SizeNS = 32645, SizeAll = 32646, Arrow = 32512;
    [StructLayout(LayoutKind.Sequential)] internal struct CursorPoint { internal int X, Y; }
}
