import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Navigation, pointSegmentDistance } from './navigation.mjs';
import { LANDING_CLEARANCE, SECTOR_SIZE } from './planet.mjs';
import { attackBorderPoint, attackBorderWeight } from './territory.mjs';
import {
  BIOMES, BUILDINGS, MAP_DEPTH, MAP_MIN_X, MAP_MIN_Z, MAP_WIDTH, UNITS, UNIT_REMAINS_LIFETIME, WALL_LENGTH, addUnit, aimedWallSite, assistConstruction, availableConstructionDeposits, buildingFootprint, buildingSite, createFog, createGame, distance,
  isBlueprint, maxBuildingHealth, orderBuilding, orderFactionAttack, orderHarvestPatrol, orderRoverAssist, productionDetails, queueTraining, removeBuilding, setConverterRecipe, setRallyPoint, setUnitOrder,
  territoryOwner, unitClearance, unitHitRadius, updateFog, updateGame, wallStrokeSites,
} from './world.mjs';

const point = (x, z) => ({ x, z });
const move = (unit, target) => setUnitOrder(unit, { kind: 'move', ...target });

function fixture(gatherables = []) {
  const game = createGame(14, {
    gatherables,
    factions: [
      { id: 'a', home: point(0, 0), controller: 'human' },
      { id: 'b', home: point(47, 0), controller: 'human' },
    ],
    territories: [
      { faction: 'a', minX: -70, maxX: 20, minZ: -60, maxZ: 60 },
      { faction: 'b', minX: 20, maxX: 70, minZ: -60, maxZ: 60 },
    ],
  });
  game.hostiles.length = 0;
  for (const faction of game.factions.values()) faction.resources.metal = 2000;
  return game;
}

function tick(game, seconds, inspect = () => {}) {
  const steps = Math.ceil(seconds / 0.05);
  for (let index = 0; index < steps; index++) {
    updateGame(game, seconds / steps);
    inspect();
  }
}

const rovers = (faction) => faction.units.filter(({ type }) => type === 'rover');
const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);

function completeFixtureBuilding(game, building) {
  building.progress = building.paidProgress = 1;
  building.health = maxBuildingHealth(building);
  game.world.navigation.addStructure(building, buildingFootprint(building));
}

test('faction borders identify owned edges and leave overlapping claims and open ground unclaimed', () => {
  const game = createGame(14, {
    factions: [{ id: 'a', home: point(0, 0), controller: 'human' }, { id: 'b', home: point(40, 0), controller: 'ai' }],
    territories: [
      { faction: 'a', minX: -14, maxX: 25, minZ: -15, maxZ: 15 },
      { faction: 'b', minX: 12, maxX: 54, minZ: -15, maxZ: 15 },
    ],
    gatherables: [],
  });
  const { pixels, edges } = game.world.territoryMap;
  const index = (x, z) => (z - MAP_MIN_Z) * MAP_WIDTH + x - MAP_MIN_X;
  const color = (x, z) => [...pixels.subarray(index(x, z) * 4, index(x, z) * 4 + 4)];
  assert.equal(territoryOwner(game.world, point(10, 0)), 'a');
  assert.equal(territoryOwner(game.world, point(15, 0)), null);
  assert.equal(territoryOwner(game.world, point(25, 0)), 'b');
  assert(edges.includes(index(11, 0)));
  assert(edges.includes(index(25, 0)));
  assert(!edges.includes(index(12, 0)));
  assert(!edges.includes(index(0, 0)));
  assert.deepEqual(color(12, 0), [0, 0, 0, 0]);
  assert.deepEqual(color(0, 25), [0, 0, 0, 0]);
  assert.notDeepEqual(color(11, 0).slice(0, 3), color(25, 0).slice(0, 3));
});

test('additional construction rovers join an existing builder at full speed for no added cost', () => {
  const game = fixture();
  const [builder, second, third] = rovers(game);
  assert.equal(orderBuilding(game, 'farm', point(10, 0), [builder]), null);
  const building = game.buildings.at(-1);
  const range = buildingFootprint(building).radius + unitClearance('rover') + 0.19;
  Object.assign(builder, point(building.x - range, building.z));
  Object.assign(second, point(building.x, building.z - range));
  Object.assign(third, point(building.x, building.z + range));
  tick(game, 1);
  const solo = building.progress;
  assert(solo > 0);
  const materials = { ...game.resources };
  assert.equal(assistConstruction(game, building, [second, third]), null);
  assert.equal(assistConstruction(game, building, [builder, second, third], true), null);
  assert.deepEqual(game.resources, materials);
  assert(rovers(game).every((rover) => rover.order.building === building && !rover.queuedOrders.length));
  tick(game, 1);
  closeTo(building.progress, solo * 4);
  tick(game, BUILDINGS.farm.time / 3 + 1);
  assert.equal(building.progress, 1);
  assert(rovers(game).every((rover) => rover.order === null));
});

test('attack direction picks the facing owned border and the warning tapers away from it', () => {
  const { world } = fixture();
  const east = attackBorderPoint(world, point(37, 0));
  const north = attackBorderPoint(world, point(0, -55));
  const cell = (x, z) => (Math.floor(z - MAP_MIN_Z)) * MAP_WIDTH + Math.floor(x - MAP_MIN_X);
  assert.deepEqual(east, point(19.5, 0.5));
  assert.deepEqual(north, point(0.5, -59.5));
  assert(world.territoryMap.edges.includes(cell(east.x, east.z)));
  assert.equal(attackBorderWeight(cell(east.x, east.z), east), 1);
  assert(attackBorderWeight(cell(east.x, east.z + 12), east) > 0);
  assert.equal(attackBorderWeight(cell(north.x, north.z), east), 0);
  assert.equal(attackBorderPoint(world, world.home), null);
});

