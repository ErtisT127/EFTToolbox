using EFTToolbox.Contracts;
using Linearstar.Windows.RawInput;
using Linearstar.Windows.RawInput.Native;

namespace EFTToolbox.Overlay;

internal sealed class RawInputHotkeyManager : IDisposable
{
    private const uint WmInput = 0x00FF, WmInputDeviceChange = 0x00FE;
    private const RawInputDeviceFlags RegistrationFlags = RawInputDeviceFlags.InputSink | RawInputDeviceFlags.DevNotify;
    private readonly nint target;
    private readonly Action<int, bool> keyAction;
    private readonly Action<int> wheelAction;
    private readonly List<Binding> bindings = [];
    private readonly HashSet<string> down = [];
    private readonly HashSet<int> active = [];
    private bool keyboardRegistered, mouseRegistered, suspended, disposed;
    private string[] failed = [];

    internal int Count { get; private set; }
    internal string[] Failed => failed;
    internal bool HasBindings => bindings.Count != 0;

    /// <summary>Where a binding's key comes from: the keyboard device, the mouse buttons, or the
    /// wheel. A binding always needs the device its own key is reported by, and the keyboard device
    /// additionally when it carries modifiers, because only the keyboard reports modifier state.</summary>
    private enum Source
    {
        Keyboard,
        MouseButton,
        Wheel,
    }

    private sealed record Binding(int Id, string Key, string[] Modifiers, Source Source);

    /// <summary>Keyboard keys and mouse buttons share the press/release path, so both can drive the
    /// held continuous actions; the wheel only reports a step.</summary>
    internal RawInputHotkeyManager(nint target, Action<int, bool> keyAction, Action<int> wheelAction)
    {
        this.target = target;
        this.keyAction = keyAction;
        this.wheelAction = wheelAction;
    }

    private static Source SourceOf(string key) => key switch
    {
        "WheelUp" or "WheelDown" => Source.Wheel,
        "Mouse3" or "Mouse4" or "Mouse5" => Source.MouseButton,
        _ => Source.Keyboard,
    };

    private static bool NeedsKeyboard(Binding binding) => binding.Source == Source.Keyboard || binding.Modifiers.Length != 0;
    private static bool NeedsMouse(Binding binding) => binding.Source != Source.Keyboard;

    internal void Configure(OverlayHotkeys settings)
    {
        Unregister();
        bindings.Clear();
        down.Clear();
        active.Clear();
        Count = 0;
        failed = [];
        if (suspended) return;

        var values = new[] { settings.ToggleEdit, settings.ToggleVisible, settings.ZoomIn, settings.ZoomOut, settings.FloorUp, settings.FloorDown, settings.ToggleBasemap, settings.PanUp, settings.PanDown, settings.PanLeft, settings.PanRight, settings.Recognition };
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rejected = new List<string>();
        for (var index = 0; index < values.Length; index++)
        {
            var value = values[index];
            if (string.IsNullOrWhiteSpace(value)) continue;
            var parts = value.Split('+');
            var key = parts[^1];
            var modifiers = parts[..^1];
            if (!seen.Add(value)) { rejected.Add(Name(index)); continue; }
            bindings.Add(new Binding(index + 1, key, modifiers, SourceOf(key)));
        }

        var needKeyboard = bindings.Any(NeedsKeyboard);
        var needMouse = bindings.Any(NeedsMouse);
        var keyboardOk = !needKeyboard || TryRegister(HidUsageAndPage.Keyboard, out keyboardRegistered);
        var mouseOk = !needMouse || TryRegister(HidUsageAndPage.Mouse, out mouseRegistered);
        if (!keyboardOk) rejected.AddRange(bindings.Where(NeedsKeyboard).Select(binding => Name(binding.Id - 1)));
        if (!mouseOk) rejected.AddRange(bindings.Where(NeedsMouse).Select(binding => Name(binding.Id - 1)));
        bindings.RemoveAll(binding => rejected.Contains(Name(binding.Id - 1), StringComparer.Ordinal));
        Count = bindings.Count;
        // The contract exposes this list in hotkeys declaration order. Registration failures are
        // appended after duplicate failures above, so normalize the order before reporting it.
        failed = [.. rejected.Distinct(StringComparer.Ordinal).OrderBy(value => Array.IndexOf(FieldNames, value))];
    }

