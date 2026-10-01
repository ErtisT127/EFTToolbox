package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	contracts "efttoolbox/contracts"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

var stunKeepaliveInterval = 20 * time.Second

const maxSignalDatagram = 60 << 10

type stunDatagram struct {
	data []byte
	from *net.UDPAddr
}

type stunSignaler struct {
	conn          *net.UDPConn
	client        *stun.Client
	pipe          net.Conn
	server        *net.UDPAddr
	messages      chan stunDatagram
	closed        chan struct{}
	keepaliveDone chan struct{}
	once          sync.Once
}

func newStunSignaler(conn *net.UDPConn, server string) (*stunSignaler, *net.UDPAddr, error) {
	host, port, err := splitStunAddress(server)
	if err != nil {
		return nil, nil, err
	}
	raddr, err := net.ResolveUDPAddr(stunNetwork(server), net.JoinHostPort(host, port))
	if err != nil {
		return nil, nil, err
	}
	pipeClient, pipeMux := net.Pipe()
	client, err := stun.NewClient(pipeClient, stun.WithRTO(500*time.Millisecond))
	if err != nil {
		_ = pipeClient.Close()
		_ = pipeMux.Close()
		return nil, nil, err
	}
	s := &stunSignaler{conn: conn, client: client, pipe: pipeMux, server: raddr, messages: make(chan stunDatagram), closed: make(chan struct{})}
	stun.WithNoRetransmit(client)
	go s.route()
	go s.writeStun()
	var mapped *net.UDPAddr
	var probeErr error
	err = client.Do(stun.MustBuild(stun.TransactionID, stun.BindingRequest), func(event stun.Event) {
		if event.Error != nil {
			probeErr = event.Error
			return
		}
		var addr stun.XORMappedAddress
		probeErr = addr.GetFrom(event.Message)
		if probeErr == nil {
			mapped = &net.UDPAddr{IP: addr.IP, Port: addr.Port}
		}
	})
	if err == nil {
		err = probeErr
	}
	if err != nil || mapped == nil {
		s.close()
		if err == nil {
			err = fmt.Errorf("missing XOR-MAPPED-ADDRESS")
		}
		return nil, nil, err
	}
	return s, mapped, nil
}

func (s *stunSignaler) route() {
	buffer := make([]byte, 1<<16)
	for {
		n, from, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		data := append([]byte(nil), buffer[:n]...)
		if stun.IsMessage(data) {
			if _, err := s.pipe.Write(data); err != nil {
				return
			}
			continue
		}
		select {
		case s.messages <- stunDatagram{data: data, from: from}:
		case <-s.closed:
			return
		}
	}
}

func (s *stunSignaler) writeStun() {
	buffer := make([]byte, 1<<16)
	for {
		n, err := s.pipe.Read(buffer)
		if err != nil {
			return
		}
		if _, err := s.conn.WriteToUDP(buffer[:n], s.server); err != nil {
			return
		}
	}
}

func (s *stunSignaler) close() {
	s.once.Do(func() {
		close(s.closed)
		_ = s.client.Close()
		if s.keepaliveDone != nil {
			<-s.keepaliveDone
		}
		_ = s.pipe.Close()
		_ = s.conn.Close()
	})
}

func (s *stunSignaler) keepalive() {
	defer close(s.keepaliveDone)
	ticker := time.NewTicker(stunKeepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			select {
			case <-s.closed:
				return
			default:
			}
			_ = s.client.Do(stun.MustBuild(stun.TransactionID, stun.BindingRequest), nil)
		case <-s.closed:
			return
		}
	}
}

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
		listener, err := net.Listen("tcp", net.JoinHostPort(ip.String(), strconv.Itoa(value)))
		if err != nil {
			return nil, 0, failDetail(http.StatusConflict, "multiplayer_port_in_use", strconv.Itoa(value))
		}
		return listener, value, nil
	}
	for attempt := 0; attempt < 20; attempt++ {
		value := 20000 + mathrand.IntN(40000)
		listener, err := net.Listen("tcp", net.JoinHostPort(ip.String(), strconv.Itoa(value)))
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

type signalRequest = contracts.SignalRequest
type signalResponse = contracts.SignalResponse

func sealSignal(roomKey string, payload any) (signalRequest, error) {
	plain, err := json.Marshal(payload)
	if err != nil {
		return signalRequest{}, err
	}
	block, err := aes.NewCipher(signalKey(roomKey))
	if err != nil {
		return signalRequest{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return signalRequest{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return signalRequest{}, err
	}
	return signalRequest{Nonce: base64.StdEncoding.EncodeToString(nonce), Payload: base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, plain, nil))}, nil
}

func openSignal(roomKey, nonceText, payloadText string, out any) error {
	nonce, err := base64.StdEncoding.DecodeString(nonceText)
	if err != nil || len(nonce) != 12 {
		return errSignalEnvelopeInvalid
	}
	ciphertext, err := base64.StdEncoding.DecodeString(payloadText)
	if err != nil || len(ciphertext) < 16 {
		return errSignalEnvelopeInvalid
	}
	block, err := aes.NewCipher(signalKey(roomKey))
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	plain, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return errSignalKeyInvalid
	}
	if err := decodeSignalJSON(plain, out); err != nil {
		return errSignalEnvelopeInvalid
	}
	return nil
}

