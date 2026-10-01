import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleOff,
  ClipboardList,
  CloudDownload,
  Eraser,
  Image,
  ImagePlus,
  LoaderCircle,
  Repeat,
  ScanLine,
  Search,
  SearchX,
  SlidersHorizontal,
  UserRound,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  ItemsCatalogItem,
  ItemsRequirement,
  ItemsSettings,
  ItemsUpdateStatus,
  RecognitionResult,
  RecognitionSettings,
} from '../../../../contracts/ts/ipc.gen';
import { AppPopover } from '../../components/AppPopover';
import { useRegisterConflictActions } from '../../stores/conflictActions';
import { AppTooltip } from '../../components/HintTooltip';
import { RecognitionTuningFields } from '../../components/RecognitionTuningFields';
import { useLocale, type LocaleKey, type Translate } from '../../hooks/useLocale';
import { notices } from '../../stores/noticeStore';
import { reportClientLog } from '../../stores/workspaceStore';
import { DataLoadError, errorDetailOf, errorKeyOf } from '../../lib/errors';
import {
  api,
  useGetItemsQuery,
  useGetItemsSettingsQuery,
  useGetItemsUpdateStatusQuery,
} from '../../stores/api';
import { store } from '../../stores/store';
import type { RootState } from '../../stores/store';
import {
  clearConflict,
  setItemsSettingsDraft,
  submitItemsSettings,
} from '../../stores/clientState';
import { useOverlay } from '../../stores/overlayStore';
import {
  filterItems,
  formatCount,
  formatPrice,
  itemCategories,
  sortItems,
  type ItemSort,
} from './lib/catalog';
import { useVirtualList } from './lib/useVirtualList';

const rowHeight = 91;
const headerHeight = 64;
/** Matches the slide in `items.css`; the subpage stays mounted until the exit finishes. */
const recognitionSlideMs = 200;

// Sortable columns, in table order. The image column carries no header.
const columns = [
  { key: 'name', label: 'name' },
  { key: 'traderPrice', label: 'trader' },
  { key: 'fleaPrice', label: 'flea' },
  { key: 'lowestPrice', label: 'lowest' },
] as const;

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

