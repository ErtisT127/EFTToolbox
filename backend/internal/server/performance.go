package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const slowOperationThreshold = 250 * time.Millisecond

// slowOperationLogger keeps performance diagnostics off request and file-store
// call paths. A full queue drops a diagnostic rather than delaying the work it
// is measuring.
type slowOperationLogger struct {
	writer  *dailyLogWriter
	entries chan clientLog
}

func newSlowOperationLogger(ctx context.Context, writer *dailyLogWriter) *slowOperationLogger {
	if writer == nil {
		return nil
	}
	logger := &slowOperationLogger{writer: writer, entries: make(chan clientLog, 128)}
	go logger.run(ctx)
	return logger
}

func (l *slowOperationLogger) run(ctx context.Context) {
	for {
		select {
		case entry := <-l.entries:
			_ = l.writer.write(entry)
		case <-ctx.Done():
			for {
				select {
				case entry := <-l.entries:
					_ = l.writer.write(entry)
				default:
					return
				}
			}
		}
	}
}

func (l *slowOperationLogger) record(elapsed time.Duration, event, message, requestID string) {
	if l == nil || elapsed < slowOperationThreshold {
		return
	}
	entry := clientLog{
		Level:     "warn",
		Component: "backend",
		Event:     event,
		Message:   message,
		RequestID: requestID,
	}
	select {
	case l.entries <- entry:
	default:
	}
}

type apiResponseWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *apiResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *apiResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += n
	return n, err
}

func (w *apiResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func shouldMeasureAPI(path string) bool {
	return strings.HasPrefix(path, "/api/") &&
		path != "/api/logs" &&
		!strings.HasPrefix(path, "/api/assets/") &&
		!strings.HasPrefix(path, "/api/map-tiles/") &&
		!strings.HasPrefix(path, "/api/game-monitor/browse/")
}

func slowAPIMessage(r *http.Request, response *apiResponseWriter, elapsed time.Duration) string {
	route := r.Pattern
	if route == "" {
		route = r.URL.Path
	}
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	return fmt.Sprintf("method=%s route=%s status=%d elapsedMs=%d bytes=%d", r.Method, route, status, elapsed.Milliseconds(), response.bytes)
}
