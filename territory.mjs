import { MAP_MIN, MAP_MAX, MAP_SIZE } from './planet.mjs';

export function territoryOwner(world, { x, z }) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || x < MAP_MIN || x >= MAP_MAX || z < MAP_MIN || z >= MAP_MAX) return null;
  if (world.territories) {
    let owner = null;
    for (const { faction, minX, maxX, minZ, maxZ } of world.territories) {
      if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
      if (owner !== null && owner !== faction) return null;
      owner = faction;
    }
    return world.defeatedFactions?.has(owner) ? null : owner;
  }
  let owner = null;
  let nearest = Infinity;
  for (const [id, home] of world.factionHomes ?? []) {
    const gap = (x - home.x) ** 2 + (z - home.z) ** 2;
    if (gap === nearest) owner = null;
    if (gap < nearest) { nearest = gap; owner = id; }
  }
  return world.defeatedFactions?.has(owner) ? null : owner;
}

export const TERRITORY_FOG_LIMIT = 102;
export const ATTACK_BORDER_COLOR = [255, 87, 76];
export const ATTACK_BORDER_INNER = 7;
export const ATTACK_BORDER_RADIUS = 20;

export function attackBorderPoint(world, source) {
  const { home, territoryMap } = world;
  const dx = source.x - home.x;
  const dz = source.z - home.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.001) return null;
  const stepX = dx * 0.5 / length;
  const stepZ = dz * 0.5 / length;
  let lastOwned = -1;
  for (let x = home.x, z = home.z; x >= MAP_MIN && x < MAP_MAX && z >= MAP_MIN && z < MAP_MAX; x += stepX, z += stepZ) {
    const cell = Math.floor(z - MAP_MIN) * MAP_SIZE + Math.floor(x - MAP_MIN);
    if (territoryMap.pixels[cell * 4 + 3] === 255) lastOwned = cell;
    else if (lastOwned >= 0) break;
  }
  return lastOwned < 0 ? null : { x: MAP_MIN + lastOwned % MAP_SIZE + 0.5, z: MAP_MIN + Math.floor(lastOwned / MAP_SIZE) + 0.5 };
}

export function attackBorderWeight(cell, center) {
  const x = MAP_MIN + cell % MAP_SIZE + 0.5;
  const z = MAP_MIN + Math.floor(cell / MAP_SIZE) + 0.5;
  const distance = Math.hypot(x - center.x, z - center.z);
  const t = Math.max(0, Math.min(1, (distance - ATTACK_BORDER_INNER) / (ATTACK_BORDER_RADIUS - ATTACK_BORDER_INNER)));
  return 1 - t * t * (3 - 2 * t);
}

export function createTerritoryMap(world) {
  const colors = new Map();
  let index = 0;
  for (const { id } of world.startingFactions) {
    if (id === world.localFaction) colors.set(id, [139, 245, 203, 255]);
    else {
      const angle = 0.4 + index++ * 2.39996;
      const rgb = [0, 2 * Math.PI / 3, 4 * Math.PI / 3].map((offset) => Math.round(191 + 58 * Math.cos(angle + offset)));
      colors.set(id, [...rgb, 128]);
    }
  }

  const pixels = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  const owners = Array(MAP_SIZE * MAP_SIZE);
  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const index = z * MAP_SIZE + x;
      const owner = territoryOwner(world, { x: MAP_MIN + x + 0.5, z: MAP_MIN + z + 0.5 });
      owners[index] = owner;
      if (owner !== null) pixels.set(colors.get(owner), index * 4);
    }
  }

  const edges = [];
  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const index = z * MAP_SIZE + x;
      const owner = owners[index];
      if (owner === null) continue;
      if (x === 0 || x === MAP_SIZE - 1 || z === 0 || z === MAP_SIZE - 1
        || owner !== owners[index - 1] || owner !== owners[index + 1]
        || owner !== owners[index - MAP_SIZE] || owner !== owners[index + MAP_SIZE]) edges.push(index);
    }
  }
  return { pixels, edges };
}