    internal void Suspend()
    {
        suspended = true;
        Unregister();
        down.Clear();
        active.Clear();
    }

    internal void Resume(OverlayHotkeys settings)
    {
        suspended = false;
        Configure(settings);
    }

    /// <summary>Reports whether the message was ours. The caller still lets DefWindowProc see it:
    /// Windows expects the default procedure to run for WM_INPUT so it can clean the raw buffer up,
    /// and for WM_INPUT_DEVICE_CHANGE there is nothing to consume. Registering the mouse for a wheel
    /// or mouse button binding means every mouse report arrives here, and the library allocates while
    /// reading it - the price of those bindings, which is why the mouse is only registered for them.</summary>
    internal bool Consume(uint message, nint lParam)
    {
        if (message == WmInputDeviceChange)
        {
            ClearState();
            return true;
        }
        if (message != WmInput || suspended || bindings.Count == 0) return false;
        try
        {
            switch (RawInputData.FromHandle(lParam))
            {
                case RawInputKeyboardData keyboard:
                    Keyboard(keyboard.Keyboard);
                    break;
                case RawInputMouseData mouse:
                    Mouse(mouse.Mouse);
                    break;
            }
        }
        catch (Exception error)
        {
            OverlayDiagnostics.Log("warn", "raw_input_failed", error.Message);
        }
        return true;
    }

    private void Keyboard(RawKeyboard value)
    {
        var key = KeyName(value);
        if (key is null) return;
        if ((value.Flags & RawKeyboardFlags.Up) != 0) Release(key);
        else Press(key);
    }

    private void Mouse(RawMouse value)
    {
        var buttons = value.Buttons;
        // A single report can carry a button and the wheel at once, so every flag is tested on its own.
        if ((buttons & RawMouseButtonFlags.Button4Down) != 0) Press("Mouse4");
        if ((buttons & RawMouseButtonFlags.Button4Up) != 0) Release("Mouse4");
        if ((buttons & RawMouseButtonFlags.Button5Down) != 0) Press("Mouse5");
        if ((buttons & RawMouseButtonFlags.Button5Up) != 0) Release("Mouse5");
        if ((buttons & RawMouseButtonFlags.MiddleButtonDown) != 0) Press("Mouse3");
        if ((buttons & RawMouseButtonFlags.MiddleButtonUp) != 0) Release("Mouse3");
        if ((buttons & RawMouseButtonFlags.MouseWheel) == 0) return;
        var delta = unchecked((short)value.ButtonData);
        if (delta == 0) return;
        var wheelKey = delta > 0 ? "WheelUp" : "WheelDown";
        foreach (var binding in bindings.Where(binding => binding.Source == Source.Wheel && binding.Key == wheelKey && ModifiersMatch(binding.Modifiers))) wheelAction(binding.Id);
    }

    // Keyboard keys and mouse buttons both arrive as press/release pairs, so they share this state
    // machine: the key stays remembered while it is held and every matching binding is activated.
    // The repeat presses a held keyboard key produces are ignored by the first line.
    private void Press(string key)
    {
        if (!down.Add(key)) return;
        foreach (var binding in bindings.Where(binding => binding.Source != Source.Wheel && binding.Key == key && ModifiersMatch(binding.Modifiers)))
        {
            active.Add(binding.Id);
            keyAction(binding.Id, true);
        }
    }

    private void Release(string key)
    {
        if (!down.Remove(key)) return;
        foreach (var binding in bindings.Where(binding => binding.Key == key || IsModifier(key) && binding.Modifiers.Contains(ModifierGroup(key), StringComparer.Ordinal)).ToArray())
        {
            if (active.Contains(binding.Id) && (binding.Key == key || !ModifierDown(ModifierGroup(key))))
            {
                active.Remove(binding.Id);
                keyAction(binding.Id, false);
            }
        }
    }

    private bool ModifiersMatch(IEnumerable<string> modifiers)
    {
        var configured = modifiers.ToHashSet(StringComparer.Ordinal);
        return new[] { "Ctrl", "Alt", "Shift", "Win" }.All(modifier => configured.Contains(modifier) == ModifierDown(modifier));
    }

    private bool ModifierDown(string modifier) => modifier switch
    {
        "Ctrl" => down.Contains("LCtrl") || down.Contains("RCtrl"),
        "Alt" => down.Contains("LAlt") || down.Contains("RAlt"),
        "Shift" => down.Contains("LShift") || down.Contains("RShift"),
        "Win" => down.Contains("LWin") || down.Contains("RWin"),
        _ => false,
    };

