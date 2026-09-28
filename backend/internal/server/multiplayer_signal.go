package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

func randomToken16() string {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(value)
}

// bindRoomSockets binds the TCP signaling listener on the chosen address. The user-facing port
// is the signaling port; ICE runs on ephemeral UDP ports that the SDP candidates already carry.
// An empty port or "0" means auto: a free port is drawn at random.
func bindRoomSockets(ip net.IP, port string) (net.Listener, int, *apiFailure) {
	if port != "" && port != "0" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return nil, 0, fail(http.StatusBadRequest, "multiplayer_port_invalid")
		}
		listener, err := net.Listen("tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(value)))
		if err != nil {
			return nil, 0, failDetail(http.StatusConflict, "multiplayer_port_in_use", strconv.Itoa(value))
		}
		return listener, value, nil
	}
	for attempt := 0; attempt < 20; attempt++ {
		value := 20000 + mathrand.IntN(40000)
		listener, err := net.Listen("tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(value)))
		if err == nil {
			return listener, value, nil
		}
	}
	return nil, 0, fail(http.StatusConflict, "multiplayer_port_unavailable")
}

// signalListener is the custom-mode host signaling endpoint: a tiny key-gated HTTP server on the
// chosen LAN address that turns a joiner's SDP offer into an answer.
type signalListener struct {
	server   *http.Server
	key      string
	capacity func() bool
	accept   func(offer string) (string, *apiFailure)
}

type signalRequest struct {
	Key   string `json:"key"`
	Offer string `json:"offer"`
}

type signalResponse struct {
	Answer string `json:"answer"`
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

func newSignalListener(listener net.Listener, key string, capacity func() bool, accept func(string) (string, *apiFailure)) *signalListener {
	s := &signalListener{key: key, capacity: capacity, accept: accept}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /signal", s.handleSignal)
	s.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		_ = s.server.Serve(listener)
	}()
	return s
}

func (s *signalListener) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = s.server.Shutdown(ctx)
	cancel()
}

func (s *signalListener) handleSignal(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeSignalJSON(w, http.StatusBadRequest, signalResponse{Error: "multiplayer_signal_invalid"})
		return
	}
	var request signalRequest
	if json.Unmarshal(body, &request) != nil || request.Offer == "" {
		writeSignalJSON(w, http.StatusBadRequest, signalResponse{Error: "multiplayer_signal_invalid"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(request.Key), []byte(s.key)) != 1 {
		writeSignalJSON(w, http.StatusForbidden, signalResponse{Error: "multiplayer_key_invalid"})
		return
	}
	if !s.capacity() {
		writeSignalJSON(w, http.StatusServiceUnavailable, signalResponse{Error: "multiplayer_room_full"})
		return
	}
	answer, failure := s.accept(request.Offer)
	if failure != nil {
		writeSignalJSON(w, failure.status, signalResponse{Error: failure.code, Detail: failure.detail})
		return
	}
	writeSignalJSON(w, http.StatusOK, signalResponse{Answer: answer})
}

func writeSignalJSON(w http.ResponseWriter, status int, value signalResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// bindStunSignaling opens the STUN-mode host signaling socket and learns its public mapped
// address from the selected STUN server. Under a cone NAT that mapping is reachable from anyone,
// which is exactly what the share text advertises; a symmetric NAT invalidates it and joining fails.
func bindStunSignaling(stunServer string) (*net.UDPConn, string, *apiFailure) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: 0})
	if err != nil {
		return nil, "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	mapped, err := stunMappedAddr(conn, stunServer, 3*time.Second)
	if err != nil {
		_ = conn.Close()
		return nil, "", fail(http.StatusBadGateway, "multiplayer_stun_failed")
	}
	return conn, net.JoinHostPort(mapped.IP.String(), strconv.Itoa(mapped.Port)), nil
}

// stunListener serves the same handshake over that UDP socket.
type stunListener struct {
	conn     *net.UDPConn
	key      string
	capacity func() bool
	accept   func(offer string) (string, *apiFailure)
	closed   chan struct{}
}

func newStunListener(conn *net.UDPConn, key string, capacity func() bool, accept func(string) (string, *apiFailure)) *stunListener {
	s := &stunListener{conn: conn, key: key, capacity: capacity, accept: accept, closed: make(chan struct{})}
	go s.run()
	return s
}

