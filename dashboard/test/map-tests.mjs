import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { pixelToWorld, worldToPixel, segmentDistance } from '../src/pages/map/lib/geometry.ts';
import { Workspace, selectableFloors } from '../src/stores/workspaceStore.ts';
import { mapTimes, timePhase } from '../src/pages/map/lib/time.ts';
import { SVG_MAX_ZOOM, zoomRange } from '../src/pages/map/lib/zoom.ts';

const root = new URL('../../data/upstream/', import.meta.url);
const dataRoot = new URL('modes/pvp/', root);
const load = async (name) => JSON.parse(await readFile(new URL(name, dataRoot), 'utf8'));
const catalog = await load('catalog.json');

test('floor options respect basemap availability and never switch basemap implicitly', async () => {
  const data = await load('maps/customs.json');
  const rasterOnly = data.floors.find((f) => !f.svgGroups.length);
  assert.ok(rasterOnly);
  assert.ok(!selectableFloors(data, 'svg').some((f) => f.id === rasterOnly.id));
  assert.ok(selectableFloors(data, 'tiles').some((f) => f.id === rasterOnly.id));
  for (const mode of ['svg', 'tiles'])
    assert.ok(!selectableFloors(data, mode).some((f) => f.id === data.baseFloor));
  const w = new Workspace();
  w.sessions.set(data.id, { data });
  const preference = w.preferenceFor(data.id);
  preference.basemap = 'svg';
  preference.floorId = rasterOnly.id;
  assert.equal(w.preferenceFor(data.id).basemap, 'svg');
  assert.equal(preference.floorId, data.baseFloor);
  preference.basemap = 'tiles';
  preference.floorId = rasterOnly.id;
  assert.equal(w.preferenceFor(data.id).floorId, rasterOnly.id);
});

test('daylight icons follow each clock independently at dawn/day/dusk/night boundaries', async () => {
  const { clock } = await load('maps/interchange.json');
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
    const map = await load(`maps/${id}.json`);
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
    const map = await load(`maps/${summary.id}.json`);
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
    const map = await load(`maps/${summary.id}.json`);
    const svg = map.svgUrl
      ? await readFile(new URL(`assets/${map.svgUrl.split('/').at(-1)}`, root), 'utf8')
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
      const image = await readFile(new URL(`assets/${category.iconUrl.split('/').at(-1)}`, root));
      assert.ok(
        image.subarray(1, 4).toString() === 'PNG' ||
          (image.subarray(0, 4).toString() === 'RIFF' &&
            image.subarray(8, 12).toString() === 'WEBP'),
      );
      if (category.id.startsWith('loose/'))
        assert.ok(
          category.iconUrl.includes('/item-'),
          `${map.id}: category still uses generic loot icon`,
        );
    }
    for (const url of new Set(map.markers.map((m) => m.iconUrl).filter(Boolean))) {
      assert.ok(url.startsWith('/api/map-assets/'));
      assert.ok((await readFile(new URL(`assets/${url.split('/').at(-1)}`, root))).length > 0);
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

test('serial saves coalesce edits, retain failed edits, retry, and preserve map history', async () => {
  const previous = globalThis.fetch;
  const map = await load('maps/factory.json');
  const w = new Workspace();
  const session = {
    data: map,
    items: [],
    past: [],
    future: [],
    revision: 0,
    savedRevision: 0,
    saving: false,
    error: '',
  };
  w.sessions.set(map.id, session);
  const pending = [],
    writes = [];
  globalThis.fetch = (url, init) => {
    if (url === '/api/logs') return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise((resolve) => {
      writes.push(JSON.parse(init.body));
      pending.push(resolve);
    });
  };
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
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    w.commit(map.id, [item('a')]);
    w.commit(map.id, [item('a'), item('b')]);
    assert.equal(writes.length, 1);
    pending.shift()(new Response('{}'));
    await tick();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].items.length, 2);
    pending.shift()(new Response('disk full', { status: 500 }));
    await tick();
    assert.equal(session.items.length, 2);
    assert.ok(session.error);
    assert.notEqual(session.revision, session.savedRevision);
    const retry = w.save(map.id);
    pending.shift()(new Response('{}'));
    await retry;
    assert.equal(session.savedRevision, session.revision);
    assert.equal(session.error, '');
    w.undo(map.id);
    assert.equal(session.items.length, 1);
    pending.shift()(new Response('{}'));
    await tick();
    w.redo(map.id);
    assert.equal(session.items.length, 2);
    pending.shift()(new Response('{}'));
    await tick();
    w.undo(map.id);
    pending.shift()(new Response('{}'));
    await tick();
    w.commit(map.id, [item('c')]);
    assert.equal(session.future.length, 0);
    pending.shift()(new Response('{}'));
    await tick();
  } finally {
    globalThis.fetch = previous;
  }
});

test('a slow previous map response cannot replace the active map', async () => {
  const previous = globalThis.fetch,
    w = new Workspace();
  const first = await load('maps/factory.json'),
    second = await load('maps/interchange.json');
  const pending = [];
  globalThis.fetch = (url, init) => {
    if (url === '/api/logs') return Promise.resolve(new Response(null, { status: 204 }));
    if (init?.method === 'PUT') return Promise.resolve(new Response('{}'));
    return new Promise((resolve) => pending.push({ url, resolve }));
  };
  try {
    const a = w.select(first.id),
      b = w.select(second.id);
    for (const p of pending.filter((p) => p.url.includes(second.id)))
      p.resolve(
        new Response(
          JSON.stringify(p.url.endsWith('annotations') ? { schemaVersion: 1, items: [] } : second),
        ),
      );
    await b;
    for (const p of pending.filter((p) => p.url.includes(first.id)))
      p.resolve(
        new Response(
          JSON.stringify(p.url.endsWith('annotations') ? { schemaVersion: 1, items: [] } : first),
        ),
      );
    await a;
    assert.equal(w.activeId, second.id);
    assert.equal(w.loading, false);
    assert.equal(w.sessions.has(first.id), false);
    await w.savePreferences();
  } finally {
    globalThis.fetch = previous;
  }
});
