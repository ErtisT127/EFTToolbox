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

func main() {
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	assets := flag.String("assets", filepath.Join(filepath.Dir(exe), "dashboard"), "dashboard asset directory")
	dataRoot := flag.String("data", filepath.Join(filepath.Dir(exe), "data"), "portable data directory")
	port := flag.Int("port", 47831, "loopback listen port")
	devStdin := flag.Bool("dev-stdin", false, "stop when the development launcher's stdin pipe closes")
	flag.Parse()
	if _, err := os.Stat(filepath.Join(*assets, "index.html")); err != nil {
		log.Fatalf("dashboard unavailable; run scripts/platform/dev.ps1: %v", err)
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
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
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
		close(done)
	}()
	log.Printf("EFTToolbox %s listening at http://%s", version, listener.Addr())
	if err := srv.Serve(listener); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-done
}