test('rover assistants follow a chain of construction and repair orders at full speed', () => {
  const game = fixture();
  const [leader, helper, secondHelper] = rovers(game);
  assert.equal(orderRoverAssist(game, [helper], leader), null);
  assert.equal(orderRoverAssist(game, [secondHelper], helper), null);
  assert.match(orderRoverAssist(game, [leader], secondHelper), /already assisting/);
  assert.match(orderRoverAssist(game, [leader], leader), /another rover/);
  assert.match(orderRoverAssist(game, [leader], rovers(game.factions.get('b'))[0]), /friendly rover/);
  assert.equal(orderBuilding(game, 'farm', point(10, 0), [leader]), null);
  const farm = game.buildings.at(-1);
  const range = buildingFootprint(farm).radius + unitClearance('rover') + 0.19;
  Object.assign(leader, point(farm.x - range, farm.z));
  Object.assign(helper, point(farm.x, farm.z - range));
  Object.assign(secondHelper, point(farm.x, farm.z + range));
  tick(game, 1);
  const speed = BIOMES[farm.biome].buildSpeed ?? 1;
  closeTo(farm.progress, 3 * speed / BUILDINGS.farm.time);
  tick(game, BUILDINGS.farm.time / 3 + 1);
  assert.equal(farm.progress, 1);
  assert.equal(leader.order, null);
  assert.equal(helper.order.target, leader);
  assert.equal(secondHelper.order.target, helper);
  farm.health -= 50;
  Object.assign(helper, point(farm.x, farm.z - range));
  Object.assign(secondHelper, point(farm.x, farm.z + range));
  setUnitOrder(leader, { kind: 'repair', building: farm });
  tick(game, 0.5);
  closeTo(farm.health, maxBuildingHealth(farm) - 50 + 18);
});

test('an assisting rover follows movement, harvests its leader’s patrol target and stops if the leader is lost', () => {
  const tree = { ...point(15, -5), id: 'tree', kind: 'tree', type: 'biomass', radius: 0.6, surface: 5 };
  const game = fixture([tree]);
  game.world.deposits.length = 0;
  const [leader, helper] = rovers(game);
  Object.assign(leader, point(5, -3));
  Object.assign(helper, point(5, -6));
  assert.equal(orderRoverAssist(game, [helper], leader), null);
  move(leader, point(9, -5));
  tick(game, 5);
  assert(distance(leader, point(9, -5)) < 0.3);
  assert(distance(leader, helper) < 2.3);
  const area = { minX: 12, maxX: 18, minZ: -8, maxZ: -2 };
  assert.equal(orderHarvestPatrol(game, [leader], area, false, tree), null);
  Object.assign(leader, point(13.7, -5));
  Object.assign(helper, point(15, -6.3));
  tick(game, 0.5);
  closeTo(game.gathered.biomass, 2.8);
  tick(game, 1);
  assert.equal(tree.surface, 0);
  assert.deepEqual(game.world.harvestedGatherables, [tree]);
  assert.equal(helper.order.kind, 'assist');
  leader.health = 0;
  tick(game, 0.05);
  assert.equal(helper.order, null);
});

test('seeds assign five unique starts across nine equal sectors with richer deposits', () => {
  const seed = 3769694225;
  const first = createGame(seed);
  const repeat = createGame(seed);
  const homes = ({ factions }) => [...factions.values()].map(({ country, home }) => [country, home]);
  assert.deepEqual(homes(first), homes(repeat));
  assert.notDeepEqual(homes(first), homes(createGame(seed + 1)));
  assert.equal(MAP_WIDTH, SECTOR_SIZE * 3);
  assert.equal(MAP_DEPTH, SECTOR_SIZE * 3);
  assert.equal(first.world.sectors.length, 9);
  assert.equal(first.factions.size, 5);
  assert.equal([...first.factions.values()].filter(({ controller }) => controller === 'human').length, 1);
  assert.equal(new Set(first.world.startingFactions.map(({ sector }) => sector)).size, 5);
  for (const faction of first.factions.values()) assert.equal(territoryOwner(first.world, faction.home), faction.country);
  assert.equal(first.world.sectors.filter(({ home }) => territoryOwner(first.world, home) === null).length, 4);
  assert.equal(first.world.deposits.find(({ id }) => id === 'iron-near').amount, 780 * 3);
  assert.equal(first.world.deposits.find(({ id }) => id === 'forest-near').amount, 570 * 2);
  assert.equal(first.world.deposits.find(({ id }) => id === 'crystal').amount, 680);
});

test('planet generation varies biome makeup and resource density across sectors while keeping starter supplies', () => {
  const seed = 3769694225;
  const { world } = createGame(seed);
  const repeat = createGame(seed).world;
  assert.deepEqual(world.regions, repeat.regions);
  assert.deepEqual(world.deposits, repeat.deposits);
  assert.notDeepEqual(world.deposits, createGame(seed + 1).world.deposits);
  const depositCounts = new Set();
  const regionCounts = new Set();
  const regionTypes = new Set();
  for (const { home, minX, maxX, minZ, maxZ } of world.sectors) {
    const within = ({ x, z }) => x >= minX && x < maxX && z >= minZ && z < maxZ;
    const deposits = world.deposits.filter(within);
    const regions = world.regions.filter(within);
    depositCounts.add(deposits.length);
    regionCounts.add(regions.length);
    regionTypes.add(world.sample(home.x, home.z));
    for (const type of ['metal', 'biomass']) {
      assert(deposits.some((site) => site.type === type && distance(site, home) <= 16));
    }
    for (const type of ['crystal', 'vent']) assert(deposits.some((site) => site.type === type));
  }
  assert(depositCounts.size >= 3);
  assert(regionCounts.size >= 3);
  assert(regionTypes.size >= 2);
});

test('visual weights remain continuous at a gameplay biome boundary', () => {
  const { world } = createGame(3769694225);
  const biomeTypes = Object.keys(BIOMES);
  const weightsAt = (x, z) => world.biomeWeights(x, z, new Float64Array(biomeTypes.length));
  const z = world.home.z;
  let left = world.home.x;
  const first = world.sample(left, z);
  let right;
  for (let offset = 1; offset <= MAP_WIDTH; offset++) {
    if (world.sample(left - offset, z) === first) continue;
    right = left - offset;
    break;
  }
  assert.notEqual(right, undefined);
  for (let index = 0; index < 20; index++) {
    const x = (left + right) / 2;
    if (world.sample(x, z) === first) left = x;
    else right = x;
  }
  assert.notEqual(world.sample(left, z), world.sample(right, z));
  const near = weightsAt(left, z);
  const far = weightsAt(right, z);
  assert(near.filter((weight) => weight > 0.15).length >= 2);
  assert(Math.abs(near.reduce((total, weight) => total + weight, 0) - 1) < 1e-12);
  assert(near.every((weight, index) => Math.abs(weight - far[index]) < 1e-5));
});

