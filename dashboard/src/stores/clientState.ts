import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  Annotation,
  CalibratorPreferences,
  CalibrationDocument,
  GameMonitorSettings,
  GameMonitorStatus,
  ItemsSettings,
  MarkerPreferences,
  MultiplayerSettings,
  OverlaySettings,
  OverlayView,
  Preferences,
  RecognitionResult,
  RecognitionSettings,
} from '../../../contracts/ts/ipc.gen';

export type ClientNotice = {
  id: number;
  message: string;
  messageKey?: string;
  severity: 'error' | 'warning' | 'success';
};

export type AnnotationSessionState = {
  draft?: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  editRevision: number;
  savedRevision: number;
  saving: boolean;
  error: string;
  pendingSync: boolean;
  conflict: boolean;
};

export type CalibrationEditorState = {
  draft?: CalibrationDocument;
  past: CalibrationDocument[];
  future: CalibrationDocument[];
  editRevision: number;
  savedRevision: number;
  saving: boolean;
  conflict: boolean;
};

export type ConflictResource =
  | 'annotations'
  | 'calibration'
  | 'mapPreferences'
  | 'calibrationPreferences'
  | 'itemsSettings'
  | 'overlaySettings'
  | 'recognitionSettings'
  | 'gameMonitorSettings'
  | 'multiplayerSettings'
  | 'markerPreferences'
  | 'userSettings';

export type ClientConflict = {
  key: string;
  resource: ConflictResource;
  entityId?: string;
};

export type ClientState = {
  notices: ClientNotice[];
  nextNoticeId: number;
  conflicts: ClientConflict[];
  mapPreferencesDraft?: Preferences;
  calibrationPreferencesDraft?: CalibratorPreferences;
  annotations: {
    sessions: Record<string, AnnotationSessionState>;
    activeId: string;
    loading: boolean;
    error: string;
    preferenceError: string;
    calibratorPreferenceError: string;
    savingPreferences: boolean;
    savingCalibratorPreferences: boolean;
  };
  overlay: {
    settingsDraft?: OverlaySettings;
    recognitionSettingsDraft?: RecognitionSettings;
    recognitionResult?: RecognitionResult;
    recognitionPending: boolean;
    recognitionRequestId: string;
    view?: OverlayView;
    connected: boolean;
    error: string;
    loading: boolean;
    calibrationEpoch: number;
    calibrationMapId: string;
    saving: boolean;
  };
  gameMonitor: {
    settingsDraft?: GameMonitorSettings;
    status?: GameMonitorStatus;
    loading: boolean;
    error: string;
    resourceRevision: number;
    mapRevision: number;
    browsing: Record<'screenshots' | 'logs', boolean>;
  };
  multiplayer: {
    settingsDraft?: MultiplayerSettings;
    markerDraft?: MarkerPreferences;
    initialized: boolean;
    loading: boolean;
  };
  itemsSettingsDraft?: ItemsSettings;
  calibrationEditors: Record<string, CalibrationEditorState>;
};

const emptyAnnotationSession = (): AnnotationSessionState => ({
  past: [],
  future: [],
  editRevision: 0,
  savedRevision: 0,
  saving: false,
  error: '',
  pendingSync: false,
  conflict: false,
});

const emptyCalibrationEditor = (): CalibrationEditorState => ({
  past: [],
  future: [],
  editRevision: 0,
  savedRevision: 0,
  saving: false,
  conflict: false,
});

const initialState: ClientState = {
  notices: [],
  nextNoticeId: 0,
  conflicts: [],
  annotations: {
    sessions: {},
    activeId: '',
    loading: true,
    error: '',
    preferenceError: '',
    calibratorPreferenceError: '',
    savingPreferences: false,
    savingCalibratorPreferences: false,
  },
  overlay: {
    recognitionPending: false,
    recognitionRequestId: '',
    connected: false,
    error: '',
    loading: false,
    calibrationEpoch: 0,
    calibrationMapId: '',
    saving: false,
  },
  gameMonitor: {
    loading: false,
    error: '',
    resourceRevision: 0,
    mapRevision: 0,
    browsing: { screenshots: false, logs: false },
  },
  multiplayer: { initialized: false, loading: false },
  calibrationEditors: {},
};

