import { pointSegmentDistance, segmentGap } from './navigation.mjs';

export const SECTOR_SIZE = 120;
export const MAP_SIZE = SECTOR_SIZE * 3;
export const MAP_MIN = -MAP_SIZE / 2;
export const MAP_MAX = MAP_SIZE / 2;
export const LANDING_CLEARANCE = 25;

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (value) => value * value * (3 - 2 * value);
const BIOME_BLEND_DISTANCE = 8;
const factionProfiles = [
  { id: 'player', name: 'Landing Colony', controller: 'human' },
  { id: 'meridian', name: 'Meridian Colony', personality: 'balanced' },
  { id: 'aurora', name: 'Aurora Compact', personality: 'commercial' },
  { id: 'forge', name: 'Forge Directorate', personality: 'defensive' },
  { id: 'drift', name: 'Drift Consortium', personality: 'expansionist' },
];

export function randomFrom(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, z, seed) {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1446648777);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function noise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = x - ix;
  const tz = z - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz, seed);
  const b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed);
  const d = hash(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

export { noise as terrainNoise };

const depositTypes = {
  metal: { label: 'Iron Deposit', multiplier: 3 },
  biomass: { label: 'Biomass Grove', multiplier: 2 },
  crystal: { label: 'Crystal Formation', multiplier: 1 },
  vent: { label: 'Geothermal Vent', multiplier: 1 },
};
const depositsByBiome = {
  plains: ['metal', 'biomass', 'biomass'],
  forest: ['biomass', 'biomass', 'biomass', 'metal'],
  mountain: ['metal', 'metal', 'metal', 'crystal'],
  desert: ['metal', 'metal', 'vent'],
  crystal: ['crystal', 'crystal', 'crystal', 'metal'],
  volcanic: ['vent', 'vent', 'vent', 'metal'],
};

function pick(items, random) { return items[Math.floor(random() * items.length)]; }

function polarPoint(center, radius, angle) {
  return { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
}

function randomMapPoint(random) {
  return { x: MAP_MIN + random() * MAP_SIZE, z: MAP_MIN + random() * MAP_SIZE };
}

function generateRegions(sectors, biomeTypes, random) {
  const landingBiomes = ['plains', 'plains', 'forest', 'desert'];
  const regions = sectors.map(({ home }) => ({ ...home, type: pick(landingBiomes, random), spread: 1.10 + random() * 0.18 }));
  const regionCount = 57 + Math.floor(random() * 17);
  let added = 0;
  for (let attempts = 0; added < regionCount && attempts < 900; attempts++) {
    const point = randomMapPoint(random);
    if (regions.some((region) => distance(region, point) < 15)) continue;
    regions.push({ ...point, type: pick(biomeTypes, random), spread: 0.83 + random() * 0.54 });
    added++;
  }
  const pocketCount = 13 + Math.floor(random() * 12);
  for (let index = 0; index < pocketCount; index++) {
    const anchor = pick(regions, random);
    const point = polarPoint(anchor, 8 + random() * 16, random() * Math.PI * 2);
    if (Math.max(Math.abs(point.x), Math.abs(point.z)) > MAP_MAX
      || sectors.some(({ home }) => distance(home, point) < 13)
      || regions.some((region) => distance(region, point) < 7)) continue;
    regions.push({ ...point, type: pick(biomeTypes, random), spread: 0.72 + random() * 0.17 });
  }
  return regions;
}

function generateDeposits(sectors, landingSites, localSector, sample, random) {
  const deposits = [];
  function add(id, type, point, amount, surface) {
    const { label, multiplier } = depositTypes[type];
    deposits.push({ id, type, label, ...point, amount: amount * multiplier, ...(surface == null ? {} : { surface }) });
  }
  function clear(point, spacing) {
    return !deposits.some((site) => distance(site, point) < spacing);
  }
  for (const sector of sectors) {
    const { home, minX, maxX, minZ, maxZ } = sector;
    const prefix = sector.id === localSector ? '' : `sector-${sector.id}-`;
    const heading = random() * Math.PI * 2;
    add(prefix + 'iron-near', 'metal', polarPoint(home, 9 + random() * 7, heading), 780, 165);
    add(prefix + 'forest-near', 'biomass', polarPoint(home, 9 + random() * 7, heading + 0.94 + random() * 4.4), 570, 165);

    // Keep the technology tree reachable from every sector while leaving the larger deposits scattered.
    for (const [id, type, preferred, amount, surface] of [
      ['iron-ridge', 'metal', 'mountain', 900, 230],
      ['crystal', 'crystal', 'crystal', 680],
      ['vent', 'vent', 'volcanic', 820],
    ]) {
      let best;
      let bestScore = -Infinity;
      for (let attempt = 0; attempt < 36; attempt++) {
        const point = { x: minX + 5 + random() * (maxX - minX - 10), z: minZ + 5 + random() * (maxZ - minZ - 10) };
        if (distance(home, point) < 19 || !clear(point, 8)) continue;
        const score = random() + (sample(point.x, point.z) === preferred ? 0.72 : 0);
        if (score > bestScore) { best = point; bestScore = score; }
      }
      // The margin scan guarantees an open site even if the random samples bunch up.
      for (let z = minZ + 6; !best && z < maxZ - 5; z += 7) {
        for (let x = minX + 6; !best && x < maxX - 5; x += 7) {
          if (distance(home, { x, z }) >= 19 && clear({ x, z }, 8)) best = { x, z };
        }
      }
      add(prefix + id, type, best, amount, surface);
    }
  }
  const clusters = 19 + Math.floor(random() * 12);
  for (let cluster = 0; cluster < clusters; cluster++) {
    const anchor = randomMapPoint(random);
    const type = pick(depositsByBiome[sample(anchor.x, anchor.z)], random);
    const size = 1 + Math.floor(random() * 4);
    for (let index = 0; index < size; index++) {
      const point = polarPoint(anchor, random() * 14, random() * Math.PI * 2);
      if (Math.max(Math.abs(point.x), Math.abs(point.z)) > MAP_MAX - 3 || !clear(point, 5.5)
        || landingSites.some((home) => distance(home, point) < 18)) continue;
      const surface = type === 'metal' || type === 'biomass' ? 95 + Math.floor(random() * 170) : undefined;
      add(`cluster-${cluster}-${index}`, type, point, 410 + Math.floor(random() * 650), surface);
    }
  }
  return deposits;
}

function makeSectors(random) {
  const sectors = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const minX = MAP_MIN + column * SECTOR_SIZE;
      const minZ = MAP_MIN + row * SECTOR_SIZE;
      const home = { x: minX + 50 + random() * 20, z: minZ + 50 + random() * 20 };
      sectors.push({ id: row * 3 + column, minX, maxX: minX + SECTOR_SIZE, minZ, maxZ: minZ + SECTOR_SIZE, home });
    }
  }
  return sectors;
}