func decodeSignalJSON(data []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("trailing signal data")
	}
	return nil
}

func signalKey(roomKey string) []byte {
	key := sha256.Sum256([]byte("efttoolbox-signal\x00" + roomKey))
	return key[:]
}

var (
	errSignalEnvelopeInvalid = errors.New("invalid signal envelope")
	errSignalKeyInvalid      = errors.New("invalid signal key")
)

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
	body, err := io.ReadAll(io.LimitReader(r.Body, 3<<20))
	if err != nil {
		s.writeResponse(w, http.StatusBadRequest, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
		return
	}
	var request signalRequest
	if decodeSignalJSON(body, &request) != nil || len(request.Nonce) != 16 || len(request.Payload) > 2<<20 {
		s.writeResponse(w, http.StatusBadRequest, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
		return
	}
	var payload contracts.SignalPayloadRequest
	if err := openSignal(s.key, request.Nonce, request.Payload, &payload); err != nil {
		code, status := signalOpenFailure(err)
		s.writeResponse(w, status, contracts.SignalPayloadResponse{Error: code})
		return
	}
	if payload.Offer == "" || len(payload.Offer) > 1<<20 {
		s.writeResponse(w, http.StatusBadRequest, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
		return
	}
	if !s.capacity() {
		s.writeResponse(w, http.StatusServiceUnavailable, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerRoomFull})
		return
	}
	answer, failure := s.accept(payload.Offer)
	if failure != nil {
		s.writeResponse(w, failure.status, contracts.SignalPayloadResponse{Error: contracts.SignalErrorCode(failure.code), Detail: failure.detail})
		return
	}
	s.writeResponse(w, http.StatusOK, contracts.SignalPayloadResponse{Answer: answer})
}

func (s *signalListener) writeResponse(w http.ResponseWriter, status int, value contracts.SignalPayloadResponse) {
	sealed, err := sealSignal(s.key, value)
	envelope := signalResponse(sealed)
	if err != nil {
		status = http.StatusInternalServerError
		envelope = signalResponse{}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope)
}

func signalOpenFailure(err error) (contracts.SignalErrorCode, int) {
	if errors.Is(err, errSignalKeyInvalid) {
		return contracts.SignalErrorMultiplayerKeyInvalid, http.StatusForbidden
	}
	return contracts.SignalErrorMultiplayerSignalInvalid, http.StatusBadRequest
}

// bindStunSignaling opens the STUN-mode host signaling socket and learns its public mapped
// address from the selected STUN server. Under a cone NAT that mapping is reachable from anyone,
// which is exactly what the structured invite advertises; a symmetric NAT invalidates it and joining fails.
func bindStunSignaling(stunServer string) (*stunSignaler, *net.UDPAddr, *apiFailure) {
	conn, err := net.ListenUDP(stunNetwork(stunServer), &net.UDPAddr{Port: 0})
	if err != nil {
		return nil, nil, fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	signaler, mapped, err := newStunSignaler(conn, stunServer)
	if err != nil {
		_ = conn.Close()
		return nil, nil, fail(http.StatusBadGateway, "multiplayer_stun_failed")
	}
	return signaler, mapped, nil
}

// stunListener serves the same handshake over that UDP socket.
type stunListener struct {
	signaler *stunSignaler
	key      string
	capacity func() bool
	accept   func(offer string) (string, *apiFailure)
	closed   chan struct{}
}

func newStunListener(signaler *stunSignaler, key string, capacity func() bool, accept func(string) (string, *apiFailure)) *stunListener {
	s := &stunListener{signaler: signaler, key: key, capacity: capacity, accept: accept, closed: signaler.closed}
	signaler.keepaliveDone = make(chan struct{})
	go signaler.keepalive()
	go s.run()
	return s
}

func (s *stunListener) close() {
	s.signaler.close()
}

func (s *stunListener) run() {
	for {
		select {
		case packet := <-s.signaler.messages:
			var request signalRequest
			if decodeSignalJSON(packet.data, &request) != nil || len(request.Nonce) != 16 || len(request.Payload) > 2<<20 {
				s.reply(packet.from, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
				continue
			}
			var payload contracts.SignalPayloadRequest
			if err := openSignal(s.key, request.Nonce, request.Payload, &payload); err != nil {
				code, _ := signalOpenFailure(err)
				s.reply(packet.from, contracts.SignalPayloadResponse{Error: code})
				continue
			}
			if payload.Offer == "" || len(payload.Offer) > 1<<20 {
				s.reply(packet.from, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
				continue
			}
			if !s.capacity() {
				s.reply(packet.from, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerRoomFull})
				continue
			}
			answer, failure := s.accept(payload.Offer)
			if failure != nil {
				s.reply(packet.from, contracts.SignalPayloadResponse{Error: contracts.SignalErrorCode(failure.code), Detail: failure.detail})
				continue
			}
			s.reply(packet.from, contracts.SignalPayloadResponse{Answer: answer})
		case <-s.closed:
			return
		}
	}
}

func (s *stunListener) reply(to *net.UDPAddr, value contracts.SignalPayloadResponse) {
	envelope, err := sealSignal(s.key, value)
	if err != nil {
		return
	}
	data, _ := json.Marshal(envelope)
	if len(data) > maxSignalDatagram {
		envelope, err = sealSignal(s.key, contracts.SignalPayloadResponse{Error: contracts.SignalErrorMultiplayerSignalInvalid})
		if err != nil {
			return
		}
		data, _ = json.Marshal(envelope)
	}
	_, _ = s.signaler.conn.WriteToUDP(data, to)
}

// joining side

func signalCustom(address, port, key, offer string) (string, *apiFailure) {
	url := fmt.Sprintf("http://%s/signal", net.JoinHostPort(address, port))
	body, err := sealSignal(key, contracts.SignalPayloadRequest{Offer: offer})
	if err != nil {
		return "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	encoded, _ := json.Marshal(body)
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Post(url, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	defer func() { _ = response.Body.Close() }()
	var envelope signalResponse
	var payload contracts.SignalPayloadResponse
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 3<<20))
	if err != nil || decodeSignalJSON(responseBody, &envelope) != nil {
		return "", fail(http.StatusForbidden, "multiplayer_key_invalid")
	}
	if err := openSignal(key, envelope.Nonce, envelope.Payload, &payload); err != nil {
		return "", fail(http.StatusForbidden, "multiplayer_key_invalid")
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
func signalFailure(payload contracts.SignalPayloadResponse) *apiFailure {
	status := http.StatusBadGateway
	switch payload.Error {
	case contracts.SignalErrorMultiplayerKeyInvalid:
		status = http.StatusForbidden
	case contracts.SignalErrorMultiplayerRoomFull:
		status = http.StatusServiceUnavailable
	case contracts.SignalErrorMultiplayerShareInvalid:
		status = http.StatusBadRequest
	}
	return failDetail(status, string(payload.Error), payload.Detail)
}

func signalStun(hostAddr, key, offer string) (string, *apiFailure) {
	network := stunNetwork(hostAddr)
	raddr, err := net.ResolveUDPAddr(network, hostAddr)
	if err != nil {
		return "", fail(http.StatusBadRequest, "multiplayer_share_invalid")
	}
	conn, err := net.DialUDP(network, nil, raddr)
	if err != nil {
		return "", fail(http.StatusGatewayTimeout, "multiplayer_signaling_timeout")
	}
	defer func() { _ = conn.Close() }()
	body, err := sealSignal(key, contracts.SignalPayloadRequest{Offer: offer})
	if err != nil {
		return "", fail(http.StatusInternalServerError, "multiplayer_connection_failed")
	}
	encoded, _ := json.Marshal(body)
	if len(encoded) > maxSignalDatagram {
		return "", fail(http.StatusBadRequest, "multiplayer_signal_invalid")
	}
	if _, err := conn.Write(encoded); err != nil {
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
	var envelope signalResponse
	var payload contracts.SignalPayloadResponse
	if decodeSignalJSON(buffer[:n], &envelope) != nil {
		return "", fail(http.StatusForbidden, "multiplayer_key_invalid")
	}
	if err := openSignal(key, envelope.Nonce, envelope.Payload, &payload); err != nil {
		return "", fail(http.StatusForbidden, "multiplayer_key_invalid")
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
