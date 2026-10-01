import { useState } from 'react';
import { Check } from 'lucide-react';
import type { GameMode } from '../../../stores/gameMonitorStore';
import { useGameMonitor } from '../../../stores/gameMonitorStore';
import { notices } from '../../../stores/noticeStore';
import { reportClientLog, updateUserSettings } from '../../../stores/workspaceStore';
import { useLocale, type LocaleKey } from '../../../hooks/useLocale';
import { errorDetailOf, errorKeyOf } from '../../../lib/errors';
import { useGetUserSettingsQuery } from '../../../stores/api';

const gameModes: GameMode[] = ['pvp', 'pve', 'pvp-season'];
const modeLabels: Record<GameMode, LocaleKey> = {
  pvp: 'mode.pvp',
  pve: 'mode.pve',
  'pvp-season': 'mode.pvpSeason',
};

type Language = 'zh-CN' | 'en-US';
const languages: Language[] = ['zh-CN', 'en-US'];
const languageLabels: Record<Language, LocaleKey> = {
  'zh-CN': 'settings.language.zh',
  'en-US': 'settings.language.en',
};

type CloseAction = 'ask' | 'tray' | 'exit';
const closeActions: CloseAction[] = ['ask', 'tray', 'exit'];
const closeActionLabels: Record<CloseAction, LocaleKey> = {
  ask: 'settings.closeBehavior.ask',
  tray: 'settings.closeBehavior.tray',
  exit: 'settings.closeBehavior.exit',
};

export function SystemSettingsTab() {
  const { t, locale } = useLocale();
  const monitor = useGameMonitor();
  // The close behavior belongs to the desktop host, but it lives in the aggregate user settings,
  // so the control reads and writes it through the same versioned settings API.
  const { data: userSettings } = useGetUserSettingsQuery();
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
        const message = errorKeyOf(reason, 'errors.request_failed') as LocaleKey;
        notices.push(t(message));
        reportClientLog(
          'language_save_failed',
          'Language could not be saved',
          errorDetailOf(reason),
        );
      });
  };
  // No reload is needed: the host reads the value when the window closes, not while it renders.
  const changeCloseAction = (next: CloseAction) => {
    void updateUserSettings((current) => ({ ...current, closeAction: next })).catch(
      (reason: unknown) => {
        const message = errorKeyOf(reason, 'errors.request_failed') as LocaleKey;
        notices.push(t(message));
        reportClientLog(
          'close_action_save_failed',
          'Close behavior could not be saved',
          errorDetailOf(reason),
        );
      },
    );
  };
  // Turning the automatic check off only affects the next start: this launch already had its answer.
  const changeUpdateCheck = (next: boolean) => {
    void updateUserSettings((current) => ({
      ...current,
      updateCheck: next ? 'auto' : 'manual',
    })).catch((reason: unknown) => {
      const message = errorKeyOf(reason, 'errors.request_failed') as LocaleKey;
      notices.push(t(message));
      reportClientLog(
        'update_check_setting_failed',
        'The automatic update check setting could not be saved',
        errorDetailOf(reason),
      );
    });
  };
  return (
    <>
      {applying && (
        <div className="language-reload-mask" role="status" aria-live="polite">
          <span className="small-spinner" aria-hidden="true" />
          {t('settings.language.applying')}
        </div>
      )}
      <fieldset>
        <legend>{t('settings.sections.general')}</legend>
        <div className="settings-field">
          <label htmlFor="system-language">{t('settings.language.label')}</label>
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
        <div className="settings-field">
          <label htmlFor="system-close-action">{t('settings.closeBehavior.label')}</label>
          <select
            id="system-close-action"
            value={userSettings?.value.closeAction ?? 'ask'}
            onChange={(event) => changeCloseAction(event.target.value as CloseAction)}
          >
            {closeActions.map((value) => (
              <option key={value} value={value}>
                {t(closeActionLabels[value])}
              </option>
            ))}
          </select>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={userSettings?.value.updateCheck !== 'manual'}
            onChange={(event) => changeUpdateCheck(event.target.checked)}
          />
          {t('settings.updateCheck.label')}
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('settings.sections.gameMonitor')}</legend>
        <div className="settings-field settings-path-field">
          <label htmlFor="monitor-screenshot-directory">
            {t('gameMonitor.screenshotDirectory')}
          </label>
          <input
            id="monitor-screenshot-directory"
            value={monitor.settings?.screenshotDirectory || ''}
            readOnly
            placeholder={t('gameMonitor.notConfigured')}
          />
          <button
            type="button"
            disabled={monitor.browsing.screenshots}
            onClick={() => void monitor.browse('screenshots')}
          >
            {t('gameMonitor.browse')}
          </button>
          <Check
            className={`monitor-ready${monitor.status?.screenshotWatching ? ' is-active' : ''}`}
            size={16}
            aria-label={t('gameMonitor.directoryReady')}
            aria-hidden={!monitor.status?.screenshotWatching}
          />
        </div>
        <div className="settings-field settings-path-field">
          <label htmlFor="monitor-log-directory">{t('gameMonitor.logDirectory')}</label>
          <input
            id="monitor-log-directory"
            value={monitor.settings?.logDirectory || ''}
            readOnly
            placeholder={t('gameMonitor.notConfigured')}
          />
          <button
            type="button"
            disabled={monitor.browsing.logs}
            onClick={() => void monitor.browse('logs')}
          >
            {t('gameMonitor.browse')}
          </button>
          <Check
            className={`monitor-ready${monitor.status?.logWatching ? ' is-active' : ''}`}
            size={16}
            aria-label={t('gameMonitor.directoryReady')}
            aria-hidden={!monitor.status?.logWatching}
          />
        </div>
      </fieldset>
    </>
  );
}
