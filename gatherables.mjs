import { MAP_MIN, MAP_MAX, randomFrom } from './planet.mjs';
import { pointSegmentDistance } from './navigation.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const polarPoint = (center, distance, angle) => ({
  x: center.x + Math.cos(angle) * distance, z: center.z + Math.sin(angle) * distance,
});

export function generateGatherables(world, forestIndex, biomeCount) {
  const random = randomFrom(world.seed + 2817);
  const gatherables = [];
  const groveSites = world.deposits.filter(({ type }) => type === 'biomass');
  const clearingSites = [...world.deposits, ...world.outposts];
  const starterTrails = world.sectors.flatMap(({ home }) => world.deposits
    .filter((site) => distance(home, site) <= 16 && (site.id.endsWith('iron-near') || site.id.endsWith('forest-near')))
    .map((site) => ({ home, site })));
  const weights = new Float64Array(biomeCount);
  function add(kind, point) {
    const size = random();
    gatherables.push({
      id: `${kind}-${gatherables.length}`, kind, type: kind === 'tree' ? 'biomass' : 'metal', ...point,
      size, angle: random() * Math.PI * 2, tone: random(),
      radius: kind === 'tree' ? 0.51 + size * 0.19 : 0,
      surface: kind === 'tree' ? 10 + Math.round(size * 12) : 13 + Math.round(size * 23),
    });
  }
  for (let z = MAP_MIN + 1; z < MAP_MAX - 1; z += 1.65) {
    for (let x = MAP_MIN + 1; x < MAP_MAX - 1; x += 1.65) {
      const point = { x: x + (random() - 0.5) * 0.62, z: z + (random() - 0.5) * 0.62 };
      world.biomeWeights(point.x, point.z, weights);
      if (random() >= Math.min(0.94, weights[forestIndex] * 1.08)) continue;
      if (world.landingSites.some((home) => distance(home, point) < 8)
        || starterTrails.some(({ home, site }) => pointSegmentDistance(point, home, site) < 1.55)
        || clearingSites.some((site) => distance(site, point) < (site.type === 'biomass' ? 2.9 : 3.5))
        || world.ridges.some(({ a, b, radius }) => pointSegmentDistance(point, a, b) < radius + 0.8)) continue;
      add('tree', point);
    }
  }
  for (const grove of groveSites) {
    const heading = random() * Math.PI * 2;
    for (let index = 0; index < 4; index++) {
      const point = polarPoint(grove, 1.04 + random() * 0.55, heading + index * Math.PI / 2);
      add('tree', point);
    }
  }
  for (let index = 0; index < 620; index++) {
    const point = { x: MAP_MIN + 2 + random() * (MAP_MAX - MAP_MIN - 4), z: MAP_MIN + 2 + random() * (MAP_MAX - MAP_MIN - 4) };
    const type = world.sample(point.x, point.z);
    if ((type === 'forest' || type === 'plains') && random() < 0.58) continue;
    if (world.landingSites.some((home) => distance(home, point) < 8)
      || clearingSites.some((site) => distance(site, point) < 2.4)
      || world.ridges.some(({ a, b, radius }) => pointSegmentDistance(point, a, b) < radius + 0.6)) continue;
    add('rock', point);
  }
  return gatherables;
}