test('ground orders detour around a building and can reach the opposite side', () => {
  const game = fixture();
  const [builder] = rovers(game);
  assert.equal(orderBuilding(game, 'farm', point(9, 0), [builder]), null);
  const farm = game.buildings.at(-1);
  completeFixtureBuilding(game, farm);
  const rover = addUnit(game, 'rover', 4.2, 0);
  const goal = point(14, 0);
  move(rover, goal);
  let deflection = 0;
  tick(game, 8, () => {
    const footprint = buildingFootprint(farm);
    assert(distance(rover, farm) >= footprint.radius + unitClearance('rover') - 1e-6);
    deflection = Math.max(deflection, Math.abs(rover.z));
  });
  assert(deflection > 1.6);
  assert(distance(rover, goal) < 0.1);
  assert.equal(rover.order, null);
});

test('a construction rover fits through a narrow gap between buildings', () => {
  const game = fixture();
  const [rover] = rovers(game);
  for (const z of [-10, -6]) {
    assert.equal(orderBuilding(game, 'farm', point(11, z), [rover]), null);
    completeFixtureBuilding(game, game.buildings.at(-1));
    setUnitOrder(rover, null);
  }
  Object.assign(rover, point(7, -8));
  const goal = point(16, -8);
  assert(game.world.navigation.clearLine(rover, goal, unitClearance('rover')));
  assert(!game.world.navigation.clearLine(rover, goal, unitClearance('skirmisher')));
  move(rover, goal);
  tick(game, 4, () => closeTo(rover.z, goal.z));
  assert(distance(rover, goal) < 0.1);
  assert.equal(rover.order, null);
});

test('traffic reroutes stop looking when a nearby destination remains occupied', () => {
  const navigation = new Navigation({ minX: -75, minZ: -75, maxX: 75, maxZ: 75 }, []);
  const from = point(0, 0);
  const target = point(7, 0);
  let checks = 0;
  const trafficAllows = (a, b) => {
    checks++;
    return pointSegmentDistance(target, a, b) >= 0.5;
  };
  assert(!navigation.route(from, target, unitClearance('rover'), 0.06, null, null, trafficAllows).reaches);
  assert(checks < 1400, `Used ${checks} collision checks for a nearby occupied destination`);
  assert(navigation.route(from, target, unitClearance('rover'), 0.06).reaches);
});

test('a ridge blocks buildings, fire and direct travel, with a route around its end', () => {
  const game = createGame(3769694225);
  const { world } = game;
  const ridge = world.ridges.find((candidate) => {
    const mid = point((candidate.a.x + candidate.b.x) / 2, (candidate.a.z + candidate.b.z) / 2);
    return territoryOwner(world, mid) === game.country;
  });
  assert(ridge);
  const mid = point((ridge.a.x + ridge.b.x) / 2, (ridge.a.z + ridge.b.z) / 2);
  const gap = distance(ridge.a, ridge.b);
  const dx = (ridge.b.z - ridge.a.z) / gap * (ridge.radius + 2);
  const dz = (ridge.a.x - ridge.b.x) / gap * (ridge.radius + 2);
  const start = point(mid.x + dx, mid.z + dz);
  const end = point(mid.x - dx, mid.z - dz);
  assert.match(buildingSite(game, 'wall', mid).error, /ridge/i);
  assert.equal(world.navigation.clearShot(start, end), false);
  assert.equal(world.navigation.clearLine(start, end, 0.5), false);
  const route = world.navigation.route(start, end, 0.5, 0.01);
  assert(route.reaches);
  assert(route.points.length >= 2);
  for (const [index, waypoint] of route.points.entries()) {
    assert(world.navigation.clearLine(index ? route.points[index - 1] : start, waypoint, 0.5));
  }
});

test('units steer around one another and park beside an occupied waypoint', () => {
  const game = fixture();
  const [mover, parked] = rovers(game);
  Object.assign(mover, point(6, -4));
  Object.assign(parked, point(9, -4));
  const spacing = unitHitRadius(mover.type) + unitHitRadius(parked.type);
  const checkSpacing = () => assert(distance(mover, parked) >= spacing - 0.0001);
  move(mover, point(15, -4));
  tick(game, 4, checkSpacing);
  assert(distance(mover, point(15, -4)) < 0.1);
  move(mover, parked);
  tick(game, 3, checkSpacing);
  assert.equal(mover.order, null);
  assert(distance(mover, parked) < spacing + 0.15);
  assert.deepEqual(point(parked.x, parked.z), point(9, -4));
});

test('two rovers moving head-on can pass while keeping their collision footprints apart', () => {
  const game = fixture();
  const [left, right] = rovers(game);
  const start = point(7, -10);
  const end = point(15, -10);
  Object.assign(left, start);
  Object.assign(right, end);
  move(left, end);
  move(right, start);
  const spacing = unitHitRadius(left.type) + unitHitRadius(right.type);
  tick(game, 5, () => assert(distance(left, right) >= spacing - 0.0001));
  assert(distance(left, end) < 0.1);
  assert(distance(right, start) < 0.1);
});

