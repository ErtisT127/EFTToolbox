import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brush,
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
  MapPinned,
  RefreshCw,
  RotateCcw,
  Search,
  Type,
} from 'lucide-react';
import type L from 'leaflet';
import type { WorldXZ } from '../../../../contracts/ts/ipc.gen';
import { MapCanvas, type Tool, type ToolOptions } from './MapCanvas';
import { StickerPicker } from './StickerPicker';
import { LayerPanel } from './LayerPanel';
import { TaskPanel } from './TaskPanel';
import { MinimapSettingsPanel } from './MinimapSettingsPanel';
import { ToolOptionsPanel } from './ToolOptionsPanel';
import { workspace, useWorkspace } from '../../stores/workspaceStore';
import { mapTimes, timePhase } from './lib/time';
import { ZOOM_BOUND_EPSILON } from './lib/zoom';
import type { MapClock } from '../../../../contracts/ts/ipc.gen';
import { useLocale } from '../../hooks/useLocale';
import { useOverlay } from '../../stores/overlayStore';
import { notices } from '../../stores/noticeStore';
import { ToolToolbar } from '../../components/ToolToolbar';
import { MapUnavailableState } from '../../components/MapUnavailableState';
import { AppPopover } from '../../components/AppPopover';
import { CastControl } from '../../components/CastControl';

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

const tools: { id: Tool; icon: typeof Hand }[] = [
  { id: 'select', icon: MousePointer2 },
  { id: 'edit', icon: Hand },
  { id: 'brush', icon: Brush },
  { id: 'marker', icon: MapPin },
  { id: 'text', icon: Type },
  { id: 'eraser', icon: Eraser },
];