    private static bool IsModifier(string key) => key is "LCtrl" or "RCtrl" or "LAlt" or "RAlt" or "LShift" or "RShift" or "LWin" or "RWin";
    private static string ModifierGroup(string key) => key[1..] switch
    {
        "Ctrl" => "Ctrl", "Alt" => "Alt", "Shift" => "Shift", _ => "Win",
    };

    private static string? KeyName(RawKeyboard value)
    {
        var vk = value.VirutalKey;
        if (value.ScanCode is >= 0x02 and <= 0x0A) return ((char)('1' + value.ScanCode - 0x02)).ToString();
        if (value.ScanCode == 0x0B) return "0";
        var letter = value.ScanCode switch
        {
            0x1E => "A", 0x30 => "B", 0x2E => "C", 0x20 => "D", 0x12 => "E", 0x21 => "F", 0x22 => "G",
            0x23 => "H", 0x17 => "I", 0x24 => "J", 0x25 => "K", 0x26 => "L", 0x32 => "M", 0x31 => "N",
            0x18 => "O", 0x19 => "P", 0x10 => "Q", 0x13 => "R", 0x1F => "S", 0x14 => "T", 0x16 => "U",
            0x2F => "V", 0x11 => "W", 0x2D => "X", 0x15 => "Y", 0x2C => "Z", _ => null,
        };
        if (letter is not null) return letter;
        if (vk is >= 0x70 and <= 0x87) return $"F{vk - 0x6F}";
        return vk switch
        {
            0xA0 => "LShift",
            0xA1 => "RShift",
            0xA2 => "LCtrl",
            0xA3 => "RCtrl",
            0xA4 => "LAlt",
            0xA5 => "RAlt",
            0x10 => value.ScanCode == 0x36 ? "RShift" : "LShift",
            0x11 => "LCtrl",
            0x12 => "LAlt",
            0x5B => "LWin",
            0x5C => "RWin",
            0x20 => "Space",
            0x2D => "Insert",
            0x2E => "Delete",
            0x24 => "Home",
            0x23 => "End",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x26 => "Up",
            0x28 => "Down",
            0x25 => "Left",
            0x27 => "Right",
            _ => Punctuation(value.ScanCode, value.Flags),
        };
    }

    // The E0 prefix marks the numpad twins of the main block keys (and the navigation cluster, which
    // the virtual key names above already resolved). Numpad Divide shares scan code 0x35 with Slash,
    // so an E0-prefixed scan code is never a contract key.
    private static string? Punctuation(int scanCode, RawKeyboardFlags flags) =>
        (flags & RawKeyboardFlags.KeyE0) != 0 ? null : scanCode switch
    {
        0x29 => "Backquote",
        0x0C => "Minus",
        0x0D => "Equal",
        0x1A => "BracketLeft",
        0x1B => "BracketRight",
        0x2B => "Backslash",
        0x27 => "Semicolon",
        0x28 => "Quote",
        0x33 => "Comma",
        0x34 => "Period",
        0x35 => "Slash",
        _ => null,
    };

    private static readonly string[] FieldNames = ["toggleEdit", "toggleVisible", "zoomIn", "zoomOut", "floorUp", "floorDown", "toggleBasemap", "panUp", "panDown", "panLeft", "panRight", "recognition"];
    private static string Name(int index) => FieldNames[index];

    private bool TryRegister(HidUsageAndPage usage, out bool registered)
    {
        registered = false;
        try
        {
            RawInputDevice.RegisterDevice(usage, RegistrationFlags, target);
            registered = true;
            return true;
        }
        catch (Exception error)
        {
            OverlayDiagnostics.Log("error", "raw_input_register_failed", $"{usage}: {error.Message}");
            return false;
        }
    }

    private void Unregister()
    {
        if (keyboardRegistered) { RawInputDevice.UnregisterDevice(HidUsageAndPage.Keyboard); keyboardRegistered = false; }
        if (mouseRegistered) { RawInputDevice.UnregisterDevice(HidUsageAndPage.Mouse); mouseRegistered = false; }
    }

    private void ClearState()
    {
        foreach (var id in active) keyAction(id, false);
        down.Clear();
        active.Clear();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        Unregister();
        down.Clear();
        active.Clear();
    }
}
