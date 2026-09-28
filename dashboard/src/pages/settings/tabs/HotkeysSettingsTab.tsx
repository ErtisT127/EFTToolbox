import type { OverlaySettings, OverlayView } from '../../../../../contracts/ts/ipc.gen';
import { HotkeyRecorder } from '../../../components/HotkeyRecorder';
import { useLocale } from '../../../hooks/useLocale';
import { hotkeyKeys, type HotkeyKey } from '../types';

export function HotkeysSettingsTab({
  value,
  view,
  onUpdate,
  onRecording,
}: {
  value: OverlaySettings;
  view?: OverlayView;
  onUpdate: (changes: Partial<OverlaySettings>) => void;
  onRecording: (recording: boolean) => void;
}) {
  const { t } = useLocale();
  const conflict = (key: HotkeyKey) => {
    const combo = value.hotkeys[key];
    return !!combo && hotkeyKeys.some((other) => other !== key && value.hotkeys[other] === combo);
  };
  const error = (key: HotkeyKey) =>
    !conflict(key) && (view?.hotkeyFailed ?? []).includes(key)
      ? t('errors.overlay_hotkey_unavailable')
      : undefined;
  return (
    <fieldset>
      <legend>{t('settings.hotkeyGroup')}</legend>
      {hotkeyKeys.map((key) => (
        <HotkeyRecorder
          key={key}
          label={t(`settings.hotkeyAction.${key}`)}
          value={value.hotkeys[key]}
          error={error(key)}
          conflict={conflict(key)}
          onRecording={onRecording}
          onChange={(hotkey) => onUpdate({ hotkeys: { ...value.hotkeys, [key]: hotkey } })}
        />
      ))}
      {!view?.connected && <p>{t('settings.unavailable')}</p>}
    </fieldset>
  );
}