function defaultFactions(sectors, random) {
  const shuffled = [...sectors];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return factionProfiles.map((faction, index) => ({ ...faction, home: shuffled[index].home, sector: shuffled[index].id }));
}

function generateRidges(sectors, safeSites, random) {
  const ridges = [];
  for (const sector of sectors) {
    let made = 0;
    for (let attempt = 0; made < 2 && attempt < 24; attempt++) {
      const angle = random() * Math.PI * 2;
      const span = 40 + random() * 11;
      const center = { x: sector.home.x + Math.cos(angle) * span, z: sector.home.z + Math.sin(angle) * span };
      const tangent = angle + Math.PI / 2 + (random() - 0.5) * 0.95;
      const halfLength = 12 + random() * 12;
      const a = { x: center.x - Math.cos(tangent) * halfLength, z: center.z - Math.sin(tangent) * halfLength };
      const b = { x: center.x + Math.cos(tangent) * halfLength, z: center.z + Math.sin(tangent) * halfLength };
      const radius = 2.7 + random() * 1.1;
      if ([a, b].some(({ x, z }) => Math.max(Math.abs(x), Math.abs(z)) > MAP_MAX - radius - 7)
        || safeSites.some(({ point, padding }) => pointSegmentDistance(point, a, b) < radius + padding)
        || ridges.some((ridge) => segmentGap(a, b, ridge.a, ridge.b) < radius + ridge.radius + 9)) continue;
      ridges.push({ kind: 'ridge', a, b, radius, height: 6.8 + random() * 4 });
      made++;
    }
  }
  return ridges;
}

function generateWildlife(sectors, settlementHomes, ridges, random) {
  const creatures = [];
  for (const { home } of sectors) {
    let made = 0;
    for (let attempt = 0; made < 2 && attempt < 40; attempt++) {
      const angle = random() * Math.PI * 2;
      const radius = 43 + random() * 17;
      const den = { x: home.x + Math.cos(angle) * radius, z: home.z + Math.sin(angle) * radius };
      if (Math.max(Math.abs(den.x), Math.abs(den.z)) > MAP_MAX - 18
        || settlementHomes.some((site) => distance(site, den) < LANDING_CLEARANCE + 19)
        || ridges.some((ridge) => pointSegmentDistance(den, ridge.a, ridge.b) < ridge.radius + 2)
        || creatures.some(({ den: other }) => distance(den, other) < 24)) continue;
      const ancient = random() < 0.3;
      const maxHealth = ancient ? 245 : 155;
      creatures.push({ id: `reptile-${creatures.length}`, kind: ancient ? 'ancient' : 'reptile',
        ...den, den, phase: random() * Math.PI * 2, heading: angle, health: maxHealth, maxHealth,
        speed: ancient ? 2.45 : 3.4, damage: ancient ? 24 : 15, cooldown: 0, leash: 18,
      });
      made++;
    }
  }
  return creatures;
}

