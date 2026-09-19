import { mapDisplay } from '../../../../contracts/ts/map-display.gen';
import type { Ref } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import type { Annotation, Sticker, StickerUsage } from '../../../../contracts/ts/ipc.gen';
import type { Tool, ToolOptions } from './MapCanvas';
import { resolvePick, type ResolvedPick } from './StickerPicker';
import { ColorPicker } from '../../components/ColorPicker';
import { useLocale } from '../../hooks/useLocale';

type Props = {
  tool: Tool;
  options: ToolOptions;
  items: Annotation[];
  stickers: Map<string, Sticker>;
  recent: StickerUsage[];
  browseStickers: boolean;
  stickerButton: Ref<HTMLButtonElement>;
  setOption: (value: Partial<ToolOptions>) => void;
  previewSize: (size: number) => void;
  onCommit: (items: Annotation[]) => void;
  onBrowse: () => void;
  onClose: () => void;
};

export function ToolOptionsPanel({
  tool,
  options,
  items,
  stickers,
  recent,
  browseStickers,
  stickerButton,
  setOption,
  previewSize,
  onCommit,
  onBrowse,
  onClose,
}: Props) {
  const { t } = useLocale();
  const setColor = (color: string) => setOption({ color });
  const stickerFor = (id: string) => stickers.get(id);
  const recentPicks = recent
    .map((usage) => resolvePick(usage.id, stickers))
    .filter((pick): pick is ResolvedPick => !!pick)
    .slice(0, 12);
  return (
    <div className="tool-options floating">
      <div className="panel-title">
        {t(`map.tools.names.${tool}`)}
        <button className="icon-button" aria-label={t('map.tools.collapse')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {tool === 'brush' && (
        <>
          <label className="field-label">{t('map.toolSettings.color')}</label>
          <ColorPicker color={options.color} onChange={setColor} />
          <label className="range-label">
            {t('map.toolSettings.width')} <output>{options.width} px</output>
            <input
              aria-label={t('map.toolSettings.brushWidth')}
              type="range"
              min="1"
              max="20"
              value={options.width}
              onChange={(e) => {
                setOption({ width: +e.target.value });
                previewSize(+e.target.value);
              }}
            />
          </label>
          <button
            className="clear-button"
            disabled={!items.some((a) => a.kind === 'stroke')}
            onClick={() => onCommit(items.filter((a) => a.kind !== 'stroke'))}
          >
            <Trash2 size={14} />
            {t('map.toolSettings.clear')}
          </button>
        </>
      )}
      {tool === 'marker' && (
        <>
          <div className="icon-choice">
            <span className="current-icon" aria-label={t('map.toolSettings.currentIcon')}>
              {options.imageId ? (
                stickerFor(options.imageId) ? (
                  <img src={stickerFor(options.imageId)!.iconUrl} alt="" decoding="async" />
                ) : (
                  <span className="current-icon-missing" aria-hidden="true" />
                )
              ) : (
                <img
                  alt=""
                  src={`/api/map-assets/emoji-${mapDisplay.emoji[options.emoji as keyof typeof mapDisplay.emoji]}.png`}
                />
              )}
            </span>
            <button ref={stickerButton} aria-expanded={browseStickers} onClick={onBrowse}>
              <Search size={16} />
              {t('map.toolSettings.browseIcons')}
            </button>
          </div>
          {recentPicks.length > 0 && (
            <>
              <span className="field-label">{t('map.stickers.recent')}</span>
              <div
                className="recent-stickers"
                // A horizontal-only scroller does not translate the wheel, so the
                // strip would be unreachable with a plain mouse.
                onWheel={(event) => {
                  event.currentTarget.scrollLeft += event.deltaY;
                }}
              >
                {recentPicks.map((pick) => {
                  const label =
                    pick.kind === 'image'
                      ? pick.sticker.name
                      : t(`map.stickers.emoji.${pick.emojiKey}`);
                  return (
                    <button
                      key={pick.id}
                      title={label}
                      aria-label={label}
                      onClick={() =>
                        setOption(
                          pick.kind === 'image'
                            ? { emoji: '', imageId: pick.id }
                            : { emoji: pick.emoji, imageId: '' },
                        )
                      }
                    >
                      {pick.kind === 'image' ? (
                        <img src={pick.sticker.iconUrl} alt="" loading="lazy" decoding="async" />
                      ) : (
                        <img
                          className="recent-sticker-emoji"
                          alt=""
                          src={`/api/map-assets/emoji-${mapDisplay.emoji[pick.emoji as keyof typeof mapDisplay.emoji]}.png`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
      {(tool === 'text' || tool === 'marker') && (
        <>
          <label className="text-field">
            {t('map.toolSettings.text')}
            <textarea
              value={options.text}
              rows={3}
              maxLength={200}
              placeholder={
                tool === 'marker'
                  ? t('map.toolSettings.textOptional')
                  : t('map.toolSettings.textPlaceholder')
              }
              onChange={(e) => setOption({ text: e.target.value })}
            />
          </label>
          <label className="range-label">
            {t('map.toolSettings.textSize')}
            <output>{options.textSize} px</output>
            <input
              aria-label={t('map.toolSettings.textSizeAria')}
              type="range"
              min="12"
              max="48"
              value={options.textSize}
              onChange={(e) => {
                setOption({ textSize: +e.target.value });
                previewSize(+e.target.value);
              }}
            />
          </label>
          <span className="field-label">{t('map.toolSettings.color')}</span>
          <ColorPicker color={options.color} onChange={setColor} />
        </>
      )}
      {tool === 'eraser' && (
        <>
          <label className="range-label">
            {t('map.toolSettings.width')}
            <output>{options.eraserSize} px</output>
            <input
              aria-label={t('map.toolSettings.eraserWidth')}
              type="range"
              min="5"
              max="50"
              value={options.eraserSize}
              onChange={(e) => {
                setOption({ eraserSize: +e.target.value });
                previewSize(+e.target.value);
              }}
            />
          </label>
        </>
      )}
    </div>
  );
}
