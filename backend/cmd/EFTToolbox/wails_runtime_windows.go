//go:build windows

package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"efttoolbox/backend/internal/server"
	"efttoolbox/contracts"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"golang.org/x/sys/windows"
)

//go:embed assets/banner.png
var splashBanner []byte

//go:embed assets/icon.png
var appIcon []byte

// eventHeartbeat is how often the host comments on an idle event stream, which is what keeps the
// WebView2 connection from being reaped while nothing is happening.
const eventHeartbeat = 20 * time.Second

// trayRequestTimeout bounds the two calls a tray click makes to the host's own backend: the menu has
// to open with the right labels even when the backend is busy or gone.
const trayRequestTimeout = 2 * time.Second

type desktopRuntime struct {
	app      *application.App
	window   *application.WebviewWindow
	splash   *application.WebviewWindow
	tray     *application.SystemTray
	dataRoot string
	events   *hostEvents
	// baseURL is the loopback address the backend listens on, empty until it is up.
	baseURL string
	// ready carries the dashboard's ready report. It is buffered so the report never blocks and one
	// that arrives before the host starts waiting is still seen.
	ready chan struct{}
	// stateMu guards the resources start() creates and stop() releases: the app can be shut down
	// while startup is still running, and neither side may see half-written state.
	stateMu    sync.Mutex
	server     *http.Server
	listener   net.Listener
	overlay    *overlayProcess
	cancel     context.CancelFunc
	stopped    atomic.Bool
	allowClose atomic.Bool
	// closeShown carries the dashboard's confirmation that the close dialog is really on screen.
	closeShown chan struct{}
	// pageReady is set once the dashboard reports that its first load finished; before that it cannot
	// draw the close dialog, so a close request falls back to a native message box.
	pageReady atomic.Bool
}

// hostEvents is the host's own push channel to the dashboard. The page subscribes with EventSource
// and the host broadcasts here instead of running ExecJS, which WebView2 silently drops whenever
// the page is busy building its first render.
type hostEvents struct {
	mu      sync.Mutex
	clients map[*hostEventClient]struct{}
}

type hostEventClient struct {
	messages chan string
	done     chan struct{}
}

func newHostEvents() *hostEvents {
	return &hostEvents{clients: map[*hostEventClient]struct{}{}}
}

func (b *hostEvents) subscribe() (*hostEventClient, int) {
	client := &hostEventClient{messages: make(chan string, 16), done: make(chan struct{})}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.clients[client] = struct{}{}
	return client, len(b.clients)
}

func (b *hostEvents) unsubscribe(client *hostEventClient) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.close(client)
	return len(b.clients)
}

// broadcast encodes one named event for every subscriber. The buffered channel keeps a page that
// stopped reading from stalling the host: that client misses the event instead.
func (b *hostEvents) broadcast(name string, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("encode host event %s: %v", name, err)
		return
	}
	message := "event: " + name + "\ndata: " + string(encoded) + "\n\n"
	b.mu.Lock()
	defer b.mu.Unlock()
	for client := range b.clients {
		select {
		case client.messages <- message:
		default:
		}
	}
}

// closeAll ends every open stream so an idle event connection cannot hold the HTTP shutdown open.
func (b *hostEvents) closeAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for client := range b.clients {
		b.close(client)
	}
}

// close drops one subscriber; the caller holds the lock, so the broadcaster can never send on a
// channel that is already closed.
func (b *hostEvents) close(client *hostEventClient) {
	if _, ok := b.clients[client]; !ok {
		return
	}
	delete(b.clients, client)
	close(client.done)
}