func (s *stunListener) close() {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	_ = s.conn.Close()
}

func (s *stunListener) run() {
	buffer := make([]byte, 1<<16)
	for {
		n, from, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			select {
			case <-s.closed:
				return
			default:
			}
			return
		}
		var request signalRequest
		if json.Unmarshal(buffer[:n], &request) != nil || request.Offer == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(request.Key), []byte(s.key)) != 1 {
			s.reply(from, signalResponse{Error: "multiplayer_key_invalid"})
			continue
		}
		if !s.capacity() {
			s.reply(from, signalResponse{Error: "multiplayer_room_full"})
			continue
		}
		answer, failure := s.accept(request.Offer)
		if failure != nil {
			s.reply(from, signalResponse{Error: failure.code, Detail: failure.detail})
			continue
		}
		s.reply(from, signalResponse{Answer: answer})
	}
}

func (s *stunListener) reply(to *net.UDPAddr, value signalResponse) {
	data, _ := json.Marshal(value)
	_, _ = s.conn.WriteToUDP(data, to)
}

// joining side

func signalCustom(address, port, key, offer string) (string, *apiFailure) {
	url := fmt.Sprintf("http://%s/signal", net.JoinHostPort(address, port))
	body, _ := json.Marshal(signalRequest{Key: key, Offer: offer})
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	defer func() { _ = response.Body.Close() }()
	var payload signalResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return "", fail(http.StatusBadGateway, "multiplayer_signaling_timeout")
	}
	if payload.Error != "" {
		return "", signalFailure(payload)
	}
	if payload.Answer == "" {
		return "", fail(http.StatusBadGateway, "multiplayer_signaling_timeout")
	}
	return payload.Answer, nil
}

// signalFailure maps the host's error code onto an HTTP status for the local REST reply.
func signalFailure(payload signalResponse) *apiFailure {
	status := http.StatusBadGateway
	switch payload.Error {
	case "multiplayer_key_invalid":
		status = http.StatusForbidden
	case "multiplayer_room_full":
		status = http.StatusServiceUnavailable
	case "multiplayer_share_invalid":
		status = http.StatusBadRequest
	}
	return failDetail(status, payload.Error, payload.Detail)
}

func signalStun(hostAddr, key, offer string) (string, *apiFailure) {
	raddr, err := net.ResolveUDPAddr("udp", hostAddr)
	if err != nil {
		return "", fail(http.StatusBadRequest, "multiplayer_share_invalid")
	}
	conn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	defer func() { _ = conn.Close() }()
	body, _ := json.Marshal(signalRequest{Key: key, Offer: offer})
	if _, err := conn.Write(body); err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	if err := conn.SetReadDeadline(time.Now().Add(6 * time.Second)); err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	buffer := make([]byte, 1<<16)
	n, err := conn.Read(buffer)
	if err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	var payload signalResponse
	if json.Unmarshal(buffer[:n], &payload) != nil {
		return "", fail(http.StatusBadGateway, "multiplayer_signaling_timeout")
	}
	if payload.Error != "" {
		return "", signalFailure(payload)
	}
	if payload.Answer == "" {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	return payload.Answer, nil
}

// answerOffer finalizes the host side of the handshake: the answer is non-trickled so the SDP
// already carries ICE candidates and no extra signaling round trip is needed.
func answerOffer(pc *webrtc.PeerConnection, offerSDP string) (string, *apiFailure) {
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return "", fail(http.StatusBadRequest, "multiplayer_share_invalid")
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	select {
	case <-gatherDone:
	case <-time.After(5 * time.Second):
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	return pc.LocalDescription().SDP, nil
}

// share text: plaintext, human-readable, and parseable for paste-to-join.

const shareHeader = "EFTToolbox 联机"

func buildShareText(mode, host, stunServer, key string) string {
	var builder strings.Builder
	builder.WriteString(shareHeader + "\n")
	if mode == multiplayerModeStun {
		builder.WriteString("模式: STUN\n")
	} else {
		builder.WriteString("模式: 局域网\n")
	}
	builder.WriteString("房主: " + host + "\n")
	if mode == multiplayerModeStun && stunServer != "" {
		builder.WriteString("STUN: " + stunServer + "\n")
	}
	builder.WriteString("密码: " + key + "\n")
	return builder.String()
}