test('a single aimed wall can face any angle and clicked extensions snap to its exposed end', () => {
  const game = fixture();
  const start = point(7, -12);
  const end = point(9, -11);
  const first = aimedWallSite(game, start, end);
  assert.equal(first.error, undefined);
  assert.deepEqual(first.wall, { a: start, b: end });
  assert.equal(orderBuilding(game, 'wall', first, rovers(game), true), null);
  const click = buildingSite(game, 'wall', point(10.1, -10.4));
  assert.equal(click.error, undefined);
  assert.deepEqual(click.wall.a, end);
  closeTo(click.wall.b.x, end.x + WALL_LENGTH * 2 / Math.sqrt(5));
  closeTo(click.wall.b.z, end.z + WALL_LENGTH / Math.sqrt(5));
  assert.equal(orderBuilding(game, 'wall', click, rovers(game), true), null);
  const corner = aimedWallSite(game, point(click.wall.b.x + 0.2, click.wall.b.z), point(click.wall.b.x, click.wall.b.z + 1.8));
  assert.equal(corner.error, undefined);
  assert.deepEqual(corner.wall.a, click.wall.b);
  closeTo(corner.wall.b.x, corner.wall.a.x);
  assert(corner.wall.b.z > corner.wall.a.z);
  assert.match(aimedWallSite(game, end, point(8.35, -11.325)).error, /occupied/);
});

test('freehand wall corners join and rovers can construct an enclosure', () => {
  const game = fixture();
  const [a, b, c, d] = [point(7, -12), point(13, -12), point(13, -6), point(7, -6)];
  const sites = wallStrokeSites(game, [a, b, c, d, a]);
  assert(sites.length >= 12);
  assert(sites.every((site) => !site.error));
  for (const [index, site] of sites.entries()) {
    assert(distance(site.wall.b, sites[(index + 1) % sites.length].wall.a) < 1e-6);
    assert.equal(orderBuilding(game, 'wall', site, rovers(game), true), null);
  }
  tick(game, 52);
  const walls = game.buildings.filter(({ type }) => type === 'wall');
  assert(walls.every((wall) => wall.progress === 1 && wall.health >= 640));
  assert.equal(BUILDINGS.wall.tier, 1);
});

test('canceling queued or partly built wall segments refunds resources and releases their footprints', () => {
  const game = fixture();
  const [builder] = rovers(game);
  const startingMetal = game.resources.metal;
  const sites = wallStrokeSites(game, [point(7, -8), point(14, -8)]);
  for (const site of sites) assert.equal(orderBuilding(game, 'wall', site, [builder]), null);
  const [active, queued, next] = game.buildings.slice(1);
  const { navigation } = game.world;
  assert(isBlueprint(active) && isBlueprint(queued));
  assert.equal(game.resources.metal, startingMetal);
  assert(!navigation.intersects(queued, queued));
  assert.match(buildingSite(game, 'wall', queued).error, /occupied/);
  Object.assign(builder, point(active.x, active.z + 1.25));
  tick(game, 1);
  assert(active.progress > 0 && active.progress < 1);
  assert(navigation.intersects(active, active));
  closeTo(startingMetal - game.resources.metal, BUILDINGS.wall.cost.metal * active.progress);
  const stock = game.resources.metal;
  assert.equal(removeBuilding(game, queued, 'cancel'), null);
  closeTo(game.resources.metal, stock);
  assert.equal(builder.order.building, active);
  assert.deepEqual(builder.queuedOrders.map(({ building }) => building), [next]);
  assert(!navigation.intersects(queued, queued));
  assert.equal(removeBuilding(game, active, 'cancel'), null);
  assert.equal(builder.order.building, next);
  assert(!navigation.intersects(active, active));
  closeTo(game.resources.metal, startingMetal);
  assert(removeBuilding(game, active, 'cancel'));
  completeFixtureBuilding(game, next);
  assert.match(removeBuilding(game, next, 'cancel'), /finished/);
  assert(game.buildings.includes(next));
});

test('canceling a farm clears the biomass deposit for an extractor', () => {
  const game = createGame(3769694225, { gatherables: [] });
  const grove = game.world.deposits.find(({ id }) => id === 'forest-near');
  const resources = { ...game.resources };
  const [builder] = rovers(game);
  assert.equal(orderBuilding(game, 'farm', grove, [builder]), null);
  assert.match(buildingSite(game, 'bio', grove).error, /occupied/);
  assert.equal(removeBuilding(game, game.buildings.at(-1), 'cancel'), null);
  assert.deepEqual(game.resources, resources);
  assert.equal(orderBuilding(game, 'bio', grove, [builder]), null);
  assert.equal(game.buildings.at(-1).deposit, grove);
});

test('projected production can fund a building whose upfront cost exceeds the stockpile', () => {
  const game = fixture();
  const [builder, producer] = rovers(game);
  const deposit = { ...point(14, -8), id: 'forecast-mine', type: 'metal', amount: 600 };
  game.world.deposits.push(deposit);
  assert.equal(orderBuilding(game, 'mine', deposit, [producer]), null);
  const mine = game.buildings.at(-1);
  completeFixtureBuilding(game, mine);
  setUnitOrder(producer, null);
  const intended = point(9, -4);
  const cost = BUILDINGS.solar.cost;
  game.resources.metal = cost.metal - 12;
  game.resources.biomass = cost.biomass;
  deposit.amount = 2;
  assert.match(orderBuilding(game, 'solar', intended, [builder]), /Projected metal/);
  deposit.amount = 600;
  const stock = { ...game.resources };
  assert.equal(orderBuilding(game, 'solar', intended, [builder]), null);
  const solar = game.buildings.at(-1);
  assert(isBlueprint(solar));
  assert.deepEqual(game.resources, stock);
  assert(!game.world.navigation.intersects(solar, solar));
  tick(game, BUILDINGS.solar.time + 8);
  assert.equal(solar.progress, 1);
  assert(game.world.navigation.intersects(solar, solar));
  closeTo(game.resources.biomass, 0);
});