func runDesktop(exeDir, assets, dataRoot string, port int, overlayExe string) error {
	absoluteDataRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return err
	}
	dataRoot = absoluteDataRoot
	if err := validateStartup(assets, dataRoot, overlayExe); err != nil {
		showNativeStartupFailure(dataRoot, err)
		return err
	}
	uniqueID := instanceID(exeDir)
	runtime := &desktopRuntime{
		dataRoot:   dataRoot,
		events:     newHostEvents(),
		ready:      make(chan struct{}, 1),
		closeShown: make(chan struct{}, 1),
	}
	options := application.Options{
		Name:        "EFTToolbox",
		Description: "Escape from Tarkov map toolbox",
		Icon:        appIcon,
		// The window navigates to the backend's loopback URL, so this handler only backs the
		// wails:// asset origin Wails serves the shell from.
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(os.DirFS(assets)),
		},
		Windows: application.WindowsOptions{
			WndClass:            "EFTToolbox",
			WebviewUserDataPath: filepath.Join(dataRoot, "webview2"),
		},
		// The dashboard's title bar posts the window commands through WebView2's own message channel,
		// so they do not depend on the Wails runtime script (which cannot reach the host from a page
		// this app serves itself).
		RawMessageHandler: func(_ application.Window, message string, _ *application.OriginInfo) {
			runtime.handleWindowMessage(message)
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: uniqueID,
			ExitCode: 0,
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if runtime.window != nil {
					runtime.showWindow()
				}
			},
		},
	}
	runtime.app = application.New(options)
	// The splash is the only thing on screen while the app starts: a frameless transparent window
	// that draws nothing but the banner, so the desktop stays visible around it.
	runtime.splash = runtime.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "splash",
		Title:            "EFTToolbox",
		Width:            splashWindowWidth,
		Height:           splashWindowHeight,
		Frameless:        true,
		DisableResize:    true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
		HTML: splashHTML(),
	})
	runtime.splash.Center()
	// Frameless: the dashboard draws the title bar. The window keeps native behaviour because it
	// publishes non-client regions for the caption and the window buttons, which is what makes
	// Windows treat them as real ones - drag, double-click maximize, the system menu, the Windows 11
	// Snap Layouts flyout on the maximize button, and the resize borders Wails computes itself.
	runtime.window = runtime.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main-window",
		Title:            "EFTToolbox",
		Width:            defaultWindowWidth,
		Height:           defaultWindowHeight,
		MinWidth:         minWindowWidth,
		MinHeight:        minWindowHeight,
		Hidden:           true,
		Frameless:        true,
		BackgroundColour: application.NewRGB(10, 12, 11),
		Windows: application.WindowsWindow{
			NonClientRegionSupport:     true,
			WebView2CompositionHosting: true,
		},
		HTML: splashHTML(),
	})
	runtime.configureTray()
	runtime.window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if runtime.allowClose.Load() {
			return
		}
		event.Cancel()
		runtime.requestCloseChoice()
	})
	// The dashboard swaps its maximize button for a restore button from these.
	runtime.window.OnWindowEvent(events.Common.WindowMaximise, func(*application.WindowEvent) { runtime.emitWindowState(true) })
	runtime.window.OnWindowEvent(events.Common.WindowUnMaximise, func(*application.WindowEvent) { runtime.emitWindowState(false) })
	runtime.app.OnShutdown(func() {
		runtime.stop()
	})
	runtime.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go runtime.start(assets, port, overlayExe)
	})
	return runtime.app.Run()
}

func (r *desktopRuntime) configureTray() {
	r.tray = r.app.SystemTray.New().SetIcon(appIcon)
	r.tray.SetTooltip("EFTToolbox")
	r.tray.OnClick(func() { r.showWindow() })
	// The window and minimap entries name the action they perform, so the menu is rebuilt for every
	// open instead of whenever the state behind a label happens to change.
	r.tray.OnRightClick(func() {
		r.applyTrayMenu()
		r.tray.ShowMenu()
	})
	r.applyTrayMenu()
}

