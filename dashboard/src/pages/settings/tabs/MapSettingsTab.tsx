import type {
  MapData,
  MapSummary,
  OverlayCommand,
  OverlaySettings,
  OverlayView,
} from '../../../../../contracts/ts/ipc.gen';
import { OverlaySettingsLimits, OverlayViewLimits } from '../../../../../contracts/ts/ipc.gen';
import { AppTooltip, HintTooltip } from '../../../components/HintTooltip';
import { NumberStepper } from '../../../components/NumberStepper';
import { rangeFill } from '../../../components/RangeSlider';
import { useLocale } from '../../../hooks/useLocale';
import type { GameMonitorSettings, GameMonitorStatus } from '../../../stores/gameMonitorStore';
import { formatCoordinate, resizeOverlay } from '../../../lib/overlayScale';
import { Link2, Unlink2 } from 'lucide-react';
import type { CSSProperties } from 'react';

export function MapSettingsTab({
  value,
  view,
  monitorSettings,
  monitorStatus,
  catalog,
  map,
  mapId,
  onMapIdChange,
  onUpdate,
  onUpdateSoon,
  onCommand,
  onMonitorUpdate,
}: {
  value: OverlaySettings;
  view?: OverlayView;
  monitorSettings?: GameMonitorSettings;
  monitorStatus?: GameMonitorStatus;
  catalog: MapSummary[];
  map?: MapData;
  mapId: string;
  onMapIdChange: (mapId: string) => void;
  onUpdate: (changes: Partial<OverlaySettings>) => void;
  onUpdateSoon: (changes: Partial<OverlaySettings>) => void;
  onCommand: (command: OverlayCommand) => void;
  onMonitorUpdate: (changes: Partial<GameMonitorSettings>) => void;
}) {
  const { t } = useLocale();
  const selectedMap = mapId || view?.mapId || catalog[0]?.id || '';
  const override = value.mapZooms.find((zoom) => zoom.mapId === selectedMap);
  const viewZoomMin = map?.tiles.length ? Math.min(...map.tiles.map((tile) => tile.minZoom)) : -10;
  const viewZoomMax = map?.tiles.length
    ? Math.min(12, Math.max(...map.tiles.map((tile) => tile.maxZoom)) + 1)
    : 4;
  const viewZoomLimit = { ...OverlayViewLimits.zoom, min: viewZoomMin, max: viewZoomMax };
  const zoomValue = (zoom: number) =>
    Number(zoom.toFixed(OverlaySettingsLimits.targetZoom.precision));
  const check = (key: 'followCenter' | 'followFloor' | 'followZoom') => (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={!!value[key]}
        onChange={(event) => onUpdate({ [key]: event.target.checked })}
      />
      {t(`settings.${key}`)}
    </label>
  );
  const updateZoom = (zoom: number) =>
    onUpdate(
      value.perMapZoom
        ? {
            mapZooms: [
              ...value.mapZooms.filter((entry) => entry.mapId !== selectedMap),
              { mapId: selectedMap, zoom },
            ],
          }
        : { targetZoom: zoom },
    );

  return (
    <>
      <fieldset>
        <legend>{t('settings.appearance')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={view?.connected ? view.visible : value.visible}
            onChange={(event) =>
              view?.connected
                ? void onCommand({ kind: 'visible', enabled: event.target.checked })
                : onUpdate({ visible: event.target.checked })
            }
          />
          {t('settings.visible')}
        </label>
        <div className="settings-field">
          <label htmlFor="settings-opacity">{t('settings.opacity')}</label>
          <span className="settings-slider">
            <input
              id="settings-opacity"
              className="range-slider"
              type="range"
              min={OverlaySettingsLimits.opacity.min}
              max={OverlaySettingsLimits.opacity.max}
              step={OverlaySettingsLimits.opacity.step}
              value={value.opacity ?? OverlaySettingsLimits.opacity.max}
              style={
                {
                  '--fill': `${rangeFill(value.opacity ?? OverlaySettingsLimits.opacity.max, OverlaySettingsLimits.opacity.min, OverlaySettingsLimits.opacity.max)}%`,
                } as CSSProperties
              }
              onChange={(event) => onUpdateSoon({ opacity: Number(event.target.value) })}
            />
            <output htmlFor="settings-opacity">
              {value.opacity ?? OverlaySettingsLimits.opacity.max}%
            </output>
          </span>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.backdrop}
            onChange={(event) => onUpdate({ backdrop: event.target.checked })}
          />
          {t('settings.backdrop')}
        </label>
        <div className="settings-field">
          <label htmlFor="settings-shape">{t('settings.shape')}</label>
          <select
            id="settings-shape"
            value={value.shape}
            onChange={(event) =>
              onUpdate({ shape: event.target.value as OverlaySettings['shape'] })
            }
          >
            <option value="square">{t('settings.square')}</option>
            <option value="circle">{t('settings.circle')}</option>
          </select>
        </div>
        <div className="size-fields">
          <NumberStepper
            label={t('settings.width')}
            value={value.width}
            limit={OverlaySettingsLimits.width}
            onChange={(width) => onUpdate(resizeOverlay(value, 'width', width))}
          />
          {value.shape === 'square' && (
            <div className="aspect-row">
              <span className="aspect-spacer" aria-hidden="true">
                {t('settings.width')}
              </span>
              <span className="aspect-track">
                <button
                  type="button"
                  className={`aspect-link ${value.lockAspect ? 'active' : ''}`}
                  aria-label={t('settings.lockAspect')}
                  title={t('settings.lockAspect')}
                  aria-pressed={value.lockAspect}
                  onClick={() => onUpdate({ lockAspect: !value.lockAspect })}
                >
                  {value.lockAspect ? <Link2 size={14} /> : <Unlink2 size={14} />}
                </button>
              </span>
            </div>
          )}
          <NumberStepper
            label={t('settings.height')}
            value={value.height}
            limit={OverlaySettingsLimits.height}
            onChange={(height) => onUpdate(resizeOverlay(value, 'height', height))}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="settings-resolution">
            <HintTooltip content={t('settings.svgResolutionHint')}>
              {t('settings.svgQualityMode')}
            </HintTooltip>
          </label>
          <select
            id="settings-resolution"
            value={value.svgQualityMode === 'auto' ? 'auto' : String(value.svgResolution)}
            onChange={(event) =>
              onUpdate(
                event.target.value === 'auto'
                  ? { svgQualityMode: 'auto' }
                  : { svgQualityMode: 'fixed', svgResolution: Number(event.target.value) },
              )
            }
          >
            <option value="auto">{t('settings.svgQualityAuto')}</option>
            {[1024, 2048, 4096, 8192].map((resolution) => (
              <option key={resolution} value={resolution}>
                {resolution}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('settings.follow')}</legend>
        <span className={`settings-check-wrap${monitorStatus?.logWatching ? '' : ' is-disabled'}`}>
          {monitorStatus?.logWatching ? (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={!!monitorSettings?.autoMapSwitch}
                onChange={(event) => onMonitorUpdate({ autoMapSwitch: event.target.checked })}
              />
              {t('settings.autoMapSwitch')}
            </label>
          ) : (
            <AppTooltip content={t('settings.noMonitorDirectory')}>
              <label className="settings-check" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitorSettings?.autoMapSwitch} />
                {t('settings.autoMapSwitch')}
              </label>
            </AppTooltip>
          )}
        </span>
        <span
          className={`settings-check-wrap${monitorStatus?.screenshotWatching ? '' : ' is-disabled'}`}
        >
          {monitorStatus?.screenshotWatching ? (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={!!monitorSettings?.deleteScreenshots}
                onChange={(event) => onMonitorUpdate({ deleteScreenshots: event.target.checked })}
              />
              {t('settings.deleteScreenshots')}
            </label>
          ) : (
            <AppTooltip content={t('settings.noMonitorDirectory')}>
              <label className="settings-check" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitorSettings?.deleteScreenshots} />
                {t('settings.deleteScreenshots')}
              </label>
            </AppTooltip>
          )}
        </span>
        {check('followCenter')}
        {check('followFloor')}
        {check('followZoom')}
        <label className="settings-check">
          <input
            type="checkbox"
            checked={!value.perMapZoom}
            disabled={!value.followZoom}
            onChange={(event) => onUpdate({ perMapZoom: !event.target.checked })}
          />
          {t('settings.perMapZoom')}
        </label>
        {value.perMapZoom && (
          <div className="settings-field">
            <label htmlFor="settings-map">{t('settings.map')}</label>
            <select
              id="settings-map"
              value={selectedMap}
              disabled={!value.followZoom}
              onChange={(event) => onMapIdChange(event.target.value)}
            >
              {catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <NumberStepper
          label={t('settings.targetZoom')}
          value={value.perMapZoom ? (override?.zoom ?? value.targetZoom) : value.targetZoom}
          limit={OverlaySettingsLimits.targetZoom}
          disabled={!value.followZoom}
          onChange={updateZoom}
        />
        <button
          type="button"
          disabled={!view?.connected || !value.followZoom}
          onClick={() => {
            if (!view) return;
            updateZoom(zoomValue(view.zoom));
          }}
        >
          {t('settings.useCurrent')}
        </button>
      </fieldset>
      <fieldset>
        <legend>{t('settings.window')}</legend>
        <div className="readonly-values">
          <span>
            {t('settings.left')} <b>{value.left}</b>
          </span>
          <span>
            {t('settings.top')} <b>{value.top}</b>
          </span>
        </div>
        <button
          type="button"
          disabled={!view?.connected}
          aria-pressed={!!view?.editing}
          onClick={() => onCommand({ kind: 'edit', enabled: !view?.editing })}
        >
          {t(view?.editing ? 'settings.exitEdit' : 'settings.enterEdit')}
        </button>
      </fieldset>
      <fieldset disabled={!view?.connected}>
        <legend>{t('settings.viewport')}</legend>
        <div className="readonly-values">
          <span>
            {t('settings.centerX')} <b>{formatCoordinate(view?.center.x || 0)}</b>
          </span>
          <span>
            {t('settings.centerY')} <b>{formatCoordinate(view?.center.y || 0)}</b>
          </span>
        </div>
        <NumberStepper
          label={t('settings.zoom')}
          value={view?.zoom || 0}
          limit={viewZoomLimit}
          onChange={(zoom) => onCommand({ kind: 'view', zoom })}
        />
        <div className="settings-field">
          <label htmlFor="settings-floor">{t('settings.floor')}</label>
          <select
            id="settings-floor"
            value={view?.floorId || ''}
            onChange={(event) => onCommand({ kind: 'view', floorId: event.target.value })}
          >
            {map?.floors.map((floor) => (
              <option key={floor.id} value={floor.id}>
                {floor.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
    </>
  );
}
