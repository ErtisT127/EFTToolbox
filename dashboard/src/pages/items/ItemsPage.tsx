import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleOff,
  ClipboardList,
  CloudDownload,
  Image,
  LoaderCircle,
  Repeat,
  ScanLine,
  Search,
  SearchX,
  UserRound,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  ItemsCatalog,
  ItemsCatalogItem,
  ItemsRequirement,
  ItemsSettings,
  ItemsUpdateStatus,
} from '../../../../contracts/ts/ipc.gen';
import { AppPopover } from '../../components/AppPopover';
import { AppTooltip } from '../../components/HintTooltip';
import { useLocale } from '../../hooks/useLocale';
import { useGameMonitor } from '../../stores/gameMonitorStore';
import { notices } from '../../stores/noticeStore';
import { request } from '../../stores/workspaceStore';
import { DataLoadError } from '../../lib/errors';
import { useItemsRevision } from '../../stores/resourceStore';
import {
  filterItems,
  formatCount,
  formatPrice,
  itemCategories,
  sortItems,
  type ItemSort,
} from './lib';
import { useVirtualList } from './useVirtualList';

const rowHeight = 91;
const headerHeight = 64;

// Sortable columns, in table order. The image column carries no header.
const columns: { key: ItemSort; label: string }[] = [
  { key: 'name', label: 'name' },
  { key: 'traderPrice', label: 'trader' },
  { key: 'fleaPrice', label: 'flea' },
  { key: 'lowestPrice', label: 'lowest' },
];

// The backend reports every fetch; the dialog groups them into one chip per thing a reader
// recognises, so a language pair never shows up as two separate steps.
const downloadSteps = [
  { id: 'items', details: ['items'] },
  { id: 'items_names', details: ['items_zh', 'items_en'] },
  { id: 'traders', details: ['traders', 'traders_en'] },
  { id: 'tasks', details: ['tasks'] },
  { id: 'task_names', details: ['tasks_zh', 'tasks_en'] },
  { id: 'barters', details: ['barters'] },
] as const;

const downloadStepIndex = (detail: string) =>
  downloadSteps.findIndex((step) => (step.details as readonly string[]).includes(detail));

