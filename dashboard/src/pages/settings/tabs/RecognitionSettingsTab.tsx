import {
  RecognitionSettingsLimits,
  type NumericLimit,
  type RecognitionSettings,
} from '../../../../../contracts/ts/ipc.gen';
import { HintTooltip } from '../../../components/HintTooltip';
import { RecognitionTuningFields } from '../../../components/RecognitionTuningFields';
import { RangeSlider } from '../../../components/RangeSlider';
import { useOverlay } from '../../../stores/overlayStore';
import { useLocale } from '../../../hooks/useLocale';

/**
 * Every parameter that changes what the recognition finds, grouped by the step it belongs to. The
 * items page keeps only the four a reader tunes while looking at a result; everything else lives
 * here, each row carrying a hint that says what it does and which way to move it.
 */
export function RecognitionSettingsTab() {
  const { t } = useLocale();
  const overlay = useOverlay();
  const settings = overlay.recognitionSettings;
  const limits = RecognitionSettingsLimits;
  if (!settings) return <p className="recognition-lead">{t('common.loading')}</p>;
  const save = (changes: Partial<RecognitionSettings>) => overlay.saveRecognitionSettings(changes);
  const whole = (value: number, limit: NumericLimit) =>
    Math.min(limit.max, Math.max(limit.min, Math.round(value)));
  const label = (id: string, text: string, hint: string) => (
    <label htmlFor={id}>
      <HintTooltip content={hint}>{text}</HintTooltip>
    </label>
  );
  return (
    <>
      <fieldset>
        <legend>{t('recognition.groups.warmup')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.ocrWarmup}
            onChange={(event) => save({ ocrWarmup: event.target.checked })}
          />
          <HintTooltip content={t('recognition.ocrWarmupHint')}>
            {t('recognition.ocrWarmup')}
          </HintTooltip>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('recognition.groups.thresholds')}</legend>
        <RecognitionTuningFields
          settings={settings}
          fields={['ocrConfidence', 'nameSimilarity']}
          layout="settings"
          onChange={save}
        />
      </fieldset>
      <fieldset>
        <legend>{t('recognition.groups.ocr')}</legend>
        <div className="settings-field">
          {label(
            'recognition-upscale',
            t('recognition.ocrUpscale'),
            t('recognition.ocrUpscaleHint'),
          )}
          <RangeSlider
            id="recognition-upscale"
            value={settings.ocrUpscale}
            min={limits.ocrUpscale.min}
            max={limits.ocrUpscale.max}
            step={limits.ocrUpscale.step}
            format={(value) => `${value}×`}
            onChange={(value) => save({ ocrUpscale: whole(value, limits.ocrUpscale) })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-min-length',
            t('recognition.ocrMinLength'),
            t('recognition.ocrMinLengthHint'),
          )}
          <RangeSlider
            id="recognition-min-length"
            value={settings.ocrMinLength}
            min={limits.ocrMinLength.min}
            max={limits.ocrMinLength.max}
            step={limits.ocrMinLength.step}
            onChange={(value) => save({ ocrMinLength: whole(value, limits.ocrMinLength) })}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('recognition.groups.template')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.templateMatching}
            onChange={(event) => save({ templateMatching: event.target.checked })}
          />
          <HintTooltip content={t('recognition.templateMatchingHint')}>
            {t('recognition.templateMatching')}
          </HintTooltip>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.templateStrict}
            // Strict mode only judges icon scores, so without the icon check it decides nothing.
            disabled={!settings.templateMatching}
            onChange={(event) => save({ templateStrict: event.target.checked })}
          />
          <HintTooltip content={t('recognition.templateStrictHint')}>
            {t('recognition.templateStrict')}
          </HintTooltip>
        </label>
        <RecognitionTuningFields
          settings={settings}
          fields={['templateSimilarity']}
          layout="settings"
          onChange={save}
        />
        <div className="settings-field">
          {label(
            'recognition-candidates',
            t('recognition.candidateLimit'),
            t('recognition.candidateLimitHint'),
          )}
          <RangeSlider
            id="recognition-candidates"
            value={settings.candidateLimit}
            min={limits.candidateLimit.min}
            max={limits.candidateLimit.max}
            step={limits.candidateLimit.step}
            disabled={!settings.templateMatching}
            onChange={(value) => save({ candidateLimit: whole(value, limits.candidateLimit) })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-scale-min',
            t('recognition.templateMinScale'),
            t('recognition.templateMinScaleHint'),
          )}
          <RangeSlider
            id="recognition-scale-min"
            value={settings.templateMinScale}
            min={limits.templateMinScale.min}
            max={limits.templateMinScale.max}
            step={limits.templateMinScale.step}
            disabled={!settings.templateMatching}
            format={(value) => `${value.toFixed(1)}×`}
            onChange={(value) => save({ templateMinScale: value })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-scale-max',
            t('recognition.templateMaxScale'),
            t('recognition.templateMaxScaleHint'),
          )}
          <RangeSlider
            id="recognition-scale-max"
            value={settings.templateMaxScale}
            min={limits.templateMaxScale.min}
            max={limits.templateMaxScale.max}
            step={limits.templateMaxScale.step}
            disabled={!settings.templateMatching}
            format={(value) => `${value.toFixed(1)}×`}
            onChange={(value) => save({ templateMaxScale: value })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-icon-window',
            t('recognition.iconWindowRatio'),
            t('recognition.iconWindowRatioHint'),
          )}
          <RangeSlider
            id="recognition-icon-window"
            value={settings.iconWindowRatio}
            min={limits.iconWindowRatio.min}
            max={limits.iconWindowRatio.max}
            step={limits.iconWindowRatio.step}
            disabled={!settings.templateMatching}
            format={(value) => `${value.toFixed(1)}×`}
            onChange={(value) => save({ iconWindowRatio: value })}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('recognition.groups.capture')}</legend>
        <RecognitionTuningFields
          settings={settings}
          fields={['captureWidth']}
          layout="settings"
          onChange={save}
        />
      </fieldset>
      <fieldset>
        <legend>{t('recognition.groups.window')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.autoPush}
            onChange={(event) => save({ autoPush: event.target.checked })}
          />
          <HintTooltip content={t('recognition.autoPushHint')}>
            {t('recognition.autoPush')}
          </HintTooltip>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.autoClose}
            // Nothing pushes the panel to the screen, so there is nothing to close.
            disabled={!settings.autoPush}
            onChange={(event) => save({ autoClose: event.target.checked })}
          />
          <HintTooltip content={t('recognition.autoCloseHint')}>
            {t('recognition.autoClose')}
          </HintTooltip>
        </label>
        <div className="settings-field">
          {label(
            'recognition-close-delay',
            t('recognition.autoCloseDelay'),
            t('recognition.autoCloseDelayHint'),
          )}
          <select
            id="recognition-close-delay"
            value={settings.autoCloseSeconds}
            disabled={!settings.autoPush || !settings.autoClose}
            onChange={(event) => save({ autoCloseSeconds: Number(event.target.value) })}
          >
            {[3, 5, 10, 15].map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds}s
              </option>
            ))}
          </select>
        </div>
        {/* How much of the game shows through the panel; it does nothing while nothing is pushed. */}
        <div className="settings-field">
          {label('recognition-opacity', t('minimap.opacity'), t('recognition.opacityHint'))}
          <RangeSlider
            id="recognition-opacity"
            value={settings.opacity}
            min={limits.opacity.min}
            max={limits.opacity.max}
            step={limits.opacity.step}
            disabled={!settings.autoPush}
            format={(value) => `${value}%`}
            onChange={(value) => save({ opacity: value })}
          />
        </div>
        {/* The panel is positioned and sized by dragging it in game, so both rows only report what
            the overlay wrote back, and both are moot while the panel is never pushed. */}
        <div className={`settings-field${settings.autoPush ? '' : ' is-disabled'}`}>
          <span>
            <HintTooltip content={t('recognition.windowHint')}>
              {t('recognition.windowSize')}
            </HintTooltip>
          </span>
          <span className="recognition-position">
            {settings.windowWidth} × {settings.windowHeight}
          </span>
        </div>
        <div className={`settings-field${settings.autoPush ? '' : ' is-disabled'}`}>
          <span>
            <HintTooltip content={t('recognition.windowHint')}>
              {t('recognition.windowPosition')}
            </HintTooltip>
          </span>
          <span className="recognition-position">
            {settings.windowLeft}, {settings.windowTop}
          </span>
        </div>
      </fieldset>
    </>
  );
}
