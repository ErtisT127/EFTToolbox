package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/user"
	"slices"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/Microsoft/go-winio"
)

func startOverlayLogPipe(ctx context.Context, writer *dailyLogWriter) string {
	current, err := user.Current()
	if err != nil {
		log.Printf("overlay log identity: %v", err)
		return ""
	}
	name := fmt.Sprintf("EFTToolbox-overlay-%d-%d", os.Getpid(), time.Now().UnixNano())
	listener, err := winio.ListenPipe(`\\.\pipe\`+name, &winio.PipeConfig{SecurityDescriptor: "D:P(D;;GA;;;NU)(A;;GA;;;" + current.Uid + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		log.Printf("overlay log pipe: %v", err)
		return ""
	}
	go func() { <-ctx.Done(); _ = listener.Close() }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go receiveOverlayLogs(ctx, conn, writer)
		}
	}()
	return name
}

func receiveOverlayLogs(ctx context.Context, conn net.Conn, writer *dailyLogWriter) {
	defer func() { _ = conn.Close() }()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		var entry contracts.OverlayLog
		if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.Component != "overlay" || !slices.Contains([]string{"info", "warn", "error"}, entry.Level) || entry.Event == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.Time); err != nil {
			entry.Time = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if err := writer.writeValue(entry); err != nil {
			log.Printf("overlay log write: %v", err)
		}
	}
}
