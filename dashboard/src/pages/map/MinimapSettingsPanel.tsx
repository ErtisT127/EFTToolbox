import { SlidersHorizontal, X } from 'lucide-react';
import {
  OverlaySettingsLimits,
  type OverlaySettings,
  type OverlayView,
} from '../../../../contracts/ts/ipc.gen';
import { useLocale } from '../../hooks/useLocale';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { AppTooltip } from '../../components/HintTooltip';

export function MinimapSettingsPanel({
  settings,
  view,
  update,
  updateSoon,
  command,
  onOpenSettings,
  onClose,
}: {
  settings?: OverlaySettings;
  view?: OverlayView;
  update: (changes: Partial<OverlaySettings>) => void;
  /** For the opacity slider, which reports continuously while it is dragged. */
  updateSoon: (changes: Partial<OverlaySettings>) => void;
  command: (command: { kind: 'edit' | 'visible'; enabled: boolean }) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const monitor = useGameMonitor();
  if (!settings) return <p className="panel-scroll hint">{t('common.loading')}</p>;
  // The overlay is the source of truth for both flags; the stored settings only stand in while it
  // is not reporting (nothing is connected yet).
  const visible = view?.connected ? view.visible : settings.visible;
  const editing = view?.connected ? view.editing : false;
  const setVisible = (next: boolean) => command({ kind: 'visible', enabled: next });
  const setEditing = () => command({ kind: 'edit', enabled: !editing });
  return (
    <>
      <div className="panel-title">
        <span>{t('map.minimap.title')}</span>
        <div className="panel-actions">
          <button
            className="minimap-action"
            aria-pressed={visible}
            disabled={!view?.connected}
            onClick={() => setVisible(!visible)}
          >
            {t(visible ? 'settings.hideMinimap' : 'settings.showMinimap')}
          </button>
          <button
            className="minimap-action"
            aria-pressed={editing}
            disabled={!view?.connected}
            onClick={setEditing}
          >
            {t(editing ? 'settings.exitEdit' : 'settings.enterEdit')}
          </button>
          <button className="icon-button" aria-label={t('map.minimap.close')} onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="panel-scroll minimap-settings">
        <div className="segmented">
          <span>{t('settings.shape')}</span>
          <div>
            <button
              className={settings.shape === 'square' ? 'active' : ''}
              aria-pressed={settings.shape === 'square'}
              onClick={() => update({ shape: 'square' })}
            >
              {t('settings.square')}
            </button>
            <button
              className={settings.shape === 'circle' ? 'active' : ''}
              aria-pressed={settings.shape === 'circle'}
              onClick={() => update({ shape: 'circle' })}
            >
              {t('settings.circle')}
            </button>
          </div>
        </div>
        <label className="range-label">
          {t('settings.opacity')}{' '}
          <output>{settings.opacity ?? OverlaySettingsLimits.opacity.max}%</output>
          <input
            type="range"
            min={OverlaySettingsLimits.opacity.min}
            max={OverlaySettingsLimits.opacity.max}
            step={OverlaySettingsLimits.opacity.step}
            value={settings.opacity ?? OverlaySettingsLimits.opacity.max}
            onChange={(e) => updateSoon({ opacity: Number(e.target.value) })}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.backdrop}
            onChange={(e) => update({ backdrop: e.target.checked })}
          />
          {t('settings.backdrop')}
        </label>
        <strong className="panel-section">{t('settings.follow')}</strong>
        <span
          className={`settings-check-wrap minimap-check-wrap${monitor.status?.screenshotWatching ? '' : ' is-disabled'}`}
        >
          {monitor.status?.screenshotWatching ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!monitor.settings?.deleteScreenshots}
                onChange={(e) => void monitor.update({ deleteScreenshots: e.target.checked })}
              />
              {t('settings.deleteScreenshots')}
            </label>
          ) : (
            <AppTooltip content={t('settings.noMonitorDirectory')}>
              <label className="check-row" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitor.settings?.deleteScreenshots} />
                {t('settings.deleteScreenshots')}
              </label>
            </AppTooltip>
          )}
        </span>
        <span
          className={`settings-check-wrap minimap-check-wrap${monitor.status?.logWatching ? '' : ' is-disabled'}`}
        >
          {monitor.status?.logWatching ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!monitor.settings?.autoMapSwitch}
                onChange={(e) => void monitor.update({ autoMapSwitch: e.target.checked })}
              />
              {t('settings.autoMapSwitch')}
            </label>
          ) : (
            <AppTooltip content={t('settings.noMonitorDirectory')}>
              <label className="check-row" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitor.settings?.autoMapSwitch} />
                {t('settings.autoMapSwitch')}
              </label>
            </AppTooltip>
          )}
        </span>
        {(['followCenter', 'followFloor', 'followZoom'] as const).map((key) => (
          <label className="check-row" key={key}>
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(e) => update({ [key]: e.target.checked })}
            />
            {t(`settings.${key}`)}
          </label>
        ))}
        {/* Size, zoom and the rest live in the settings page; this is the way there. */}
        <button className="panel-footer-button" onClick={onOpenSettings}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          {t('settings.detail')}
        </button>
      </div>
    </>
  );
}
