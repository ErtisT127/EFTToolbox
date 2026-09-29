import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type {
  Annotations,
  CalibratorPreferences,
  CalibrationDocument,
  ItemsCatalog,
  ItemsSettings,
  ItemsUpdateStatus,
  MapData,
  MapSummary,
  MarkerPreferences,
  MultiplayerSettings,
  MultiplayerStatus,
  MultiplayerHostRequest,
  MultiplayerJoinRequest,
  MultiplayerKickRequest,
  MobileInterfaces,
  MobileStartRequest,
  MobileStatus,
  StunServerList,
  StunProbeRequest,
  StunProbeResults,
  NatCheckResult,
  ManualPositionUpdate,
  OverlayCommand,
  OverlaySettings,
  GameMonitorSettings,
  GameMonitorStatus,
  Preferences,
  RecognitionSettings,
  RecognitionRequest,
  Sticker,
  UserSettings,
} from '../../../contracts/ts/ipc.gen';

export type Versioned<T> = { value: T; revision: string; etag: string };
export type RevisionConflict = { code: 'revision_conflict'; currentRevision?: string };

export function isRevisionConflict(error: unknown) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 'REVISION_CONFLICT'
  );
}

const rawBaseQuery = fetchBaseQuery({
  baseUrl: typeof window === 'undefined' ? 'http://localhost/api' : '/api',
});

