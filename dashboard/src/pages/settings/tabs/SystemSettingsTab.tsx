import { useState } from 'react';
import { Check } from 'lucide-react';
import type { GameMode } from '../../../stores/gameMonitorStore';
import { useGameMonitor } from '../../../stores/gameMonitorStore';
import { notices } from '../../../stores/noticeStore';
import { reportClientLog, updateUserSettings } from '../../../stores/workspaceStore';
import { useLocale, type LocaleKey } from '../../../hooks/useLocale';

const gameModes: GameMode[] = ['pvp', 'pve', 'pvp-season'];
const modeLabels: Record<GameMode, LocaleKey> = {
  pvp: 'mode.pvp',
  pve: 'mode.pve',
  'pvp-season': 'mode.season',
};

type Language = 'zh-CN' | 'en-US';
const languages: Language[] = ['zh-CN', 'en-US'];
const languageLabels: Record<Language, LocaleKey> = {
  'zh-CN': 'settings.languageOptionZh',
  'en-US': 'settings.languageOptionEn',
};

export function SystemSettingsTab() {
  const { t, locale } = useLocale();
  const monitor = useGameMonitor();
  const [applying, setApplying] = useState(false);
  const mode = monitor.settings?.mode || monitor.status?.mode || 'pvp';
  // The language reaches every surface: interface strings, map data and item data are all fetched
  // per locale, so the switch saves, shows a mask and reloads the whole document rather than
  // trying to chase every cache in place. The reload boots through the language-aware startup.
  const changeLanguage = (next: Language) => {
    if (next === locale || applying) return;
    setApplying(true);
    void updateUserSettings((current) => ({ ...current, language: next }))
      .then(() => {
        setTimeout(() => window.location.reload(), 150);
      })
      .catch((reason: unknown) => {
        setApplying(false);
        const message =
          reason instanceof Error ? (reason.message as LocaleKey) : 'errors.request_failed';
        notices.push(t(message));
        reportClientLog('language_save_failed', 'Language could not be saved', String(reason));
      });
  };
  return (
    <>
      {applying && (
        <div className="language-reload-mask" role="status" aria-live="polite">
          <span className="small-spinner" aria-hidden="true" />
          {t('settings.applyingLanguage')}
        </div>
      )}
      <fieldset>
        <legend>{t('settings.general')}</legend>
        <div className="settings-field">
          <label htmlFor="system-language">{t('settings.language')}</label>
          <select
            id="system-language"
            value={locale}
            onChange={(event) => changeLanguage(event.target.value as Language)}
          >
            {languages.map((value) => (
              <option key={value} value={value}>
                {t(languageLabels[value])}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-field">
          <label htmlFor="system-game-mode">{t('mode.select')}</label>
          <select
            id="system-game-mode"
            value={mode}
            onChange={(event) => void monitor.update({ mode: event.target.value as GameMode })}
          >
            {gameModes.map((value) => (
              <option key={value} value={value}>
                {t(modeLabels[value])}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('settings.gameMonitor')}</legend>
        <div className="settings-field settings-path-field">
          <label htmlFor="monitor-screenshot-directory">{t('settings.screenshotDirectory')}</label>
          <input
            id="monitor-screenshot-directory"
            value={monitor.settings?.screenshotDirectory || ''}
            readOnly
            placeholder={t('settings.monitorUnavailable')}
          />
          <button
            type="button"
            disabled={monitor.browsing.screenshots}
            onClick={() => void monitor.browse('screenshots')}
          >
            {t('settings.browse')}
          </button>
          <Check
            className={`monitor-ready${monitor.status?.screenshotWatching ? ' is-active' : ''}`}
            size={16}
            aria-label={t('settings.monitorReady')}
            aria-hidden={!monitor.status?.screenshotWatching}
          />
        </div>
        <div className="settings-field settings-path-field">
          <label htmlFor="monitor-log-directory">{t('settings.logDirectory')}</label>
          <input
            id="monitor-log-directory"
            value={monitor.settings?.logDirectory || ''}
            readOnly
            placeholder={t('settings.monitorUnavailable')}
          />
          <button
            type="button"
            disabled={monitor.browsing.logs}
            onClick={() => void monitor.browse('logs')}
          >
            {t('settings.browse')}
          </button>
          <Check
            className={`monitor-ready${monitor.status?.logWatching ? ' is-active' : ''}`}
            size={16}
            aria-label={t('settings.monitorReady')}
            aria-hidden={!monitor.status?.logWatching}
          />
        </div>
      </fieldset>
    </>
  );
}
