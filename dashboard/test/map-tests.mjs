import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { pixelToWorld, worldToPixel, segmentDistance } from '../src/pages/map/lib/geometry.ts';
import { Workspace, selectableFloors } from '../src/stores/workspaceStore.ts';
import {
  clientReducer,
  commitAnnotations,
  ensureAnnotationSession,
  redoAnnotations,
  undoAnnotations,
} from '../src/stores/clientState.ts';
import { mapTimes, timePhase } from '../src/pages/map/lib/time.ts';
import { SVG_MAX_ZOOM, zoomRange } from '../src/pages/map/lib/zoom.ts';
import {
  isAnnotationVisible,
  nextMarkerPreferences,
  ownerVisibleFor,
  ownerVisibilityFor,
} from '../src/pages/map/lib/visibility.ts';
import { isImeComposing } from '../src/lib/ime.ts';

const root = new URL('../../data/upstream/', import.meta.url);
const assetsRoot = new URL('assets/', root);
const dataRoot = new URL('modes/pvp/', root);
const load = async (name) => JSON.parse(await readFile(new URL(name, dataRoot), 'utf8'));
const catalog = await load('catalog_zh.json');

test('floor options respect basemap availability and never switch basemap implicitly', async () => {
  const data = await load('maps/customs_zh.json');
  const rasterOnly = data.floors.find((f) => !f.svgGroups.length);
  assert.ok(rasterOnly);
  assert.ok(!selectableFloors(data, 'svg').some((f) => f.id === rasterOnly.id));
  assert.ok(selectableFloors(data, 'tiles').some((f) => f.id === rasterOnly.id));
  for (const mode of ['svg', 'tiles'])
    assert.ok(!selectableFloors(data, mode).some((f) => f.id === data.baseFloor));
});

test('daylight icons follow each clock independently at dawn/day/dusk/night boundaries', async () => {
  const { clock } = await load('maps/interchange_zh.json');
  for (const [time, phase] of [
    ['00:00:00', 'night'],
    ['04:59:59', 'night'],
    ['05:00:00', 'dawn'],
    ['05:44:59', 'dawn'],
    ['05:45:00', 'day'],
    ['21:29:59', 'day'],
    ['21:30:00', 'dusk'],
    ['21:49:59', 'dusk'],
    ['21:50:00', 'night'],
    ['23:59:59', 'night'],
  ])
    assert.equal(timePhase(time, clock.phases)?.icon, phase, time);
  assert.deepEqual(
    ['08:00:00', '20:00:00'].map((time) => timePhase(time, clock.phases)?.icon),
    ['day', 'day'],
  );
});

test('tile grid matches upstream world transform for rotated and nonuniform maps', async () => {
  const sources = JSON.parse(await readFile(new URL('source/map-rules.json', root), 'utf8'));
  for (const id of ['factory', 'lab', 'reserve', 'icebreaker', 'the-labyrinth']) {
    const map = await load(`maps/${id}_zh.json`);
    const rule = sources
      .flatMap((s) => s.maps)
      .find((r) => map.tiles.some((t) => t.sourceUrl === r.tilePath));
    assert.ok(rule, `${id}: upstream tile rule`);
    const world = { x: map.projection.bounds[0].x + 13, z: map.projection.bounds[0].z + 21 };
    const p = worldToPixel(world, map.projection);
    const angle = (rule.coordinateRotation * Math.PI) / 180;
    const rx = world.x * Math.cos(angle) - world.z * Math.sin(angle);
    const rz = world.x * Math.sin(angle) + world.z * Math.cos(angle);
    const expected = [
      rule.transform[0] * rx + rule.transform[1],
      -rule.transform[2] * rz + rule.transform[3],
    ];
    for (const tile of map.tiles) {
      const [a, b, c, d] = tile.transform;
      assert.ok(Math.abs(a * p.x + b - expected[0]) < 1e-8, `${id}: tile x`);
      assert.ok(Math.abs(c * p.y + d - expected[1]) < 1e-8, `${id}: tile y`);
    }
  }
});