// applyTrayMenu (re)builds the tray entries in the interface language and in the state the window and
// the minimap are in right now.
func (r *desktopRuntime) applyTrayMenu() {
	language := r.language()
	windowKey := "host.trayShowWindow"
	if r.window.IsVisible() {
		windowKey = "host.trayHideWindow"
	}
	minimapKey := "host.trayShowMinimap"
	if r.overlayVisible() {
		minimapKey = "host.trayHideMinimap"
	}
	menu := r.app.Menu.New()
	menu.Add(contracts.MessageText(language, windowKey)).OnClick(func(*application.Context) { r.toggleWindow() })
	menu.Add(contracts.MessageText(language, minimapKey)).OnClick(func(*application.Context) { r.toggleMinimap() })
	menu.AddSeparator()
	menu.Add(contracts.MessageText(language, "host.traySettings")).OnClick(func(*application.Context) { r.openSettings() })
	menu.AddSeparator()
	menu.Add(contracts.MessageText(language, "host.trayQuit")).OnClick(func(*application.Context) {
		r.allowClose.Store(true)
		r.app.Quit()
	})
	r.tray.SetMenu(menu)
}

// openSettings brings the window up and asks the dashboard for its settings page, which is the one
// place a user reaching for the tray usually wants.
func (r *desktopRuntime) openSettings() {
	r.showWindow()
	r.events.broadcast("open-settings", struct{}{})
}

// toggleWindow hides the window to the tray or brings it back, the same two states the close dialog's
// tray answer produces.
func (r *desktopRuntime) toggleWindow() {
	if r.window.IsVisible() {
		r.window.Hide()
		r.emitHostState(true)
		return
	}
	r.showWindow()
}

// toggleMinimap flips the overlay's visibility through the command the dashboard's own switch sends,
// so the overlay applies both down one path.
func (r *desktopRuntime) toggleMinimap() {
	address := r.address()
	if address == "" {
		return
	}
	visible := !r.overlayVisible()
	body, err := json.Marshal(contracts.OverlayCommand{Kind: "visible", Enabled: &visible})
	if err != nil {
		log.Printf("encode overlay command: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), trayRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address+"/api/overlay/command", bytes.NewReader(body))
	if err != nil {
		log.Printf("overlay command: %v", err)
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		log.Printf("overlay command failed: %v", err)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusNoContent {
		log.Printf("overlay command rejected: %s", response.Status)
		return
	}
	log.Printf("tray toggled the minimap to visible=%t", visible)
}

// overlayVisible reports whether the minimap is on screen. The tray menu labels its toggle from this,
// and an unreachable backend simply means the overlay is not drawing anything.
func (r *desktopRuntime) overlayVisible() bool {
	address := r.address()
	if address == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), trayRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/api/overlay/state", nil)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer func() { _ = response.Body.Close() }()
	var view contracts.OverlayView
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&view) != nil {
		return false
	}
	return view.Visible
}

// address is the loopback base URL the backend ended up on, empty until it is up.
func (r *desktopRuntime) address() string {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.baseURL
}

// language is the interface language the host's own chrome is rendered in.
func (r *desktopRuntime) language() string {
	return server.HostLanguage(r.dataRoot)
}

func (r *desktopRuntime) start(assets string, port int, overlayExe string) {
	ctx, cancel := context.WithCancel(context.Background())
	if !r.holdState(func() { r.cancel = cancel }) {
		cancel()
		return
	}
	if err := server.InstallLogging(filepath.Join(r.dataRoot, "..", "logs")); err != nil {
		r.fail(failure("host.startupLog", err))
		return
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		r.fail(failure("host.startupPort", err))
		return
	}
	baseURL := "http://" + listener.Addr().String()
	handler := server.New(ctx, version, http.Dir(assets), r.dataRoot)
	srv := &http.Server{Handler: r.hostHandler(handler), ReadHeaderTimeout: 5 * time.Second}
	if !r.holdState(func() { r.listener = listener; r.server = srv; r.baseURL = baseURL }) {
		_ = listener.Close()
		return
	}
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("backend stopped: %v", err)
		}
	}()
	if err := waitHTTP(ctx, baseURL+"/api/status", 20*time.Second); err != nil {
		r.fail(failure("host.startupBackend", err))
		return
	}
	if r.stopped.Load() {
		return
	}
	process, err := startOverlayChecked(overlayExe, baseURL+"/")
	if err != nil {
		r.fail(failure("host.startupOverlayStart", err))
		return
	}
	if !r.holdState(func() { r.overlay = process }) {
		process.Stop(3 * time.Second)
		return
	}
	if err := waitOverlay(ctx, baseURL, process); err != nil {
		r.fail(failure("host.startupOverlayReady", err))
		return
	}
	if r.stopped.Load() {
		return
	}
	// The window stays hidden behind the splash until the dashboard says its first load finished, so
	// nobody sees an empty page or a half-built shell.
	r.window.SetURL(baseURL + "/")
	r.showWhenReady()
}

