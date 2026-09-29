import type { RecognitionSettings } from '../../../contracts/ts/ipc.gen';
import { RecognitionSettingsLimits } from '../../../contracts/ts/ipc.gen';
import { useLocale } from '../hooks/useLocale';
import { HintTooltip } from './HintTooltip';
import { RangeSlider } from './RangeSlider';

type TuningKey = 'ocrConfidence' | 'nameSimilarity' | 'templateSimilarity' | 'captureWidth';
type Layout = 'settings' | 'rail';

const tuningKeys: TuningKey[] = [
  'ocrConfidence',
  'nameSimilarity',
  'templateSimilarity',
  'captureWidth',
];

export function RecognitionTuningFields({
  settings,
  onChange,
  fields = tuningKeys,
  layout = 'rail',
}: {
  settings: RecognitionSettings;
  onChange: (changes: Partial<RecognitionSettings>) => void;
  fields?: TuningKey[];
  layout?: Layout;
}) {
  const { t } = useLocale();
  const config = {
    ocrConfidence: {
      label: t('recognition.ocrConfidence'),
      hint: t('recognition.ocrConfidenceHint'),
      limit: RecognitionSettingsLimits.ocrConfidence,
      format: (value: number) => value.toFixed(2),
      changes: (value: number) => ({ ocrConfidence: value }),
    },
    nameSimilarity: {
      label: t('recognition.nameSimilarity'),
      hint: t('recognition.nameSimilarityHint'),
      limit: RecognitionSettingsLimits.nameSimilarity,
      format: (value: number) => value.toFixed(2),
      changes: (value: number) => ({ nameSimilarity: value }),
    },
    templateSimilarity: {
      label: t('recognition.templateSimilarity'),
      hint: t('recognition.templateSimilarityHint'),
      limit: RecognitionSettingsLimits.templateSimilarity,
      format: (value: number) => value.toFixed(2),
      changes: (value: number) => ({ templateSimilarity: value }),
    },
    captureWidth: {
      label: t('recognition.captureSize'),
      hint: t('recognition.captureSizeHint'),
      limit: RecognitionSettingsLimits.captureWidth,
      format: (value: number) => `${value}×${value}`,
      changes: (value: number) => ({ captureWidth: value, captureHeight: value }),
    },
  } satisfies Record<
    TuningKey,
    {
      label: string;
      hint: string;
      limit: { min: number; max: number; step: number };
      format: (value: number) => string;
      changes: (value: number) => Partial<RecognitionSettings>;
    }
  >;

  return (
    <>
      {fields.map((key) => {
        const entry = config[key];
        const label = <HintTooltip content={entry.hint}>{entry.label}</HintTooltip>;
        const sliderProps = {
          id: `recognition-${key}`,
          value: settings[key],
          min: entry.limit.min,
          max: entry.limit.max,
          step: entry.limit.step,
          disabled: key === 'templateSimilarity' && !settings.templateMatching,
          format: entry.format,
          onChange: (value: number) => onChange(entry.changes(value)),
        };
        return layout === 'settings' ? (
          <div className="settings-field" key={key}>
            <label htmlFor={`recognition-${key}`}>{label}</label>
            <RangeSlider {...sliderProps} />
          </div>
        ) : (
          <RangeSlider key={key} {...sliderProps} label={label} />
        );
      })}
    </>
  );
}
