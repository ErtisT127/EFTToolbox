import {
  RecognitionSettingsLimits,
  type NumericLimit,
  type RecognitionSettings,
} from '../../../../contracts/ts/ipc.gen';
import { HintTooltip } from '../../components/HintTooltip';
import { RangeSlider } from '../../components/RangeSlider';
import { useOverlay } from '../../stores/overlayStore';
import { useLocale } from '../../hooks/useLocale';

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
        <legend>{t('settings.recognitionGroup.thresholds')}</legend>
        <div className="settings-field">
          {label(
            'recognition-ocr',
            t('items.ocrConfidence'),
            t('items.recognitionOcrConfidenceHint'),
          )}
          <RangeSlider
            id="recognition-ocr"
            value={settings.ocrConfidence}
            min={limits.ocrConfidence.min}
            max={limits.ocrConfidence.max}
            step={limits.ocrConfidence.step}
            format={(value) => value.toFixed(2)}
            onChange={(value) => save({ ocrConfidence: value })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-name',
            t('items.nameSimilarity'),
            t('items.recognitionNameSimilarityHint'),
          )}
          <RangeSlider
            id="recognition-name"
            value={settings.nameSimilarity}
            min={limits.nameSimilarity.min}
            max={limits.nameSimilarity.max}
            step={limits.nameSimilarity.step}
            format={(value) => value.toFixed(2)}
            onChange={(value) => save({ nameSimilarity: value })}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('settings.recognitionGroup.ocr')}</legend>
        <div className="settings-field">
          {label('recognition-upscale', t('items.ocrUpscale'), t('items.ocrUpscaleHint'))}
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
          {label('recognition-min-length', t('items.ocrMinLength'), t('items.ocrMinLengthHint'))}
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
        <legend>{t('settings.recognitionGroup.template')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.templateMatching}
            onChange={(event) => save({ templateMatching: event.target.checked })}
          />
          <HintTooltip content={t('items.templateMatchingHint')}>
            {t('items.templateMatching')}
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
          <HintTooltip content={t('items.templateStrictHint')}>
            {t('items.templateStrict')}
          </HintTooltip>
        </label>
        <div className="settings-field">
          {label(
            'recognition-template',
            t('items.templateSimilarity'),
            t('items.recognitionTemplateSimilarityHint'),
          )}
          <RangeSlider
            id="recognition-template"
            value={settings.templateSimilarity}
            min={limits.templateSimilarity.min}
            max={limits.templateSimilarity.max}
            step={limits.templateSimilarity.step}
            // Without the icon check this threshold decides nothing.
            disabled={!settings.templateMatching}
            format={(value) => value.toFixed(2)}
            onChange={(value) => save({ templateSimilarity: value })}
          />
        </div>
        <div className="settings-field">
          {label(
            'recognition-candidates',
            t('items.candidateLimit'),
            t('items.candidateLimitHint'),
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
            t('items.templateMinScale'),
            t('items.templateMinScaleHint'),
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
            t('items.templateMaxScale'),
            t('items.templateMaxScaleHint'),
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
            t('items.iconWindowRatio'),
            t('items.iconWindowRatioHint'),
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
        <legend>{t('settings.recognitionGroup.capture')}</legend>
        <div className="settings-field">
          {label(
            'recognition-capture',
            t('items.recognitionCaptureSize'),
            t('items.recognitionCaptureSizeHint'),
          )}
          <RangeSlider
            id="recognition-capture"
            value={settings.captureWidth}
            min={limits.captureWidth.min}
            max={limits.captureWidth.max}
            step={limits.captureWidth.step}
            format={(value) => `${value}×${value}`}
            onChange={(value) => save({ captureWidth: value, captureHeight: value })}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('settings.recognitionGroup.window')}</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.autoPush}
            onChange={(event) => save({ autoPush: event.target.checked })}
          />
          <HintTooltip content={t('items.autoPushHint')}>{t('items.autoPush')}</HintTooltip>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.autoClose}
            // Nothing pushes the panel to the screen, so there is nothing to close.
            disabled={!settings.autoPush}
            onChange={(event) => save({ autoClose: event.target.checked })}
          />
          <HintTooltip content={t('items.autoCloseHint')}>{t('items.autoClose')}</HintTooltip>
        </label>
        <div className="settings-field">
          {label(
            'recognition-close-delay',
            t('items.autoCloseDelay'),
            t('items.autoCloseDelayHint'),
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
          {label('recognition-opacity', t('settings.opacity'), t('items.recognitionOpacityHint'))}
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
            <HintTooltip content={t('items.recognitionWindowHint')}>
              {t('items.recognitionWindowSize')}
            </HintTooltip>
          </span>
          <span className="recognition-position">
            {settings.windowWidth} × {settings.windowHeight}
          </span>
        </div>
        <div className={`settings-field${settings.autoPush ? '' : ' is-disabled'}`}>
          <span>
            <HintTooltip content={t('items.recognitionWindowHint')}>
              {t('items.recognitionWindowPosition')}
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