// showWhenReady waits for the dashboard's ready report and then swaps the splash for the window. The
// timeout only exists so a dashboard that cannot report still becomes visible instead of leaving the
// app as a splash that never ends.
func (r *desktopRuntime) showWhenReady() {
	select {
	case <-r.ready:
	case <-time.After(readyTimeout):
		log.Printf("dashboard did not report ready within %s; showing the window anyway", readyTimeout)
	}
	if r.stopped.Load() {
		return
	}
	r.revealMainWindow(true)
}

// holdState stores a startup-owned resource unless the app already began shutting down, and reports
// whether startup may continue. It shares its lock with stop(), so a resource is either visible in
// stop()'s snapshot or handed back to the caller to release.
func (r *desktopRuntime) holdState(assign func()) bool {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if r.stopped.Load() {
		return false
	}
	assign()
	return true
}

func (r *desktopRuntime) hostHandler(next http.Handler) http.Handler {
	hostMux := http.NewServeMux()
	hostMux.HandleFunc("GET /api/host/events", r.serveEvents)
	hostMux.HandleFunc("GET /api/host/close-behavior", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(contracts.HostCloseBehavior{Action: server.HostCloseAction(r.dataRoot)})
	})
	hostMux.HandleFunc("POST /api/host/ready", func(w http.ResponseWriter, req *http.Request) {
		defer func() { _ = req.Body.Close() }()
		select {
		case r.ready <- struct{}{}:
		default:
			// The dashboard reports ready once per load; a reload reporting again is not an error.
		}
		r.pageReady.Store(true)
		log.Print("dashboard reported ready")
		w.WriteHeader(http.StatusNoContent)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// /api/host/* belongs to the desktop shell; every other path is the backend's.
		if strings.HasPrefix(req.URL.Path, "/api/host/") {
			hostMux.ServeHTTP(w, req)
			return
		}
		next.ServeHTTP(w, req)
	})
}