test('funding forecasts account for materials already needed by independently working rovers', () => {
  const game = fixture();
  const [first, second] = rovers(game);
  const farmSite = point(10, -6);
  const habitatSite = point(16, -5);
  const farmCost = BUILDINGS.farm.cost;
  const habitatCost = BUILDINGS.habitat.cost;
  game.resources.metal = farmCost.metal + habitatCost.metal - 1;
  game.resources.biomass = farmCost.biomass + habitatCost.biomass;
  assert.equal(orderBuilding(game, 'farm', farmSite, [first]), null);
  const farm = game.buildings.at(-1);
  Object.assign(first, point(7.62, -6));
  tick(game, 1);
  assert(farm.progress > 0);
  assert(game.resources.metal >= habitatCost.metal);
  assert.match(orderBuilding(game, 'habitat', habitatSite, [second]), /Projected metal/);
  assert.equal(orderBuilding(game, 'habitat', habitatSite, [second], true), null);
  const habitat = game.buildings.at(-1);
  tick(game, BUILDINGS.farm.time + 2);
  assert.equal(farm.progress, 1);
  assert(isBlueprint(habitat));
  assert.equal(habitat.materialShortage, 'metal');
  closeTo(game.resources.metal, habitatCost.metal - 1);
  game.resources.metal += 1;
  tick(game, BUILDINGS.habitat.time + 2);
  assert.equal(habitat.progress, 1);
  closeTo(game.resources.metal, 0);
  closeTo(game.resources.biomass, 0);
});

test('an unfunded blueprint waits without collision and resumes once workers and materials are available', () => {
  const game = fixture();
  const [builder, visitor] = rovers(game);
  const site = point(10, -6);
  const cost = BUILDINGS.farm.cost;
  Object.assign(game.resources, { metal: 0, biomass: 0 });
  assert.match(orderBuilding(game, 'farm', site, [builder]), /Projected metal/);
  assert.equal(orderBuilding(game, 'farm', site, [builder], true), null);
  const farm = game.buildings.at(-1);
  move(visitor, site);
  tick(game, 8);
  assert(distance(visitor, site) < 0.1);
  assert(isBlueprint(farm));
  assert.equal(farm.health, 0);
  Object.assign(game.resources, cost);
  tick(game, 1);
  assert(farm.blockedFootprint);
  assert.equal(game.resources.metal, cost.metal);
  move(visitor, point(site.x + 4, site.z));
  tick(game, 3);
  assert(farm.progress > 0 && farm.progress < 1);
  closeTo(cost.metal - game.resources.metal, cost.metal * farm.progress);
  closeTo(cost.biomass - game.resources.biomass, cost.biomass * farm.progress);

  const fraction = 0.0002;
  game.resources.metal = cost.metal * fraction;
  const progress = farm.progress;
  const biomass = game.resources.biomass;
  tick(game, 1);
  closeTo(farm.progress, progress + fraction);
  closeTo(game.resources.metal, 0);
  closeTo(biomass - game.resources.biomass, cost.biomass * fraction);
  assert.equal(farm.materialShortage, 'metal');
  tick(game, 1);
  closeTo(farm.progress, progress + fraction);
  game.resources.metal = cost.metal * (1 - farm.progress);
  tick(game, BUILDINGS.farm.time);
  assert.equal(farm.progress, 1);
  closeTo(game.resources.metal, 0);
  closeTo(game.resources.biomass, 0);
});

test('wartime territory permits structures and extractors while enemy footprints still block placement', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  const builder = rovers(game)[0];
  const site = point(28, 1);
  const ore = { ...point(28, 8), id: 'wartime-ore', type: 'metal', amount: 1000 };
  game.world.deposits.push(ore);
  assert.match(buildingSite(game, 'solar', site).error, /at war/);
  assert(!availableConstructionDeposits(game, 'mine').includes(ore));
  assert.equal(game.diplomacy.beginIncident(game.country, enemy.country, 'declaration'), null);
  assert.match(buildingSite(game, 'solar', site).error, /at war/);
  assert.equal(game.diplomacy.proceedToWar(game.country, enemy.country), null);
  assert.match(buildingSite(game, 'solar', enemy.home).error, /occupied/);
  assert.match(buildingSite(game, 'solar', point(72, 0)).error, /at war/);
  assert(availableConstructionDeposits(game, 'mine').includes(ore));
  assert.equal(orderBuilding(game, 'solar', site, [builder]), null);
  assert.equal(orderBuilding(game, 'mine', ore, [builder], true), null);
  assert.equal(game.buildings.at(-1).deposit, ore);
  assert.equal(territoryOwner(game.world, site), enemy.country);
});

test('a ceasefire pauses wartime construction until war is declared again', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  const site = point(29, 0);
  const builder = addUnit(game, 'rover', 25, 0);
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  assert.equal(orderBuilding(game, 'farm', site, [builder]), null);
  const farm = game.buildings.at(-1);
  tick(game, 2);
  assert(farm.progress > 0 && farm.progress < 1);
  const progress = farm.progress;
  const { offer } = game.diplomacy.propose(game.country, enemy.country, { offered: {}, requested: {}, duration: 60 });
  assert.equal(game.diplomacy.accept(enemy.country, game.country, offer.id), null);
  assert.match(buildingSite(game, 'solar', point(29, 7)).error, /at war/);
  tick(game, 61);
  assert.equal(farm.progress, progress);
  assert.equal(builder.order.building, farm);
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  tick(game, 30);
  assert.equal(farm.progress, 1);
});

test('a wall stops automatic fire and movement until a manual attack opens a breach', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  const corners = [point(26, -4.8), point(34, -4.8), point(34, 4.8), point(26, 4.8)];
  for (const site of wallStrokeSites(enemy, [...corners, corners[0]])) {
    assert.equal(orderBuilding(enemy, 'wall', site, rovers(enemy), true), null);
    completeFixtureBuilding(game, enemy.buildings.at(-1));
  }
  for (const unit of rovers(enemy)) setUnitOrder(unit, null);
  const breach = enemy.buildings.find((building) => building.wall && building.x === 26 && Math.abs(building.z - 1.2) < 0.01);
  assert(breach);
  const infantry = addUnit(game, 'infantry', 24, 1.2);
  const defender = addUnit(enemy, 'infantry', 27.3, 1.2);
  const scout = addUnit(game, 'scout', 23, 1.2);
  const goal = point(30, 1.2);
  const initialHealth = [infantry.health, defender.health, breach.health];
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  move(scout, goal);
  tick(game, 2);
  assert.deepEqual([infantry.health, defender.health, breach.health], initialHealth);
  assert(scout.x < breach.x);
  breach.health = 1;
  assert.deepEqual(orderFactionAttack(game, [infantry], breach), {});
  tick(game, 2);
  assert(!enemy.buildings.includes(breach));
  assert(distance(scout, goal) < 0.1);
});