test('zoom bounds follow each map: one upscale step over native tiles, fit-based floor', async () => {
  const ceilings = new Set();
  for (const summary of catalog) {
    const map = await load(`maps/${summary.id}_zh.json`);
    const wide = zoomRange(map, 1600, 900);
    const narrow = zoomRange(map, 640, 480);
    assert.ok(wide.min < wide.max, `${summary.id}: ${wide.min}..${wide.max}`);
    // Saving a preference rejects zoom outside [-10, 10], so a bound beyond it would break silently.
    assert.ok(wide.max <= 10, summary.id);
    if (map.tiles.length) {
      assert.equal(wide.max, Math.max(...map.tiles.map((t) => t.maxZoom)) + 1, summary.id);
      assert.ok(wide.min <= Math.min(...map.tiles.map((t) => t.minZoom)), summary.id);
    } else {
      assert.equal(wide.max, SVG_MAX_ZOOM, summary.id);
    }
    assert.ok(narrow.min <= wide.min, `${summary.id}: a smaller window must not raise the floor`);
    ceilings.add(wide.max);
  }
  assert.ok(ceilings.size > 1, 'zoom ceiling has to be per map, not one global constant');
});

test('all shipped maps reference real SVG groups and coordinates round-trip', async () => {
  for (const summary of catalog) {
    const map = await load(`maps/${summary.id}_zh.json`);
    const svg = map.svgUrl
      ? await readFile(new URL(map.svgUrl.slice('/api/assets/'.length), assetsRoot), 'utf8')
      : '<svg/>';
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const groups = new Set(
      Array.from(document.getElementsByTagName('g')).map((e) => e.getAttribute('id')),
    );
    for (const floor of map.floors)
      for (const group of floor.svgGroups)
        assert.ok(groups.has(group), `${map.id}: missing ${group}`);
    const [x, y, width, height] = map.projection.viewBox;
    if (map.svgUrl)
      assert.deepEqual(
        document.documentElement.getAttribute('viewBox').split(/[ ,]+/).map(Number),
        map.projection.viewBox,
      );
    for (const floor of map.floors)
      assert.ok(
        floor.svgGroups.length || map.tiles.some((t) => t.floorId === floor.id),
        `${map.id}/${floor.id}: missing basemap`,
      );
    for (const pixel of [
      { x, y },
      { x: x + width, y: y + height },
      { x: x + width * 0.37, y: y + height * 0.61 },
    ]) {
      const result = worldToPixel(pixelToWorld(pixel, map.projection), map.projection);
      assert.ok(
        Math.hypot(result.x - pixel.x, result.y - pixel.y) < 1e-8,
        `${map.id}: projection round-trip`,
      );
    }
    assert.equal(new Set(map.markers.map((m) => m.id)).size, map.markers.length);
    const categories = new Set(map.categories.map((c) => c.id));
    for (const marker of map.markers) {
      assert.equal(typeof marker.labelSize, 'number');
      assert.equal(typeof marker.labelRotation, 'number');
      assert.ok(marker.floorIds.every((id) => map.floors.some((f) => f.id === id)));
      assert.ok(
        marker.categoryIds.includes(marker.categoryId),
        `${map.id}: missing primary category`,
      );
      assert.equal(new Set(marker.categoryIds).size, marker.categoryIds.length);
      for (const id of marker.categoryIds)
        assert.ok(categories.has(id), `${map.id}: ${marker.id} references unknown ${id}`);
    }
    for (const category of map.categories) {
      if (category.symbol === 'label') continue;
      assert.ok(category.iconUrl, `${map.id}: no upstream icon for ${category.id}`);
      const image = await readFile(
        new URL(category.iconUrl.slice('/api/assets/'.length), assetsRoot),
      );
      assert.ok(
        image.subarray(1, 4).toString() === 'PNG' ||
          (image.subarray(0, 4).toString() === 'RIFF' &&
            image.subarray(8, 12).toString() === 'WEBP'),
      );
      if (category.id.startsWith('loose/'))
        assert.ok(
          category.iconUrl.includes('/category-'),
          `${map.id}: category still uses generic loot icon`,
        );
    }
    for (const url of new Set(map.markers.map((m) => m.iconUrl).filter(Boolean))) {
      assert.ok(url.startsWith('/api/assets/'));
      assert.ok((await readFile(new URL(url.slice('/api/assets/'.length), assetsRoot))).length > 0);
    }
  }
});

test('two Tarkov slots use upstream 7x UTC conversion; map-specific fixed/hidden slots are data', () => {
  assert.deepEqual(mapTimes({ rate: 7, offsets: [3, 15], fixed: [] }, 0), ['03:00:00', '15:00:00']);
  assert.deepEqual(mapTimes({ rate: 7, offsets: [3, 15], fixed: [] }, 3600000), [
    '10:00:00',
    '22:00:00',
  ]);
  assert.deepEqual(
    mapTimes({ rate: 0, offsets: [], fixed: ['15:28:00', '03:28:00'] }, Date.now()),
    ['15:28:00', '03:28:00'],
  );
  assert.deepEqual(mapTimes({ rate: 0, offsets: [], fixed: [] }, Date.now()), []);
});