function mountainRange(center, random) {
  const angle = random() * Math.PI * 2;
  const spine = (x, z, heading, span, width, height) => ({
    x, z, dx: Math.cos(heading), dz: Math.sin(heading), span, width, height, phase: random() * Math.PI * 2,
  });
  return {
    ...center,
    spines: [
      spine(center.x, center.z, angle, 13 + random() * 6, 6 + random() * 2, 8.9 + random() * 2.5),
      ...[-1, 1].map((side) => {
        const along = side * (2.5 + random() * 2.5);
        const heading = angle + side * (0.73 + random() * 0.57);
        const jointX = center.x + Math.cos(angle) * along;
        const jointZ = center.z + Math.sin(angle) * along;
        return spine(jointX + side * Math.cos(heading) * 4, jointZ + side * Math.sin(heading) * 4,
          heading, 8 + random() * 3.5, 4.8 + random() * 1.8, 5.8 + random() * 2.1);
      }),
    ],
  };
}

function spineRelief(spine, x, z, roughness) {
  const dx = x - spine.x;
  const dz = z - spine.z;
  const along = dx * spine.dx + dz * spine.dz;
  const taper = 1 - Math.abs(along) / spine.span;
  if (taper <= 0) return 0;
  const bend = Math.sin(along * 0.43 + spine.phase) * 0.75 + (roughness - 0.5) * 0.72;
  const side = dz * spine.dx - dx * spine.dz - bend;
  const width = spine.width * (0.45 + taper * 0.55);
  const flank = Math.abs(side) / width;
  if (flank >= 1) return 0;
  // Run narrow gullies down the flanks and taper them out at the crests and foothills.
  const channel = 0.5 + 0.5 * Math.sin(along * 1.58 + side * 0.43 + spine.phase);
  const erosion = 1 - channel ** 4 * Math.sin(Math.PI * flank) * 0.26;
  const summits = 0.86 + Math.sin(along * 0.61 + spine.phase) * 0.12 + roughness * 0.21;
  return spine.height * taper ** 0.72 * (1 - flank) ** 1.30 * summits * erosion;
}