export function ItemsPage({
  openRecognitionRequest = 0,
  onOpenSettings,
}: {
  openRecognitionRequest?: number;
  onOpenSettings: () => void;
}) {
  const { t, locale } = useLocale();
  const catalogQuery = useGetItemsQuery(locale);
  const settingsQuery = useGetItemsSettingsQuery();
  const statusQuery = useGetItemsUpdateStatusQuery(undefined, { pollingInterval: 1000 });
  const catalog = catalogQuery.data;
  const status = statusQuery.data || emptyStatus;
  const settingsDraft = useSelector((state: RootState) => state.client.itemsSettingsDraft);
  // The conflict banner is window-level; this page supplies the two page-scoped choices.
  useRegisterConflictActions('items-settings', {
    loadRemote: () => {
      void store
        .dispatch(api.endpoints.getItemsSettings.initiate(undefined, { forceRefetch: true }))
        .unwrap()
        .then(() => {
          store.dispatch(setItemsSettingsDraft(undefined));
          store.dispatch(clearConflict('items-settings'));
        });
    },
    retry: () => {
      void store
        .dispatch(api.endpoints.getItemsSettings.initiate(undefined, { forceRefetch: true }))
        .unwrap()
        .then(() => store.dispatch(submitItemsSettings()));
    },
  });
  const settings = settingsDraft || settingsQuery.data?.value;
  const [loadError, setLoadError] = useState<DataLoadError | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ItemSort>('id');
  const [descending, setDescending] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [dialog, setDialog] = useState<'update' | null>(null);
  const [recognitionPage, setRecognitionPage] = useState(false);
  const [recognitionLeaving, setRecognitionLeaving] = useState(false);
  const recognitionLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlay = useOverlay();
  const [recognitionImage, setRecognitionImage] = useState('');
  const [recognitionName, setRecognitionName] = useState('');
  const [recognitionImageRequestId, setRecognitionImageRequestId] = useState('');
  const recognitionImageRequestRef = useRef('');
  const recognitionImportRevision = useRef(0);
  // The backend owns what is running and what came back last, so this page, the settings tab and the
  // overlay window all render the same run whichever surface started it.
  const recognitionSettings = overlay.recognitionSettings;
  const recognitionResult = overlay.recognitionResult;
  const recognitionPending = overlay.recognitionPending;
  // The subpage slides over the catalogue and slides back out before it unmounts, so the exit is a
  // transition and the table is the surface behind it the whole way.
  const openRecognitionPage = useCallback(() => {
    if (recognitionLeaveTimer.current) clearTimeout(recognitionLeaveTimer.current);
    recognitionLeaveTimer.current = null;
    setRecognitionLeaving(false);
    setRecognitionPage(true);
  }, []);
  useEffect(() => {
    if (openRecognitionRequest > 0) openRecognitionPage();
  }, [openRecognitionRequest, openRecognitionPage]);
  const closeRecognitionPage = () => {
    if (!recognitionPage || recognitionLeaving) return;
    setRecognitionLeaving(true);
    recognitionLeaveTimer.current = setTimeout(() => {
      recognitionLeaveTimer.current = null;
      setRecognitionLeaving(false);
      setRecognitionPage(false);
    }, recognitionSlideMs);
  };
  useEffect(
    () => () => {
      if (recognitionLeaveTimer.current) clearTimeout(recognitionLeaveTimer.current);
    },
    [],
  );
  const [scrollHeight, setScrollHeight] = useState(520);
  const [refreshing, setRefreshing] = useState(false);
  const [tableNode, setTableNode] = useState<HTMLDivElement | null>(null);
  const reportedRun = useRef<string | undefined>(undefined);

  const startUpdate = useCallback(
    (includeImages = false) => {
      setDialog('update');
      void store
        .dispatch(api.endpoints.updateItems.initiate({ includeImages }))
        .unwrap()
        .catch((reason: unknown) => {
          notices.push(t(errorKeyOf(reason, 'errors.request_failed') as LocaleKey));
        });
    },
    [t],
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setRefreshing(catalogQuery.isFetching);
  }, [catalogQuery.isFetching]);

  useEffect(() => {
    if (catalogQuery.isError || settingsQuery.isError) {
      notices.push(t('errors.items_settings_invalid'));
      setLoadError(new DataLoadError('errors.items_not_available', 'items'));
    } else if (catalog && settings) {
      setLoadError(null);
    }
  }, [
    catalogQuery.isError,
    settingsQuery.isError,
    catalog,
    settings,
    overlay.connected,
    overlay.hasConnected,
    t,
  ]);

  useEffect(() => {
    if (!settings || settingsDraft) return;
    setCategory(settings.category || '');
    setSort(settings.sort || 'id');
    setDescending(settings.descending);
  }, [settings, settingsDraft]);

  // A failed background update is not tied to a control the page can put a message next to, so it
  // reports through the shared notice pipeline with a retry. The raw backend detail stays out of
  // the notice: it is untranslated diagnostics, kept for the update dialog and the log file.
  useEffect(() => {
    if (status.running || !status.error || status.error === 'cancelled') return;
    const run = status.finishedAt ?? status.errorDetail;
    if (reportedRun.current === run) return;
    reportedRun.current = run;
    notices.push(t('items.updateFailedNotice'), () => void startUpdate(status.includeImages));
  }, [status, t, startUpdate]);

  // The virtual window is measured from the live table box. Using the node itself as the dependency
  // re-measures when the recognition subpage replaces the table and the same table comes back, and
  // it keeps the recorded scroll offset in step with the node the offset belongs to.
  useEffect(() => {
    if (!tableNode) return;
    setScrollTop(tableNode.scrollTop);
    const updateHeight = () => {
      if (tableNode.clientHeight > 0)
        setScrollHeight(Math.max(0, tableNode.clientHeight - headerHeight));
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(tableNode);
    return () => observer.disconnect();
  }, [catalog, tableNode]);

  const visible = useMemo(
    () => sortItems(filterItems(catalog?.items || [], query, category), sort, descending),
    [catalog, category, descending, query, sort],
  );
  const virtual = useVirtualList(visible, scrollTop, scrollHeight, rowHeight);

  const saveSettings = (changes: Partial<ItemsSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...changes };
    store.dispatch(setItemsSettingsDraft(next));
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
  const resetTableScroll = () => {
    if (tableNode) tableNode.scrollTop = 0;
    setScrollTop(0);
  };
  const changeCategory = (next: string) => {
    if (next !== category) resetTableScroll();
    setCategory(next);
    saveSettings({ category: next });
  };
  const cancelUpdate = () => {
    void store
      .dispatch(api.endpoints.cancelItemsUpdate.initiate())
      .unwrap()
      .catch(() => notices.push(t('errors.request_failed')));
  };

  // The recognition endpoints answer with contract error codes; the ones a reader can act on get
  // their own sentence instead of the generic failure.
  const recognitionErrorKey = (reason: unknown) => {
    const code = errorKeyOf(reason, '');
    if (code === 'errors.overlay_unavailable') return 'errors.recognition_unavailable';
    if (
      code === 'errors.recognition_request_invalid' ||
      code === 'errors.recognition_result_invalid'
    )
      return 'errors.recognition_request_invalid';
    return code || 'errors.request_failed';
  };
  const saveRecognition = (changes: Partial<RecognitionSettings>) => {
    // One implementation for the rail and the settings tab, so a rejected save behaves the same there.
    overlay.saveRecognitionSettings(changes);
  };
  const clearRecognition = () => {
    recognitionImportRevision.current++;
    setRecognitionImage('');
    setRecognitionName('');
    setRecognitionImageRequestId('');
    recognitionImageRequestRef.current = '';
    overlay.clearRecognition();
  };
  const importRecognition = (file: File) => {
    const importRevision = ++recognitionImportRevision.current;
    setRecognitionName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (importRevision !== recognitionImportRevision.current) return;
      const data = String(reader.result || '');
      const requestId = crypto.randomUUID();
      setRecognitionImage(data);
      setRecognitionImageRequestId(requestId);
      recognitionImageRequestRef.current = requestId;
      overlay.requestRecognition(requestId);
      void store
        .dispatch(api.endpoints.startRecognition.initiate({ requestId, imageData: data }))
        .unwrap()
        .catch((reason: unknown) => {
          // Nothing is pending once the request is refused; the notice says why.
          if (recognitionImageRequestRef.current === requestId) {
            setRecognitionImage('');
            setRecognitionName('');
            setRecognitionImageRequestId('');
            recognitionImageRequestRef.current = '';
            overlay.clearRecognition(requestId);
          }
          const message = t(recognitionErrorKey(reason) as LocaleKey);
          notices.push(message);
          reportClientLog('recognition_request_failed', message, errorDetailOf(reason));
        });
    };
    reader.onerror = () => {
      if (importRevision !== recognitionImportRevision.current) return;
      const message = t('errors.request_failed');
      notices.push(message);
      reportClientLog(
        'recognition_import_failed',
        message,
        reader.error ? errorDetailOf(reader.error) : '',
      );
    };
    reader.readAsDataURL(file);
  };

  // Rendering the failure instead of handling it locally lets the module's error boundary take
  // over the whole page with the shared error state.
  if (overlay.hasConnected && !overlay.connected)
    throw new DataLoadError('errors.request_failed', 'items');
  if (loadError) throw loadError;

  return (
    <section className={`items-page${recognitionPage ? ' is-recognizing' : ''}`}>
      <div className="items-toolbar">
        <label className="items-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={t('items.search')}
            value={search}
            onChange={(event) => {
              if (event.target.value !== search) resetTableScroll();
              setSearch(event.target.value);
            }}
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
        <button type="button" className="items-recognition" onClick={openRecognitionPage}>
          <span className="items-recognition-badge">
            <ScanLine size={18} aria-hidden="true" />
          </span>
          <span className="items-recognition-label">
            <b>{t('recognition.title')}</b>
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
            {t(`data.category.${value}`)}
          </button>
        ))}
      </div>
      {catalog ? (
        <div
          className={`items-table-wrap${refreshing ? ' is-refreshing' : ''}`}
          aria-busy={refreshing}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          ref={setTableNode}
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
      {recognitionPage && (
        <div className={`items-recognition-view${recognitionLeaving ? ' is-leaving' : ''}`}>
          <RecognitionPage
            t={t}
            // The result knows the image it was made from, so a hotkey capture mirrored into this
            // page still shows the picture it came from.
            image={
              recognitionResult && recognitionResult.requestId !== recognitionImageRequestId
                ? recognitionResult.imageData
                : recognitionImage || recognitionResult?.imageData || ''
            }
            imageName={
              recognitionResult && recognitionResult.requestId !== recognitionImageRequestId
                ? ''
                : recognitionName
            }
            result={recognitionResult}
            pending={recognitionPending}
            settings={recognitionSettings}
            onBack={closeRecognitionPage}
            onImport={importRecognition}
            onSettings={saveRecognition}
            onClear={clearRecognition}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}
    </section>
  );
}

function RecognitionPage({
  t,
  image,
  imageName,
  result,
  pending,
  settings,
  onBack,
  onImport,
  onSettings,
  onClear,
  onOpenSettings,
}: {
  t: Translate;
  image: string;
  imageName: string;
  result?: RecognitionResult;
  pending: boolean;
  settings?: RecognitionSettings;
  onBack: () => void;
  onImport: (file: File) => void;
  onSettings: (changes: Partial<RecognitionSettings>) => void;
  onClear: () => void;
  onOpenSettings: () => void;
}) {
  const ocrText = result?.ocrText.join(' / ') ?? '';
  const rows = result?.rows ?? [];
  // The label only carries states the reader has to act on: waiting is the import hint's job,
  // running is the mask's, and a finished import is announced by its notice.
  const status = result?.error
    ? t('recognition.failed')
    : result && rows.length === 0
      ? t('recognition.noMatches')
      : '';

  return (
    <section className="items-page">
      <div className="items-toolbar items-recognition-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label={t('common.back')}
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="items-recognition-title">{t('recognition.title')}</h2>
        <button
          type="button"
          className="items-recognition-clear"
          onClick={onClear}
          disabled={!image && !result}
        >
          <Eraser size={15} aria-hidden="true" />
          {t('recognition.clear')}
        </button>
      </div>
      <div className="items-recognition-grid">
        {/* The preview is the import control: the file input stays reachable by keyboard, the whole
            box is the pointer target. */}
        <label
          className={`items-recognition-preview${image ? ' is-filled' : ''}`}
          title={t('recognition.import')}
        >
          <input
            type="file"
            accept="image/*"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.currentTarget.value = '';
            }}
          />
          <span className="items-recognition-frame">
            {image ? (
              <img src={image} alt={imageName} />
            ) : (
              <>
                <ImagePlus size={30} aria-hidden="true" />
                <span>{t('recognition.previewEmpty')}</span>
              </>
            )}
          </span>
          <span className="items-recognition-filename" title={imageName || undefined}>
            {imageName || (image ? '' : t('recognition.previewFormats'))}
          </span>
        </label>
        <div className="items-recognition-output">
          {pending && (
            <div className="items-recognition-loading" role="status">
              <LoaderCircle className="items-spin" size={22} aria-hidden="true" />
              {t('recognition.working')}
            </div>
          )}
          <div className="items-recognition-heading">
            <h3>{t('recognition.ocrText')}</h3>
            {status && (
              <span className={result?.error ? 'is-error' : undefined} role="status">
                {status}
              </span>
            )}
          </div>
          <p className="items-recognition-text">{ocrText || '—'}</p>
          <h3>{t('recognition.results')}</h3>
          <div className="items-recognition-results">
            <div className="items-recognition-result is-head">
              <span />
              <span>{t('items.name')}</span>
              <span>{t('items.trader')}</span>
              <span>{t('items.flea')}</span>
            </div>
            {rows.map((row) => (
              <div className="items-recognition-result" key={row.id}>
                <span className="item-image">
                  {row.image ? <img src={row.image} alt="" loading="lazy" /> : <Image size={18} />}
                </span>
                <span
                  className="item-name"
                  title={
                    row.templateConfidence > 0
                      ? `${row.name} · ${t('recognition.templateSimilarity')} ${row.templateConfidence.toFixed(2)}`
                      : row.name
                  }
                >
                  {row.name}
                </span>
                <span className="items-recognition-price">
                  {row.trader?.image ? (
                    <img className="items-recognition-avatar" src={row.trader.image} alt="" />
                  ) : null}
                  {formatPrice(row.traderPrice)}
                </span>
                <span className="items-recognition-price">{formatPrice(row.fleaPrice)}</span>
              </div>
            ))}
            {rows.length === 0 && <p className="items-recognition-empty">—</p>}
          </div>
        </div>
        <div className="items-recognition-settings">
          <div className="items-recognition-settings-head">
            <h3 className="items-recognition-settings-title">{t('recognition.settings')}</h3>
          </div>
          {settings && (
            <>
              <RecognitionTuningFields settings={settings} onChange={onSettings} />
              <button
                type="button"
                className="items-recognition-detailed"
                title={t('recognition.detailedHint')}
                onClick={onOpenSettings}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                {t('recognition.detailed')}
              </button>
            </>
          )}
        </div>
      </div>
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
          resource: t(`data.resource.${downloadSteps[Math.max(0, downloading)].id}`, {
            defaultValue: status.detail,
          }),
        })
      : t(`data.phaseDetail.${status.phase}`, { defaultValue: '' })
    : status.error
      ? status.error === 'cancelled'
        ? t('items.cancelledDescription')
        : t('items.updateFailedDescription')
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
            {recognition ? t('recognition.title') : t('items.updateTitle')}
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
            <strong>{t('recognition.title')}</strong>
            <p>{t('recognition.placeholder')}</p>
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
                {!status.running &&
                  status.error &&
                  status.error !== 'cancelled' &&
                  status.errorDetail && (
                    <small className="items-dialog-error-detail">
                      {t('items.errorDetail')}: {status.errorDetail}
                    </small>
                  )}
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
                      <b className={active ? 'is-active' : ''}>{t(`data.phase.${phase}`)}</b>
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
                              {t(`data.resource.${step.id}`)}
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
