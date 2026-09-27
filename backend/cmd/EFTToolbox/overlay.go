package main

import (
	"bufio"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
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
	cmd.Stdout = io.Discard
	// The overlay sends its diagnostics over the named log pipe. Anything it prints instead —
	// argument errors, a crash before the pipe is up — would otherwise only exist on the launcher's
	// terminal, so it is mirrored into the log pipeline as well.
	stderrReader, stderrWriter, stderrErr := os.Pipe()
	if stderrErr != nil {
		log.Printf("overlay stderr pipe: %v", stderrErr)
		return nil
	}
	cmd.Stderr = stderrWriter
	input, err := cmd.StdinPipe()
	if err != nil {
		_ = stderrReader.Close()
		_ = stderrWriter.Close()
		log.Printf("overlay startup: %v", err)
		return nil
	}
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		_ = stderrReader.Close()
		_ = stderrWriter.Close()
		log.Printf("overlay startup: %v", err)
		return nil
	}
	// The child owns the write end now; the reader stays here until the overlay exits.
	_ = stderrWriter.Close()
	go func() {
		defer func() { _ = stderrReader.Close() }()
		scanner := bufio.NewScanner(stderrReader)
		for scanner.Scan() {
			if line := strings.TrimSpace(scanner.Text()); line != "" {
				log.Printf("overlay: %s", line)
			}
		}
	}()
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
