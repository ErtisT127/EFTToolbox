package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"efttoolbox/backend/internal/server"
)

var version = "0.0.0-dev"

// Startup failures happen before any UI exists, so they are written to the log pipeline and echoed
// on the launcher's terminal — one line, then exit.
func fatal(message string, err error) {
	text := message
	if err != nil {
		text = fmt.Sprintf("%s: %v", message, err)
	}
	log.Print(text)
	_, _ = fmt.Fprintln(os.Stderr, text)
	os.Exit(1)
}

func main() {
	setProcessDPIAwareness()
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	assets := flag.String("assets", filepath.Join(filepath.Dir(exe), "dashboard"), "dashboard asset directory")
	dataRoot := flag.String("data", filepath.Join(filepath.Dir(exe), "data"), "portable data directory")
	port := flag.Int("port", 47831, "loopback listen port")
	devStdin := flag.Bool("dev-stdin", false, "stop when the development launcher's stdin pipe closes")
	overlayExe := flag.String("overlay", filepath.Join(filepath.Dir(exe), "overlay", "overlay.exe"), "native overlay executable")
	flag.Parse()
	// Install the log pipeline before the startup checks: a missing dashboard or a busy port is
	// exactly the kind of failure that has to leave a record.
	if err := server.InstallLogging(filepath.Join(*dataRoot, "..", "logs")); err != nil {
		log.Printf("initialize daily log writer: %v", err)
	}
	if _, err := os.Stat(filepath.Join(*assets, "index.html")); err != nil {
		fatal("dashboard unavailable; run scripts/platform/dev.ps1", err)
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fatal("listen failed", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	if *devStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}
	srv := &http.Server{Handler: server.New(ctx, version, http.Dir(*assets), *dataRoot), ReadHeaderTimeout: 5 * time.Second}
	done := make(chan struct{})
	log.Printf("EFTToolbox %s listening at http://%s", version, listener.Addr())
	overlay := startOverlay(*overlayExe, fmt.Sprintf("http://%s/", listener.Addr()))
	go func() {
		<-ctx.Done()
		if overlay != nil {
			overlay.Stop(3 * time.Second)
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			log.Printf("HTTP shutdown: %v", err)
			_ = srv.Close()
		}
		close(done)
	}()
	if err := srv.Serve(listener); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-done
}