const clientState = createSlice({
  name: 'client',
  initialState,
  reducers: {
    pushNotice(state, action: PayloadAction<Omit<ClientNotice, 'id'>>) {
      const existing = state.notices.find(
        (notice) =>
          (notice.messageKey || notice.message) ===
          (action.payload.messageKey || action.payload.message),
      );
      if (existing) {
        existing.severity = action.payload.severity;
        return;
      }
      state.notices = [...state.notices.slice(-2), { ...action.payload, id: ++state.nextNoticeId }];
    },
    dismissNotice(state, action: PayloadAction<number>) {
      state.notices = state.notices.filter((notice) => notice.id !== action.payload);
    },
    clearNotices(state) {
      state.notices = [];
    },
    setConflict(state, action: PayloadAction<ClientConflict>) {
      const index = state.conflicts.findIndex((item) => item.key === action.payload.key);
      if (index < 0) state.conflicts.push(action.payload);
      else state.conflicts[index] = action.payload;
    },
    clearConflict(state, action: PayloadAction<string>) {
      state.conflicts = state.conflicts.filter((item) => item.key !== action.payload);
    },
    setMapPreferencesDraft(state, action: PayloadAction<Preferences | undefined>) {
      state.mapPreferencesDraft = action.payload;
    },
    setCalibrationPreferencesDraft(
      state,
      action: PayloadAction<CalibratorPreferences | undefined>,
    ) {
      state.calibrationPreferencesDraft = action.payload;
    },
    setWorkspaceState(state, action: PayloadAction<Partial<ClientState['annotations']>>) {
      Object.assign(state.annotations, action.payload);
    },
    ensureAnnotationSession(state, action: PayloadAction<string>) {
      state.annotations.sessions[action.payload] ||= emptyAnnotationSession();
    },
    clearAnnotationSessions(state) {
      state.annotations.sessions = {};
    },
    commitAnnotations(
      state,
      action: PayloadAction<{ id: string; base: Annotation[]; items: Annotation[] }>,
    ) {
      const session = (state.annotations.sessions[action.payload.id] ||= emptyAnnotationSession());
      if (JSON.stringify(action.payload.base) === JSON.stringify(action.payload.items)) return;
      session.past = [...session.past, action.payload.base].slice(-50);
      session.future = [];
      session.draft = action.payload.items;
      session.editRevision++;
      session.error = '';
    },
    undoAnnotations(state, action: PayloadAction<{ id: string; current: Annotation[] }>) {
      const session = state.annotations.sessions[action.payload.id];
      if (!session?.past.length) return;
      session.future = [action.payload.current, ...session.future];
      session.draft = session.past.pop();
      session.editRevision++;
      session.error = '';
    },
    redoAnnotations(state, action: PayloadAction<{ id: string; current: Annotation[] }>) {
      const session = state.annotations.sessions[action.payload.id];
      if (!session?.future.length) return;
      session.past = [...session.past, action.payload.current].slice(-50);
      session.draft = session.future.shift();
      session.editRevision++;
      session.error = '';
    },
    submitAnnotations(_state, _action: PayloadAction<{ id: string; explicit?: boolean }>) {},
    setAnnotationSaveState(
      state,
      action: PayloadAction<{ id: string; changes: Partial<AnnotationSessionState> }>,
    ) {
      const session = (state.annotations.sessions[action.payload.id] ||= emptyAnnotationSession());
      Object.assign(session, action.payload.changes);
    },
    // A successful local save clears only the transient draft so saved edits remain undoable.
    clearAnnotationDraft(state, action: PayloadAction<string>) {
      const session = state.annotations.sessions[action.payload];
      if (!session) return;
      session.draft = undefined;
      session.conflict = false;
      session.error = '';
      session.savedRevision = session.editRevision;
    },
    // Remote replacement or an explicit conflict choice invalidates old snapshots.
    resetAnnotationSession(state, action: PayloadAction<string>) {
      const session = state.annotations.sessions[action.payload];
      if (!session) return;
      session.draft = undefined;
      session.past = [];
      session.future = [];
      session.conflict = false;
      session.error = '';
      session.savedRevision = session.editRevision;
    },
    setOverlayState(state, action: PayloadAction<Partial<ClientState['overlay']>>) {
      Object.assign(state.overlay, action.payload);
    },
    setGameMonitorState(state, action: PayloadAction<Partial<ClientState['gameMonitor']>>) {
      Object.assign(state.gameMonitor, action.payload);
    },
    setMultiplayerState(state, action: PayloadAction<Partial<ClientState['multiplayer']>>) {
      Object.assign(state.multiplayer, action.payload);
    },
    setItemsSettingsDraft(state, action: PayloadAction<ItemsSettings | undefined>) {
      state.itemsSettingsDraft = action.payload;
    },
    submitItemsSettings() {},
    submitMapPreferences() {},
    submitCalibrationPreferences() {},
    setCalibrationEditorDraft(
      state,
      action: PayloadAction<{
        key: string;
        draft?: CalibrationDocument;
        record?: boolean;
        base?: CalibrationDocument;
      }>,
    ) {
      const editor = (state.calibrationEditors[action.payload.key] ||= emptyCalibrationEditor());
      if (action.payload.record) {
        const previous = editor.draft || action.payload.base;
        if (previous) editor.past = [...editor.past, previous].slice(-50);
      }
      if (action.payload.record) editor.future = [];
      editor.draft = action.payload.draft;
      editor.editRevision++;
    },
    setCalibrationEditorHistory(
      state,
      action: PayloadAction<{
        key: string;
        past: CalibrationDocument[];
        future: CalibrationDocument[];
      }>,
    ) {
      const editor = (state.calibrationEditors[action.payload.key] ||= emptyCalibrationEditor());
      editor.past = action.payload.past;
      editor.future = action.payload.future;
    },
    setCalibrationEditorSaveState(
      state,
      action: PayloadAction<{ key: string; changes: Partial<CalibrationEditorState> }>,
    ) {
      const editor = (state.calibrationEditors[action.payload.key] ||= emptyCalibrationEditor());
      Object.assign(editor, action.payload.changes);
    },
    clearCalibrationEditor(state, action: PayloadAction<string>) {
      delete state.calibrationEditors[action.payload];
    },
    // Clears the working draft after a save or a context switch while keeping the undo history:
    // wiping past/future here made the undo stack empty itself before the user could ever use it.
    clearCalibrationEditorDraft(state, action: PayloadAction<string>) {
      const editor = state.calibrationEditors[action.payload];
      if (!editor) return;
      editor.draft = undefined;
      editor.savedRevision = editor.editRevision;
    },
  },
});

export const {
  pushNotice,
  dismissNotice,
  clearNotices,
  setConflict,
  clearConflict,
  setMapPreferencesDraft,
  setCalibrationPreferencesDraft,
  setWorkspaceState,
  ensureAnnotationSession,
  clearAnnotationSessions,
  commitAnnotations,
  undoAnnotations,
  redoAnnotations,
  submitAnnotations,
  setAnnotationSaveState,
  clearAnnotationDraft,
  resetAnnotationSession,
  setOverlayState,
  setGameMonitorState,
  setMultiplayerState,
  setItemsSettingsDraft,
  submitItemsSettings,
  submitMapPreferences,
  submitCalibrationPreferences,
  setCalibrationEditorDraft,
  setCalibrationEditorHistory,
  setCalibrationEditorSaveState,
  clearCalibrationEditor,
  clearCalibrationEditorDraft,
} = clientState.actions;
export const clientReducer = clientState.reducer;
