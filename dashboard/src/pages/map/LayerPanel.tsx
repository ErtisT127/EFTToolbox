import { ChevronRight, X } from 'lucide-react';
import type { Annotation, MapData, MapPreference } from '../../../../contracts/ts/ipc.gen';
import { selectableFloors } from './lib/floors';
import { useLocale, type LocaleKey } from '../../hooks/useLocale';

type OwnerRow = {
  ownerId: string;
  name: string;
  color: string;
  /** Live roster member (default visible) versus departed teammate (default hidden). */
  active: boolean;
};

type OwnerVisibilityProps = {
  selfId: string;
  rows: OwnerRow[];
  hiddenOwners: string[];
  shownOwners: string[];
  onToggle: (ownerId: string, visible: boolean) => void;
};

type Props = {
  data: MapData;
  items: Annotation[];
  preference: MapPreference;
  onPreference: (changes: Partial<MapPreference>) => void;
  onClose: () => void;
  readOnly?: boolean;
  /** Teammate marker sub-rows; absent in read-only mirrors, which show no owner controls. */
  owners?: OwnerVisibilityProps;
};

export function LayerPanel({
  data,
  items,
  preference,
  onPreference,
  onClose,
  readOnly = false,
  owners,
}: Props) {
  const { t } = useLocale();
  const ownerToggle = (ownerId: string, checked: boolean) => {
    // The per-owner boxes read off while the group master is off, so switching one back on has to
    // bring the group with it: the switch always produces the state it shows.
    if (checked && !preference.showAnnotations) onPreference({ showAnnotations: true });
    owners?.onToggle(ownerId, checked);
  };
  const floorItems = items.filter((a) => a.floorId === preference.floorId);
  const ownerRows = (owners?.rows || []).map((row) => ({
    ...row,
    count: floorItems.filter((a) => a.ownerId === row.ownerId).length,
  }));
  const selfCount = floorItems.filter((a) => a.ownerId === owners?.selfId).length;
  const toggleCategory = (categoryId: string) => {
    const hidden = preference.hiddenCategories;
    onPreference({
      hiddenCategories: hidden.includes(categoryId)
        ? hidden.filter((c) => c !== categoryId)
        : [...hidden, categoryId],
    });
  };
  const expanded = (key: string) => !preference.collapsedGroups.includes(key);
  const toggleGroup = (key: string, open: boolean) => {
    if (open === expanded(key)) return;
    const collapsed = preference.collapsedGroups;
    onPreference({
      collapsedGroups: open ? collapsed.filter((g) => g !== key) : [...collapsed, key],
    });
  };

  return (
    <>
      <div className="panel-title">
        <span>{t('map.layers.title')}</span>
        <button
          className="icon-button"
          aria-label={t('map.layers.close')}
          onClick={() => onClose()}
        >
          <X size={15} />
        </button>
      </div>
      <div className="panel-scroll">
        {data.svgUrl && data.tiles.length > 0 && (
          <div className="basemap-section">
            {[
              ...(data.svgUrl
                ? [{ id: 'svg' as const, label: 'map.layers.abstract' as const }]
                : []),
              ...(data.tiles.length
                ? [{ id: 'tiles' as const, label: 'map.layers.satellite' as const }]
                : []),
            ].map((mode) => (
              <label className="check-row" key={mode.id}>
                <input
                  type="radio"
                  name="basemap"
                  checked={preference.basemap === mode.id}
                  onChange={() => onPreference({ basemap: mode.id })}
                />
                {t(mode.label)}
              </label>
            ))}
          </div>
        )}
        {selectableFloors(data, preference.basemap).length > 0 && (
          <details
            open={expanded('levels')}
            onToggle={(e) => toggleGroup('levels', e.currentTarget.open)}
          >
            <summary>
              <ChevronRight className="group-chevron" size={16} aria-hidden="true" />
              {t('map.layers.levels')}
            </summary>
            {selectableFloors(data, preference.basemap).map((floor) => (
              <label className="check-row" key={floor.id}>
                <input
                  type="checkbox"
                  name="floor"
                  value={floor.id}
                  checked={preference.floorId === floor.id}
                  onChange={() =>
                    onPreference({
                      floorId: preference.floorId === floor.id ? data.baseFloor : floor.id,
                    })
                  }
                />
                {floor.name}
              </label>
            ))}
          </details>
        )}
        {!readOnly && (
          <details
            open={expanded('annotations')}
            onToggle={(e) => toggleGroup('annotations', e.currentTarget.open)}
          >
            <summary>
              <input
                type="checkbox"
                checked={preference.showAnnotations}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onPreference({ showAnnotations: e.target.checked })}
              />
              <ChevronRight className="group-chevron" size={16} aria-hidden="true" />
              {t('map.layers.annotations')}
            </summary>
            {owners ? (
              <>
                {/* The group switch is the master: while it is off every user marker is hidden, so the
                    per-owner boxes read as off too instead of claiming markers nobody can see. */}
                {owners.selfId !== '' && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={
                        preference.showAnnotations && !owners.hiddenOwners.includes(owners.selfId)
                      }
                      onChange={(e) => ownerToggle(owners.selfId, e.target.checked)}
                    />
                    {t('map.layers.myMarkers')}
                    <span className="count">{selfCount}</span>
                  </label>
                )}
                {ownerRows.map((row) => (
                  <label className="check-row" key={row.ownerId}>
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={
                        preference.showAnnotations &&
                        (row.active
                          ? !owners.hiddenOwners.includes(row.ownerId)
                          : owners.shownOwners.includes(row.ownerId))
                      }
                      onChange={(e) => ownerToggle(row.ownerId, e.target.checked)}
                    />
                    {row.color && (
                      <i
                        className="owner-dot"
                        style={{ background: row.color }}
                        aria-hidden="true"
                      />
                    )}
                    {row.name || t('multiplayer.layers.unknownOwner')}
                    <span className="count">{row.count}</span>
                  </label>
                ))}
              </>
            ) : (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={preference.showAnnotations}
                  onChange={(e) => onPreference({ showAnnotations: e.target.checked })}
                />
                {t('map.layers.myMarkers')}
                <span className="count">
                  {items.filter((a) => a.floorId === preference.floorId).length}
                </span>
              </label>
            )}
          </details>
        )}
        {!readOnly &&
          [...new Set(data.categories.map((c) => c.groupId))].map((groupId) => (
            <details
              key={groupId}
              open={expanded(groupId)}
              onToggle={(e) => toggleGroup(groupId, e.currentTarget.open)}
            >
              <summary>
                <input
                  type="checkbox"
                  aria-label={t('map.layers.toggleGroup', {
                    group: t(`data.mapGroups.${groupId}` as LocaleKey),
                  })}
                  ref={(input) => {
                    if (!input) return;
                    const categories = data.categories.filter((c) => c.groupId === groupId);
                    const visible = categories.filter(
                      (c) => !preference.hiddenCategories.includes(c.id),
                    ).length;
                    input.indeterminate = visible > 0 && visible < categories.length;
                  }}
                  checked={data.categories
                    .filter((c) => c.groupId === groupId)
                    .every((c) => !preference.hiddenCategories.includes(c.id))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const ids = data.categories
                      .filter((c) => c.groupId === groupId)
                      .map((c) => c.id);
                    onPreference({
                      hiddenCategories: e.target.checked
                        ? preference.hiddenCategories.filter((c) => !ids.includes(c))
                        : [...new Set([...preference.hiddenCategories, ...ids])],
                    });
                  }}
                />
                <ChevronRight className="group-chevron" size={16} aria-hidden="true" />
                {t(`data.mapGroups.${groupId}` as LocaleKey)}
              </summary>
              {data.categories
                .filter((c) => c.groupId === groupId)
                .map((category) => (
                  <label className="check-row" key={category.id}>
                    <input
                      type="checkbox"
                      checked={!preference.hiddenCategories.includes(category.id)}
                      onChange={() => toggleCategory(category.id)}
                    />
                    {category.iconUrl && (
                      <img className="category-icon" src={category.iconUrl} alt="" />
                    )}
                    {category.name}
                    <span className="count">
                      {
                        data.markers.filter(
                          (m) =>
                            m.categoryIds.includes(category.id) &&
                            m.floorIds.includes(preference.floorId),
                        ).length
                      }
                    </span>
                  </label>
                ))}
            </details>
          ))}
      </div>
    </>
  );
}
