package main

import (
	"io"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"
)

type overlayProcess struct {
	cmd   *exec.Cmd
	input io.Closer
	done  chan struct{}
}

func startOverlay(executable, address string) *overlayProcess {
	cmd := exec.Command(executable, "--backend", address, "--dev-stdin")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		log.Printf("overlay startup: %v", err)
		return nil
	}
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		log.Printf("overlay startup: %v", err)
		return nil
	}
	log.Printf("overlay started pid=%d", cmd.Process.Pid)
	process := &overlayProcess{cmd: cmd, input: input, done: make(chan struct{})}
	go func() {
		defer close(process.done)
		if err := cmd.Wait(); err != nil {
			log.Printf("overlay stopped: %v", err)
		}
	}()
	return process
}

func (p *overlayProcess) Stop(timeout time.Duration) {
	if p == nil {
		return
	}
	_ = p.input.Close()
	select {
	case <-p.done:
		return
	case <-time.After(timeout):
		log.Printf("overlay did not stop within %s; terminating pid=%d", timeout, p.cmd.Process.Pid)
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}
