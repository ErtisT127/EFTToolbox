import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Brush,
  Check,
  Crosshair,
  Eraser,
  Hand,
  Sun,
  Moon,
  Sunrise,
  Sunset,
  Layers,
  MapPin,
  Maximize,
  Minimize,
  Minus,
  MousePointer2,
  Plus,
  Radio,
  Redo2,
  RefreshCw,
  RotateCcw,
  Settings2,
  Search,
  Type,
  Undo2,
} from 'lucide-react';
import type L from 'leaflet';
import type { PlayerState, Point, ServerEvent } from '../../../../contracts/ts/ipc.gen';
import { MapCanvas, type Tool, type ToolOptions } from './MapCanvas';
import { StickerPicker } from './StickerPicker';
import { LayerPanel } from './LayerPanel';
import { TaskPanel } from './TaskPanel';
import { ToolOptionsPanel } from './ToolOptionsPanel';
import { reportClientLog, Workspace, useWorkspace } from '../../stores/workspaceStore';
import { mapTimes, timePhase } from './lib/time';
import { ZOOM_BOUND_EPSILON } from './lib/zoom';
import type { MapClock } from '../../../../contracts/ts/ipc.gen';
import { useLocale } from '../../hooks/useLocale';

function RaidTimes({ clock }: { clock: MapClock }) {
  const { t } = useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!clock.offsets.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000 / Math.max(1, clock.rate));
    return () => clearInterval(timer);
  }, [clock]);
  return (
    <div className="raid-times">
      {mapTimes(clock, now).map((time, i) => {
        const phase = timePhase(time, clock.phases || []);
        const Icon = { day: Sun, night: Moon, dawn: Sunrise, dusk: Sunset }[phase?.icon || ''];
        return (
          <div className="time-slot" key={i}>
            {Icon && (
              <span title={phase?.label} aria-label={phase?.label}>
                <Icon size={17} aria-hidden="true" />
              </span>
            )}
            <time aria-label={t('map.info.slotAria', { index: i + 1 })}>{time}</time>
          </div>
        );
      })}
    </div>
  );
}

const workspace = new Workspace();
const tools: { id: Tool; icon: typeof Hand }[] = [
  { id: 'select', icon: MousePointer2 },
  { id: 'edit', icon: Hand },
  { id: 'brush', icon: Brush },
  { id: 'marker', icon: MapPin },
  { id: 'text', icon: Type },
  { id: 'eraser', icon: Eraser },
];

function Connection({ onEvent }: { onEvent: (event: ServerEvent) => void }) {
  const { t } = useLocale();
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    let stopped = false,
      socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>, stale: ReturnType<typeof setTimeout>;
    function connect() {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      );
      const current = socket;
      let reconnecting = false;
      function reconnect(reason: string, error = '', shouldLog = true) {
        if (reconnecting) return;
        reconnecting = true;
        if (shouldLog) reportClientLog('websocket_reconnect', reason, error);
        clearTimeout(stale);
        current.onclose = null;
        current.onerror = null;
        current.onmessage = null;
        current.close();
        if (!stopped) {
          setConnected(false);
          retry = setTimeout(connect, 2000);
        }
      }
      stale = setTimeout(() => reconnect('stale_timeout'), 7000);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as ServerEvent;
          if (
            data.status.protocolVersion !== '1' ||
            ![
              'snapshot',
              'heartbeat',
              'map_changed',
              'player_upsert',
              'player_remove',
              'annotation_upsert',
              'annotation_remove',
            ].includes(data.type)
          )
            throw new Error('invalid event');
          handler.current(data);
          setConnected(true);
          clearTimeout(stale);
          stale = setTimeout(() => reconnect('stale_timeout'), 7000);
        } catch (error) {
          reconnect('invalid_event', error instanceof Error ? error.message : String(error));
        }
      };
      socket.onerror = () => reconnect('socket_error');
      socket.onclose = (event) =>
        reconnect(`socket_close_${event.code}`, event.reason, event.code !== 1000);
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(stale);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    };
  }, []);
  return (
    <span className={`connection ${connected ? 'connected' : ''}`}>
      <Radio size={12} aria-hidden="true" />
      {connected ? t('status.connected') : t('status.reconnecting')}
    </span>
  );
}