const emptyStatus: ItemsUpdateStatus = {
  running: false,
  phase: '',
  detail: '',
  imagesTotal: 0,
  imagesDone: 0,
  downloaded: 0,
  skipped: 0,
  includeImages: false,
  error: '',
  errorDetail: '',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function ItemsPage() {
  const { t, locale } = useLocale();
  const monitor = useGameMonitor();
  const revision = useItemsRevision();
  const [catalog, setCatalog] = useState<ItemsCatalog>();
  const [settings, setSettings] = useState<ItemsSettings>();
  const [status, setStatus] = useState(emptyStatus);
  const [loadError, setLoadError] = useState<DataLoadError | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ItemSort>('id');
  const [descending, setDescending] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [dialog, setDialog] = useState<'update' | 'recognition' | null>(null);
  const [scrollHeight, setScrollHeight] = useState(520);
  const [refreshing, setRefreshing] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const reportedRun = useRef<string | undefined>(undefined);

  const startUpdate = useCallback(
    (includeImages = false) => {
      setDialog('update');
      void request<ItemsUpdateStatus>('/api/items/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeImages }),
      })
        .then(setStatus)
        .catch((reason: unknown) => {
          notices.push(t(reason instanceof Error ? reason.message : 'errors.request_failed'));
        });
    },
    [t],
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    void request<ItemsCatalog>(`/api/items?locale=${encodeURIComponent(locale)}`)
      .then((nextCatalog) => {
        if (active) setCatalog(nextCatalog);
      })
      .catch((reason: unknown) => {
        // A catalog the page cannot read is fatal, so it goes through the shared page-level error
        // boundary instead of a bespoke box.
        if (active)
          setLoadError(
            new DataLoadError(
              reason instanceof Error ? reason.message : 'errors.items_not_available',
              'items',
              reason,
            ),
          );
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    void request<ItemsSettings>('/api/items-settings')
      .then((nextSettings) => {
        if (!active) return;
        setSettings(nextSettings);
        setCategory(nextSettings.category || '');
        setSort(nextSettings.sort || 'id');
        setDescending(nextSettings.descending);
      })
      .catch(() => {
        // Preferences are not worth blocking the table: keep the defaults and report in a notice.
        if (active) notices.push(t('errors.items_settings_invalid'));
      });
    return () => {
      active = false;
    };
  }, [locale, monitor.settings?.mode, revision, t]);

  useEffect(() => {
    if (!status.running) return;
    const timer = window.setInterval(() => {
      void request<ItemsUpdateStatus>('/api/items/update')
        .then(setStatus)
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status.running]);

  // A failed background update is not tied to a control the page can put a message next to, so it
  // reports through the shared notice pipeline with a retry.
  useEffect(() => {
    if (status.running || !status.error || status.error === 'cancelled') return;
    const run = status.finishedAt ?? status.errorDetail;
    if (reportedRun.current === run) return;
    reportedRun.current = run;
    notices.push(
      t('items.updateFailedNotice', {
        detail: status.errorDetail ? ` (${status.errorDetail})` : '',
      }),
      () => void startUpdate(status.includeImages),
    );
  }, [status, t, startUpdate]);

  useEffect(() => {
    const node = tableRef.current;
    if (!node) return;
    const updateHeight = () => setScrollHeight(Math.max(0, node.clientHeight - headerHeight));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [catalog]);

  const visible = useMemo(
    () => sortItems(filterItems(catalog?.items || [], query, category), sort, descending),
    [catalog, category, descending, query, sort],
  );
  const virtual = useVirtualList(visible, scrollTop, scrollHeight, rowHeight);

  const saveSettings = (changes: Partial<ItemsSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...changes };
    setSettings(next);
    void request<ItemsSettings>('/api/items-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => notices.push(t('errors.items_settings_invalid')));
  };
  const changeSort = (next: ItemSort) => {
    const nextState =
      sort !== next
        ? { sort: next, descending: false }
        : descending
          ? { sort: 'id' as const, descending: false }
          : { sort: next, descending: true };
    setSort(nextState.sort);
    setDescending(nextState.descending);
    saveSettings(nextState);
  };
  const changeCategory = (next: string) => {
    setCategory(next);
    saveSettings({ category: next });
  };
  const cancelUpdate = () => {
    void request<ItemsUpdateStatus>('/api/items/update/cancel', { method: 'POST' })
      .then(setStatus)
      .catch(() => notices.push(t('errors.request_failed')));
  };

  // Rendering the failure instead of handling it locally lets the module's error boundary take
  // over the whole page with the shared error state.
  if (loadError) throw loadError;

  return (
    <section className="items-page">
      <div className="items-toolbar">
        <label className="items-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={t('items.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('items.searchPlaceholder')}
          />
          {search && (
            <button type="button" aria-label={t('common.clear')} onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <button
          type="button"
          className="items-update"
          onClick={() => startUpdate(settings?.includeImages ?? true)}
          disabled={status.running}
        >
          <CloudDownload size={14} />
          {t('items.update')}
        </button>
        <label className="items-check">
          <input
            type="checkbox"
            checked={settings?.includeImages ?? true}
            onChange={(event) => saveSettings({ includeImages: event.target.checked })}
          />
          {t('items.includeImages')}
        </label>
        <label className="items-check">
          <input
            type="checkbox"
            checked={settings?.autoUpdate ?? false}
            onChange={(event) => saveSettings({ autoUpdate: event.target.checked })}
          />
          {t('items.autoUpdate')}
        </label>
        <select
          aria-label={t('items.interval')}
          disabled={!settings?.autoUpdate}
          value={settings?.intervalMinutes ?? 60}
          onChange={(event) => saveSettings({ intervalMinutes: Number(event.target.value) })}
        >
          {[60, 120, 240, 480, 720].map((value) => (
            <option key={value} value={value}>
              {value / 60}h
            </option>
          ))}
        </select>
        <button
          type="button"
          className="items-recognition"
          onClick={() => setDialog('recognition')}
        >
          <span className="items-recognition-badge">
            <ScanLine size={18} aria-hidden="true" />
          </span>
          <span className="items-recognition-label">
            <b>{t('items.recognition')}</b>
            <small>{t('items.recognitionTag')}</small>
          </span>
        </button>
      </div>
      <div
        className="items-categories"
        aria-label={t('items.categories')}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            event.currentTarget.scrollLeft += event.deltaY;
            event.preventDefault();
          }
        }}
      >
        <button type="button" aria-pressed={category === ''} onClick={() => changeCategory('')}>
          {t('items.all')}
        </button>
        {itemCategories.map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={category === value}
            onClick={() => changeCategory(value)}
          >
            {t(`items.category.${value}`)}
          </button>
        ))}
      </div>
      {catalog ? (
        <div
          className={`items-table-wrap${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          ref={tableRef}
        >
          {refreshing && (
            <div className="items-refresh" role="status">
              <LoaderCircle className="items-spin" size={20} aria-hidden="true" />
              {t('items.refreshing')}
            </div>
          )}
          <div className="items-table" style={{ minHeight: virtual.totalHeight + headerHeight }}>
            <div className="items-row items-head">
              <span />
              {columns.map(({ key, label }) => (
                <button
                  className="items-sort-button"
                  type="button"
                  key={key}
                  aria-sort={sort === key ? (descending ? 'descending' : 'ascending') : 'none'}
                  onClick={() => changeSort(key)}
                >
                  <span className="items-sort-label">{t(`items.${label}`)}</span>
                  <span className="items-sort-slot" aria-hidden="true">
                    {sort === key ? (
                      descending ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronUp size={15} />
                      )
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="items-rows"
              style={{ transform: `translateY(${virtual.start * rowHeight}px)` }}
            >
              {virtual.items.map((item) => (
                <ItemRow key={item.id} item={item} t={t} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="items-loading">{t('common.loading')}</div>
      )}
      {dialog === 'update' && (
        <UpdateDialog
          status={status}
          t={t}
          onClose={() => setDialog(null)}
          onCancel={cancelUpdate}
        />
      )}
      {dialog === 'recognition' && (
        <UpdateDialog status={status} t={t} recognition onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

function StatusIcon({ icon: Icon, content }: { icon: LucideIcon; content: string }) {
  return (
    <AppTooltip content={content} placement="top" className="items-status-tooltip">
      <span className="items-status-icon" aria-label={content}>
        <Icon size={17} aria-hidden="true" />
      </span>
    </AppTooltip>
  );
}

function unavailableMessages(item: ItemsCatalogItem, t: Translate) {
  return [
    item.traderStatus === 'unavailable' ? t('items.traderUnavailable') : '',
    item.fleaStatus === 'noFlea' ? t('items.fleaUnavailable') : '',
    item.fleaStatus === 'notScanned' ? t('items.fleaNotScanned') : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function ItemRow({ item, t }: { item: ItemsCatalogItem; t: Translate }) {
  const unavailable = unavailableMessages(item, t);

  return (
    <div className="items-row">
      <span className="item-image">
        {item.image ? <img src={item.image} loading="lazy" alt="" /> : <Image size={18} />}
      </span>
      <span className="item-name" title={item.name}>
        {item.name}
      </span>
      <span className="items-price-cell">
        {item.traderStatus === 'available' ? (
          <span className="trader-offer">
            {item.trader?.image ? (
              <img src={item.trader.image} alt={item.trader.name} className="trader-avatar" />
            ) : (
              <UserRound size={17} aria-hidden="true" />
            )}
            <span className="trader-price">{formatPrice(item.traderPrice)}</span>
          </span>
        ) : (
          <StatusIcon icon={CircleOff} content={unavailable} />
        )}
      </span>
      <span className="items-price-cell">
        {item.fleaStatus === 'available' ? (
          formatPrice(item.fleaPrice)
        ) : (
          <StatusIcon
            icon={item.fleaStatus === 'notScanned' ? SearchX : CircleOff}
            content={unavailable}
          />
        )}
      </span>
      <LowestPrice item={item} t={t} />
    </div>
  );
}

// The lowest price names the source it buys from. Only sources that cost something besides cash —
// a task requirement or a barter — carry the icon and its popover.
function LowestPrice({ item, t }: { item: ItemsCatalogItem; t: Translate }) {
  const reference = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  if (item.lowestPrice === null) {
    return (
      <span className="items-price-cell">
        <StatusIcon
          icon={item.fleaStatus === 'notScanned' ? SearchX : CircleOff}
          content={unavailableMessages(item, t)}
        />
      </span>
    );
  }

  const source = item.lowestPriceSource;
  const task = source?.task ?? null;
  const barter = source?.barter ?? null;
  const hasDetails = Boolean(task || barter);

  return (
    <span className="items-price-cell items-lowest-cell">
      <span>{formatPrice(item.lowestPrice)}</span>
      {source && (
        <span className="item-price-source-row">
          <span className="item-price-source">{source.label}</span>
          {hasDetails && (
            <span
              ref={reference}
              className={`item-price-info${task && barter ? ' is-multi' : ''}`}
              role="img"
              tabIndex={0}
              aria-label={t('items.priceSource')}
              onPointerEnter={show}
              onPointerLeave={hide}
              onFocus={show}
              onBlur={hide}
            >
              {task && <ClipboardList size={15} aria-hidden="true" />}
              {barter && <Repeat size={15} aria-hidden="true" />}
            </span>
          )}
          {hasDetails && (
            <AppPopover
              open={open}
              reference={reference}
              placement="top-end"
              className="items-price-popover"
            >
              {task && (
                <div className="items-popover-section">
                  <strong>
                    {t('items.taskPrefix')}: {task.name}
                  </strong>
                  {task.requirements.map((entry) => (
                    <PriceFormula key={`${entry.itemId}-${entry.name}`} entry={entry} />
                  ))}
                </div>
              )}
              {barter && (
                <div className="items-popover-section">
                  {barter.items.map((entry) => (
                    <PriceFormula key={`${entry.itemId}-${entry.count}`} entry={entry} />
                  ))}
                </div>
              )}
            </AppPopover>
          )}
        </span>
      )}
    </span>
  );
}

function PriceFormula({ entry }: { entry: ItemsRequirement }) {
  return (
    <div className="items-price-formula">
      <span className="items-formula-image">
        {entry.image ? (
          <img src={entry.image} alt={entry.name} />
        ) : (
          <Image size={20} aria-hidden="true" />
        )}
        <b>{formatCount(entry.count)}</b>
      </span>
      <span>
        {entry.name}
        {entry.unitPrice !== null && entry.totalPrice !== null && (
          <small>
            {formatCount(entry.count)} × {formatPrice(entry.unitPrice)} ={' '}
            {formatPrice(entry.totalPrice)}
          </small>
        )}
      </span>
    </div>
  );
}

function UpdateDialog({
  status,
  t,
  recognition = false,
  onClose,
  onCancel,
}: {
  status: ItemsUpdateStatus;
  t: Translate;
  recognition?: boolean;
  onClose: () => void;
  onCancel?: () => void;
}) {
  const stages = (['download', 'images', 'parse', 'write'] as const).filter(
    (phase) => phase !== 'images' || status.includeImages,
  );
  const currentStage = stages.indexOf(status.phase as (typeof stages)[number]);
  const finished = !status.running && !status.error;
  const downloading = downloadStepIndex(status.detail);
  const chipRef = useRef<HTMLLIElement | null>(null);

  // Keep the running fetch visible: the chip row scrolls on its own once the later steps start.
  useEffect(() => {
    chipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [downloading]);
  const phaseTitle = status.running
    ? t(
        status.phase === 'images'
          ? 'items.downloadingImages'
          : status.phase === 'parse'
            ? 'items.parsing'
            : status.phase === 'write'
              ? 'items.writing'
              : 'items.fetching',
      )
    : status.error === 'cancelled'
      ? t('items.cancelled')
      : status.error
        ? t('items.failed')
        : t('items.completed');
  const phaseDetail = status.running
    ? status.phase === 'download'
      ? t('items.currentResource', {
          resource: t(`items.resource.${downloadSteps[Math.max(0, downloading)].id}`, {
            defaultValue: status.detail,
          }),
        })
      : t(`items.phaseDetail.${status.phase}`, { defaultValue: '' })
    : status.error
      ? status.error === 'cancelled'
        ? t('items.cancelledDescription')
        : status.errorDetail || t('items.updateDescription')
      : t('items.completedDescription');

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`confirm-dialog items-dialog ${
          recognition
            ? 'is-recognition'
            : status.running
              ? 'is-running'
              : status.error === 'cancelled'
                ? 'is-cancelled'
                : status.error
                  ? 'is-failed'
                  : 'is-complete'
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="items-dialog-title"
      >
        <div className="panel-title">
          <span id="items-dialog-title">
            {recognition ? t('items.recognitionTitle') : t('items.updateTitle')}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {recognition ? (
          <div className="items-dialog-body items-recognition-body">
            <span className="items-recognition-badge is-large">
              <ScanLine size={26} aria-hidden="true" />
            </span>
            <strong>{t('items.recognitionTitle')}</strong>
            <p>{t('items.recognitionPlaceholder')}</p>
            <div className="items-dialog-actions">
              <button type="button" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        ) : (
          <div className={`items-dialog-body ${status.running ? 'is-running' : 'is-finished'}`}>
            <div className="items-dialog-status">
              {status.running ? (
                <LoaderCircle
                  className="items-spin items-dialog-glyph"
                  size={22}
                  aria-hidden="true"
                />
              ) : status.error === 'cancelled' ? (
                <XCircle className="items-dialog-glyph" size={22} aria-hidden="true" />
              ) : status.error ? (
                <XCircle className="items-dialog-glyph is-error" size={22} aria-hidden="true" />
              ) : (
                <CheckCircle2
                  className="items-dialog-glyph is-success"
                  size={22}
                  aria-hidden="true"
                />
              )}
              <div className="items-dialog-headline">
                <strong>{phaseTitle}</strong>
                <small>{phaseDetail}</small>
              </div>
            </div>
            <div className="items-update-stages" aria-live="polite">
              {stages.map((phase, index) => {
                const done = finished || currentStage > index;
                const active = status.running && status.phase === phase;
                return (
                  <div className={`items-stage${active ? ' is-active' : ''}`} key={phase}>
                    <span className="items-stage-mark" aria-hidden="true">
                      {done ? <CheckCircle2 size={15} /> : <span className="items-stage-dot" />}
                    </span>
                    <div className="items-stage-body">
                      <b className={active ? 'is-active' : ''}>{t(`items.phase.${phase}`)}</b>
                      {phase === 'download' && (
                        <ul className="items-update-resources">
                          {downloadSteps.map((step, stepIndex) => (
                            <li
                              className={
                                status.running && downloading === stepIndex
                                  ? 'active'
                                  : finished || (downloading >= 0 && stepIndex < downloading)
                                    ? 'complete'
                                    : ''
                              }
                              key={step.id}
                              ref={
                                status.running && downloading === stepIndex ? chipRef : undefined
                              }
                            >
                              {t(`items.resource.${step.id}`)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {phase === 'images' && status.includeImages && status.imagesTotal > 0 && (
                        <div className="items-progress-block">
                          <progress max={status.imagesTotal} value={status.imagesDone} />
                          <span className="items-progress-text">
                            {t('items.imageProgress', {
                              done: status.imagesDone,
                              total: status.imagesTotal,
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {!status.running && (status.downloaded > 0 || status.skipped > 0) && (
              <p className="items-update-stats">
                {t('items.imageSummary', {
                  downloaded: status.downloaded,
                  skipped: status.skipped,
                })}
              </p>
            )}
            <div className="items-dialog-actions">
              {status.running ? (
                <button type="button" onClick={onCancel}>
                  {t('common.cancel')}
                </button>
              ) : (
                <button type="button" onClick={onClose}>
                  {t('common.close')}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
