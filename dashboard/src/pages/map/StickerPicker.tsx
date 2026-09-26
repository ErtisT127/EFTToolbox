import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Sticker, StickerUsage } from '../../../../contracts/ts/ipc.gen';
import { useLocale } from '../../hooks/useLocale';
import { SearchInput } from '../../components/SearchInput';
import { mapDisplay } from '../../../../contracts/ts/map-display.gen';

// The built-in glyphs. They replace the old four emoji groups, so the picker has one curated set
// rather than two overlapping ones.
export const builtInEmoji: [string, string][] = [
  ['📝', 'text'],
  ['👾', 'enemy'],
  ['📦', 'container'],
  ['📜', 'task'],
  ['🛒', 'trader'],
  ['🚪', 'extract'],
  ['⚠️', 'caution'],
  ['📍', 'location'],
];

export type StickerPick = { emoji: string; imageId: string };

export type ResolvedPick =
  | { kind: 'image'; id: string; sticker: Sticker }
  | { kind: 'emoji'; id: string; emoji: string; emojiKey: string };

// A recent-usage id is either a catalogue sticker or one of the built-in glyphs, and only this
// module knows the glyph set. Ids the catalogue no longer carries resolve to null.
export function resolvePick(id: string, stickers: Map<string, Sticker>): ResolvedPick | null {
  const sticker = stickers.get(id);
  if (sticker) return { kind: 'image', id, sticker };
  const glyph = builtInEmoji.find(([char]) => char === id);
  if (glyph) return { kind: 'emoji', id, emoji: glyph[0], emojiKey: glyph[1] };
  return null;
}

type Category = { id: string; label: string; group?: string };

// The single ordering source: the rail renders this list, and "all" concatenates the same groups
// in the same order, so the two can never disagree.
const categoryOrder: Category[] = [
  { id: 'recent', label: 'map.stickers.recent' },
  { id: 'all', label: 'map.stickers.all' },
  { id: 'builtin', label: 'map.stickers.builtin' },
  { id: 'extract', label: 'map.stickers.groups.extract', group: 'extract' },
  { id: 'trader', label: 'map.stickers.groups.trader', group: 'trader' },
  { id: 'boss', label: 'map.stickers.groups.boss', group: 'boss' },
  { id: 'container', label: 'map.stickers.groups.container', group: 'container' },
  { id: 'key', label: 'map.stickers.groups.key', group: 'key' },
  { id: 'battlepass', label: 'map.stickers.groups.battlepass', group: 'battlepass' },
];

type Props = {
  stickers: Sticker[];
  recent: StickerUsage[];
  onPick: (pick: StickerPick) => void;
  onClose: () => void;
};

export function StickerPicker({ stickers, recent, onPick, onClose }: Props) {
  const { t } = useLocale();
  const [category, setCategory] = useState('builtin');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const dialog = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(stickers.map((s) => [s.id, s])), [stickers]);
  const recentItems = useMemo(
    () =>
      recent
        .map((usage) => resolvePick(usage.id, byId))
        .filter((pick): pick is ResolvedPick => !!pick)
        .map((pick) =>
          pick.kind === 'image'
            ? {
                kind: 'image' as const,
                id: pick.id,
                name: pick.sticker.name,
                sticker: pick.sticker,
              }
            : {
                kind: 'emoji' as const,
                id: pick.id,
                name: t(`map.stickers.emoji.${pick.emojiKey}`),
                emoji: pick.emoji,
                key: pick.emojiKey,
              },
        ),
    [recent, byId, t],
  );

  const emojiItems = useMemo(
    () =>
      builtInEmoji.map(([emoji, key]) => ({
        kind: 'emoji' as const,
        id: emoji,
        name: t(`map.stickers.emoji.${key}`),
        emoji,
        key,
      })),
    [t],
  );
  const orderedStickers = useMemo(
    () =>
      categoryOrder.flatMap((entry) =>
        entry.group ? stickers.filter((s) => s.group === entry.group) : [],
      ),
    [stickers],
  );

  // One list drives both browsing and searching, so the grid only ever renders one category's
  // worth of tiles instead of the whole catalogue.
  const items = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    if (needle)
      return [
        ...emojiItems.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)),
        ...stickers
          .filter((s) => s.name.toLocaleLowerCase().includes(needle))
          .map((s) => ({ kind: 'image' as const, id: s.id, name: s.name, sticker: s })),
      ];
    if (category === 'recent') return recentItems;
    if (category === 'builtin') return emojiItems;
    if (category === 'all')
      return [
        ...emojiItems,
        ...orderedStickers.map((s) => ({
          kind: 'image' as const,
          id: s.id,
          name: s.name,
          sticker: s,
        })),
      ];
    return stickers
      .filter((s) => s.group === category)
      .map((s) => ({ kind: 'image' as const, id: s.id, name: s.name, sticker: s }));
  }, [category, deferredQuery, stickers, emojiItems, orderedStickers, recentItems]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = dialog.current.querySelectorAll<HTMLElement>('button, input, [tabindex]');
      if (!focusable.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const counts: Record<string, number> = {
    all: stickers.length + builtInEmoji.length,
    builtin: builtInEmoji.length,
    ...Object.fromEntries(
      categoryOrder
        .filter((entry) => entry.group)
        .map((entry) => [entry.id, stickers.filter((s) => s.group === entry.group).length]),
    ),
  };

  return (
    <div className="sticker-backdrop" onPointerDown={onClose}>
      <div
        className="sticker-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('map.stickers.title')}
        ref={dialog}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sticker-head">
          <span className="sticker-title">{t('map.stickers.title')}</span>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('map.stickers.search')}
            label={t('map.stickers.search')}
            clearLabel={t('map.stickers.clearSearch')}
            autoFocus
          />
          <button className="icon-button" aria-label={t('map.stickers.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="sticker-body">
          <nav className="sticker-rail" aria-label={t('map.stickers.title')}>
            {categoryOrder.map((entry) => (
              <div key={entry.id} className="sticker-rail-item">
                <button
                  aria-pressed={category === entry.id && !query}
                  className={category === entry.id && !query ? 'active' : ''}
                  onClick={() => {
                    setCategory(entry.id);
                    setQuery('');
                  }}
                >
                  {t(entry.label)}
                  {entry.id !== 'recent' && (
                    <span className="sticker-count">{counts[entry.id] ?? 0}</span>
                  )}
                </button>
                {entry.id === 'recent' && <hr className="sticker-divider" />}
              </div>
            ))}
          </nav>
          <div className="sticker-scroll">
            {items.length ? (
              <div className="sticker-grid">
                {items.map((item) =>
                  item.kind === 'emoji' ? (
                    <button
                      key={`emoji-${item.key}`}
                      className="sticker-cell"
                      title={item.name}
                      aria-label={item.name}
                      onClick={() => onPick({ emoji: item.emoji, imageId: '' })}
                    >
                      <img
                        className="sticker-emoji"
                        width="26"
                        height="26"
                        alt=""
                        src={`/api/assets/display/emoji/emoji-${mapDisplay.emoji[item.emoji as keyof typeof mapDisplay.emoji]}.png`}
                      />
                    </button>
                  ) : (
                    <button
                      key={item.id}
                      className="sticker-cell"
                      title={item.name}
                      aria-label={item.name}
                      onClick={() => onPick({ emoji: '', imageId: item.id })}
                    >
                      <img src={item.sticker.iconUrl} alt="" loading="lazy" decoding="async" />
                    </button>
                  ),
                )}
              </div>
            ) : (
              <p className="hint">{t('map.stickers.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
