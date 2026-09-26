package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	contracts "efttoolbox/contracts"
)

const mobileCookie = "eft_mobile_token"

type mobilePacket struct {
	event string
	data  []byte
}

type mobileManager struct {
	ctx    context.Context
	assets http.FileSystem
	hub    *overlayHub

	mu          sync.Mutex
	enabled     bool
	token       string
	address     string
	url         string
	server      *http.Server
	listener    net.Listener
	subscribers map[chan mobilePacket]struct{}
}

func newMobileManager(ctx context.Context, assets http.FileSystem, hub *overlayHub) *mobileManager {
	m := &mobileManager{ctx: ctx, assets: assets, hub: hub, subscribers: map[chan mobilePacket]struct{}{}}
	go func() {
		<-ctx.Done()
		m.stop()
	}()
	return m
}

func (m *mobileManager) status() contracts.MobileStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := contracts.MobileStatus{Enabled: m.enabled, Connected: len(m.subscribers)}
	if m.url != "" {
		url := m.url
		status.Url = &url
	}
	if m.address != "" {
		address := m.address
		status.Address = &address
	}
	return status
}

func (m *mobileManager) interfaces() []string {
	return localInterfaces()
}

// localInterfaces lists the machine's non-loopback IPv4 addresses, shared by the cast and
// multiplayer panels for their address pickers.
func localInterfaces() []string {
	values := []string{}
	if interfaces, err := net.Interfaces(); err == nil {
		for _, item := range interfaces {
			if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
				continue
			}
			addresses, _ := item.Addrs()
			for _, address := range addresses {
				ip, _, err := net.ParseCIDR(address.String())
				if err == nil && ip.To4() != nil {
					values = append(values, ip.String())
				}
			}
		}
	}
	return values
}

func randomToken() (string, error) {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func hostPort(host string) string {
	if _, port, err := net.SplitHostPort(host); err == nil && port != "" {
		return port
	}
	return "0"
}

func (m *mobileManager) start(address, port string) (contracts.MobileStatus, error) {
	ip := net.ParseIP(strings.TrimSpace(address))
	if ip == nil || ip.To4() == nil {
		return contracts.MobileStatus{}, fmt.Errorf("mobile_address_invalid")
	}
	if _, err := strconv.Atoi(port); err != nil {
		return contracts.MobileStatus{}, fmt.Errorf("mobile_port_invalid")
	}
	token, err := randomToken()
	if err != nil {
		return contracts.MobileStatus{}, err
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort(ip.String(), port))
	if err != nil {
		return contracts.MobileStatus{}, err
	}
	m.stop()
	m.mu.Lock()
	m.enabled = true
	m.token = token
	m.address = ip.String()
	m.listener = listener
	m.url = fmt.Sprintf("http://%s/cast?token=%s", net.JoinHostPort(ip.String(), strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)), url.QueryEscape(token))
	m.server = &http.Server{Handler: http.HandlerFunc(m.serveLAN), ReadHeaderTimeout: 5 * time.Second}
	server := m.server
	m.mu.Unlock()
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			m.mu.Lock()
			m.enabled = false
			m.mu.Unlock()
		}
	}()
	return m.status(), nil
}

func (m *mobileManager) stop() {
	m.mu.Lock()
	if !m.enabled && m.server == nil {
		m.mu.Unlock()
		return
	}
	server := m.server
	m.enabled = false
	m.server = nil
	m.listener = nil
	m.token = ""
	m.url = ""
	for subscriber := range m.subscribers {
		select {
		case subscriber <- m.sessionPacket("session_end", "stopped"):
		default:
		}
		close(subscriber)
	}
	m.subscribers = map[chan mobilePacket]struct{}{}
	m.mu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = server.Shutdown(ctx)
		cancel()
	}
}

func (m *mobileManager) sessionPacket(kind, reason string) mobilePacket {
	event := contracts.ServerEvent{
		Type:   kind,
		SentAt: time.Now().UTC().Format(time.RFC3339Nano),
		Status: m.hub.status,
		Reason: &reason,
	}
	data, _ := json.Marshal(event)
	return mobilePacket{event: kind, data: data}
}

func (m *mobileManager) authorized(r *http.Request) bool {
	m.mu.Lock()
	token := m.token
	enabled := m.enabled
	m.mu.Unlock()
	if !enabled || token == "" {
		return false
	}
	if r.URL.Query().Get("token") == token {
		return true
	}
	cookie, err := r.Cookie(mobileCookie)
	return err == nil && cookie.Value == token
}

func (m *mobileManager) setCookie(w http.ResponseWriter) {
	m.mu.Lock()
	token := m.token
	m.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: mobileCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (m *mobileManager) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	clone := r.Clone(r.Context())
	clone.URL.Path = "/" + strings.TrimPrefix(name, "/")
	http.FileServer(m.assets).ServeHTTP(w, clone)
}

