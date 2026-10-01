import { configureStore, createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import { api, isRevisionConflict } from './api.ts';
import {
  clearAnnotationDraft,
  clearConflict,
  clientReducer,
  commitAnnotations,
  pushNotice,
  redoAnnotations,
  resetAnnotationSession,
  setAnnotationSaveState,
  setConflict,
  setItemsSettingsDraft,
  setMapPreferencesDraft,
  setCalibrationPreferencesDraft,
  setWorkspaceState,
  submitAnnotations,
  submitItemsSettings,
  submitMapPreferences,
  submitCalibrationPreferences,
  undoAnnotations,
} from './clientState.ts';
import {
  ContractSchemaVersion,
  type CalibratorPreferences,
  type ItemsSettings,
  type Preferences,
} from '../../../contracts/ts/ipc.gen.ts';

const listener = createListenerMiddleware();
let itemsSaveQueue = Promise.resolve();
let preferencesSaveQueue = Promise.resolve();
const annotationSaveQueues = new Map<string, Promise<void>>();
const debounceGeneration: Record<'items' | 'mapPreferences' | 'calibrationPreferences', number> = {
  items: 0,
  mapPreferences: 0,
  calibrationPreferences: 0,
};

const saveItemsSettings = async (
  value: ItemsSettings,
  getState: () => RootState,
  dispatch: AppDispatch,
) => {
  const current = api.endpoints.getItemsSettings.select()(getState()).data;
  if (!current) return;
  const saved = await dispatch(
    api.endpoints.updateItemsSettings.initiate({
      value,
      revision: current.revision,
      etag: current.etag,
    }),
  ).unwrap();
  dispatch(api.util.updateQueryData('getItemsSettings', undefined, () => saved));
  const latest = getState().client.itemsSettingsDraft;
  if (JSON.stringify(latest) === JSON.stringify(value)) {
    dispatch(setItemsSettingsDraft(undefined));
    dispatch(clearConflict('items-settings'));
  }
};

const saveAnnotations = async (id: string, getState: () => RootState, dispatch: AppDispatch) => {
  const session = getState().client.annotations.sessions[id];
  const current = api.endpoints.getAnnotations.select(id)(getState()).data;
  if (!session?.draft || !current || session.savedRevision >= session.editRevision) return;
  const editRevision = session.editRevision;
  dispatch(setAnnotationSaveState({ id, changes: { saving: true, error: '' } }));
  try {
    const saved = await dispatch(
      api.endpoints.updateAnnotations.initiate({
        id,
        value: { schemaVersion: ContractSchemaVersion, items: session.draft },
        revision: current.revision,
      }),
    ).unwrap();
    dispatch(api.util.updateQueryData('getAnnotations', id, () => saved));
    const latest = getState().client.annotations.sessions[id];
    dispatch(
      setAnnotationSaveState({
        id,
        changes: {
          conflict: false,
          savedRevision: editRevision,
          ...(latest?.editRevision === editRevision ? { draft: undefined } : {}),
        },
      }),
    );
    if (latest?.editRevision === editRevision) dispatch(clearAnnotationDraft(id));
    const settled = getState().client.annotations.sessions[id];
    if (settled?.pendingSync && settled.savedRevision >= settled.editRevision) {
      dispatch(setAnnotationSaveState({ id, changes: { pendingSync: false } }));
      const beforeRefresh = api.endpoints.getAnnotations.select(id)(getState()).data?.value.items;
      const refreshed = await dispatch(
        api.endpoints.getAnnotations.initiate(id, { forceRefetch: true }),
      ).unwrap();
      const currentSession = getState().client.annotations.sessions[id];
      if (
        currentSession &&
        currentSession.savedRevision >= currentSession.editRevision &&
        refreshed.value.schemaVersion === ContractSchemaVersion &&
        Array.isArray(refreshed.value.items)
      ) {
        if (JSON.stringify(beforeRefresh) === JSON.stringify(refreshed.value.items))
          dispatch(clearAnnotationDraft(id));
        else dispatch(resetAnnotationSession(id));
      }
    }
  } catch (error) {
    const conflict = isRevisionConflict(error);
    dispatch(
      setAnnotationSaveState({
        id,
        changes: {
          conflict,
          error: conflict ? 'errors.revision_conflict' : 'errors.request_failed',
        },
      }),
    );
    if (conflict) {
      dispatch(setConflict({ key: `annotations:${id}`, resource: 'annotations', entityId: id }));
      dispatch(
        pushNotice({ message: '', messageKey: 'errors.revision_conflict', severity: 'error' }),
      );
      void dispatch(api.endpoints.getAnnotations.initiate(id, { forceRefetch: true }));
    } else {
      dispatch(pushNotice({ message: '', messageKey: 'errors.request_failed', severity: 'error' }));
    }
  } finally {
    dispatch(setAnnotationSaveState({ id, changes: { saving: false } }));
  }
};

listener.startListening({
  matcher: isAnyOf(commitAnnotations, undoAnnotations, redoAnnotations, submitAnnotations),
  effect: async (action, apiListener) => {
    const getState = apiListener.getState as () => RootState;
    const dispatch = apiListener.dispatch as AppDispatch;
    const id =
      'payload' in action &&
      typeof action.payload === 'object' &&
      action.payload !== null &&
      'id' in action.payload
        ? String(action.payload.id)
        : '';
    if (!id) return;
    const explicit = submitAnnotations.match(action) && action.payload.explicit === true;
    if (!explicit && getState().client.annotations.sessions[id]?.conflict) return;
    const previous = annotationSaveQueues.get(id) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        if (!explicit && getState().client.annotations.sessions[id]?.conflict) return;
        await saveAnnotations(id, getState, dispatch);
      });
    annotationSaveQueues.set(id, task);
    await task;
    if (annotationSaveQueues.get(id) === task) annotationSaveQueues.delete(id);
  },
});

