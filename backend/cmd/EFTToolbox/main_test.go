package main

import (
	"bufio"
	"context"
	"flag"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDevStdinClosesServer(t *testing.T) {
	assets := t.TempDir()
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDevServerProcess$")
	cmd.Env = append(os.Environ(), "EFT_TEST_ASSETS="+assets)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = input.Close() }()
	output, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		t.Fatal("server did not start")
	}
	_, address, ok := strings.Cut(scanner.Text(), "listening at http://")
	if !ok {
		t.Fatalf("unexpected startup output: %s", scanner.Text())
	}
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("shutdown after stdin EOF: %v", err)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("server left its port occupied: %v", err)
	}
	_ = listener.Close()
}

func TestDevServerProcess(t *testing.T) {
	assets := os.Getenv("EFT_TEST_ASSETS")
	if assets == "" {
		return
	}
	flag.CommandLine = flag.NewFlagSet("EFTToolbox", flag.ExitOnError)
	port := os.Getenv("EFT_TEST_PORT")
	if port == "" {
		port = "0"
	}
	os.Args = []string{"EFTToolbox", "-assets", assets, "-port", port, "-dev-stdin"}
	main()
}

func TestOccupiedPortExits(t *testing.T) {
	busy, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	assets := t.TempDir()
	if err := os.WriteFile(filepath.Join(assets, "index.html"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDevServerProcess$")
	cmd.Env = append(os.Environ(), "EFT_TEST_ASSETS="+assets, "EFT_TEST_PORT="+strconv.Itoa(busy.Addr().(*net.TCPAddr).Port))
	output, err := cmd.CombinedOutput()
	if err == nil || ctx.Err() != nil {
		t.Fatalf("expected immediate failure, got %v: %s", err, output)
	}
	if !strings.Contains(string(output), "bind") || strings.Contains(string(output), "listening at") {
		t.Fatalf("unexpected output: %s", output)
	}
}
