package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func startOverlay(ctx context.Context, executable, address string) {
	cmd := exec.Command(executable, "--backend", address, "--dev-stdin")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		log.Printf("overlay startup: %v", err)
		return
	}
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		log.Printf("overlay startup: %v", err)
		return
	}
	log.Printf("overlay started pid=%d", cmd.Process.Pid)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := cmd.Wait(); err != nil {
			log.Printf("overlay stopped: %v", err)
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		_ = input.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
		}
	}()
}
