// The desktop host is a Wails/WebView2 window: `window.chrome.webview` exists there and nowhere in a
// browser, which is how the title bar decides whether to render the window buttons at all.
type WebViewBridge = { postMessage: (message: string) => void };

const bridge = (): WebViewBridge | undefined =>
  (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;

export const isHosted = () => bridge() !== undefined;

export const postHostMessage = (message: string) => bridge()?.postMessage(message);

type CloseBehavior = 'ask' | 'exit' | 'tray';

// The host owns the saved close behavior, so the dashboard asks for it instead of guessing. A
// browser or the development server has no such route, and "ask" is the safe answer there.
export async function loadCloseBehavior(): Promise<CloseBehavior> {
  try {
    const response = await fetch('/api/host/close-behavior', { cache: 'no-store' });
    if (response.ok) {
      const body = (await response.json()) as { action?: string };
      if (body.action === 'exit' || body.action === 'tray' || body.action === 'ask')
        return body.action;
    }
  } catch {
    // Fall through to the dialog: asking is always safe.
  }
  return 'ask';
}

// The dashboard's own close dialog, opened from the title bar. It needs no host round trip: the
// answer travels back through the message channel once the user picks something.
export const openCloseDialog = () => window.dispatchEvent(new Event('efttoolbox:close-dialog'));

export async function requestClose() {
  if ((await loadCloseBehavior()) === 'ask') openCloseDialog();
  else postHostMessage('efttoolbox:window:close');
}

// A page link has nowhere to go inside the app: an anchor would navigate the window itself away from
// the dashboard, and the host never opened a second window. The host hands the URL to the system
// browser instead, which is also why it refuses anything that is not https.
export const openExternal = (url: string) => {
  if (isHosted()) postHostMessage(`efttoolbox:open-url:${url}`);
  else window.open(url, '_blank', 'noopener');
};

// What the host pushes back: window state for the tray, the maximize button's icon, the close
// requests it starts itself (Alt+F4, the taskbar menu) and the tray's settings entry. It is a
// server-sent event stream rather than an injected script, because WebView2 drops a script into a
// page that is still busy rendering.
const hostEventNames = ['host-state', 'window-state', 'close-request', 'open-settings'] as const;

type HostEventName = (typeof hostEventNames)[number];

type HostEventPayload = { background?: boolean; maximized?: boolean };

const hostEventListeners = new Map<HostEventName, Set<(payload: HostEventPayload) => void>>();

let hostEventSource: EventSource | undefined;

const openHostEvents = () => {
  const source = new EventSource('/api/host/events');
  for (const name of hostEventNames) {
    source.addEventListener(name, (message) => {
      let payload: HostEventPayload = {};
      try {
        payload = JSON.parse((message as MessageEvent<string>).data) as HostEventPayload;
      } catch {
        // A payload the host did not write as JSON only means this event carries no detail.
      }
      for (const handler of hostEventListeners.get(name) ?? []) handler(payload);
    });
  }
  return source;
};

// Every subscriber shares one connection: the host has a single stream per page, and the reference
// count closes it again once the last listener goes away. A browser has no host to push anything, so
// it subscribes to nothing.
export function subscribeHostEvents(
  event: HostEventName,
  handler: (payload: HostEventPayload) => void,
) {
  if (!isHosted()) return () => {};
  const handlers = hostEventListeners.get(event) ?? new Set<(payload: HostEventPayload) => void>();
  hostEventListeners.set(event, handlers);
  handlers.add(handler);
  hostEventSource ??= openHostEvents();
  return () => {
    handlers.delete(handler);
    if ([...hostEventListeners.values()].every((entry) => entry.size === 0)) {
      hostEventSource?.close();
      hostEventSource = undefined;
    }
  };
}

type RegionKind = 'caption' | 'minimize' | 'maximize' | 'close';

const kinds: readonly string[] = ['caption', 'minimize', 'maximize', 'close'];

const regionKind = (element: Element): RegionKind | undefined => {
  const value = element.getAttribute('data-non-client-region');
  return value && kinds.includes(value) ? (value as RegionKind) : undefined;
};

// Wails maps the regions published here into real Windows hit tests, so the custom title bar keeps
// native dragging, double-click maximize, the system menu and the Windows 11 Snap Layouts flyout on
// the maximize button. The message is the same one Wails' own runtime sends.
const publish = () => {
  const scale = window.devicePixelRatio || 1;
  const regions: { kind: RegionKind; left: number; top: number; right: number; bottom: number }[] =
    [];
  for (const element of Array.from(document.querySelectorAll('[data-non-client-region]'))) {
    const kind = regionKind(element);
    if (!kind) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    regions.push({
      kind,
      left: Math.floor(box.left * scale),
      top: Math.floor(box.top * scale),
      right: Math.ceil(box.right * scale),
      bottom: Math.ceil(box.bottom * scale),
    });
  }
  postHostMessage(`wails:non-client-region:${JSON.stringify({ version: 1, regions })}`);
};

// Geometry is only correct after layout, so publishing is batched into an animation frame and
// repeated whenever the window or a tagged element changes size, plus when the set of tagged
// elements changes.
export function publishNonClientRegions(): () => void {
  if (!isHosted()) return () => {};
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      publish();
    });
  };
  const tags = () => document.querySelectorAll('[data-non-client-region]');
  const resizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
  const observeTags = () => {
    if (!resizes) return;
    resizes.disconnect();
    for (const element of Array.from(tags())) resizes.observe(element);
  };
  const mutations =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => {
          observeTags();
          schedule();
        });
  schedule();
  observeTags();
  window.addEventListener('resize', schedule);
  mutations?.observe(document.body, { childList: true, subtree: true });
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    resizes?.disconnect();
    mutations?.disconnect();
  };
}
