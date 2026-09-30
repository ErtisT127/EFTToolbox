import type { MapData } from '../../../../../contracts/ts/ipc.gen';

export function selectableFloors(data: MapData, basemap: string) {
  return data.floors.filter(
    (floor) =>
      floor.id !== data.baseFloor &&
      (basemap === 'tiles'
        ? data.tiles.some((tile) => tile.floorId === floor.id) || floor.svgGroups.length > 0
        : floor.svgGroups.length > 0),
  );
}