test('infantry can approach and disable a foreign Command Center during war', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  enemy.units.length = 0;
  const command = enemy.buildings[0];
  const infantry = addUnit(game, 'infantry', command.x - 9, command.z);
  command.health = 22;
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  assert.deepEqual(orderFactionAttack(game, [infantry], command), {});
  tick(game, 6);
  assert.equal(command.health, 0);
  assert.equal(enemy.buildings[0], command);
});

test('a disabled Command with a surviving rover can recover under AI control', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  enemy.controller = 'ai';
  enemy.supplySites = [];
  enemy.nextDecision = 0;
  const command = enemy.buildings[0];
  command.health = 0;
  tick(game, 2);
  assert(!enemy.defeat);
  assert(command.health > 0);
  assert(rovers(enemy).some((unit) => unit.order?.kind === 'repair' && unit.order.building === command));
});

test('losing Command and every rover ends the war and cancels hostile orders', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  enemy.controller = 'ai';
  enemy.nextDecision = Infinity;
  const command = game.buildings[0];
  command.health = 10;
  const [lastRover, ...lost] = rovers(game);
  for (const rover of lost) rover.health = 0;
  Object.assign(lastRover, point(-6, 0));
  const tank = addUnit(enemy, 'vanguard', 6.2, 0);
  const patrol = addUnit(enemy, 'infantry', 8, 5);
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  assert.deepEqual(orderFactionAttack(enemy, [tank], command), {});
  tick(game, 0.05);
  assert.equal(command.health, 0);
  assert(!game.defeat);
  assert.equal(game.diplomacy.warCount(enemy.country), 1);

  setUnitOrder(patrol, { kind: 'move', ...point(7, 7), intentFaction: game.country });
  lastRover.health = 0;
  const previousMap = game.world.territoryMap;
  tick(game, 0.05);
  assert.equal(game.defeat.by, enemy.country);
  assert.equal(game.diplomacy.warCount(enemy.country), 0);
  assert.equal(game.diplomacy.between(game.country, enemy.country).state, 'Defeated');
  assert.equal(tank.order, null);
  assert.equal(patrol.order, null);
  assert.notEqual(game.world.territoryMap, previousMap);
  assert.equal(territoryOwner(game.world, game.home), null);
  assert.match(game.diplomacy.beginIncident(enemy.country, game.country, 'declaration'), /defeat/i);
  assert(enemy.messages.some(({ message }) => message.includes('forces have stood down')));
});

test('a Vanguard fires a tracked shell at extended range without turning away from its move order', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  enemy.units.length = 0;
  const target = addUnit(enemy, 'scout', 28, 0);
  const tank = addUnit(game, 'vanguard', 22, 0);
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  move(tank, point(22, 9));
  tick(game, 0.2);
  assert(tank.z > 0.5);
  closeTo(tank.heading, 0);
  assert(tank.aim > 1.3);
  assert.equal(tank.order.kind, 'move');
  assert.equal(target.health, UNITS.scout.health - UNITS.vanguard.combat.damage);
  const [shell] = game.world.shells;
  assert.equal(shell.type, 'vanguard');
  assert(shell.from.z > 0 && shell.from.z < tank.z);
  assert.deepEqual(shell.to, point(target.x, target.z));
  tick(game, 0.6);
  assert.equal(game.world.shells.length, 0);
});

test('a Vanguard can hold the line against two Sentinels already in firing range', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  game.units.length = 0;
  enemy.units.length = 0;
  const tank = addUnit(game, 'vanguard', 22, -7);
  const guards = [-7.5, -6.5].map((z) => addUnit(enemy, 'sentinel', 25, z));
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  game.diplomacy.proceedToWar(game.country, enemy.country);
  tick(game, 9);
  assert(guards.every((guard) => guard.health === 0));
  assert(tank.health > 0 && tank.health < UNITS.vanguard.health);
});

test('two Heavy Foundries can share training and rally orders', () => {
  const game = fixture();
  const [first, second] = rovers(game);
  game.buildings[0].tier = 3;
  Object.assign(game.resources, { energy: 400, crystal: 200, biomass: 400 });
  const foundries = [point(10, -7), point(16, -7)].map((site, index) => {
    assert.equal(orderBuilding(game, 'foundry', site, [index === 0 ? first : second]), null);
    const foundry = game.buildings.at(-1);
    completeFixtureBuilding(game, foundry);
    return foundry;
  });
  assert.equal(queueTraining(game, 'vanguard', 1, foundries).facilitiesUsed, 2);
  for (const foundry of foundries) {
    setRallyPoint(foundry, point(9, -13));
    assert.equal(foundry.queue[0].type, 'vanguard');
    assert.deepEqual(foundry.rallyPoints, [point(9, -13)]);
  }
});

test('military can deliberately target civilians after war is confirmed but a ceasefire still protects them', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  const rover = rovers(enemy)[0];
  Object.assign(rover, { x: 24, z: 0 });
  const scout = addUnit(enemy, 'scout', 24, 0.5);
  const infantry = addUnit(game, 'infantry', 22, 0);
  const startingHealth = rover.health;
  assert.deepEqual(orderFactionAttack(game, [infantry], rover), { incident: true });
  tick(game, 0.2);
  assert.equal(rover.health, startingHealth);
  assert.equal(game.diplomacy.proceedToWar(game.country, enemy.country), null);
  assert.deepEqual(orderFactionAttack(game, [infantry], rover), {});
  tick(game, 0.2);
  assert(rover.health < startingHealth);

  const { offer } = game.diplomacy.propose(game.country, enemy.country, { offered: {}, requested: {}, duration: 600 });
  assert.equal(game.diplomacy.accept(enemy.country, game.country, offer.id), null);
  assert.match(orderFactionAttack(game, [infantry], scout).error, /ceasefire/);
  const scoutHealth = scout.health;
  tick(game, 2);
  assert.equal(scout.health, scoutHealth);
});