export function createPlanet(seed, biomeTypes, customFactions) {
  const random = randomFrom(seed);
  const sectors = makeSectors(random);
  const startingFactions = customFactions ?? defaultFactions(sectors, random);
  const settlementHomes = startingFactions.map(({ home }) => home);
  const landingSites = customFactions ? [...sectors.map((sector) => sector.home), ...settlementHomes] : sectors.map((sector) => sector.home);
  const localSector = startingFactions.find(({ controller }) => controller === 'human')?.sector;
  const home = startingFactions[0].home;
  const regions = generateRegions(sectors, biomeTypes, randomFrom(seed + 411));
  const outposts = sectors.map(({ id, home }) => ({
    id: `frontier-${id}`, name: 'Frontier Relay', ...polarPoint(home, 27 + random() * 14, random() * Math.PI * 2),
    discovered: false, relay: true, owner: null, vision: 24,
  }));
  const mountainRandom = randomFrom(seed + 7201);
  const ranges = regions.filter(({ type }) => type === 'mountain').map((region) => mountainRange(region, mountainRandom));
  const volcanoes = regions.filter(({ type }) => type === 'volcanic');
  const centers = regions.map((region) => ({
    x: region.x, z: region.z, spreadSquared: region.spread * region.spread, biome: biomeTypes.indexOf(region.type),
  }));
  const deposits = generateDeposits(sectors, landingSites, localSector, sample, randomFrom(seed + 7633));
  const safeSites = [
    ...landingSites.map((point) => ({ point, padding: 28 })),
    ...deposits.map((point) => ({ point, padding: 3.5 })),
    ...outposts.map((point) => ({ point, padding: 4 })),
  ];
  const ridges = generateRidges(sectors, safeSites, randomFrom(seed + 2399));
  const wildlife = generateWildlife(sectors, landingSites, ridges, randomFrom(seed + 632));
  const ridgeBands = ridges.map((ridge) => {
    const margin = ridge.radius + 3.5;
    const length = distance(ridge.a, ridge.b);
    return { ridge, length, dx: (ridge.b.x - ridge.a.x) / length, dz: (ridge.b.z - ridge.a.z) / length,
      minX: Math.min(ridge.a.x, ridge.b.x) - margin, maxX: Math.max(ridge.a.x, ridge.b.x) + margin,
      minZ: Math.min(ridge.a.z, ridge.b.z) - margin, maxZ: Math.max(ridge.a.z, ridge.b.z) + margin };
  });

  function nearestBiome(x, z, scores) {
    const warpedX = x + (noise(x * 0.08, z * 0.08, seed) - 0.5) * 10;
    const warpedZ = z + (noise(x * 0.08 + 37, z * 0.08, seed) - 0.5) * 10;
    if (scores) scores.fill(Infinity);
    let best = Infinity;
    let nearest = 0;
    for (const { x: centerX, z: centerZ, spreadSquared, biome } of centers) {
      const dx = warpedX - centerX;
      const dz = warpedZ - centerZ;
      const score = (dx * dx + dz * dz) / spreadSquared;
      if (score < best) { nearest = biome; best = score; }
      if (scores && score < scores[biome]) scores[biome] = score;
    }
    return nearest;
  }

  function sample(x, z) {
    return biomeTypes[nearestBiome(x, z)];
  }

  // Compare the nearest center of each biome so two centers of the same biome never create a seam.
  function biomeWeights(x, z, weights) {
    const nearest = nearestBiome(x, z, weights);
    const best = Math.sqrt(weights[nearest]);
    let total = 0;
    for (let biome = 0; biome < biomeTypes.length; biome++) {
      const gap = Math.sqrt(weights[biome]) - best;
      const weight = smoothstep(clamp(1 - gap / BIOME_BLEND_DISTANCE, 0, 1));
      weights[biome] = weight;
      total += weight;
    }
    for (let biome = 0; biome < biomeTypes.length; biome++) weights[biome] /= total;
    return weights;
  }

  function ridgeWeight(x, z) {
    let weight = 0;
    const point = { x, z };
    for (const { ridge, minX, maxX, minZ, maxZ } of ridgeBands) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const distance = pointSegmentDistance(point, ridge.a, ridge.b);
      const shoulder = clamp((ridge.radius + 2.5 - distance) / 3.2, 0, 1);
      weight = Math.max(weight, smoothstep(shoulder));
    }
    return weight;
  }

  function elevation(x, z) {
    const rolling = noise(x * 0.105, z * 0.105, seed + 13) * 1.9;
    const jagged = noise(x * 0.42, z * 0.42, seed + 333);
    let relief = 0;
    for (const range of ranges) {
      const dx = x - range.x;
      const dz = z - range.z;
      if (Math.abs(dx) > 24 || Math.abs(dz) > 24) continue;
      const base = Math.max(0, 1 - Math.hypot(dx, dz) / 23);
      let crest = 0;
      for (const spine of range.spines) crest = Math.max(crest, spineRelief(spine, x, z, jagged));
      relief = Math.max(relief, crest + base ** 1.65 * (1.6 + jagged));
    }
    for (const peak of volcanoes) {
      const dx = x - peak.x;
      const dz = z - peak.z;
      if (Math.abs(dx) > 12 || Math.abs(dz) > 12) continue;
      const slope = Math.max(0, 1 - Math.hypot(dx, dz) / 12);
      relief = Math.max(relief, slope ** 1.35 * (4.7 + jagged * 4));
    }
    for (const { ridge, dx, dz, length, minX, maxX, minZ, maxZ } of ridgeBands) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const offsetX = x - ridge.a.x;
      const offsetZ = z - ridge.a.z;
      const along = offsetX * dx + offsetZ * dz;
      const spine = clamp(along, 0, length);
      const bend = (Math.sin(spine * 0.55) * 0.55 + (jagged - 0.5) * 0.65)
        * smoothstep(clamp(Math.min(spine, length - spine) / 3, 0, 1));
      const side = Math.hypot(offsetZ * dx - offsetX * dz - bend, along - spine) / ridge.radius;
      const lift = Math.max(0, 1 - side / 1.55);
      const crest = 0.77 + Math.sin(spine * 0.82) * 0.12 + jagged * 0.22;
      relief = Math.max(relief, lift ** 1.22 * ridge.height * crest);
    }
    let landingSlope = Infinity;
    for (const site of landingSites) landingSlope = Math.min(landingSlope, Math.max(Math.abs(x - site.x), Math.abs(z - site.z)));
    return (rolling + relief) * (0.27 + clamp((landingSlope - 3) / 9, 0, 1) * 0.73);
  }

  return {
    seed, home, sectors, startingFactions, settlementHomes, landingSites, regions, deposits, outposts, ridges, wildlife,
    sample, biomeWeights, ridgeWeight, elevation,
  };
}