export function MapPage() {
  const { t } = useLocale();
  const w = useWorkspace(workspace);
  const [tab, setTab] = useState('map');
  const [selectedTool, setTool] = useState<Tool>('select');
  const [temporaryHand, setTemporaryHand] = useState(false);
  const tool = temporaryHand ? 'edit' : selectedTool;
  const [panel, setPanel] = useState<'layers' | 'tasks' | null>(null);
  const [taskQuery, setTaskQuery] = useState('');
  const [cursor, setCursor] = useState<Point | null>(null);
  const [players, setPlayers] = useState<Map<string, PlayerState>>(() => new Map());
  const [fullscreenError, setFullscreenError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [options, setOptions] = useState<ToolOptions>({
    color: '#5FD3C4',
    width: 3,
    emoji: '📍',
    imageId: '',
    text: '',
    textSize: 15,
    eraserSize: 20,
  });
  const [browseStickers, setBrowseStickers] = useState(false);
  const [toolSettingsOpen, setToolSettingsOpen] = useState(false);
  const closeToolSettings = () => {
    setToolSettingsOpen(false);
    setBrowseStickers(false);
    setSizePreviewVisible(false);
  };
  const [sizePreview, setSizePreview] = useState(0);
  const [sizePreviewVisible, setSizePreviewVisible] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSize = (size: number) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setSizePreview(size);
    setSizePreviewVisible(true);
    previewTimer.current = setTimeout(() => setSizePreviewVisible(false), 1000);
  };
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    [],
  );
  // Zoom bounds reported by the canvas: the buttons and the wheel must stop in the same place.
  const [zoomState, setZoomState] = useState<{ zoom: number; min: number; max: number } | null>(
    null,
  );
  const atMin = zoomState !== null && zoomState.zoom <= zoomState.min + ZOOM_BOUND_EPSILON;
  const atMax = zoomState !== null && zoomState.zoom >= zoomState.max - ZOOM_BOUND_EPSILON;
  const map = useRef<L.Map | null>(null);
  const initialized = useRef(false);
  const workArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(!!workArea.current && document.fullscreenElement === workArea.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  const layerButton = useRef<HTMLButtonElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const stickerButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocus = useRef(false);
  const panelPinned = useRef(false);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openPanel = (next: 'layers' | 'tasks') => {
    closeToolSettings();
    cancelClose();
    if (!restoringFocus.current) {
      if (panel !== next) panelPinned.current = false;
      setPanel(next);
    }
  };
  const leavePanel = () => {
    cancelClose();
    if (panelPinned.current) return;
    closeTimer.current = setTimeout(() => setPanel(null), 450);
  };
  const closePanel = (next: 'layers' | 'tasks') => {
    cancelClose();
    panelPinned.current = false;
    setPanel(null);
    restoringFocus.current = true;
    (next === 'layers' ? layerButton : taskButton).current?.focus();
    restoringFocus.current = false;
  };
  // Hovering opens a panel unpinned, so a click on a panel that is merely hovered pins it in
  // place; a click on one already pinned closes it, the way the button's own toggle should read.
  const togglePanel = (next: 'layers' | 'tasks') => {
    if (panel === next && panelPinned.current) closePanel(next);
    else {
      openPanel(next);
      panelPinned.current = true;
    }
  };
  const blurPanel = (target: EventTarget | null) => {
    if (
      target instanceof Node &&
      (popup.current?.contains(target) ||
        layerButton.current?.contains(target) ||
        taskButton.current?.contains(target))
    )
      return;
    if (
      popup.current?.matches(':hover') ||
      layerButton.current?.matches(':hover') ||
      taskButton.current?.matches(':hover')
    )
      return;
    leavePanel();
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const session = w.sessions.get(w.activeId);
  const preference = session ? w.preferenceFor(w.activeId) : undefined;
  const id = w.activeId;
  const handleServerEvent = (event: ServerEvent) => {
    if (event.type === 'snapshot') {
      if (!Array.isArray(event.players)) {
        reportClientLog('websocket_payload_invalid', 'snapshot missing players');
      }
      setPlayers(new Map((event.players || []).map((player) => [player.playerId, player])));
      return;
    }
    if (event.type === 'player_upsert') {
      if (!event.player) {
        reportClientLog('websocket_payload_invalid', 'player_upsert missing player');
        return;
      }
      const player = event.player;
      setPlayers((previous) => new Map(previous).set(player.playerId, player));
      return;
    }
    if (event.type === 'player_remove') {
      if (!event.playerId) {
        reportClientLog('websocket_payload_invalid', 'player_remove missing playerId');
        return;
      }
      const playerId = event.playerId;
      setPlayers((previous) => {
        const next = new Map(previous);
        next.delete(playerId);
        return next;
      });
      return;
    }
    if (event.type === 'map_changed') {
      const nextMap = event.mapId;
      if (!nextMap || !w.catalog.some((map) => map.id === nextMap)) {
        reportClientLog(
          'map_event_rejected',
          'rejected unknown map event',
          nextMap || 'missing mapId',
        );
        return;
      }
      setPlayers(new Map());
      void w.select(nextMap);
    }
  };

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void workspace.initialize();
    }
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (workspace.unsaved) event.preventDefault();
    };
    const hidden = () => {
      // TODO: For shared/online use, add conflict detection: saving pending preferences sends
      // the entire in-memory snapshot and can overwrite changes made by an external writer.
      if (document.visibilityState === 'hidden') void workspace.savePreferences();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  useEffect(() => {
    if (!panel) return;
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setPanel(null);
        restoringFocus.current = true;
        (panel === 'layers' ? layerButton : taskButton).current?.focus();
        restoringFocus.current = false;
      }
    }
    document.addEventListener('keydown', key);
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !popup.current?.contains(target) &&
        !layerButton.current?.contains(target) &&
        !taskButton.current?.contains(target)
      )
        setPanel(null);
    }
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [panel]);
  const setOption = (value: Partial<ToolOptions>) =>
    setOptions((previous) => ({ ...previous, ...value }));
  // Resolve stored stickers without walking the catalogue on each pointer update.
  const stickerIndex = useMemo(() => new Map(w.stickers.map((s) => [s.id, s])), [w.stickers]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await workArea.current?.requestFullscreen();
      setFullscreenError('');
    } catch {
      setFullscreenError('errors.fullscreen_unsupported');
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Crosshair size={21} strokeWidth={1.5} aria-hidden="true" />
          <span>
            EFT<span className="brand-secondary"> TOOLBOX</span>
          </span>
        </div>
        <nav aria-label={t('nav.aria')}>
          {[
            ['map', t('nav.map')],
            ['items', t('nav.items')],
            ['tools', t('nav.tools')],
            ['settings', t('nav.settings')],
          ].map(([key, name]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="mode">
          <span className="mode-dot" />
          PVP
        </div>
      </header>
      {tab !== 'map' ? (
        <section className="placeholder">
          <Settings2 size={32} strokeWidth={1.5} />
          <span className="eyebrow">EFT TOOLBOX</span>
          <h1>{t(`nav.${tab}`)}</h1>
          <p>{t('common.building')}</p>
          <button onClick={() => setTab('map')}>
            <ArrowLeft size={15} />
            {t('common.backToMap')}
          </button>
        </section>
      ) : (
        <>
          <div className="map-strip">
            <div
              className="map-tabs"
              role="tablist"
              aria-label={t('map.tabs.aria')}
              // Its scrollbar is hidden, so the wheel has to drive it; a horizontal-only scroller
              // does not translate the wheel on its own.
              onWheel={(event) => {
                event.currentTarget.scrollLeft += event.deltaY;
              }}
            >
              {w.catalog.map((m) => (
                <button
                  role="tab"
                  aria-selected={id === m.id}
                  key={m.id}
                  className={id === m.id ? 'active' : ''}
                  onClick={() => {
                    closeToolSettings();
                    setPanel(null);
                    setCursor(null);
                    void w.select(m.id);
                  }}
                >
                  <span className="map-tab-name">
                    {m.iconUrl && (
                      <i
                        className="map-tab-icon"
                        style={{ maskImage: `url("${m.iconUrl}")` }}
                        aria-hidden="true"
                      />
                    )}
                    {m.name}
                  </span>
                  <small>{m.subtitle}</small>
                </button>
              ))}
            </div>
            <button
              className="icon-button reload"
              title={t('map.tabs.reload')}
              aria-label={t('map.tabs.reload')}
              disabled={w.loading}
              onClick={() => {
                if (id) void w.select(id, true);
                else void w.initialize();
              }}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="workspace" ref={workArea}>
            {w.loading ? (
              <div className="empty-state" role="status">
                <span className="spinner" />
                <p>{t('map.state.loading')}</p>
              </div>
            ) : w.error ? (
              <div className="empty-state" role="alert">
                <h2>{t('map.state.unavailable')}</h2>
                <p>{t(w.error)}</p>
                <button onClick={() => void w.initialize()}>{t('map.state.reload')}</button>
              </div>
            ) : !session || !preference ? (
              <div className="empty-state">
                <h2>{t('map.state.empty')}</h2>
                <p>{t('map.state.emptyHint')}</p>
              </div>
            ) : (
              <>
                <MapCanvas
                  key={id}
                  data={session.data}
                  preference={preference}
                  stickers={stickerIndex}
                  items={session.items}
                  players={players}
                  playerFollow
                  playerAutoZoom={{ enabled: false, zoomLevel: preference.zoom }}
                  tool={tool}
                  options={options}
                  onCommit={(items) => w.commit(id, items)}
                  onView={(center, zoom) => w.updatePreference(id, { center, zoom })}
                  onUndo={() => w.undo(id)}
                  onRedo={() => w.redo(id)}
                  onSelectTool={setTool}
                  onTemporaryHand={setTemporaryHand}
                  onActivateFloor={(floorId) => w.updatePreference(id, { floorId })}
                  onCursor={setCursor}
                  onZoomChange={setZoomState}
                  onReady={(value) => {
                    map.current = value;
                  }}
                />
                <div className="view-controls">
                  <div className="zoom-buttons">
                    <button
                      aria-label={t('map.view.zoomInAria')}
                      title={t('map.view.zoomIn')}
                      disabled={atMax}
                      aria-disabled={atMax}
                      onClick={() => map.current?.zoomIn()}
                    >
                      <Plus size={17} />
                    </button>
                    <button
                      aria-label={t('map.view.zoomOutAria')}
                      title={t('map.view.zoomOut')}
                      disabled={atMin}
                      aria-disabled={atMin}
                      onClick={() => map.current?.zoomOut()}
                    >
                      <Minus size={17} />
                    </button>
                  </div>
                  <button
                    ref={layerButton}
                    aria-label={t('map.view.layers')}
                    title={t('map.view.layers')}
                    aria-expanded={panel === 'layers'}
                    className={panel === 'layers' ? 'active' : ''}
                    onPointerEnter={() => openPanel('layers')}
                    onPointerLeave={leavePanel}
                    onFocus={() => openPanel('layers')}
                    onBlur={(e) => blurPanel(e.relatedTarget)}
                    onClick={() => togglePanel('layers')}
                  >
                    <Layers size={28} fill="currentColor" />
                    {preference.floorId !== session.data.baseFloor && (
                      <span className="floor-badge">
                        {session.data.floors.find((f) => f.id === preference.floorId)?.name}
                      </span>
                    )}
                  </button>
                  <button
                    aria-label={
                      isFullscreen ? t('map.view.exitFullscreen') : t('map.view.fullscreen')
                    }
                    title={isFullscreen ? t('map.view.exitFullscreen') : t('map.view.fullscreen')}
                    onClick={() => void toggleFullscreen()}
                  >
                    {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                  </button>
                  <button
                    title={t('map.view.fit')}
                    aria-label={t('map.view.fit')}
                    onClick={() => {
                      const [x, y, width, height] = session.data.projection.viewBox;
                      map.current?.fitBounds(
                        [
                          [-y - height, x],
                          [-y, x + width],
                        ],
                        { padding: [48, 48] },
                      );
                    }}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
                {panel === 'layers' && (
                  <div
                    className="layer-panel floating"
                    ref={popup}
                    aria-label={t('map.layers.title')}
                    onPointerDown={() => {
                      cancelClose();
                      panelPinned.current = true;
                    }}
                    onPointerEnter={cancelClose}
                    onPointerLeave={leavePanel}
                    onFocus={cancelClose}
                    onBlur={(e) => blurPanel(e.relatedTarget)}
                  >
                    <LayerPanel
                      data={session.data}
                      items={session.items}
                      preference={preference}
                      onPreference={(changes) => w.updatePreference(id, changes)}
                      onClose={() => closePanel('layers')}
                    />
                  </div>
                )}
                <div
                  className="tool-group"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      closeToolSettings();
                      event.currentTarget
                        .querySelector<HTMLButtonElement>('.toolbar button.active')
                        ?.focus();
                    }
                  }}
                >
                  <div className="toolbar floating" role="toolbar" aria-label={t('map.tools.aria')}>
                    {tools.map(({ id: toolId, icon: Icon }) => (
                      <button
                        key={toolId}
                        title={t(`map.tools.names.${toolId}`)}
                        aria-label={t(`map.tools.names.${toolId}`)}
                        aria-pressed={tool === toolId}
                        aria-expanded={
                          ['brush', 'marker', 'text', 'eraser'].includes(toolId)
                            ? tool === toolId && toolSettingsOpen
                            : undefined
                        }
                        className={tool === toolId ? 'active' : ''}
                        onClick={() => {
                          setPanel(null);
                          setToolSettingsOpen(
                            ['brush', 'marker', 'text', 'eraser'].includes(toolId) &&
                              (selectedTool !== toolId || !toolSettingsOpen),
                          );
                          setTool(toolId);
                          setBrowseStickers(false);
                          setSizePreviewVisible(false);
                        }}
                      >
                        <Icon size={20} strokeWidth={1.5} />
                      </button>
                    ))}
                    <div className="tool-divider" />
                    <button
                      aria-label={t('map.tools.undo')}
                      title={t('map.tools.undoTitle')}
                      disabled={!session.past.length}
                      onClick={() => w.undo(id)}
                    >
                      <Undo2 size={19} />
                    </button>
                    <button
                      aria-label={t('map.tools.redo')}
                      title={t('map.tools.redoTitle')}
                      disabled={!session.future.length}
                      onClick={() => w.redo(id)}
                    >
                      <Redo2 size={19} />
                    </button>
                  </div>
                  {toolSettingsOpen && ['brush', 'marker', 'text', 'eraser'].includes(tool) && (
                    <ToolOptionsPanel
                      tool={tool}
                      options={options}
                      items={session.items}
                      stickers={stickerIndex}
                      recent={tool === 'marker' ? w.recentStickers() : []}
                      browseStickers={browseStickers}
                      stickerButton={stickerButton}
                      setOption={setOption}
                      previewSize={previewSize}
                      onCommit={(items) => w.commit(id, items)}
                      onBrowse={() => setBrowseStickers(true)}
                      onClose={closeToolSettings}
                    />
                  )}
                  {browseStickers && (
                    <StickerPicker
                      stickers={w.stickers}
                      recent={w.recentStickers()}
                      onClose={() => {
                        setBrowseStickers(false);
                        stickerButton.current?.focus();
                      }}
                      onPick={({ emoji, imageId }) => {
                        setOption({ emoji, imageId });
                        w.recordSticker(imageId || emoji);
                        setBrowseStickers(false);
                        stickerButton.current?.focus();
                      }}
                    />
                  )}
                </div>
                <div
                  className={`size-preview-scrim ${sizePreviewVisible ? 'visible' : ''}`}
                  aria-hidden="true"
                />
                <div
                  className={`size-preview ${sizePreviewVisible ? 'visible' : ''}`}
                  aria-hidden="true"
                  style={{ width: sizePreview, height: sizePreview }}
                />
                <div className="map-sidebar">
                  <aside className="map-info floating">
                    <RaidTimes clock={session.data.clock} />
                    <dl>
                      <div>
                        <dt>{t('map.info.duration')}</dt>
                        <dd>
                          {session.data.raidDuration || '—'} <span>{t('map.info.minutes')}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('map.info.players')}</dt>
                        <dd>{session.data.players}</dd>
                      </div>
                    </dl>
                  </aside>
                  <div className="task-control">
                    <button
                      className="task-trigger"
                      aria-label={t('map.tasks.trigger')}
                      title={t('map.tasks.trigger')}
                      ref={taskButton}
                      aria-expanded={panel === 'tasks'}
                      onPointerEnter={() => openPanel('tasks')}
                      onPointerLeave={leavePanel}
                      onFocus={() => openPanel('tasks')}
                      onBlur={(e) => blurPanel(e.relatedTarget)}
                      onClick={() => togglePanel('tasks')}
                    >
                      <Search size={24} />
                    </button>
                    {panel === 'tasks' && (
                      <div
                        className="task-panel floating"
                        ref={popup}
                        aria-label={t('map.tasks.trigger')}
                        onPointerDown={() => {
                          cancelClose();
                          panelPinned.current = true;
                        }}
                        onPointerEnter={cancelClose}
                        onPointerLeave={leavePanel}
                        onFocus={cancelClose}
                        onBlur={(e) => blurPanel(e.relatedTarget)}
                      >
                        <TaskPanel
                          tasks={session.data.tasks}
                          preference={preference}
                          taskQuery={taskQuery}
                          setTaskQuery={setTaskQuery}
                          onPreference={(changes) => w.updatePreference(id, changes)}
                          onClose={() => closePanel('tasks')}
                        />
                      </div>
                    )}
                  </div>
                </div>
                {cursor && (
                  <div className="coordinates">
                    {`x: ${cursor.x.toFixed(2)} z: ${cursor.y.toFixed(2)}`}
                  </div>
                )}
                {(session.error || w.preferenceError || fullscreenError) && (
                  <div className="save-error floating" role="alert">
                    <span>{t(session.error || w.preferenceError || fullscreenError)}</span>
                    <button
                      onClick={() => {
                        void w.save(id);
                        void w.savePreferences();
                        setFullscreenError('');
                      }}
                    >
                      {t('common.retry')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      <footer className="statusbar">
        <Connection onEvent={handleServerEvent} />
        <div className="save-status" role="status">
          {session?.error ? (
            <span className="danger">{t('map.status.unsaved')}</span>
          ) : session?.saving ? (
            <>
              <span className="small-spinner" />
              {t('map.status.saving')}
            </>
          ) : (
            <>
              <Check size={12} />
              {t('map.status.saved')}
            </>
          )}
        </div>
      </footer>
    </main>
  );
}