test('destroyed units and wildlife leave non-blocking remains at the casualty site until they expire', () => {
  const game = fixture();
  const enemy = game.factions.get('b');
  const attacker = addUnit(game, 'infantry', 22, 0);
  const rover = addUnit(enemy, 'rover', 24, 0);
  rover.health = 1;
  game.diplomacy.beginIncident(game.country, enemy.country, 'declaration');
  assert.equal(game.diplomacy.proceedToWar(game.country, enemy.country), null);
  assert.deepEqual(orderFactionAttack(game, [attacker], rover), {});
  const shots = [];
  updateGame(game, 0.05, shots);
  assert.deepEqual(shots, [{ weapon: 'infantry', source: { x: 22, z: 0, factionId: game.country },
    impact: { x: 24, z: 0, factionId: enemy.country, destroyed: true } }]);
  assert(!enemy.units.includes(rover));
  assert.equal(enemy.lastAttackedAt, game.time);
  assert.deepEqual(enemy.lastAttackSource, point(22, 0));
  assert.equal(game.lastAttackedAt, -Infinity);
  assert.equal(game.lastAttackSource, null);
  const remains = game.world.unitRemains;
  assert.deepEqual(remains, [{type: 'rover', factionId: enemy.country, x: 24, z: 0, heading: 0, expiresAt: game.time + UNIT_REMAINS_LIFETIME}]);
  assert(game.world.navigation.clearLine(point(23, 0), point(25, 0), unitClearance('rover')));

  game.hostiles.push({id: 'test-reptile', kind: 'reptile', x: 24, z: 1, health: 1});
  attacker.cooldown = 0;
  tick(game, 0.10);
  assert.equal(remains.length, 2);
  assert.equal(remains[1].type, 'reptile');
  assert.deepEqual(point(remains[1].x, remains[1].z), point(24, 1));
  tick(game, UNIT_REMAINS_LIFETIME - 1);
  assert.equal(remains.length, 2);
  tick(game, 2);
  assert.equal(remains.length, 0);
});

test('reptiles hunt near their dens and never follow targets into the landing zone', () => {
  const game = createGame(3769694225);
  const reptile = game.hostiles[0];
  assert(game.hostiles.length >= 9);
  assert(game.hostiles.every(({ den, leash }) => game.world.settlementHomes.every((home) => distance(den, home) >= LANDING_CLEARANCE + leash)));
  assert(game.hostiles.every(({ factionId }) => factionId === undefined));
  const scout = addUnit(game, 'scout', reptile.x + 0.5, reptile.z);
  const health = scout.health;
  tick(game, 0.1);
  assert(scout.health < health);
  assert(game.lastAttackedAt > 0 && game.lastAttackedAt <= game.time);
  assert(distance(game.lastAttackSource, reptile) < 0.6);
  Object.assign(scout, game.home);
  const safeHealth = scout.health;
  tick(game, 8, () => {
    assert(distance(reptile, reptile.den) <= reptile.leash + 1e-4);
    assert(game.world.settlementHomes.every((home) => distance(reptile, home) >= LANDING_CLEARANCE));
  });
  assert.equal(scout.health, safeHealth);
});

test('unseen and previously explored terrain both have darker fog', () => {
  const fog = createFog();
  updateFog(fog, [{ x: 0, z: 0, vision: 10 }]);
  const explored = fog.explored.findIndex(Boolean);
  const unseen = fog.explored.findIndex((value) => !value);
  updateFog(fog, []);
  assert.equal(fog.shade[explored], 71);
  assert.equal(fog.shade[unseen], 120);
});

test('a Tier II reclaimer is paused by default and pays inputs for either recipe', () => {
  const game = fixture();
  const builder = rovers(game)[0];
  Object.assign(game.resources, { energy: 400, food: 300, biomass: 200 });
  assert.match(orderBuilding(game, 'reclaimer', point(9, 0), [builder]), /Tier 2/);
  game.buildings[0].tier = 2;
  assert.equal(orderBuilding(game, 'reclaimer', point(9, 0), [builder]), null);
  const reclaimer = game.buildings.at(-1);
  assert.equal(setConverterRecipe(game, reclaimer, 'metal'), null);
  assert(!productionDetails(game).conversions.has(reclaimer));
  assert.equal(setConverterRecipe(game, reclaimer, 'off'), null);
  completeFixtureBuilding(game, reclaimer);
  assert(!productionDetails(game).conversions.has(reclaimer));
  let stock = { ...game.resources };
  assert.match(setConverterRecipe(game, reclaimer, 'crystal'), /recipe/);
  assert.equal(setConverterRecipe(game, reclaimer, 'metal'), null);
  assert.equal(productionDetails(game).conversions.get(reclaimer).produced, 36);
  tick(game, 1);
  closeTo(game.resources.metal - stock.metal, 0.6);
  closeTo(stock.biomass - game.resources.biomass, 1.2);
  closeTo(stock.energy - game.resources.energy, 0.32);
  stock = { ...game.resources };
  assert.equal(setConverterRecipe(game, reclaimer, 'biomass'), null);
  tick(game, 1);
  closeTo(game.resources.biomass - stock.biomass, 0.6);
  closeTo(stock.food - game.resources.food, 1.48);
  reclaimer.health = 0;
  assert(!productionDetails(game).conversions.has(reclaimer));
});

test('a Tier III synthesizer uses only available power and sustains partial output at an empty stockpile', () => {
  const game = fixture();
  const builder = rovers(game)[0];
  Object.assign(game.resources, { energy: 500, crystal: 40, vent: 30, metal: 0, biomass: 0 });
  game.buildings[0].tier = 2;
  assert.match(orderBuilding(game, 'synthesizer', point(9, 0), [builder]), /Tier 3/);
  game.buildings[0].tier = 3;
  assert.equal(orderBuilding(game, 'synthesizer', point(9, 0), [builder]), null);
  const synthesizer = game.buildings.at(-1);
  completeFixtureBuilding(game, synthesizer);
  assert.equal(setConverterRecipe(game, synthesizer, 'metal'), null);
  game.resources.energy = 0;
  const { conversions } = productionDetails(game);
  assert.equal(conversions.get(synthesizer).limitingResource, 'energy');
  closeTo(conversions.get(synthesizer).produced, 8.64);
  tick(game, 1);
  closeTo(game.resources.metal, 0.144);
  closeTo(game.resources.energy, 0);
  assert.equal(setConverterRecipe(game, synthesizer, 'biomass'), null);
  tick(game, 1);
  closeTo(game.resources.biomass, 0.224);
  closeTo(game.resources.energy, 0);
});

