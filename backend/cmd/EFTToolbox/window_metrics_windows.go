//go:build windows

package main

import (
	"syscall"
	"time"
	"unsafe"
)

const (
	// The main window opens with room for the tool rails and the item table: the table alone needs
	// 1030px of content, and the page keeps its own side padding on top of that.
	minWindowWidth      = 1200
	minWindowHeight     = 640
	defaultWindowWidth  = 1280
	defaultWindowHeight = 820
	maxWindowWidth      = 1600
	maxWindowHeight     = 1000
	// A splash that is exactly the banner: the transparent window adds nothing around it. The size
	// keeps the artwork's 2.64:1 ratio so the wordmark fills the window without letterboxing.
	splashWindowWidth  = 560
	splashWindowHeight = 212
	// How long the host waits for the dashboard's ready report before showing the window anyway.
	readyTimeout = 20 * time.Second
	// How long the host waits for the dashboard to confirm the close dialog before falling back to a
	// native message box.
	closeDialogTimeout = 500 * time.Millisecond
)

var (
	user32DLL           = syscall.NewLazyDLL("user32.dll")
	procGetMonitorInfo  = user32DLL.NewProc("GetMonitorInfoW")
	procMonitorFromRect = user32DLL.NewProc("MonitorFromRect")
	procGetDpiForSystem = user32DLL.NewProc("GetDpiForSystem")
)

type nativeRect struct {
	Left, Top, Right, Bottom int32
}

type nativeMonitorInfo struct {
	Size    uint32
	Monitor nativeRect
	Work    nativeRect
	Flags   uint32
}

// defaultWindowSize returns the size the main window should open at: a share of the primary monitor's
// work area, capped so it never grows past a comfortable width and floored at the minimum the layout
// needs. The values are DIPs, matching the units Wails uses for window sizes. ok is false when the
// system call fails, and the caller keeps the size the window was created with.
func defaultWindowSize() (width, height int, ok bool) {
	probe := nativeRect{Right: 1, Bottom: 1}
	// MONITOR_DEFAULTTOPRIMARY: the probe sits at the virtual-screen origin, so this is the primary.
	monitor, _, _ := procMonitorFromRect.Call(uintptr(unsafe.Pointer(&probe)), 1)
	if monitor == 0 {
		return 0, 0, false
	}
	info := nativeMonitorInfo{Size: uint32(unsafe.Sizeof(nativeMonitorInfo{}))}
	if ret, _, _ := procGetMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); ret == 0 {
		return 0, 0, false
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	if dpi == 0 {
		return 0, 0, false
	}
	scale := float64(dpi) / 96
	width = clampSize(int(float64(info.Work.Right-info.Work.Left)*0.88/scale), minWindowWidth, maxWindowWidth)
	height = clampSize(int(float64(info.Work.Bottom-info.Work.Top)*0.88/scale), minWindowHeight, maxWindowHeight)
	return width, height, true
}

func clampSize(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