export function MapPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useLocale();
  const w = useWorkspace(workspace);
  const overlay = useOverlay();
  const [selectedTool, setTool] = useState<Tool>('select');
  const [temporaryHand, setTemporaryHand] = useState(false);
  const tool = temporaryHand ? 'edit' : selectedTool;
  const [panel, setPanel] = useState<'layers' | 'tasks' | 'minimap' | null>(null);
  const [taskQuery, setTaskQuery] = useState('');
  const [cursor, setCursor] = useState<WorldXZ | null>(null);
  const players = overlay.players;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const initialOptions: ToolOptions = {
    color: '#5FD3C4',
    width: 3,
    emoji: '\u{1F4CD}',
    imageId: '',
    text: '',
    textSize: 15,
    eraserSize: 20,
  };
  const [toolOptions, setToolOptions] = useState<Record<Tool, ToolOptions>>(
    () =>
      Object.fromEntries(
        ['select', 'edit', 'brush', 'marker', 'text', 'eraser'].map((key) => [
          key,
          { ...initialOptions },
        ]),
      ) as Record<Tool, ToolOptions>,
  );
  const options = toolOptions[tool];
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
  const [canvasError, setCanvasError] = useState('');
  const [canvasRetry, setCanvasRetry] = useState(0);
  const blockingError = !w.loading && (w.error || canvasError);
  const atMin = zoomState !== null && zoomState.zoom <= zoomState.min + ZOOM_BOUND_EPSILON;
  const atMax = zoomState !== null && zoomState.zoom >= zoomState.max - ZOOM_BOUND_EPSILON;
  // The overlay owns this flag; the stored settings are only a stand-in until it reports.
  const minimapVisible = overlay.view?.connected
    ? overlay.view.visible
    : !!overlay.settings?.visible;
  const map = useRef<L.Map | null>(null);
  const workArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(!!workArea.current && document.fullscreenElement === workArea.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  const layerButton = useRef<HTMLButtonElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const minimapButton = useRef<HTMLButtonElement>(null);
  const stickerButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringFocus = useRef(false);
  const panelPinned = useRef(false);
  // Once a panel has been used, a pointer that strays off it must not take it away: only Escape,
  // an outside click, the close button or the trigger itself closes it after that.
  const panelUsed = useRef(false);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openPanel = (next: 'layers' | 'tasks' | 'minimap') => {
    closeToolSettings();
    cancelClose();
    if (!restoringFocus.current) {
      if (panel !== next) {
        panelPinned.current = false;
        panelUsed.current = false;
      }
      setPanel(next);
    }
  };
  const leavePanel = () => {
    cancelClose();
    if (panelPinned.current || panelUsed.current) return;
    closeTimer.current = setTimeout(() => setPanel(null), 450);
  };
  const closePanel = (next: 'layers' | 'tasks' | 'minimap') => {
    cancelClose();
    panelPinned.current = false;
    panelUsed.current = false;
    setPanel(null);
    restoringFocus.current = true;
    (next === 'layers'
      ? layerButton
      : next === 'tasks'
        ? taskButton
        : minimapButton
    ).current?.focus();
    restoringFocus.current = false;
  };
  // Hovering opens a panel unpinned, so a click on a panel that is merely hovered pins it in
  // place; a click on one already pinned closes it, the way the button's own toggle should read.
  const togglePanel = (next: 'layers' | 'tasks' | 'minimap') => {
    if (panel === next && panelPinned.current) closePanel(next);
    else {
      openPanel(next);
      panelPinned.current = true;
    }
  };
  const markPanelUsed = () => {
    cancelClose();
    panelUsed.current = true;
  };
  const outsidePanel = (target: Node) =>
    ![popup, layerButton, taskButton, minimapButton].some((ref) => ref.current?.contains(target));
  const blurPanel = (target: EventTarget | null) => {
    if (!(target instanceof Node) || !outsidePanel(target) || popup.current?.matches(':hover'))
      return;
    if (layerButton.current?.matches(':hover') || taskButton.current?.matches(':hover')) return;
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
  useEffect(() => {
    setCanvasError('');
    setCanvasRetry(0);
  }, [id]);
  useEffect(() => {
    if (!panel) return;
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        panelUsed.current = false;
        setPanel(null);
        restoringFocus.current = true;
        (panel === 'layers'
          ? layerButton
          : panel === 'tasks'
            ? taskButton
            : minimapButton
        ).current?.focus();
        restoringFocus.current = false;
      }
    }
    document.addEventListener('keydown', key);
    function outside(event: PointerEvent) {
      if (outsidePanel(event.target as Node)) {
        panelUsed.current = false;
        setPanel(null);
      }
    }
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [panel]);
  const setOption = (value: Partial<ToolOptions>, target: Tool = tool) =>
    setToolOptions((previous) => ({ ...previous, [target]: { ...previous[target], ...value } }));
  // Resolve stored stickers without walking the catalogue on each pointer update.
  const stickerIndex = useMemo(() => new Map(w.stickers.map((s) => [s.id, s])), [w.stickers]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await workArea.current?.requestFullscreen();
    } catch {
      notices.push(t('errors.fullscreen_unsupported'), undefined, 'warning');
    }
  };

  return (
    <section className={`map-page${blockingError ? ' map-page--blocked' : ''}`}>
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
          <MapUnavailableState errorKey={w.error} onRetry={() => void w.initialize()} />
        ) : canvasError ? (
          <MapUnavailableState
            errorKey={canvasError}
            onRetry={() => {
              setCanvasError('');
              setCanvasRetry((value) => value + 1);
            }}
          />
        ) : !session || !preference ? (
          <div className="empty-state">
            <h2>{t('map.state.empty')}</h2>
            <p>{t('map.state.emptyHint')}</p>
          </div>
        ) : (
          <>
            <MapCanvas
              key={`${id}:${canvasRetry}`}
              data={session.data}
              preference={preference}
              stickers={stickerIndex}
              items={session.items}
              players={players}
              playerFollow
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
              onError={setCanvasError}
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
                aria-controls="map-layer-panel"
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
                aria-label={isFullscreen ? t('map.view.exitFullscreen') : t('map.view.fullscreen')}
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
              <AppPopover
                open={panel === 'layers'}
                reference={layerButton}
                placement="right-start"
                boundaryRef={workArea}
              >
                <div
                  id="map-layer-panel"
                  className="layer-panel floating"
                  ref={popup}
                  role="dialog"
                  aria-modal="false"
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
              </AppPopover>
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
              <ToolToolbar
                ariaLabel={t('map.tools.aria')}
                tools={tools.map(({ id: toolId, icon }) => ({
                  id: toolId,
                  icon,
                  label: t(`map.tools.names.${toolId}`),
                  active: tool === toolId,
                  pressed: tool === toolId,
                  expanded: ['brush', 'marker', 'text', 'eraser'].includes(toolId)
                    ? tool === toolId && toolSettingsOpen
                    : undefined,
                  onClick: () => {
                    setPanel(null);
                    setToolSettingsOpen(
                      ['brush', 'marker', 'text', 'eraser'].includes(toolId) &&
                        (selectedTool !== toolId || !toolSettingsOpen),
                    );
                    setTool(toolId);
                    setBrowseStickers(false);
                    setSizePreviewVisible(false);
                  },
                }))}
                undo={{
                  label: t('map.tools.undo'),
                  title: t('map.tools.undoTitle'),
                  disabled: !session.past.length,
                  onClick: () => w.undo(id),
                }}
                redo={{
                  label: t('map.tools.redo'),
                  title: t('map.tools.redoTitle'),
                  disabled: !session.future.length,
                  onClick: () => w.redo(id),
                }}
              />
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
                    setOption({ emoji, imageId }, 'marker');
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
                {/* One trigger per row, its panel right after it in the DOM so Tab reaches the
                    panel controls; the panel itself opens to the left of its own button. */}
                <div className="task-item">
                  <button
                    className="task-trigger"
                    aria-label={t('map.tasks.trigger')}
                    aria-controls="map-task-panel"
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
                    <AppPopover
                      open={panel === 'tasks'}
                      reference={taskButton}
                      placement="left-start"
                      boundaryRef={workArea}
                    >
                      <div
                        id="map-task-panel"
                        className="task-panel floating"
                        ref={popup}
                        role="dialog"
                        aria-modal="false"
                        aria-label={t('map.tasks.trigger')}
                        onPointerDown={() => {
                          markPanelUsed();
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
                    </AppPopover>
                  )}
                </div>
                <div className="task-item">
                  <button
                    className={`task-trigger minimap-trigger ${overlay.view?.editing ? 'minimap-editing' : ''}`}
                    aria-label={t('map.minimap.trigger')}
                    aria-controls="map-minimap-panel"
                    title={t('map.minimap.trigger')}
                    ref={minimapButton}
                    aria-pressed={minimapVisible}
                    aria-expanded={panel === 'minimap'}
                    disabled={!overlay.view?.connected}
                    onClick={() =>
                      void overlay.command({ kind: 'visible', enabled: !minimapVisible })
                    }
                    onPointerEnter={() => openPanel('minimap')}
                    onPointerLeave={leavePanel}
                    onFocus={() => openPanel('minimap')}
                    onBlur={(e) => blurPanel(e.relatedTarget)}
                  >
                    <MapPinned size={24} />
                  </button>
                  {panel === 'minimap' && (
                    <AppPopover
                      open={panel === 'minimap'}
                      reference={minimapButton}
                      placement="left-start"
                      boundaryRef={workArea}
                    >
                      <div
                        id="map-minimap-panel"
                        className="task-panel minimap-panel floating"
                        ref={popup}
                        role="dialog"
                        aria-modal="false"
                        aria-label={t('map.minimap.title')}
                        onPointerDown={() => {
                          markPanelUsed();
                          panelPinned.current = true;
                        }}
                        onPointerEnter={cancelClose}
                        onPointerLeave={leavePanel}
                        onFocus={cancelClose}
                        onBlur={(e) => blurPanel(e.relatedTarget)}
                      >
                        <MinimapSettingsPanel
                          settings={overlay.settings}
                          view={overlay.view}
                          update={(changes) => overlay.update(changes)}
                          updateSoon={(changes) => overlay.updateSoon(changes)}
                          command={(command) => void overlay.command(command)}
                          onOpenSettings={onOpenSettings}
                          onClose={() => closePanel('minimap')}
                        />
                      </div>
                    </AppPopover>
                  )}
                </div>
                <CastControl />
              </div>
            </div>
            {cursor && (
              <div className="coordinates">
                {`x: ${cursor.x.toFixed(2)} z: ${cursor.z.toFixed(2)}`}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