export const api = createApi({
  reducerPath: 'api',
  baseQuery: async (args, api, extra) => {
    const result = await rawBaseQuery(args, api, extra);
    if ('error' in result) {
      const errorData = result.error?.data;
      if (
        result.error?.status === 409 &&
        errorData &&
        typeof errorData === 'object' &&
        'code' in errorData &&
        errorData.code === 'revision_conflict'
      ) {
        return {
          error: {
            status: 'REVISION_CONFLICT',
            data: {
              code: 'revision_conflict',
              currentRevision: result.meta?.response?.headers.get('X-Revision') || undefined,
            } satisfies RevisionConflict,
          },
        };
      }
      return result;
    }
    const response = result.meta?.response;
    if (response?.headers.has('X-Revision')) {
      return {
        data: {
          value: result.data,
          revision: response.headers.get('X-Revision') || '',
          etag: response.headers.get('ETag') || '',
        },
        meta: result.meta,
      };
    }
    return result;
  },
  tagTypes: [
    'Maps',
    'Map',
    'Stickers',
    'Items',
    'ItemsStatus',
    'Preferences',
    'Annotations',
    'Settings',
    'Calibration',
    'Multiplayer',
    'Cast',
    'Stun',
  ],
  endpoints: (build) => ({
    getMapCatalog: build.query<MapSummary[], string>({
      query: (locale) => `maps?locale=${encodeURIComponent(locale)}`,
      providesTags: ['Maps'],
    }),
    getMap: build.query<MapData, { id: string; locale: string }>({
      query: ({ id, locale }) =>
        `maps/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`,
      providesTags: (_value, _error, { id }) => [{ type: 'Map', id }],
    }),
    getStickers: build.query<Sticker[], void>({
      query: () => 'stickers',
      providesTags: ['Stickers'],
    }),
    getItems: build.query<ItemsCatalog, string>({
      query: (locale) => `items?locale=${encodeURIComponent(locale)}`,
      providesTags: ['Items'],
    }),
    getItemsUpdateStatus: build.query<ItemsUpdateStatus, void>({
      query: () => 'items/update',
      providesTags: ['ItemsStatus'],
    }),
    getUserSettings: build.query<Versioned<UserSettings>, void>({
      query: () => 'user-settings',
      providesTags: ['Settings'],
    }),
    getOverlaySettings: build.query<Versioned<OverlaySettings>, void>({
      query: () => 'overlay-settings',
      providesTags: ['Settings'],
    }),
    updateOverlaySettings: build.mutation<Versioned<OverlaySettings>, Versioned<OverlaySettings>>({
      query: ({ value, revision }) => ({
        url: 'overlay-settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Settings'],
    }),
    getRecognitionSettings: build.query<Versioned<RecognitionSettings>, void>({
      query: () => 'recognition-settings',
      providesTags: ['Settings'],
    }),
    updateRecognitionSettings: build.mutation<
      Versioned<RecognitionSettings>,
      Versioned<RecognitionSettings>
    >({
      query: ({ value, revision }) => ({
        url: 'recognition-settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Settings'],
    }),
    getGameMonitorSettings: build.query<Versioned<GameMonitorSettings>, void>({
      query: () => 'game-monitor/settings',
      providesTags: ['Settings'],
    }),
    getGameMonitorStatus: build.query<GameMonitorStatus, void>({
      query: () => 'game-monitor/status',
      providesTags: ['Settings'],
    }),
    updateGameMonitorSettings: build.mutation<
      Versioned<GameMonitorSettings>,
      Versioned<GameMonitorSettings>
    >({
      query: ({ value, revision }) => ({
        url: 'game-monitor/settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Settings'],
    }),
    browseGameMonitorDirectory: build.mutation<string | { path?: string }, 'screenshots' | 'logs'>({
      query: (kind) => ({ url: `game-monitor/browse/${kind}`, method: 'POST' }),
    }),
    updateUserSettings: build.mutation<Versioned<UserSettings>, Versioned<UserSettings>>({
      query: ({ value, revision }) => ({
        url: 'user-settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Settings'],
    }),
    resetUserSettings: build.mutation<Versioned<UserSettings>, void>({
      query: () => ({ url: 'data/reset-user-settings', method: 'POST' }),
      invalidatesTags: ['Settings'],
    }),
    getMapPreferences: build.query<Versioned<Preferences>, void>({
      query: () => 'map-preferences',
      transformResponse: (result: Versioned<Preferences>) => ({
        ...result,
        value: {
          ...result.value,
          maps: (result.value.maps || []).map((preference) => ({
            ...preference,
            hiddenCategories: preference.hiddenCategories || [],
            collapsedGroups: preference.collapsedGroups || [],
            selectedTasks: preference.selectedTasks || [],
            center: preference.center || [],
          })),
          stickerUsage: result.value.stickerUsage || [],
        },
      }),
      providesTags: ['Preferences'],
    }),
    updateMapPreferences: build.mutation<Versioned<Preferences>, Versioned<Preferences>>({
      query: ({ value, revision }) => ({
        url: 'map-preferences',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Preferences'],
    }),
    getMarkerPreferences: build.query<Versioned<MarkerPreferences>, void>({
      query: () => 'marker-preferences',
      providesTags: ['Preferences'],
    }),
    updateMarkerPreferences: build.mutation<
      Versioned<MarkerPreferences>,
      Versioned<MarkerPreferences>
    >({
      query: ({ value, revision }) => ({
        url: 'marker-preferences',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Preferences'],
    }),
    getItemsSettings: build.query<Versioned<ItemsSettings>, void>({
      query: () => 'items-settings',
      providesTags: ['Settings'],
    }),
    updateItemsSettings: build.mutation<Versioned<ItemsSettings>, Versioned<ItemsSettings>>({
      query: ({ value, revision }) => ({
        url: 'items-settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Settings'],
    }),
    getCalibrationPreferences: build.query<Versioned<CalibratorPreferences>, void>({
      query: () => 'calibration-preferences',
      transformResponse: (result: Versioned<CalibratorPreferences>) => ({
        ...result,
        value: {
          ...result.value,
          collapsedMaps: result.value.collapsedMaps || [],
          collapsedFloors: result.value.collapsedFloors || [],
        },
      }),
      providesTags: ['Calibration'],
    }),
    updateCalibrationPreferences: build.mutation<
      Versioned<CalibratorPreferences>,
      Versioned<CalibratorPreferences>
    >({
      query: ({ value, revision }) => ({
        url: 'calibration-preferences',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Calibration'],
    }),
    getCalibration: build.query<Versioned<CalibrationDocument>, { id: string; basemap: string }>({
      query: ({ id, basemap }) => `maps/${encodeURIComponent(id)}/calibration?basemap=${basemap}`,
      providesTags: (_value, _error, { id, basemap }) => [
        { type: 'Calibration', id: `${id}:${basemap}` },
      ],
    }),
    updateCalibration: build.mutation<
      Versioned<CalibrationDocument>,
      Versioned<CalibrationDocument>
    >({
      query: ({ value, revision }) => ({
        url: `maps/${encodeURIComponent(value.mapId)}/calibration?basemap=${value.basemap}`,
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: (_value, _error, { value }) => [
        { type: 'Calibration', id: `${value.mapId}:${value.basemap}` },
      ],
    }),
    getAnnotations: build.query<Versioned<Annotations>, string>({
      query: (id) => `maps/${encodeURIComponent(id)}/annotations`,
      providesTags: (_value, _error, id) => [{ type: 'Annotations', id }],
    }),
    updateAnnotations: build.mutation<
      Versioned<Annotations>,
      { id: string; value: Annotations; revision: string }
    >({
      query: ({ id, value, revision }) => ({
        url: `maps/${encodeURIComponent(id)}/annotations`,
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: (_value, _error, { id }) => [{ type: 'Annotations', id }],
    }),
    getMultiplayerSettings: build.query<Versioned<MultiplayerSettings>, void>({
      query: () => 'multiplayer/settings',
      providesTags: ['Multiplayer'],
    }),
    updateMultiplayerSettings: build.mutation<
      Versioned<MultiplayerSettings>,
      Versioned<MultiplayerSettings>
    >({
      query: ({ value, revision }) => ({
        url: 'multiplayer/settings',
        method: 'PUT',
        headers: { 'If-Match': revision },
        body: value,
      }),
      invalidatesTags: ['Multiplayer'],
    }),
    getMultiplayerStatus: build.query<MultiplayerStatus, void>({
      query: () => 'multiplayer/status',
      providesTags: ['Multiplayer'],
    }),
    getMultiplayerInterfaces: build.query<MobileInterfaces, void>({
      query: () => 'multiplayer/interfaces',
    }),
    hostMultiplayer: build.mutation<MultiplayerStatus, MultiplayerHostRequest>({
      query: (body) => ({ url: 'multiplayer/host', method: 'POST', body }),
      invalidatesTags: ['Multiplayer'],
    }),
    joinMultiplayer: build.mutation<MultiplayerStatus, MultiplayerJoinRequest>({
      query: (body) => ({ url: 'multiplayer/join', method: 'POST', body }),
      invalidatesTags: ['Multiplayer'],
    }),
    leaveMultiplayer: build.mutation<MultiplayerStatus, void>({
      query: () => ({ url: 'multiplayer/leave', method: 'POST' }),
      invalidatesTags: ['Multiplayer'],
    }),
    kickMultiplayerPeer: build.mutation<MultiplayerStatus, MultiplayerKickRequest>({
      query: (body) => ({ url: 'multiplayer/kick', method: 'POST', body }),
      invalidatesTags: ['Multiplayer'],
    }),
    updateItems: build.mutation<ItemsUpdateStatus, { includeImages: boolean }>({
      query: (body) => ({ url: 'items/update', method: 'POST', body }),
      invalidatesTags: ['Items', 'ItemsStatus'],
    }),
    cancelItemsUpdate: build.mutation<ItemsUpdateStatus, void>({
      query: () => ({ url: 'items/update/cancel', method: 'POST' }),
      invalidatesTags: ['ItemsStatus'],
    }),
    getCastStatus: build.query<MobileStatus, void>({
      query: () => 'cast/status',
      providesTags: ['Cast'],
    }),
    getCastInterfaces: build.query<MobileInterfaces, void>({ query: () => 'cast/interfaces' }),
    startCast: build.mutation<MobileStatus, MobileStartRequest>({
      query: (body) => ({ url: 'cast/start', method: 'POST', body }),
      invalidatesTags: ['Cast'],
    }),
    stopCast: build.mutation<MobileStatus, void>({
      query: () => ({ url: 'cast/stop', method: 'POST' }),
      invalidatesTags: ['Cast'],
    }),
    getStunServers: build.query<StunServerList, void>({
      query: () => 'multiplayer/stun/servers',
      providesTags: ['Stun'],
    }),
    probeStunServers: build.mutation<StunProbeResults, StunProbeRequest>({
      query: (body) => ({ url: 'multiplayer/stun/probe', method: 'POST', body }),
    }),
    refreshStunServers: build.mutation<StunServerList, void>({
      query: () => ({ url: 'multiplayer/stun/refresh', method: 'POST' }),
      invalidatesTags: ['Stun'],
    }),
    checkNat: build.mutation<NatCheckResult, void>({
      query: () => ({ url: 'multiplayer/nat-check', method: 'POST' }),
    }),
    updateGameMonitorPosition: build.mutation<void, ManualPositionUpdate>({
      query: (body) => ({
        url: 'game-monitor/position',
        method: 'POST',
        body,
        responseHandler: async () => undefined,
      }),
      invalidatesTags: ['Settings'],
    }),
    sendOverlayCommand: build.mutation<void, OverlayCommand>({
      query: (body) => ({
        url: 'overlay/command',
        method: 'POST',
        body,
        responseHandler: async () => undefined,
      }),
    }),
    openDataDirectory: build.mutation<void, 'data' | 'user-settings'>({
      query: (kind) => ({
        url: kind === 'data' ? 'data/open' : 'data/open-user-settings',
        method: 'GET',
        responseHandler: async () => undefined,
      }),
    }),
    clearRecognitionResult: build.mutation<void, string | undefined>({
      query: (requestId) => ({
        url: `recognition-result${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ''}`,
        method: 'DELETE',
        responseHandler: async () => undefined,
      }),
    }),
    startRecognition: build.mutation<RecognitionRequest, RecognitionRequest>({
      query: (body) => ({ url: 'recognition/request', method: 'POST', body }),
    }),
    resetData: build.mutation<{ ok: boolean }, string>({
      query: (kind) => ({
        url: kind === 'calibration' ? 'data/reset-calibration' : `data/reset/${kind}`,
        method: 'POST',
      }),
      invalidatesTags: ['Preferences', 'Annotations', 'Calibration', 'Settings', 'Multiplayer'],
    }),
  }),
});

export const {
  useGetMapCatalogQuery,
  useGetMapQuery,
  useGetStickersQuery,
  useGetItemsQuery,
  useGetItemsUpdateStatusQuery,
  useGetUserSettingsQuery,
  useUpdateUserSettingsMutation,
  useResetUserSettingsMutation,
  useGetOverlaySettingsQuery,
  useUpdateOverlaySettingsMutation,
  useGetRecognitionSettingsQuery,
  useUpdateRecognitionSettingsMutation,
  useGetGameMonitorSettingsQuery,
  useGetGameMonitorStatusQuery,
  useUpdateGameMonitorSettingsMutation,
  useBrowseGameMonitorDirectoryMutation,
  useGetMapPreferencesQuery,
  useUpdateMapPreferencesMutation,
  useGetMarkerPreferencesQuery,
  useUpdateMarkerPreferencesMutation,
  useGetItemsSettingsQuery,
  useUpdateItemsSettingsMutation,
  useGetCalibrationPreferencesQuery,
  useUpdateCalibrationPreferencesMutation,
  useGetCalibrationQuery,
  useUpdateCalibrationMutation,
  useGetAnnotationsQuery,
  useUpdateAnnotationsMutation,
  useGetMultiplayerSettingsQuery,
  useUpdateMultiplayerSettingsMutation,
  useGetMultiplayerStatusQuery,
  useGetMultiplayerInterfacesQuery,
  useHostMultiplayerMutation,
  useJoinMultiplayerMutation,
  useLeaveMultiplayerMutation,
  useKickMultiplayerPeerMutation,
  useUpdateItemsMutation,
  useCancelItemsUpdateMutation,
  useResetDataMutation,
  useGetCastStatusQuery,
  useGetCastInterfacesQuery,
  useStartCastMutation,
  useStopCastMutation,
  useGetStunServersQuery,
  useProbeStunServersMutation,
  useRefreshStunServersMutation,
  useCheckNatMutation,
  useUpdateGameMonitorPositionMutation,
  useSendOverlayCommandMutation,
  useOpenDataDirectoryMutation,
} = api;