test('rotation orientation and stroke hit testing have independent expected values', () => {
  const projection = {
    rotation: 180,
    bounds: [
      { x: -100, z: -50 },
      { x: 100, z: 50 },
    ],
    viewBox: [10, 20, 400, 200],
  };
  const p = worldToPixel({ x: 100, z: -50 }, projection);
  assert.ok(Math.abs(p.x - 10) < 1e-8 && Math.abs(p.y - 20) < 1e-8);
  assert.equal(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(segmentDistance({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

test('annotation drafts keep undo and redo history independently of server requests', async () => {
  const map = await load('maps/factory_zh.json');
  let state = clientReducer(undefined, ensureAnnotationSession(map.id));
  const item = (id) => ({
    id,
    floorId: map.defaultFloor,
    kind: 'marker',
    points: [{ x: 50, y: 50 }],
    color: '#ffffff',
    width: 3,
    emoji: '📍',
    text: id,
    textSize: 15,
  });
  state = clientReducer(state, commitAnnotations({ id: map.id, base: [], items: [item('a')] }));
  state = clientReducer(
    state,
    commitAnnotations({ id: map.id, base: [item('a')], items: [item('a'), item('b')] }),
  );
  state = clientReducer(state, undoAnnotations({ id: map.id, current: [item('a'), item('b')] }));
  assert.equal(state.annotations.sessions[map.id].draft.length, 1);
  state = clientReducer(state, redoAnnotations({ id: map.id, current: [item('a')] }));
  assert.equal(state.annotations.sessions[map.id].draft.length, 2);
  state = clientReducer(state, undoAnnotations({ id: map.id, current: [item('a'), item('b')] }));
  state = clientReducer(
    state,
    commitAnnotations({ id: map.id, base: [item('a')], items: [item('c')] }),
  );
  assert.equal(state.annotations.sessions[map.id].future.length, 0);
});

test('a slow previous map response cannot replace the active map', async () => {
  const previous = globalThis.fetch,
    w = new Workspace();
  const first = await load('maps/factory_zh.json'),
    second = await load('maps/interchange_zh.json');
  const pending = [];
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/api/maps?locale=zh-CN')) return Promise.resolve(new Response('[]'));
    if (url.endsWith('/api/map-preferences'))
      return Promise.resolve(
        new Response(
          JSON.stringify({ schemaVersion: 1, selectedMap: '', maps: [], stickerUsage: [] }),
          { headers: { 'Content-Type': 'application/json', ETag: '"pref"', 'X-Revision': 'pref' } },
        ),
      );
    if (init?.method === 'PUT' || (input instanceof Request && input.method === 'PUT'))
      return Promise.resolve(
        new Response(
          JSON.stringify({ schemaVersion: 1, selectedMap: '', maps: [], stickerUsage: [] }),
          { headers: { 'Content-Type': 'application/json', ETag: '"next"', 'X-Revision': 'next' } },
        ),
      );
    if (url.includes('/api/maps/') && url.endsWith('/annotations'))
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, items: [] }), {
          headers: { 'Content-Type': 'application/json', ETag: '"rev"', 'X-Revision': 'rev' },
        }),
      );
    if (url.includes('/api/maps/')) {
      const map = url.includes(first.id) ? first : second;
      return Promise.resolve(
        new Response(JSON.stringify(map), { headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return new Promise((resolve) => pending.push({ url, resolve }));
  };
  try {
    const a = w.select(first.id),
      b = w.select(second.id);
    await new Promise((resolve) => setImmediate(resolve));
    await b;
    await a;
    assert.equal(w.activeId, second.id);
    assert.equal(w.loading, false);
    assert.equal(w.sessions.has(first.id), false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await w.savePreferences();
  } finally {
    globalThis.fetch = previous;
  }
});

const selfOwner = 'self';
const teammate = 'mate';
const departed = 'gone';
const visibleContext = {
  selfId: selfOwner,
  activeOwners: [teammate],
  hiddenOwners: [],
  shownOwners: [],
};

// The dashboard, the cast and the native overlay share one owner-visibility rule; these cases are
// the matrix the C# mirror (--owner-visibility-self-check) repeats.
test('owner visibility: hidden wins, own markers stay visible, roster defaults and departed owners', () => {
  const visible = (context, ownerId) => ownerVisibleFor(context)?.(ownerId);
  assert.equal(
    visible(visibleContext, selfOwner),
    true,
    'own markers render outside/inside a room',
  );
  assert.equal(
    visible({ ...visibleContext, hiddenOwners: [selfOwner] }, selfOwner),
    false,
    'own markers hide when hidden',
  );
  assert.equal(
    visible({ ...visibleContext, hiddenOwners: [teammate] }, teammate),
    false,
    'a manual hide beats the roster',
  );
  assert.equal(visible(visibleContext, teammate), true, 'room members default visible');
  assert.equal(visible(visibleContext, departed), false, 'departed owners default hidden');
  assert.equal(
    visible({ ...visibleContext, shownOwners: [departed] }, departed),
    true,
    'explicitly shown departed owners render',
  );
  assert.equal(
    visible({ ...visibleContext, hiddenOwners: [departed], shownOwners: [departed] }, departed),
    false,
    'hidden beats an explicit show',
  );
  assert.equal(
    visible({ ...visibleContext, selfId: '' }, teammate),
    undefined,
    'no identity means no filtering',
  );
  const owners = ownerVisibilityFor(visibleContext);
  assert.equal(owners.selfId, selfOwner);
  assert.deepEqual([...owners.active], [teammate]);
});

test('annotation visibility: the group switch hides everyone, the floor splits the rest', () => {
  const owners = ownerVisibilityFor(visibleContext);
  const annotation = { ownerId: selfOwner, floorId: 'ground' };
  const preference = { floorId: 'ground', showAnnotations: true };
  assert.equal(isAnnotationVisible(annotation, preference, owners), true);
  assert.equal(
    isAnnotationVisible(annotation, { ...preference, showAnnotations: false }, owners),
    false,
    'the group switch hides the local owner too',
  );
  assert.equal(
    isAnnotationVisible({ ...annotation, floorId: 'second' }, preference, owners),
    false,
    'only the current floor renders',
  );
  assert.equal(
    isAnnotationVisible(
      { ...annotation, ownerId: departed },
      { ...preference, showAnnotations: false },
      owners,
    ),
    false,
  );
  assert.equal(
    isAnnotationVisible({ ...annotation, ownerId: departed }, preference, owners),
    false,
  );
});

test('owner toggle writes the side that makes the choice stick', () => {
  const base = { schemaVersion: 1, hiddenOwners: [], shownOwners: [] };
  const context = { selfId: selfOwner, activeOwners: [teammate] };

  // The bug this locks: a departed owner is hidden by default, so showing one has to be recorded.
  const shown = nextMarkerPreferences(base, departed, true, context);
  assert.deepEqual(shown.shownOwners, [departed]);
  assert.deepEqual(shown.hiddenOwners, []);
  assert.equal(
    ownerVisibleFor({ ...visibleContext, shownOwners: shown.shownOwners })?.(departed),
    true,
  );

  // Unchecking records the manual hide, so it survives that owner rejoining the room.
  const hidden = nextMarkerPreferences(base, teammate, false, context);
  assert.deepEqual(hidden.hiddenOwners, [teammate]);
  assert.equal(
    ownerVisibleFor({ ...visibleContext, hiddenOwners: hidden.hiddenOwners })?.(teammate),
    false,
  );

  // Checking an active member only clears the hide: the roster already keeps them visible.
  const cleared = nextMarkerPreferences(hidden, teammate, true, context);
  assert.deepEqual(cleared.hiddenOwners, []);
  assert.deepEqual(cleared.shownOwners, []);

  // Own markers never need the shown list, and a redundant toggle writes nothing.
  const selfShown = nextMarkerPreferences(base, selfOwner, true, context);
  assert.equal(selfShown, base);
  assert.equal(nextMarkerPreferences(shown, departed, true, context), shown);
  const selfHidden = nextMarkerPreferences(base, selfOwner, false, context);
  assert.deepEqual(selfHidden.hiddenOwners, [selfOwner]);
  assert.deepEqual(nextMarkerPreferences(selfHidden, selfOwner, true, context).hiddenOwners, []);

  // Unchecking a shown departed owner must not leave it visible by default either.
  const unshown = nextMarkerPreferences(shown, departed, false, context);
  assert.deepEqual(unshown.shownOwners, []);
  assert.deepEqual(unshown.hiddenOwners, [departed]);
});

// An IME's own keys (including its Escape and Space) carry isComposing; some Chromium builds only
// expose them through the legacy 229 process key, so both have to count as "the IME is typing".
test('ime composition keys are recognised so shortcuts can stand down', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 27 }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 32 }), false);
  assert.equal(isImeComposing({}), false);
});
