import { useEffect, useState } from 'react';
import type { MapData, MapSummary, OverlaySettings } from '../../../../contracts/ts/ipc.gen';
import { useOverlay } from '../../stores/overlayStore';
import { request } from '../../stores/workspaceStore';
import { useLocale } from '../../hooks/useLocale';
import '../../styles/settings.css';

function NumberSetting({
  label,
  value,
  min,
  max,
  change,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  change: (n: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        key={value}
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        step="any"
        onBlur={(e) => {
          const n = e.currentTarget.valueAsNumber;
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) change(n);
          else if (!e.currentTarget.validity.valid) e.currentTarget.reportValidity();
        }}
      />
    </label>
  );
}
export function SettingsPage() {
  const { t } = useLocale();
  const store = useOverlay();
  const value = store.settings;
  const view = store.view;
  const [tab, setTab] = useState<'map' | 'hotkeys'>('map');
  const [catalog, setCatalog] = useState<MapSummary[]>([]);
  const [map, setMap] = useState<MapData>();
  const [mapId, setMapId] = useState('');
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    void request<MapSummary[]>('/api/maps')
      .then(setCatalog)
      .catch(() => setLoadError('errors.request_failed'));
  }, []);
  useEffect(() => {
    if (!view?.mapId) return;
    const controller = new AbortController();
    void request<MapData>(`/api/maps/${view.mapId}`, { signal: controller.signal })
      .then(setMap)
      .catch(() => {
        if (!controller.signal.aborted) setLoadError('errors.request_failed');
      });
    return () => controller.abort();
  }, [view?.mapId]);
  const update = (v: Partial<OverlaySettings>) => store.update(v);
  const check = (
    key:
      | 'lockAspect'
      | 'followCenter'
      | 'followFloor'
      | 'followZoom'
      | 'perMapZoom'
      | 'devPlayerEnabled',
  ) => (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={!!value?.[key]}
        onChange={(e) => update({ [key]: e.target.checked })}
      />
      {t(`settings.${key}`)}
    </label>
  );
  const number = (
    key: 'width' | 'height' | 'left' | 'top' | 'targetZoom',
    min: number,
    max: number,
  ) => (
    <NumberSetting
      label={t(`settings.${key}`)}
      value={value![key]}
      min={min}
      max={max}
      change={(n) => {
        const v: Partial<OverlaySettings> = { [key]: n };
        if (
          value &&
          (key === 'width' || key === 'height') &&
          (value.lockAspect || value.shape === 'circle')
        ) {
          if (value.shape === 'circle') {
            v.width = v.height = n;
          } else {
            const scale = Math.max(
              160 / value.width,
              160 / value.height,
              Math.min(n / value[key], 2048 / value.width, 2048 / value.height),
            );
            v.width = Math.round(value.width * scale);
            v.height = Math.round(value.height * scale);
          }
        }
        update(v);
      }}
    />
  );
  const selectedMap = mapId || view?.mapId || catalog[0]?.id || '';
  const override = value?.mapZooms.find((z) => z.mapId === selectedMap);
  return (
    <section className="settings-page">
      <aside className="settings-tabs" role="tablist" aria-label={t('nav.settings')}>
        {(['map', 'hotkeys'] as const).map((key) => (
          <button
            key={key}
            id={`settings-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls="settings-panel"
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = key === 'map' ? 'hotkeys' : 'map';
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }
            }}
          >
            {t(`settings.${key}`)}
          </button>
        ))}
      </aside>
      <div
        className="settings-content"
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        <h1>{t(`settings.${tab}`)}</h1>
        {(store.error || loadError) && (
          <div role="alert" className="danger">
            {t(store.error || loadError)}{' '}
            <button onClick={() => void (value ? store.save() : store.load())}>
              {t('common.retry')}
            </button>
          </div>
        )}
        {view?.error && (
          <p role="alert" className="danger">
            {t('settings.nativeError', { error: t(view.error) })}
          </p>
        )}
        <p role="status">
          {t(
            !view?.connected
              ? 'settings.unavailable'
              : store.saving
                ? 'settings.saving'
                : 'settings.ready',
          )}
        </p>
        {!value ? (
          <p>{t('common.loading')}</p>
        ) : tab === 'hotkeys' ? (
          <fieldset>
            <legend>{t('settings.hotkeys')}</legend>
            <p>{t('settings.hotkeyHint')}</p>
            {(['toggleEdit', 'toggleVisible'] as const).map((key) => (
              <label key={key}>
                {t(`settings.${key}`)}
                <input
                  key={value.hotkeys[key]}
                  defaultValue={value.hotkeys[key]}
                  placeholder={t('settings.disabled')}
                  onBlur={(e) => {
                    if (e.target.value !== value.hotkeys[key])
                      update({ hotkeys: { ...value.hotkeys, [key]: e.target.value.trim() } });
                  }}
                />
              </label>
            ))}
          </fieldset>
        ) : (
          <>
            <fieldset>
              <legend>{t('settings.appearance')}</legend>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={value.visible}
                  onChange={(e) => update({ visible: e.target.checked })}
                />
                {t('settings.visible')}
              </label>
              <label>
                {t('settings.shape')}
                <select
                  value={value.shape}
                  onChange={(e) => update({ shape: e.target.value as OverlaySettings['shape'] })}
                >
                  <option value="square">{t('settings.square')}</option>
                  <option value="circle">{t('settings.circle')}</option>
                </select>
              </label>
              {number('width', 160, 2048)}
              {number('height', 160, 2048)}
              {check('lockAspect')}
              <label>
                {t('settings.svgResolution')}
                <select
                  value={value.svgResolution}
                  onChange={(e) => update({ svgResolution: Number(e.target.value) })}
                >
                  {[1024, 2048, 4096].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('settings.window')}</legend>
              {number('left', -100000, 100000)}
              {number('top', -100000, 100000)}
              <p>{t('settings.boundaryHint')}</p>
              <button
                disabled={!view?.connected}
                aria-pressed={!!view?.editing}
                onClick={() => void store.command({ kind: 'edit', enabled: !view?.editing })}
              >
                {t(view?.editing ? 'settings.exitEdit' : 'settings.enterEdit')}
              </button>
            </fieldset>
            <fieldset disabled={!view?.connected}>
              <legend>{t('settings.viewport')}</legend>
              <p>{t('settings.transientHint')}</p>
              <NumberSetting
                label={t('settings.centerX')}
                value={view?.center.x || 0}
                min={-1e7}
                max={1e7}
                change={(x) =>
                  void store.command({ kind: 'view', center: { x, y: view?.center.y || 0 } })
                }
              />
              <NumberSetting
                label={t('settings.centerY')}
                value={view?.center.y || 0}
                min={-1e7}
                max={1e7}
                change={(y) =>
                  void store.command({ kind: 'view', center: { x: view?.center.x || 0, y } })
                }
              />
              <NumberSetting
                label={t('settings.zoom')}
                value={view?.zoom || 0}
                min={-10}
                max={12}
                change={(zoom) => void store.command({ kind: 'view', zoom })}
              />
              <label>
                {t('settings.floor')}
                <select
                  value={view?.floorId || ''}
                  onChange={(e) => void store.command({ kind: 'view', floorId: e.target.value })}
                >
                  {map?.floors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('settings.follow')}</legend>
              {check('followCenter')}
              {check('followFloor')}
              {check('followZoom')}
              {number('targetZoom', -10, 12)}
              {check('perMapZoom')}
              {value.perMapZoom && (
                <>
                  <label>
                    {t('settings.map')}
                    <select value={selectedMap} onChange={(e) => setMapId(e.target.value)}>
                      {catalog.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberSetting
                    label={t('settings.mapZoom')}
                    value={override?.zoom ?? value.targetZoom}
                    min={-10}
                    max={12}
                    change={(zoom) =>
                      update({
                        mapZooms: [
                          ...value.mapZooms.filter((z) => z.mapId !== selectedMap),
                          { mapId: selectedMap, zoom },
                        ],
                      })
                    }
                  />
                  <button
                    disabled={!override}
                    onClick={() =>
                      update({ mapZooms: value.mapZooms.filter((z) => z.mapId !== selectedMap) })
                    }
                  >
                    {t('settings.useGlobal')}
                  </button>
                </>
              )}
              <button
                disabled={!view?.connected}
                onClick={() => {
                  if (!view) return;
                  if (value.perMapZoom)
                    update({
                      mapZooms: [
                        ...value.mapZooms.filter((z) => z.mapId !== view.mapId),
                        { mapId: view.mapId, zoom: view.zoom },
                      ],
                    });
                  else update({ targetZoom: view.zoom });
                }}
              >
                {t('settings.useCurrent')}
              </button>
            </fieldset>
            <fieldset>
              <legend>{t('settings.development')}</legend>
              {check('devPlayerEnabled')}
            </fieldset>
          </>
        )}
      </div>
    </section>
  );
}