func (m *mobileManager) serveLAN(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !m.authorized(r) {
		if strings.HasPrefix(r.URL.Path, "/cast/events") {
			packet := m.sessionPacket("session_expired", "token_invalid")
			m.writeEventStream(w, r, packet.event, packet.data, nil)
			return
		}
		http.Error(w, "session expired", http.StatusGone)
		return
	}
	if r.URL.Path == "/cast" || r.URL.Path == "/cast/" {
		m.setCookie(w)
		m.serveAsset(w, r, "cast.html")
		return
	}
	if r.URL.Path == "/cast/events" {
		m.events(w, r)
		return
	}
	// The map API and static assets are read-only on the LAN handler. The base handler owns all
	// validation and resource loading, while this gate prevents mobile clients from reaching any
	// mutation endpoint.
	m.hub.mobileBase.ServeHTTP(w, r)
}

func (m *mobileManager) writeEventStream(w http.ResponseWriter, r *http.Request, event string, data []byte, packets <-chan mobilePacket) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", http.StatusInternalServerError)
		return
	}
	write := func(name string, payload []byte) bool {
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if event != "" && !write(event, data) {
		return
	}
	if packets == nil {
		return
	}
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case packet, ok := <-packets:
			if !ok || !write(packet.event, packet.data) {
				return
			}
			if packet.event == "session_end" || packet.event == "session_expired" {
				return
			}
		case <-ticker.C:
			if _, err := io.WriteString(w, ":keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (m *mobileManager) events(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	subscriber := make(chan mobilePacket, 64)
	m.subscribers[subscriber] = struct{}{}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if _, ok := m.subscribers[subscriber]; ok {
			delete(m.subscribers, subscriber)
			close(subscriber)
		}
		m.mu.Unlock()
	}()
	snapshot := m.hub.mobileSnapshot()
	data, _ := json.Marshal(snapshot)
	// Events published while the snapshot was being assembled remain buffered and are delivered
	// after it. A fresh snapshot is authoritative, so the client can safely apply those updates.
	m.writeEventStream(w, r, "snapshot", data, subscriber)
}

func (m *mobileManager) publish(event contracts.ServerEvent) {
	name := event.Type
	if name == "preferences_changed" {
		name = "map_changed"
	}
	if name == "overlay_status" {
		name = "map_changed"
	}
	if name != "snapshot" && name != "map_changed" && name != "player_upsert" && name != "player_remove" && name != "annotation_upsert" && name != "annotation_remove" && name != "annotations_changed" && name != "session_end" {
		return
	}
	names := []string{name}
	if event.Type == "preferences_changed" {
		names = append(names, "floor_changed", "basemap_changed", "center_changed")
	}
	if event.Type == "overlay_status" {
		names = append(names, "center_changed")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, eventName := range names {
		payload := event
		payload.Type = eventName
		data, err := json.Marshal(payload)
		if err != nil {
			continue
		}
		packet := mobilePacket{event: eventName, data: data}
		for subscriber := range m.subscribers {
			select {
			case subscriber <- packet:
			default:
				delete(m.subscribers, subscriber)
				close(subscriber)
			}
		}
	}
}

func (m *mobileManager) publishFilters(preferences *contracts.Preferences, mapID string) {
	if preferences == nil {
		return
	}
	for _, preference := range preferences.Maps {
		if preference.MapId != mapID {
			continue
		}
		payload := contracts.ServerEvent{
			Type:   "filters_changed",
			SentAt: time.Now().UTC().Format(time.RFC3339Nano),
			Status: m.hub.status,
			FiltersChanged: &contracts.MobileFiltersChanged{
				MapId: preference.MapId, HiddenCategories: preference.HiddenCategories,
				CollapsedGroups: preference.CollapsedGroups, ShowAnnotations: preference.ShowAnnotations,
				SelectedTasks: preference.SelectedTasks, TaskFilterActive: preference.TaskFilterActive,
			},
		}
		data, _ := json.Marshal(payload)
		m.mu.Lock()
		for subscriber := range m.subscribers {
			select {
			case subscriber <- mobilePacket{event: "filters_changed", data: data}:
			default:
				delete(m.subscribers, subscriber)
				close(subscriber)
			}
		}
		m.mu.Unlock()
		return
	}
}

func (m *mobileManager) writeLocalStatus(w http.ResponseWriter, r *http.Request) {
	if !localRequest(w, r) {
		return
	}
	jsonResponse(w, m.status())
}

func (m *mobileManager) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/cast/interfaces", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		jsonResponse(w, contracts.MobileInterfaces{Addresses: m.interfaces()})
	})
	mux.HandleFunc("GET /api/cast/status", m.writeLocalStatus)
	mux.HandleFunc("POST /api/cast/start", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		var body contracts.MobileStartRequest
		if !decodeUpdate(w, r, &body) {
			return
		}
		status, err := m.start(body.Address, hostPort(r.Host))
		if err != nil {
			apiError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonResponse(w, status)
	})
	mux.HandleFunc("POST /api/cast/stop", func(w http.ResponseWriter, r *http.Request) {
		if !localRequest(w, r) {
			return
		}
		m.stop()
		jsonResponse(w, m.status())
	})
}