test('harvesting a tree removes its movement blocker and clears a biomass yard footprint', () => {
  const tree = { ...point(10, 0), id: 'tree', kind: 'tree', type: 'biomass', radius: 0.6, surface: 10 };
  const game = fixture([tree]);
  const grove = { ...point(10, 0.8), id: 'grove', type: 'biomass', amount: 100, surface: 100 };
  game.world.deposits.push(grove);
  assert.match(buildingSite(game, 'bio', grove).error, /Harvest the trees/);
  assert.equal(game.world.navigation.clearLine(point(7, 0), point(13, 0), 0.4), false);
  const rover = rovers(game)[0];
  Object.assign(rover, point(7, 0));
  setUnitOrder(rover, { kind: 'harvest', deposit: tree, remaining: tree.surface, ...point(tree.x, tree.z) });
  const biomass = game.resources.biomass;
  tick(game, 6);
  assert.equal(tree.surface, 0);
  assert.deepEqual(game.world.harvestedGatherables, [tree]);
  closeTo(game.resources.biomass - biomass, 10);
  assert.equal(game.world.navigation.clearLine(point(7, 0), point(13, 0), 0.4), true);
  move(rover, point(7, 0));
  tick(game, 1);
  assert.equal(orderBuilding(game, 'bio', grove, [rover]), null);
  assert.equal(game.buildings.at(-1).deposit, grove);
  assert.equal(grove.amount, 100);
});

test('harvest patrol clears its area before gathering nearby trees and rocks without roaming farther', () => {
  const tree = { ...point(10, 6), id: 'tree', kind: 'tree', type: 'biomass', radius: 0.6, surface: 9 };
  const rock = { ...point(14, 6), id: 'rock', kind: 'rock', type: 'metal', surface: 13 };
  const outside = { ...point(17, 6), id: 'outside', kind: 'rock', type: 'metal', surface: 16 };
  const nearbyTree = { ...point(17, 10), id: 'nearby-tree', kind: 'tree', type: 'biomass', radius: 0.6, surface: 8 };
  const distant = { ...point(28, 6), id: 'distant', kind: 'rock', type: 'metal', surface: 16 };
  const game = fixture([tree, rock, outside, nearbyTree, distant]);
  game.world.deposits.length = 0;
  const area = { minX: 8, maxX: 16, minZ: 4, maxZ: 9 };
  const workers = rovers(game).slice(0, 2);
  assert.equal(orderHarvestPatrol(game, workers, area), null);
  tick(game, 25, () => {
    if (tree.surface > 0 || rock.surface > 0) {
      assert.equal(outside.surface, 16);
      assert.equal(nearbyTree.surface, 8);
    }
  });
  assert.equal(tree.surface, 0);
  assert.equal(rock.surface, 0);
  assert.equal(outside.surface, 0);
  assert.equal(nearbyTree.surface, 0);
  assert.equal(distant.surface, 16);
  closeTo(game.gathered.metal, 29);
  closeTo(game.gathered.biomass, 17);
  assert(workers.every((rover) => rover.order.kind === 'harvestPatrol'));
  const previous = point(workers[0].x, workers[0].z);
  tick(game, 1);
  assert(distance(previous, workers[0]) > 0.2);
});

test('an empty patrol looks for natural resources near the drawn edges', () => {
  const nearby = { ...point(21, -10), id: 'nearby', kind: 'rock', type: 'metal', surface: 12 };
  const distantCorner = { ...point(26, 0), id: 'distant', kind: 'rock', type: 'metal', surface: 12 };
  const game = fixture([nearby, distantCorner]);
  game.world.deposits.length = 0;
  const rover = rovers(game)[0];
  Object.assign(rover, point(26, 0));
  const area = { minX: -2, maxX: 18, minZ: -18, maxZ: 2,
    corners: [point(8, -18), point(18, -8), point(8, 2), point(-2, -8)] };
  assert.equal(orderHarvestPatrol(game, [rover], area), null);
  tick(game, 0.05);
  assert.equal(rover.order.target, nearby);
});

test('a patrol assigned to a tree harvests that tree first and then gathers nearby', () => {
  const tree = { ...point(12, 0), id: 'tree', kind: 'tree', type: 'biomass', radius: 0.6, surface: 5 };
  const rock = { ...point(8, 2), id: 'rock', kind: 'rock', type: 'metal', surface: 4 };
  const game = fixture([tree, rock]);
  game.world.deposits.length = 0;
  const rover = rovers(game)[0];
  Object.assign(rover, point(8, 0));
  const area = { minX: 5, maxX: 19, minZ: -7, maxZ: 7 };
  assert.equal(orderHarvestPatrol(game, [rover], area, false, tree), null);
  tick(game, 3);
  assert.equal(tree.surface, 0);
  assert.equal(rock.surface, 4);
  tick(game, 7);
  assert.equal(rock.surface, 0);
  assert.equal(rover.order.kind, 'harvestPatrol');
});

test('an empty food store warns first and then costs colonists until upkeep balances', () => {
  const game = fixture();
  game.resources.food = 10;
  updateGame(game, 0.1);
  assert(game.messages.some((entry) => /Food reserves are running low/.test(entry.message)));
  const before = game.population;
  game.resources.food = 0;
  for (let step = 0; step < 310; step++) updateGame(game, 0.1);
  assert.equal(game.population, before - 1);
  for (let step = 0; step < 20000; step++) { game.resources.food = 0; updateGame(game, 0.1); }
  assert.equal(game.population, Math.max(4, game.units.length));
});
