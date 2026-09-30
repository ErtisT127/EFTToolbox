//go:build !windows

package main

import "errors"

func runDesktop(string, string, string, int, string) error {
	return errors.New("Wails desktop host is only supported on Windows")
}