listener.startListening({
  matcher: isAnyOf(
    setItemsSettingsDraft,
    submitItemsSettings,
    setMapPreferencesDraft,
    submitMapPreferences,
    setCalibrationPreferencesDraft,
    submitCalibrationPreferences,
  ),
  effect: async (action, apiListener) => {
    const getState = apiListener.getState as () => RootState;
    const dispatch = apiListener.dispatch as AppDispatch;
    const items = submitItemsSettings.match(action) || setItemsSettingsDraft.match(action);
    const mapPreferences =
      submitMapPreferences.match(action) || setMapPreferencesDraft.match(action);
    const calibrationPreferences =
      submitCalibrationPreferences.match(action) || setCalibrationPreferencesDraft.match(action);
    const explicit =
      submitItemsSettings.match(action) ||
      submitMapPreferences.match(action) ||
      submitCalibrationPreferences.match(action);
    const debounceKey = items
      ? 'items'
      : mapPreferences
        ? 'mapPreferences'
        : 'calibrationPreferences';
    const generation = ++debounceGeneration[debounceKey];
    if (!explicit) {
      await apiListener.delay(350);
      if (generation !== debounceGeneration[debounceKey]) return;
      const key = items
        ? 'items-settings'
        : mapPreferences
          ? 'map-preferences'
          : 'calibration-preferences';
      if (getState().client.conflicts.some((item) => item.key === key)) return;
    }
    const value = items
      ? getState().client.itemsSettingsDraft
      : mapPreferences
        ? getState().client.mapPreferencesDraft
        : getState().client.calibrationPreferencesDraft;
    if (!value) return;
    const queue = items ? itemsSaveQueue : preferencesSaveQueue;
    const task = queue
      .catch(() => undefined)
      .then(async () => {
        const latest = items
          ? getState().client.itemsSettingsDraft
          : mapPreferences
            ? getState().client.mapPreferencesDraft
            : getState().client.calibrationPreferencesDraft;
        if (!latest) return;
        const key = items
          ? 'items-settings'
          : mapPreferences
            ? 'map-preferences'
            : 'calibration-preferences';
        if (!explicit && getState().client.conflicts.some((item) => item.key === key)) return;
        try {
          if (items) {
            await saveItemsSettings(latest as ItemsSettings, getState, dispatch);
          } else if (mapPreferences) {
            const current = api.endpoints.getMapPreferences.select()(getState()).data;
            if (!current) return;
            const saved = await dispatch(
              api.endpoints.updateMapPreferences.initiate({
                value: latest as Preferences,
                revision: current.revision,
                etag: current.etag,
              }),
            ).unwrap();
            dispatch(api.util.updateQueryData('getMapPreferences', undefined, () => saved));
            if (JSON.stringify(getState().client.mapPreferencesDraft) === JSON.stringify(latest)) {
              dispatch(setMapPreferencesDraft(undefined));
              dispatch(clearConflict('map-preferences'));
              dispatch(setWorkspaceState({ preferenceError: '' }));
            }
          } else {
            const current = api.endpoints.getCalibrationPreferences.select()(getState()).data;
            if (!current) return;
            const saved = await dispatch(
              api.endpoints.updateCalibrationPreferences.initiate({
                value: latest as CalibratorPreferences,
                revision: current.revision,
                etag: current.etag,
              }),
            ).unwrap();
            dispatch(api.util.updateQueryData('getCalibrationPreferences', undefined, () => saved));
            if (
              JSON.stringify(getState().client.calibrationPreferencesDraft) ===
              JSON.stringify(latest)
            ) {
              dispatch(setCalibrationPreferencesDraft(undefined));
              dispatch(clearConflict('calibration-preferences'));
              dispatch(setWorkspaceState({ calibratorPreferenceError: '' }));
            }
          }
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'status' in error &&
            error.status === 'REVISION_CONFLICT'
          ) {
            const resource = items
              ? 'itemsSettings'
              : mapPreferences
                ? 'mapPreferences'
                : 'calibrationPreferences';
            dispatch(setConflict({ key, resource }));
            dispatch(
              setWorkspaceState(
                mapPreferences
                  ? { preferenceError: 'errors.revision_conflict' }
                  : calibrationPreferences
                    ? { calibratorPreferenceError: 'errors.revision_conflict' }
                    : {},
              ),
            );
            void dispatch(
              (mapPreferences
                ? api.endpoints.getMapPreferences.initiate(undefined, { forceRefetch: true })
                : calibrationPreferences
                  ? api.endpoints.getCalibrationPreferences.initiate(undefined, {
                      forceRefetch: true,
                    })
                  : api.endpoints.getItemsSettings.initiate(undefined, {
                      forceRefetch: true,
                    })) as never,
            );
          } else {
            dispatch(
              setWorkspaceState(
                mapPreferences
                  ? { preferenceError: 'errors.preferences_save_failed' }
                  : calibrationPreferences
                    ? { calibratorPreferenceError: 'errors.preferences_save_failed' }
                    : {},
              ),
            );
            dispatch(
              pushNotice({
                message: '',
                messageKey: items
                  ? 'errors.items_settings_invalid'
                  : 'errors.preferences_save_failed',
                severity: 'error',
              }),
            );
          }
        }
      });
    if (items) itemsSaveQueue = task;
    else preferencesSaveQueue = task;
    await task;
  },
});

export async function waitForAnnotationSaves() {
  await Promise.all(annotationSaveQueues.values());
}

export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer, client: clientReducer },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().prepend(listener.middleware).concat(api.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