// serveEvents is the dashboard's subscription to the host's own state. It stays open for the life of
// the page, so the host writes the headers immediately and then one event per state change.
func (r *desktopRuntime) serveEvents(w http.ResponseWriter, req *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	client, count := r.events.subscribe()
	defer func() {
		log.Printf("host events client disconnected (%d)", r.events.unsubscribe(client))
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	// The browser's own reconnect delay, so a dropped stream comes back without the page asking.
	_, _ = io.WriteString(w, "retry: 1000\n\n")
	flusher.Flush()
	log.Printf("host events client connected (%d)", count)
	heartbeat := time.NewTicker(eventHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-req.Context().Done():
			return
		case <-client.done:
			return
		case message := <-client.messages:
			if _, err := io.WriteString(w, message); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (r *desktopRuntime) requestCloseChoice() {
	if pref := server.HostCloseAction(r.dataRoot); pref == "exit" || pref == "tray" {
		log.Printf("close requested; applying the saved close behavior %q", pref)
		r.applyClose(pref)
		return
	}
	if !r.pageReady.Load() {
		log.Print("close requested before the dashboard was ready; using the native dialog")
		r.showNativeCloseDialog()
		return
	}
	log.Print("close requested; asking the dashboard for the close dialog")
	for {
		select {
		case <-r.closeShown:
			continue
		default:
		}
		break
	}
	r.events.broadcast("close-request", struct{}{})
	// The request only counts as handled once the page says the dialog is up. Without that answer the
	// native dialog keeps the close from going silent.
	select {
	case <-r.closeShown:
		log.Print("dashboard confirmed the close dialog")
	case <-time.After(closeDialogTimeout):
		log.Print("dashboard did not confirm the close dialog; using the native dialog")
		r.showNativeCloseDialog()
	}
}

// The close dialog itself is drawn by the dashboard, so its wording and layout are the app's own; the
// title bar opens it without asking the host at all. This message box is the fallback for the paths
// the host starts itself (Alt+F4, the taskbar menu) when the page is not ready or does not confirm the
// dialog in time. Wails maps MessageBox's Yes/No to these exact labels, so anything else would never
// fire.
func (r *desktopRuntime) showNativeCloseDialog() {
	language := r.language()
	dialog := r.app.Dialog.Question().
		SetTitle(contracts.MessageText(language, "host.closeTitle")).
		SetMessage(contracts.MessageText(language, "host.closeStartupMessage")).
		AttachToWindow(r.window)
	exit := dialog.AddButton("Yes").SetAsDefault()
	cancel := dialog.AddButton("No").SetAsCancel()
	dialog.SetDefaultButton(exit)
	dialog.SetCancelButton(cancel)
	exit.OnClick(func() { r.applyClose("exit") })
	cancel.OnClick(func() { log.Print("close cancelled") })
	dialog.Show()
}

// handleCloseChoice applies what the dashboard's close dialog reported:
// {"action": "exit"|"tray"|"cancel", "remember": bool}.
func (r *desktopRuntime) handleCloseChoice(payload string) {
	var choice struct {
		Action   string `json:"action"`
		Remember bool   `json:"remember"`
	}
	if err := json.Unmarshal([]byte(payload), &choice); err != nil {
		log.Printf("invalid close choice: %v", err)
		return
	}
	if choice.Action != "exit" && choice.Action != "tray" && choice.Action != "cancel" {
		log.Printf("invalid close action: %q", choice.Action)
		return
	}
	if choice.Remember {
		// The dialog doubles as the way back to "ask": dismissing it with the box ticked clears the
		// preference instead of picking a new one.
		action := choice.Action
		if action == "cancel" {
			action = "ask"
		}
		if err := server.SetHostCloseAction(r.dataRoot, action); err != nil {
			log.Printf("save host close preference: %v", err)
		}
	}
	log.Printf("close choice: %s (remember=%t)", choice.Action, choice.Remember)
	r.applyClose(choice.Action)
}

func (r *desktopRuntime) applyClose(action string) {
	log.Printf("close action: %s", action)
	if action == "exit" {
		r.allowClose.Store(true)
		r.app.Quit()
		return
	}
	if action == "tray" {
		r.window.Hide()
		r.emitHostState(true)
	}
}

func (r *desktopRuntime) showWindow() {
	r.revealMainWindow(false)
}

// revealMainWindow drops the splash and brings the real window up. withSize is only true on the
// first reveal: after that the window keeps whatever size and position the user gave it.
func (r *desktopRuntime) revealMainWindow(withSize bool) {
	if splash := r.splash; splash != nil {
		r.splash = nil
		splash.Close()
	}
	if withSize {
		if width, height, ok := defaultWindowSize(); ok {
			r.window.SetSize(width, height)
			r.window.Center()
		}
	}
	r.window.Show().Focus()
	r.emitHostState(false)
	r.emitWindowState(r.window.IsMaximised())
}

func (r *desktopRuntime) emitHostState(background bool) {
	r.events.broadcast("host-state", map[string]bool{"background": background})
}

func (r *desktopRuntime) emitWindowState(maximized bool) {
	r.events.broadcast("window-state", map[string]bool{"maximized": maximized})
}

// handleWindowMessage receives what the dashboard posts with window.chrome.webview.postMessage.
// Closing goes straight to the close dialog instead of the window's own close path, so the dialog
// cannot be skipped even when the click was forwarded from a non-client region.
func (r *desktopRuntime) handleWindowMessage(message string) {
	switch {
	case message == "efttoolbox:window:minimize":
		r.window.Minimise()
	case message == "efttoolbox:window:toggle-maximize":
		r.window.ToggleMaximise()
	case message == "efttoolbox:window:close":
		r.requestCloseChoice()
	case message == "efttoolbox:close:shown":
		select {
		case r.closeShown <- struct{}{}:
		default:
		}
	case strings.HasPrefix(message, "efttoolbox:close:"):
		r.handleCloseChoice(strings.TrimPrefix(message, "efttoolbox:close:"))
	case strings.HasPrefix(message, openURLPrefix):
		r.openExternal(strings.TrimPrefix(message, openURLPrefix))
	default:
		log.Printf("unhandled window message: %s", message)
	}
}

// openURLPrefix carries a page link the user clicked to the shell: a WebView2 page has no way to
// hand a URL to the system browser on its own, and letting it navigate would replace the app.
const openURLPrefix = "efttoolbox:open-url:"

func (r *desktopRuntime) openExternal(url string) {
	if !strings.HasPrefix(url, "https://") {
		log.Printf("refused to open non-https link: %s", url)
		return
	}
	if err := r.app.Browser.OpenURL(url); err != nil {
		log.Printf("open %s: %v", url, err)
	}
}

// keyedFailure keeps a startup failure as a message key plus the raw detail, so the error page can
// state the reason in the interface language without losing what the system reported.
type keyedFailure struct {
	key string
	err error
}

func (f keyedFailure) Error() string { return f.err.Error() }
func (f keyedFailure) Unwrap() error { return f.err }

func failure(key string, err error) error { return keyedFailure{key: key, err: err} }

func startupFailureDetail(language string, err error) string {
	detail := err.Error()
	var keyed keyedFailure
	if errors.As(err, &keyed) {
		detail = contracts.MessageText(language, keyed.key) + ": " + keyed.err.Error()
		if keyed.key == "host.startupDataDirectory" || keyed.key == "host.startupLog" {
			detail += "\n\n" + contracts.MessageText(language, "host.startupPermissionHint")
		}
	}
	return detail
}

func showNativeStartupFailure(dataRoot string, err error) {
	language := server.HostLanguage(dataRoot)
	detail := startupFailureDetail(language, err)
	body, bodyErr := windows.UTF16PtrFromString(detail)
	title, titleErr := windows.UTF16PtrFromString("EFTToolbox")
	if bodyErr == nil && titleErr == nil {
		_, _ = windows.MessageBox(0, body, title, windows.MB_ICONERROR|windows.MB_OK)
	}
}

func (r *desktopRuntime) fail(err error) {
	log.Printf("startup failed: %v", err)
	language := r.language()
	detail := startupFailureDetail(language, err)
	// Startup errors must terminate even though the normal close hook protects the
	// window while the user is deciding between exit and tray mode.
	r.allowClose.Store(true)
	if splash := r.splash; splash != nil {
		r.splash = nil
		splash.Close()
	}
	r.window.SetHTML(errorHTML(language, detail)).Show().Focus()
	r.window.Center()
	time.AfterFunc(3*time.Second, r.app.Quit)
}

func (r *desktopRuntime) stop() {
	r.stopped.Store(true)
	// An open event stream is an active request: without this the HTTP shutdown would wait for the
	// dashboard's subscription until its timeout.
	r.events.closeAll()
	r.stateMu.Lock()
	cancel, overlay, srv := r.cancel, r.overlay, r.server
	r.stateMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if overlay != nil {
		overlay.Stop(3 * time.Second)
	}
	if srv != nil {
		ctx, shutdown := context.WithTimeout(context.Background(), 5*time.Second)
		_ = srv.Shutdown(ctx)
		shutdown()
	}
}

func validateStartup(assets, dataRoot, overlayExe string) error {
	for _, path := range []string{
		filepath.Join(assets, "index.html"),
		overlayExe,
		filepath.Join(dataRoot, "upstream", "modes"),
		filepath.Join(dataRoot, "upstream", "assets"),
	} {
		if _, err := os.Stat(path); err != nil {
			return failure("host.startupResource", fmt.Errorf("%s: %w", path, err))
		}
	}
	for _, target := range []struct {
		path string
		key  string
	}{
		{filepath.Join(dataRoot, "user"), "host.startupDataDirectory"},
		{filepath.Join(dataRoot, "webview2"), "host.startupDataDirectory"},
		{filepath.Join(filepath.Dir(dataRoot), "logs"), "host.startupLog"},
	} {
		if err := checkStartupDirectory(target.path); err != nil {
			return failure(target.key, fmt.Errorf("%s: %w", target.path, err))
		}
	}
	return nil
}

func checkStartupDirectory(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	probe, err := os.CreateTemp(path, ".startup-write-")
	if err != nil {
		return err
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Remove(name); err != nil {
		return err
	}
	return nil
}

func waitHTTP(ctx context.Context, endpoint string, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if requestErr != nil {
			return requestErr
		}
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("timeout after %s", timeout)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func waitOverlay(ctx context.Context, baseURL string, process *overlayProcess) error {
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	for {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/overlay/bootstrap", nil)
		if requestErr != nil {
			return requestErr
		}
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				// Do not open a probe socket with client=overlay here. The server uses
				// that query value to mark a native overlay connection, so doing so
				// would make startup succeed without the child process being ready.
				stateRequest, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/overlay/state", nil)
				if requestErr == nil {
					stateResponse, stateErr := http.DefaultClient.Do(stateRequest)
					if stateErr == nil {
						var state contracts.OverlayView
						decodeErr := json.NewDecoder(stateResponse.Body).Decode(&state)
						_ = stateResponse.Body.Close()
						if stateResponse.StatusCode == http.StatusOK && decodeErr == nil && state.Connected {
							return nil
						}
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-process.done:
			return errors.New("process exited early")
		case <-deadline.C:
			return errors.New("timeout")
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func instanceID(exeDir string) string {
	clean := filepath.Clean(exeDir)
	var hash uint64 = 1469598103934665603
	for _, value := range strings.ToLower(clean) {
		hash ^= uint64(value)
		hash *= 1099511628211
	}
	return fmt.Sprintf("efttoolbox-%x", hash)
}

// splashHTML is the splash document: a transparent page with nothing but the banner, so the splash
// window shows the wordmark on the desktop instead of a page with a background.
func splashHTML() string {
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%%;margin:0;background:transparent;overflow:hidden}body{display:grid;place-items:center}img{width:100%%;height:100%%;max-width:%dpx;max-height:%dpx;object-fit:contain;-webkit-user-select:none;user-select:none}</style></head><body><img src="data:image/png;base64,%s" alt="EFT TOOLBOX" draggable="false"></body></html>`, splashWindowWidth, splashWindowHeight, base64.StdEncoding.EncodeToString(splashBanner))
}

func errorHTML(language, detail string) string {
	title := html.EscapeString(contracts.MessageText(language, "host.errorTitle"))
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%%;margin:0;background:#0a0c0b;color:#d4d8d5;font:16px sans-serif;display:grid;place-items:center}main{max-width:720px;padding:32px}h1{color:#c4554b;font-size:22px}pre{white-space:pre-wrap;color:#d9a93e}</style></head><body><main><h1>%s</h1><pre>%s</pre></main></body></html>`, title, html.EscapeString(detail))
}
