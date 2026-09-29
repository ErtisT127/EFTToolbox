import { SlidersHorizontal, X } from 'lucide-react';
import {
  OverlaySettingsLimits,
  type OverlaySettings,
  type OverlayView,
} from '../../../../contracts/ts/ipc.gen';
import { useLocale } from '../../hooks/useLocale';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { AppTooltip } from '../../components/HintTooltip';
import { RangeSlider } from '../../components/RangeSlider';

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
        <span>{t('minimap.settingsTitle')}</span>
        <div className="panel-actions">
          <button
            className="minimap-action"
            aria-pressed={visible}
            disabled={!view?.connected}
            onClick={() => setVisible(!visible)}
          >
            {t(visible ? 'minimap.hide' : 'minimap.show')}
          </button>
          <button
            className="minimap-action"
            aria-pressed={editing}
            disabled={!view?.connected}
            onClick={setEditing}
          >
            {t(editing ? 'minimap.exitEdit' : 'minimap.enterEdit')}
          </button>
          <button className="icon-button" aria-label={t('minimap.closeSettings')} onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="panel-scroll minimap-settings">
        <div className="segmented">
          <span>{t('minimap.shape')}</span>
          <div>
            <button
              className={settings.shape === 'square' ? 'active' : ''}
              aria-pressed={settings.shape === 'square'}
              onClick={() => update({ shape: 'square' })}
            >
              {t('minimap.square')}
            </button>
            <button
              className={settings.shape === 'circle' ? 'active' : ''}
              aria-pressed={settings.shape === 'circle'}
              onClick={() => update({ shape: 'circle' })}
            >
              {t('minimap.circle')}
            </button>
          </div>
        </div>
        <RangeSlider
          label={t('minimap.opacity')}
          value={settings.opacity ?? OverlaySettingsLimits.opacity.max}
          min={OverlaySettingsLimits.opacity.min}
          max={OverlaySettingsLimits.opacity.max}
          step={OverlaySettingsLimits.opacity.step}
          format={(value) => `${value}%`}
          onChange={(value) => updateSoon({ opacity: value })}
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.backdrop}
            onChange={(e) => update({ backdrop: e.target.checked })}
          />
          {t('minimap.backdrop')}
        </label>
        <strong className="panel-section">{t('minimap.follow')}</strong>
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
              {t('gameMonitor.deleteScreenshots')}
            </label>
          ) : (
            <AppTooltip content={t('gameMonitor.noDirectory')}>
              <label className="check-row" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitor.settings?.deleteScreenshots} />
                {t('gameMonitor.deleteScreenshots')}
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
              {t('gameMonitor.autoMapSwitch')}
            </label>
          ) : (
            <AppTooltip content={t('gameMonitor.noDirectory')}>
              <label className="check-row" aria-disabled="true">
                <input type="checkbox" disabled checked={!!monitor.settings?.autoMapSwitch} />
                {t('gameMonitor.autoMapSwitch')}
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
            {t(`minimap.${key}`)}
          </label>
        ))}
        {/* Size, zoom and the rest live in the settings page; this is the way there. */}
        <button className="panel-footer-button" onClick={onOpenSettings}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          {t('minimap.detail')}
        </button>
      </div>
    </>
  );
}
