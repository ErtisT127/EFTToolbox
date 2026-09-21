//go:build windows

package main

import "syscall"

func setProcessDPIAwareness() {
	dll := syscall.NewLazyDLL("user32.dll")
	proc := dll.NewProc("SetProcessDpiAwarenessContext")
	const perMonitorAwareV2 = ^uintptr(3) // -4
	_, _, _ = proc.Call(perMonitorAwareV2)
}
