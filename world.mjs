import { Diplomacy, STANCE } from './diplomacy.mjs';
import { PERSONALITIES, advanceDiplomaticAI, intrusionScore, tradeValue } from './diplomacy-ai.mjs';
import { Navigation, pointSegmentDistance, segmentGap } from './navigation.mjs';
import { createPlanet, LANDING_CLEARANCE, MAP_MIN, MAP_MAX } from './planet.mjs';
import { generateGatherables } from './gatherables.mjs';
import { createTerritoryMap, territoryOwner } from './territory.mjs';

export { randomFrom } from './planet.mjs';
export { territoryOwner } from './territory.mjs';
export const MAP_MIN_X = MAP_MIN;
export const MAP_MAX_X = MAP_MAX;
export const MAP_MIN_Z = MAP_MIN;
export const MAP_MAX_Z = MAP_MAX;
export const MAP_WIDTH = MAP_MAX - MAP_MIN;
export const MAP_DEPTH = MAP_WIDTH;
export const FOG_WIDTH = MAP_WIDTH;
export const FOG_DEPTH = MAP_DEPTH;
export const WALL_LENGTH = 2.45;
export const UNIT_REMAINS_LIFETIME = 90;
const CONTACT_SURVEY_TIME = 12;
const CONTACT_SURVEY_RADIUS = 26;
const DEPOSIT_BUILD_RADIUS = 2.65;
const BUILD_LINE_SPACING = 3;
const WALL_JOINT_RADIUS = 0.95;
const PATROL_SEARCH_MARGIN = 10;

export const RESOURCES = {
  metal: { name: 'Metal', color: '#fac579' },
  biomass: { name: 'Biomass', color: '#76dfad' },
  food: { name: 'Food', color: '#e9d88d' },
  energy: { name: 'Energy', color: '#73dcf1' },
  crystal: { name: 'Crystal', color: '#c9b6ff' },
  vent: { name: 'Geothermal charge', label: 'Geo', color: '#ffc29c' },
};

export const BIOMES = {
  plains: { name: 'Fertile plains', color: '#64794e', advantage: 'Farms and Hydroponics yield the most food', output: { farm: 1.3, hydro: 2.3 } },
  forest: { name: 'Forest', color: '#365c48', advantage: 'Higher food and biomass production', output: { farm: 0.99, hydro: 1.95, bio: 1.1 } },
  mountain: { name: 'Mountains', color: '#65747b', advantage: '+25% building health and higher mine output', durability: 1.25, output: { mine: 1.65 } },
  desert: { name: 'Desert', color: '#a48655', advantage: 'Solar Arrays generate the most energy', output: { solar: 2.4 } },
  crystal: { name: 'Crystal fields', color: '#656b94', advantage: '+25% construction speed and higher crystal output', buildSpeed: 1.25, output: { crystalTap: 1.6 } },
  volcanic: { name: 'Volcanic uplands', color: '#60464b', advantage: 'More geothermal and fusion output, lower Habitat upkeep', output: { habitat: -0.048, fusion: 6, geoTap: 2 } },
};

export const COMMAND_TIERS = {
  1: { health: 520, capacity: 10, vision: 12 },
  2: { health: 720, capacity: 15, vision: 15, time: 35, cost: { metal: 100, biomass: 45, energy: 60 } },
  3: { health: 1000, capacity: 20, vision: 18, time: 55, cost: { metal: 180, biomass: 80, energy: 120 } },
};

export const ORBITAL_SURVEY = {
  cost: { metal: 90, energy: 100, crystal: 40, vent: 30 },
  time: 24,
  vision: 29,
};

export const RESEARCH = {
  optics: { name: 'Crystal Array Optics', tier: 2, time: 30, cost: { metal: 65, energy: 45, crystal: 30 },
    description: '+30% vision for Scouts, Pathfinders, Survey Drones, and Survey Relays.' },
  recovery: { name: 'Geothermal Heat Recovery', tier: 2, time: 32, cost: { metal: 55, biomass: 45, vent: 35 },
    description: 'Each working Geothermal Tap also generates 45 energy per minute.' },
  network: { name: 'Orbital Survey Network', tier: 3, time: 42, cost: { energy: 120, crystal: 60, vent: 55 },
    description: 'Expands every Survey Satellite from 29 to 40 world units of vision.' },
};
const OPTICS_TYPES = new Set(['scout', 'pathfinder', 'drone', 'relay']);

export const BUILDINGS = {
  command: { name: 'Colonial Command Center', trains: ['rover', 'scout', 'infantry'], combat: { damage: 10, range: 10, cooldown: 1 } },
  mine: { name: 'Mine', tier: 1, key: '1', shortcut: 'm', cost: { metal: 45, biomass: 15 }, time: 27, deposit: 'metal', produces: 'metal', output: 1.28, description: 'Extracts metal from deposits.' },
  solar: { name: 'Solar Array', tier: 1, key: '2', shortcut: 's', cost: { metal: 30, biomass: 10 }, time: 19, produces: 'energy', output: 1.65, description: 'Generates energy. Desert sites yield more.' },
  habitat: { name: 'Habitat', tier: 1, key: '3', shortcut: 'h', cost: { metal: 35, biomass: 30 }, time: 32, produces: 'energy', output: -0.12, description: 'Houses 5 additional colonists.' },
  farm: { name: 'Farm', tier: 1, key: '4', shortcut: 'f', cost: { metal: 25, biomass: 20 }, time: 24, produces: 'food', output: 0.72, description: 'Produces food. Fertile plains yield more.' },
  bio: { name: 'Biomass Yard', tier: 1, key: '5', shortcut: 'b', cost: { metal: 25, energy: 15 }, time: 22, deposit: 'biomass', produces: 'biomass', output: 0.88, description: 'Clear trees from a Biomass Grove to build a yard that produces biomass.' },
  wall: { name: 'Fortified Wall', tier: 1, key: '6', shortcut: 'l', cost: { metal: 8 }, time: 7, health: 640, vision: 0,
    description: 'Blocks units and weapon fire. Enemy walls require an explicit attack order.' },
  factory: { name: 'Combat Factory', tier: 2, shortcut: 'c', cost: { metal: 90, biomass: 45 }, time: 36, health: 160, trainingSpeed: 1.25, trains: ['infantry', 'skirmisher', 'sentinel', 'pathfinder'], description: 'Trains Infantry, Skirmishers, Sentinels, and Pathfinders.' },
  relay: { name: 'Survey Relay', tier: 2, shortcut: 'r', cost: { metal: 60, energy: 40 }, time: 24, vision: 26, description: 'Reveals terrain and contacts across a wide area.' },
  hydro: { name: 'Hydroponics', tier: 2, shortcut: 'g', cost: { metal: 85, biomass: 50 }, time: 33, produces: 'food', output: 1.7, description: 'Produces more food than a Farm.' },
  tower: { name: 'Defense Tower', tier: 2, shortcut: 'w', cost: { metal: 65, energy: 35 }, time: 27, health: 145, vision: 7, combat: { damage: 12, range: 11, cooldown: 0.95 }, description: 'Automatically fires at nearby hostiles.' },
  crystalTap: { name: 'Crystal Extractor', tier: 2, shortcut: 'x', cost: { metal: 75, energy: 45 }, time: 31, deposit: 'crystal', produces: 'crystal', output: 1.15, description: 'Place on a crystal formation to extract crystal.' },
  geoTap: { name: 'Geothermal Tap', tier: 2, shortcut: 'v', cost: { metal: 70, biomass: 35 }, time: 30, deposit: 'vent', produces: 'vent', output: 1.35, description: 'Place on a geothermal vent to collect geothermal charge.' },
  reclaimer: { name: 'Resource Reclaimer', tier: 2, shortcut: 'p', cost: { food: 30, energy: 65 }, time: 32, health: 150,
    description: 'Turns biomass into metal or surplus food into biomass. Both recipes consume energy.',
    conversion: { metal: { inputs: { biomass: 72, energy: 48 }, output: 36 },
      biomass: { inputs: { food: 78, energy: 36 }, output: 36 } } },
  foundry: { name: 'Heavy Foundry', tier: 3, shortcut: 'd', cost: { metal: 155, biomass: 70, crystal: 35 }, time: 48, health: 210, trains: ['vanguard', 'siege', 'drone'], description: 'Trains Vanguards, Siege Crawlers, and Survey Drones.' },
  fusion: { name: 'Fusion Plant', tier: 3, shortcut: 'e', cost: { metal: 140, biomass: 70, vent: 45 }, time: 44, produces: 'energy', output: 4.2, description: 'Generates large amounts of energy. Volcanic sites yield more.' },
  bastion: { name: 'Defense Bastion', tier: 3, shortcut: 't', cost: { metal: 125, crystal: 20, vent: 20 }, time: 38, health: 240, vision: 9, combat: { damage: 19, range: 14, cooldown: 0.8 }, description: 'Automatically engages nearby hostiles.' },
  uplink: { name: 'Orbital Uplink', tier: 3, shortcut: 'u', cost: { metal: 165, biomass: 60, crystal: 35, vent: 35 }, time: 46, health: 185, vision: 12, description: 'Launches a Survey Satellite for permanent vision over a chosen area.' },
  synthesizer: { name: 'Matter Synthesizer', tier: 3, shortcut: 'y', cost: { energy: 100, crystal: 35, vent: 25 }, time: 45, health: 185,
    description: 'Uses large amounts of energy to synthesize metal or biomass without a deposit.',
    conversion: { metal: { inputs: { energy: 240 }, output: 72 },
      biomass: { inputs: { energy: 180 }, output: 84 } } },
};

export const UNITS = {
  rover: { name: 'Construction Rover', label: 'Rover', speed: 3.1, vision: 6.5, health: 90, time: 18, cost: { metal: 25, energy: 12 },
    role: 'Builds and repairs structures, gathers resources, and captures relays.' },
  scout: { name: 'Scout', label: 'Scout', speed: 5.2, vision: 10, health: 65, time: 19, cost: { metal: 28, energy: 16 },
    role: 'Fast early reconnaissance for finding resources and routes.' },
  infantry: { name: 'Infantry', label: 'Infantry', speed: 3.6, vision: 6, health: 85, time: 16, cost: { metal: 18, food: 12 },
    role: 'Low-cost defenders and rover escorts.', combat: { damage: 11, range: 3.7, cooldown: 0.85 } },
  skirmisher: { name: 'Skirmisher', label: 'Skirmisher', model: 'rover', scale: 1.15, speed: 4.4, vision: 9, health: 120, time: 21, cost: { metal: 42, energy: 22 },
    role: 'Fast gun vehicle for flanking and firing on the move.', combat: { damage: 13, range: 5.6, cooldown: 0.75, shell: 0.24 } },
  sentinel: { name: 'Sentinel', label: 'Sentinel', model: 'infantry', scale: 1.3, speed: 3.0, vision: 8, health: 155, time: 22, cost: { metal: 38, food: 24 },
    role: 'Armored infantry for holding chokepoints and guarding vehicles.', combat: { damage: 18, range: 4.4, cooldown: 0.95 } },
  pathfinder: { name: 'Pathfinder', label: 'Pathfinder', model: 'scout', scale: 1.2, speed: 6.4, vision: 14, health: 95, time: 20, cost: { metal: 34, energy: 30 },
    role: 'Faster scout with a wider view for screening an advance.' },
  vanguard: { name: 'Vanguard', label: 'Vanguard', model: 'rover', scale: 1.55, speed: 3.0, vision: 11, health: 340, time: 32, cost: { metal: 88, energy: 42 },
    role: 'Heavy frontline tank built to absorb fire and sustain an attack.', combat: { damage: 44, range: 7.2, cooldown: 1.1, shell: 0.32 } },
  siege: { name: 'Siege Crawler', label: 'Siege Crawler', model: 'rover', scale: 1.7, speed: 2.25, vision: 12, health: 225, time: 34, cost: { metal: 95, energy: 58 },
    role: 'Long-range siege gun for hitting structures from behind an escort.', combat: { damage: 64, range: 10.5, cooldown: 2, shell: 0.45 } },
  drone: { name: 'Survey Drone', label: 'Survey Drone', model: 'scout', scale: 0.95, speed: 8, vision: 19, health: 70, time: 24, cost: { metal: 54, energy: 48 },
    role: 'Fast, light scout with the widest vision of any mobile unit.' },
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const distance = (a, b) => Math.sqrt(distanceSquared(a, b));

export function createWorld(seed, factions) {
  return createPlanet(seed, Object.keys(BIOMES), factions);
}

function createColony(world, definition) {
  const { home, id: country, name = country, controller = 'ai', personality = 'balanced', conquestTarget } = definition;
  const state = {
    world, home, country, name, controller, conquestTarget,
    personality: { ...PERSONALITIES.balanced, ...(typeof personality === 'string' ? PERSONALITIES[personality] : personality) },
    time: 0, lastAttackedAt: -Infinity, lastAttackSource: null,
    resources: { metal: 65, biomass: 38, food: 52, energy: 40, crystal: 0, vent: 0, ...definition.resources },
    units: [], buildings: [], queue: [], satellites: [], research: new Set(), researchProject: null,
    messages: [], nextId: 1,
    population: 10, gathered: { metal: 0, biomass: 0 }, recruited: 0, contacts: 0,
    knownFactions: new Set(), surveyedFactions: new Map(), sightings: new Set(), nextDecision: 1, lastAction: 'Landing at Command',
  };
  const command = { id: 0, factionId: country, type: 'command', ...home, biome: world.sample(home.x, home.z), tier: 1,
    progress: 1, rallyPoints: [], repeatProduction: false, repeatBacklog: [] };
  command.health = maxBuildingHealth(command);
  state.buildings.push(command);
  const starters = [
    ['rover', -3.4, 2.2], ['rover', -1.5, 3.75], ['rover', 0.5, 4.0],
    ['scout', 3.65, 0.6], ['infantry', 2.0, 3.5], ['infantry', 3.45, 2.8],
  ];
  for (const [type, x, z] of starters) addUnit(state, type, home.x + x, home.z + z);
  return state;
}

export function createGame(seed, options = {}) {
  const custom = options.factions;
  if (custom && (!custom.length || new Set(custom.map(({ id }) => id)).size !== custom.length
    || custom.some(({ id, home }) => typeof id !== 'string' || !id || !Number.isFinite(home?.x) || !Number.isFinite(home?.z)))) {
    throw new Error('Configure unique faction IDs and valid home coordinates.');
  }
  const world = createWorld(seed, custom);
  const definitions = world.startingFactions;
  const focal = definitions.find(({ id }) => id === options.localFaction)
    ?? definitions.find(({ controller }) => controller === 'human') ?? definitions[0];
  world.localFaction = focal.id;
  world.defeatedFactions = new Set();
  world.home = focal.home;
  world.territories = options.territories ?? (custom ? null : definitions.map(({ id, sector }) => ({ ...world.sectors[sector], faction: id })));
  if (custom && !world.territories) world.factionHomes = new Map(definitions.map(({ id, home }) => [id, home]));
  if (world.territories?.some(({ faction }) => !definitions.some(({ id }) => id === faction))) {
    throw new Error('A territory references an unknown faction.');
  }
  world.territoryMap = createTerritoryMap(world);
  world.navigation = new Navigation({ minX: MAP_MIN_X, maxX: MAP_MAX_X, minZ: MAP_MIN_Z, maxZ: MAP_MAX_Z }, world.ridges);
  const biomes = Object.keys(BIOMES);
  world.gatherables = options.gatherables ?? generateGatherables(world, biomes.indexOf('forest'), biomes.length);
  world.harvestedGatherables = [];
  world.unitRemains = [];
  world.shells = [];
  for (const node of world.gatherables) {
    if (node.kind === 'tree' && node.surface > 0) {
      world.navigation.addStructure(node, { a: node, b: node, kind: 'tree', radius: node.radius, entity: node });
    }
  }
  const hostiles = world.wildlife;
  const factions = new Map(definitions.map((definition) => [definition.id, createColony(world, definition)]));
  for (const colony of factions.values()) {
    Object.assign(colony, { factions, hostiles });
    world.navigation.addStructure(colony.buildings[0], buildingFootprint(colony.buildings[0]));
    if (colony.controller === 'ai') {
      colony.supplySites = world.deposits.filter((site) => site.surface !== undefined && territoryOwner(world, site) === colony.country);
    }
  }
  const diplomacy = new Diplomacy(factions, {
    log, strength: militaryStrength, fieldStrength, value: tradeValue, territorialValue, resources: Object.keys(RESOURCES),
    resourceName: (type) => RESOURCES[type].name.toLowerCase(),
    commandIntegrity: (id) => { const command = factions.get(id).buildings[0]; return command ? command.health / maxBuildingHealth(command) : 0; },
    contact: (a, b) => {
      factions.get(a).knownFactions.add(b);
      factions.get(b).knownFactions.add(a);
    },
    intruders: (a, b) => intrudingUnits(factions.get(a), b),
    withdraw: (a, b) => withdrawForces(factions.get(a), b),
    stopAttacks: (a, b) => {
      cancelAttacks(factions.get(a), b);
      cancelAttacks(factions.get(b), a);
    },
  }, options.diplomacy);
  for (const colony of factions.values()) colony.diplomacy = diplomacy;
  const state = factions.get(focal.id);
  log(state, 'Command Center operational. Landing zone secured.');
  return state;
}

export function addUnit(state, type, x, z) {
  const unit = { id: state.nextId++, factionId: state.country, type, x, z, heading: 0, health: UNITS[type].health,
    territory: state.country, order: null, queuedOrders: [], work: null, cooldown: 0 };
  state.units.push(unit);
  return unit;
}

export function setUnitOrder(unit, order, append = false) {
  if (!append) unit.queuedOrders.length = 0;
  if (append && unit.order) unit.queuedOrders.push(order);
  else {
    unit.order = order;
    unit.work = null;
    unit.route = null;
  }
}

export function finishUnitOrder(unit) {
  unit.order = unit.queuedOrders.shift() || null;
  unit.work = null;
  unit.route = null;
}

export function orderHarvestPatrol(state, units, area, append = false, firstTarget = null) {
  const workers = units.filter((unit) => unit.type === 'rover' && unit.health > 0 && state.units.includes(unit));
  if (!workers.length) return 'Select a construction rover to patrol.';
  const { minX, maxX, minZ, maxZ } = area;
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || minX >= maxX || minZ >= maxZ) return 'Choose a patrol area.';
  const corners = area.corners ?? [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
  const lead = firstTarget && workers.reduce((closest, worker) =>
    distance(worker, firstTarget) < distance(closest, firstTarget) ? worker : closest);
  for (const [index, worker] of workers.entries()) {
    setUnitOrder(worker, { kind: 'harvestPatrol', area, corners, corner: index % corners.length,
      target: worker === lead ? firstTarget : null, searchAt: 0, walkAt: 0, blocked: new Map() }, append);
  }
  return null;
}

export function setRallyPoint(building, point, append = false) {
  if (!append) building.rallyPoints.length = 0;
  building.rallyPoints.push({ x: point.x, z: point.z });
}

function visionRadius(entity) {
  return entity.vision ?? UNITS[entity.type]?.vision ?? (entity.type === 'command'
    ? COMMAND_TIERS[entity.tier ?? 1].vision : BUILDINGS[entity.type]?.vision ?? 5);
}

export function sightSources(state) {
  const sources = [...state.units, ...state.buildings.filter((building) => building.progress === 1 && building.health > 0 && building.type !== 'wall')];
  if (state.research.has('optics')) {
    for (const [index, source] of sources.entries()) {
      if (OPTICS_TYPES.has(source.type)) sources[index] = { x: source.x, z: source.z, vision: visionRadius(source) * 1.3 };
    }
  }
  sources.push(...state.world.outposts.filter((site) => site.relay && site.owner === state.country));
  sources.push(...state.satellites);
  for (const [id, until] of state.surveyedFactions) {
    if (until <= state.time) continue;
    const faction = state.factions.get(id);
    sources.push({ ...faction.home, vision: CONTACT_SURVEY_RADIUS });
    for (const site of [...faction.buildings, ...faction.units]) {
      if (distance(site, faction.home) > CONTACT_SURVEY_RADIUS - 4) sources.push({ ...site, vision: 5 });
    }
  }
  return sources;
}

export function inSight(point, sources) {
  return sources.some((source) => distanceSquared(point, source) <= visionRadius(source) ** 2);
}

export function createFog() {
  const size = FOG_WIDTH * FOG_DEPTH;
  return { shade: new Uint8Array(size), explored: new Uint8Array(size), visibility: new Uint8Array(size) };
}

export function updateFog(fog, sources) {
  const { shade, explored, visibility } = fog;
  const feather = 2;
  visibility.fill(0);
  for (const source of sources) {
    const radius = visionRadius(source);
    const reach = radius + feather;
    const centerX = source.x - MAP_MIN_X - 0.5;
    const centerZ = source.z - MAP_MIN_Z - 0.5;
    const left = Math.max(0, Math.floor(centerX - reach));
    const right = Math.min(FOG_WIDTH - 1, Math.ceil(centerX + reach));
    const top = Math.max(0, Math.floor(centerZ - reach));
    const bottom = Math.min(FOG_DEPTH - 1, Math.ceil(centerZ + reach));
    for (let z = top; z <= bottom; z++) {
      const dzSquared = (z - centerZ) ** 2;
      for (let x = left; x <= right; x++) {
        const index = z * FOG_WIDTH + x;
        const gap = Math.sqrt((x - centerX) ** 2 + dzSquared);
        const light = clamp((reach - gap) / (2 * feather), 0, 1);
        if (gap <= radius) explored[index] = 1;
        visibility[index] = Math.max(visibility[index], Math.round(255 * light * light * (3 - 2 * light)));
      }
    }
  }
  for (let index = 0; index < shade.length; index++) {
    shade[index] = Math.round((explored[index] ? 71 : 120) * (1 - visibility[index] / 255));
  }
}

export function log(state, message) {
  state.messages.push({ time: state.time, message });
  if (state.messages.length > 30) state.messages.shift();
}

export function canAfford(state, cost) {
  return Object.entries(cost).every(([resource, value]) => state.resources[resource] >= value);
}

function spend(state, cost) {
  for (const [resource, amount] of Object.entries(cost)) state.resources[resource] -= amount;
}

export function capacity(state) {
  return COMMAND_TIERS[state.buildings[0].tier ?? 1].capacity
    + state.buildings.filter((building) => building.type === 'habitat' && building.progress === 1).length * 5;
}

export function maxBuildingHealth(building) {
  const base = building.type === 'command' ? COMMAND_TIERS[building.tier ?? 1].health : BUILDINGS[building.type].health ?? 100;
  return Math.round(base * (BIOMES[building.biome]?.durability ?? 1));
}

function siteOutput(type, biome) {
  return BIOMES[biome]?.output?.[type] ?? BUILDINGS[type].output ?? 0;
}

export function preferredConstructionBiome(type) {
  const biomes = Object.keys(BIOMES);
  const output = biomes.map((biome) => siteOutput(type, biome));
  const highest = Math.max(...output);
  if (highest > Math.min(...output)) return biomes[output.indexOf(highest)];
  return BUILDINGS[type].combat ? 'mountain' : 'crystal';
}

function buildingOutput(state, building) {
  return siteOutput(building.type, building.biome ?? state.world.sample(building.x, building.z));
}

export function productionDetails(state, seconds = 1) {
  // A colony with no rovers or no working mine can stall for good; Command salvages a trickle of metal so it can recover.
  const stranded = !state.units.some((unit) => unit.type === 'rover' && unit.health > 0)
    || (state.controller === 'ai' && state.resources.metal < 50
      && !state.buildings.some((building) => building.type === 'mine' && building.progress === 1 && building.health > 0));
  const salvage = state.buildings[0]?.health > 0 && stranded ? 0.25 : 0;
  const rates = { metal: salvage, biomass: 0, food: 0.15 - state.population * 0.033, energy: 0.48, crystal: 0, vent: 0 };
  const active = [];
  for (const building of state.buildings) {
    if (building.progress < 1 || building.health <= 0) continue;
    const { produces, deposit, conversion } = BUILDINGS[building.type];
    if (produces && (!deposit || building.deposit?.amount > 0)) {
      const output = buildingOutput(state, building);
      rates[produces] += deposit ? Math.min(output, building.deposit.amount / seconds) : output;
    }
    if (state.research.has('recovery') && building.type === 'geoTap' && building.deposit?.amount > 0) rates.energy += 0.75;
    if (conversion && Object.hasOwn(conversion, building.recipe)) active.push(building);
  }
  const conversions = new Map();
  if (!active.length) return { rates, conversions };
  const budget = Object.fromEntries(Object.entries(rates).map(([resource, rate]) =>
    [resource, Math.max(0, state.resources[resource] / seconds + rate)]));
  for (const building of active) {
    const { inputs, output } = BUILDINGS[building.type].conversion[building.recipe];
    let fraction = 1;
    let limitingResource;
    for (const [resource, perMinute] of Object.entries(inputs)) {
      const available = budget[resource] * 60 / perMinute;
      if (available >= fraction) continue;
      fraction = available;
      limitingResource = resource;
    }
    // Only ordinary production and existing stocks can fund recipes in this step.
    for (const [resource, perMinute] of Object.entries(inputs)) {
      const use = perMinute * fraction / 60;
      budget[resource] = Math.max(0, budget[resource] - use);
      rates[resource] -= use;
    }
    const produced = output * fraction;
    rates[building.recipe] += produced / 60;
    conversions.set(building, { produced, limitingResource });
  }
  return { rates, conversions };
}

export function production(state) {
  return productionDetails(state).rates;
}

export function setConverterRecipe(state, building, recipe) {
  const recipes = BUILDINGS[building?.type]?.conversion;
  if (!recipes || !state.buildings.includes(building)) return 'Select a resource converter.';
  if (recipe !== 'off' && !Object.hasOwn(recipes, recipe)) return 'Choose an available conversion recipe.';
  building.recipe = recipe;
  return null;
}

function canBuildAt(state, point) {
  const owner = territoryOwner(state.world, point);
  return owner === state.country || (owner !== null && state.diplomacy.canAttack(state.country, owner));
}

export function hasConstructionAccess(state, site) {
  return canBuildAt(state, site) && (!site.wall || (canBuildAt(state, site.wall.a) && canBuildAt(state, site.wall.b)));
}

function constructionDeposits(state, resource) {
  return state.world.deposits.filter((deposit) => deposit.type === resource && deposit.amount > 0 && canBuildAt(state, deposit));
}

const buildingRadii = { command: 3.05, factory: 2.05, foundry: 2.1, tower: 1.15, bastion: 1.6, mine: 1.3,
  farm: 1.6, solar: 1.65, hydro: 1.7, uplink: 1.7, reclaimer: 1.55, synthesizer: 1.65 };
const wallRadius = 0.46;
const siteClearance = 0.06;

export function isBlueprint(building) {
  return building.progress === 0 && building.paidProgress === 0;
}

export function unitClearance(type) {
  if (type === 'rover') return 0.38;
  const chassis = UNITS[type].model ?? type;
  return (chassis === 'rover' ? 0.59 : chassis === 'scout' ? 0.49 : 0.32) * (UNITS[type].scale ?? 1);
}

export function unitHitRadius(type) {
  return unitClearance(type) * 0.65;
}

function nearbyUnits(state, point, range, mover) {
  const units = [];
  for (const faction of state.factions.values()) {
    for (const unit of faction.units) {
      if (unit !== mover && unit.health > 0 && Math.abs(unit.x - point.x) <= range && Math.abs(unit.z - point.z) <= range) units.push(unit);
    }
  }
  return units;
}

function unitInPath(units, from, to, radius) {
  for (const other of units) {
    const clearance = radius + unitHitRadius(other.type);
    if (other.x < Math.min(from.x, to.x) - clearance || other.x > Math.max(from.x, to.x) + clearance
      || other.z < Math.min(from.z, to.z) - clearance || other.z > Math.max(from.z, to.z) + clearance) continue;
    const closest = pointSegmentDistance(other, from, to);
    if (closest >= clearance - 0.0001) continue;
    const start = distance(from, other);
    // Units that already overlap can move apart without getting locked together.
    if (start < clearance && closest >= start - 0.0001 && distance(to, other) > start + 0.0001) continue;
    return other;
  }
  return null;
}

export function buildingFootprint(building) {
  const { type, wall } = building;
  if (type === 'wall' && wall) return { ...wall, radius: wallRadius, kind: 'wall', entity: building };
  return { a: building, b: building, radius: buildingRadii[type] ?? 1.45, kind: 'building', entity: building };
}

function wallSegment(a, b) {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, wall: { a, b } };
}

function nearestWallEnd(state, point, radius, start) {
  let joint = null;
  for (const { wall } of state.buildings) {
    if (!wall) continue;
    for (const [end, other] of [[wall.a, wall.b], [wall.b, wall.a]]) {
      const gap = distance(point, end);
      if (gap >= radius) continue;
      if (start) {
        const length = distance(start, end);
        if (length < 0.68 || length > WALL_LENGTH + 0.12) continue;
      }
      joint = { end, other };
      radius = gap;
    }
  }
  return joint;
}

function aimedWall(state, start, dx, dz, length) {
  const direction = Math.hypot(dx, dz);
  const end = { x: start.x + length * dx / direction, z: start.z + length * dz / direction };
  return wallSegment(start, nearestWallEnd(state, end, 0.58, start)?.end ?? end);
}

function wallSite(state, point) {
  if (point.wall) return wallSegment(point.wall.a, point.wall.b);
  const joint = nearestWallEnd(state, point, WALL_LENGTH * 0.7);
  if (joint) {
    const { end, other } = joint;
    const dx = point.x - end.x;
    const dz = point.z - end.z;
    const length = distance(end, other);
    const outwardX = (end.x - other.x) / length;
    const outwardZ = (end.z - other.z) / length;
    const straight = Math.hypot(dx, dz) < 0.2 || Math.abs(dx * outwardZ - dz * outwardX) < 0.24;
    return aimedWall(state, end, straight ? outwardX : dx, straight ? outwardZ : dz, WALL_LENGTH);
  }
  const half = WALL_LENGTH / 2;
  const x = Math.round(point.x * 2) / 2;
  const z = Math.round(point.z * 2) / 2;
  return wallSegment({ x: x - half, z }, { x: x + half, z });
}

export function aimedWallSite(state, start, end) {
  const anchor = nearestWallEnd(state, start, WALL_JOINT_RADIUS)?.end ?? start;
  const length = distance(anchor, end);
  if (length < 0.16) return buildingSite(state, 'wall', end);
  const site = aimedWall(state, anchor, end.x - anchor.x, end.z - anchor.z, clamp(length, 0.68, WALL_LENGTH));
  return buildingSite(state, 'wall', site);
}

function overlapsWallSegment({ a, b }, other) {
  const length = distance(a, b);
  const dx = (b.x - a.x) / length;
  const dz = (b.z - a.z) / length;
  const offsets = [other.a, other.b].map((end) => ({ x: end.x - a.x, z: end.z - a.z }));
  if (offsets.some((offset) => Math.abs(offset.x * dz - offset.z * dx) > 0.16)) return false;
  const [first, second] = offsets.map((offset) => offset.x * dx + offset.z * dz);
  return Math.min(length, Math.max(first, second)) - Math.max(0, Math.min(first, second)) > 0.18;
}

function insideFootprint(unit, point, shape) {
  return pointSegmentDistance(point, shape.a, shape.b) < shape.radius + unitClearance(unit.type);
}

function unitsInFootprint(state, shape) {
  for (const faction of state.factions.values()) {
    if (faction.units.some((unit) => unit.health > 0 && insideFootprint(unit, unit, shape))) return true;
  }
  return false;
}

export function buildingSite(state, type, point) {
  const definition = BUILDINGS[type];
  if (!definition || type === 'command' || !point) return { error: 'Select a building site.' };
  if (definition.tier > (state.buildings[0].tier ?? 1)) return { ...point, error: `Upgrade Command to Tier ${definition.tier} first.` };
  const borderError = (site) => ({ ...site, error: 'Build in your territory or in territory held by a faction you are at war with.' });
  if (!hasConstructionAccess(state, point)) return borderError(point);
  let deposit;
  let nearest = DEPOSIT_BUILD_RADIUS;
  if (definition.deposit) {
    for (const candidate of constructionDeposits(state, definition.deposit)) {
      const gap = distance(candidate, point);
      if (gap >= nearest) continue;
      deposit = candidate;
      nearest = gap;
    }
  }
  if (definition.deposit && !deposit) {
    const name = definition.deposit === 'vent' ? 'geothermal vent' : definition.deposit === 'crystal' ? 'crystal formation'
      : `${RESOURCES[definition.deposit].name.toLowerCase()} deposit`;
    return { ...point, error: `Place on a ${name}.` };
  }
  const site = type === 'wall' ? wallSite(state, point) : deposit ? { x: deposit.x, z: deposit.z, deposit }
    : { x: Math.round(point.x * 2) / 2, z: Math.round(point.z * 2) / 2 };
  if (site.wall && distance(site.wall.a, site.wall.b) < 0.16) return { ...site, error: 'Choose two distinct wall endpoints.' };
  const shape = buildingFootprint({ ...site, type });
  if (!hasConstructionAccess(state, site)) return borderError(site);
  const { navigation } = state.world;
  if (navigation.intersects(shape.a, shape.b, shape.radius, (other) => other.kind === 'ridge')) {
    return { ...site, error: 'Uncrossable ridge. Look for a pass.' };
  }
  if (navigation.intersects(shape.a, shape.b, shape.radius, (other) => other.kind === 'tree')) {
    return { ...site, error: 'Harvest the trees in the building footprint first.' };
  }
  const overlapsStructure = (other) => (other.kind === 'building' || other.kind === 'wall')
    && (type !== 'wall' || other.kind !== 'wall' || distance(other.entity, site) < 0.68 || overlapsWallSegment(site.wall, other));
  const overlapsBlueprint = (building) => {
    if (!isBlueprint(building)) return false;
    const other = buildingFootprint(building);
    return segmentGap(shape.a, shape.b, other.a, other.b) < shape.radius + other.radius + siteClearance - 1e-7
      && overlapsStructure(other);
  };
  if (navigation.intersects(shape.a, shape.b, shape.radius + siteClearance, overlapsStructure)
    || [...state.factions.values()].some((faction) => faction.buildings.some(overlapsBlueprint))) {
    return { ...site, error: 'This site is occupied. Leave room between structures.' };
  }
  if (unitsInFootprint(state, shape)) return { ...site, error: 'Move units out of the building footprint.' };
  return site;
}

export function availableConstructionDeposits(state, type) {
  return constructionDeposits(state, BUILDINGS[type].deposit).filter((deposit) => !buildingSite(state, type, deposit).error);
}

export function recommendedConstructionDeposits(state, type, sites = availableConstructionDeposits(state, type)) {
  const output = (site) => siteOutput(type, state.world.sample(site.x, site.z));
  const best = Math.max(...sites.map(output));
  return sites.filter((site) => output(site) === best);
}

export function highlightedMines(state, selection) {
  if (!state.buildings.some((building) => building.type === 'mine' && selection.has(building.id))) return [];
  return state.buildings.filter((building) => building.type === 'mine');
}

function simplifyStroke(points, start, end, result) {
  let split = -1;
  let deviation = 0.48;
  for (let index = start + 1; index < end; index++) {
    const gap = pointSegmentDistance(points[index], points[start], points[end]);
    if (gap > deviation) { split = index; deviation = gap; }
  }
  if (split < 0) {
    result.push(points[end]);
    return;
  }
  simplifyStroke(points, start, split, result);
  simplifyStroke(points, split, end, result);
}

export function wallStrokeSites(state, points) {
  if (!points.length) return [];
  const stroke = [points[0]];
  for (const point of points.slice(1)) {
    if (distance(stroke.at(-1), point) >= 0.66) stroke.push(point);
  }
  if (stroke.length < 2) return [buildingSite(state, 'wall', points.at(-1))];
  const path = [stroke[0]];
  simplifyStroke(stroke, 0, stroke.length - 1, path);
  const snap = (point) => nearestWallEnd(state, point, WALL_JOINT_RADIUS)?.end ?? point;
  path[0] = snap(path[0]);
  path[path.length - 1] = snap(path.at(-1));
  const sites = [];
  let affordable = Math.floor(state.resources.metal / BUILDINGS.wall.cost.metal);
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1];
    const b = path[index];
    const count = Math.ceil(distance(a, b) / WALL_LENGTH);
    const at = (t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    for (let segment = 0; segment < count; segment++) {
      const start = at(segment / count);
      const end = at((segment + 1) / count);
      if (distance(start, end) < 0.16) continue;
      const site = buildingSite(state, 'wall', { ...at((segment + 0.5) / count), wall: { a: start, b: end } });
      if (!site.error && sites.some((other) => !other.error && distance(other, site) < 0.68)) site.error = 'Overlapping wall segment.';
      if (!site.error && affordable <= 0) site.error = 'Insufficient resources for construction.';
      if (!site.error) affordable--;
      sites.push(site);
    }
  }
  return sites;
}

export function buildingLineSites(state, type, start, end) {
  if (type === 'wall') return wallStrokeSites(state, [start, end]);
  const { deposit, cost } = BUILDINGS[type];
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const pointAt = (ratio) => ({ x: start.x + dx * ratio, z: start.z + dz * ratio });
  const segments = Math.floor(length / BUILD_LINE_SPACING);
  let points = segments ? Array.from({ length: segments + 1 }, (_, index) => pointAt(index / segments)) : [end];
  if (deposit && length) {
    const project = (point) => ((point.x - start.x) * dx + (point.z - start.z) * dz) / length ** 2;
    points = constructionDeposits(state, deposit).filter((point) =>
      distance(point, pointAt(Math.max(0, Math.min(1, project(point))))) < DEPOSIT_BUILD_RADIUS);
    points.sort((a, b) => project(a) - project(b));
    if (!points.length) points = [end];
  }
  const affordable = Math.min(...Object.entries(cost).map(([resource, amount]) => Math.floor(state.resources[resource] / amount)));
  const reserved = [];
  return points.map((point) => {
    const site = buildingSite(state, type, point);
    if (site.error) return site;
    if (reserved.some((other) => distance(other, site) < 2 * buildingFootprint({ ...site, type }).radius + 0.06)) {
      return { ...site, error: 'Leave room between structures.' };
    }
    if (reserved.length >= affordable) return { ...site, error: 'Insufficient resources for construction.' };
    reserved.push(site);
    return site;
  });
}

function constructionRovers(state, units) {
  return [...new Set(units)].filter((unit) => unit.type === 'rover' && unit.health > 0 && state.units.includes(unit));
}

function hasConstruction(unit) {
  return unitTask(unit)?.kind === 'build' || unit.queuedOrders.some((order) => order.kind === 'build');
}

function buildDuration(state, type, site) {
  const biome = site.biome ?? state.world.sample(site.x, site.z);
  return BUILDINGS[type].time / (BIOMES[biome]?.buildSpeed ?? 1);
}

function constructionFunding(state, type, site, workers) {
  const assigned = new Map();
  for (const unit of state.units) {
    const task = unitTask(unit);
    if (unit.health > 0 && task?.kind === 'build') assigned.set(task.building, (assigned.get(task.building) ?? 0) + 1);
  }
  const reach = constructionReach({ ...site, type });
  const travelTime = workers.length
    ? Math.min(...workers.map((worker) => Math.max(0, distance(worker, site) - reach) / UNITS.rover.speed))
    : 0;
  const seconds = travelTime + buildDuration(state, type, site) / Math.max(1, workers.length);
  // Use current production, capped by remaining deposits, over the expected time to finish.
  const { rates } = productionDetails(state, seconds);
  const projected = Object.fromEntries(Object.entries(rates).map(([resource, rate]) =>
    [resource, state.resources[resource] + rate * seconds]));
  for (const [building, crew] of assigned) {
    if (building === site || !(building.paidProgress > 0) || building.progress >= 1 || !hasConstructionAccess(state, building)) continue;
    const expected = Math.min(1 - building.progress, seconds * crew / buildDuration(state, building.type, building));
    for (const [resource, amount] of Object.entries(BUILDINGS[building.type].cost)) projected[resource] -= expected * amount;
  }
  return Object.entries(BUILDINGS[type].cost).find(([resource, amount]) => projected[resource] + 1e-8 < amount)?.[0];
}

const fundingMessage = (resource) => resource
  ? `Projected ${RESOURCES[resource].name.toLowerCase()} is too low. Shift-click to queue this site.`
  : null;

export function constructionFundingError(state, type, site, rovers, buildAsCrew = false) {
  const available = constructionRovers(state, rovers).filter((unit) => !hasConstruction(unit));
  available.sort((a, b) => Number(Boolean(a.order)) - Number(Boolean(b.order)) || distance(a, site) - distance(b, site));
  return fundingMessage(constructionFunding(state, type, site, buildAsCrew ? available : available.slice(0, 1)));
}

function assistLeader(worker, target) {
  const seen = new Set([worker]);
  while (target?.health > 0 && !seen.has(target)) {
    if (target.order?.kind !== 'assist') return target;
    seen.add(target);
    target = target.order.target;
  }
  return null;
}

export function unitTask(unit) {
  const order = unit.order;
  return order?.kind === 'assist' ? assistLeader(unit, order.target)?.order : order;
}

export function orderRoverAssist(state, units, target, append = false) {
  if (target?.type !== 'rover' || !(target.health > 0) || !state.units.includes(target)) return 'Choose a friendly rover to assist.';
  const workers = constructionRovers(state, units).filter((unit) => unit !== target);
  if (!workers.length) return 'Select another rover to assist this one.';
  if (workers.some((unit) => !assistLeader(unit, target))) return 'Those rovers are already assisting each other through this assignment.';
  for (const worker of workers) {
    if (append && [worker.order, ...worker.queuedOrders].some((order) => order?.kind === 'assist' && order.target === target)) continue;
    setUnitOrder(worker, { kind: 'assist', target }, append);
  }
  return null;
}

export function assistConstruction(state, building, rovers, append = false) {
  if (!state.buildings.includes(building) || building.progress >= 1) return 'Select an unfinished building.';
  if (!hasConstructionAccess(state, building)) return 'Construction is paused until you are at war with the faction that holds this site.';
  const workers = constructionRovers(state, rovers);
  if (!workers.length) return 'Select a Construction Rover.';
  for (const rover of workers) {
    if (rover.order?.building === building || (append && rover.queuedOrders.some((order) => order.building === building))) continue;
    setUnitOrder(rover, { kind: 'build', building }, append);
  }
  return null;
}

export function orderBuilding(state, type, point, rovers, append = false, buildAsCrew = false) {
  const site = buildingSite(state, type, point);
  if (site.error) return site.error;
  append ||= type === 'wall';
  const available = constructionRovers(state, rovers);
  const priority = (unit) => append ? Number(Boolean(unit.order)) + unit.queuedOrders.length
    : hasConstruction(unit) ? 2 : Number(Boolean(unit.order));
  const rover = available.sort((a, b) => priority(a) - priority(b) || distance(a, site) - distance(b, site))[0];
  if (!rover) return 'Select a Construction Rover.';
  if (!append && hasConstruction(rover)) return 'All selected rovers have construction orders. Shift-click to queue another site.';
  const workers = buildAsCrew && !append ? available.filter((worker) => !hasConstruction(worker)) : [rover];
  if (!append) {
    const error = fundingMessage(constructionFunding(state, type, site, workers));
    if (error) return error;
  }
  const building = { id: state.nextId++, factionId: state.country, type, ...site, biome: state.world.sample(site.x, site.z),
    progress: 0, paidProgress: 0, health: 0 };
  if (BUILDINGS[type].trains) {
    building.queue = [];
    building.rallyPoints = [];
  }
  state.buildings.push(building);
  for (const worker of workers) setUnitOrder(worker, { kind: 'build', building }, append);
  log(state, `${BUILDINGS[type].name} construction ordered.`);
  return null;
}

export function removeBuilding(state, building, mode) {
  const index = state.buildings.indexOf(building);
  if (index < 0 || building.type === 'command') return 'Select a colony building to remove.';
  if (mode !== 'cancel' && mode !== 'dismantle') return 'Choose how to remove the building.';
  const unfinished = building.progress < 1;
  if (unfinished && mode === 'dismantle') return 'Use Cancel construction to remove this site.';
  if (!unfinished && mode === 'cancel') return 'Construction has finished. Use Dismantle to clear the site.';

  const blueprint = BUILDINGS[building.type];
  const refunds = (building.queue ?? []).map(({ type }) => UNITS[type].cost);
  const paid = unfinished ? building.paidProgress ?? 1 : 0;
  if (paid) refunds.push(Object.fromEntries(Object.entries(blueprint.cost).map(([resource, amount]) => [resource, amount * paid])));
  if (building.launch) refunds.push(ORBITAL_SURVEY.cost);
  for (const cost of refunds) {
    for (const [resource, amount] of Object.entries(cost)) state.resources[resource] += amount;
  }
  discardBuilding(state, building);
  log(state, unfinished ? `${blueprint.name} construction canceled.${paid ? ' Materials refunded.' : ''}`
    : `${blueprint.name} dismantled. Site cleared.`);
  return null;
}

function discardBuilding(state, building) {
  for (const unit of state.units) {
    unit.queuedOrders = unit.queuedOrders.filter((order) => order.building !== building);
    if (unit.order?.building === building) finishUnitOrder(unit);
  }
  state.buildings.splice(state.buildings.indexOf(building), 1);
  state.world.navigation.removeStructure(building);
}

export function trainingQueue(state, facility = state.buildings[0]) {
  return facility.type === 'command' ? state.queue : facility.queue;
}

export function trainingTime(type, facility) {
  return UNITS[type].time / (BUILDINGS[facility.type].trainingSpeed ?? 1);
}

export function availableCrew(state) {
  const training = state.buildings.reduce((total, building) => total + (trainingQueue(state, building)?.length ?? 0), 0);
  return Math.max(0, state.population - state.units.length - training);
}

export function queueUnit(state, type, quantity = 1, facility = state.buildings[0]) {
  return queueTraining(state, type, quantity, [facility]).error;
}

export function queueTraining(state, type, quantity, facilities) {
  const definition = UNITS[type];
  if (!definition) return { error: 'Choose a unit to train.' };
  const candidates = facilities.filter((facility) => state.buildings.includes(facility) && BUILDINGS[facility.type].trains?.includes(type));
  if (!candidates.length) return { error: 'Select a building that trains this unit.' };
  const ready = candidates.filter((facility) => facility.progress === 1 && facility.health > 0);
  if (!ready.length) return { error: 'Training requires an operational building.' };
  const available = availableCrew(state);
  if (available <= 0) return { error: 'No colonists available to crew another unit.' };
  const limit = Math.min(Math.ceil(quantity) * ready.length, available);
  let count = 0;
  while (count < limit && canAfford(state, definition.cost)) {
    const facility = ready[count % ready.length];
    spend(state, definition.cost);
    trainingQueue(state, facility).push({ type, remaining: trainingTime(type, facility) });
    count++;
  }
  if (!count) return { error: 'Insufficient resources to recruit this unit.' };
  const facilitiesUsed = Math.min(count, ready.length);
  if (facilities.length > 1) {
    log(state, `${count} queued across ${facilitiesUsed} of ${facilities.length} selected factories.`);
  } else {
    const [facility] = ready;
    const name = facility.type === 'command' ? 'Command' : BUILDINGS[facility.type].name;
    log(state, count === 1 ? `${definition.name} queued at ${name}.` : `${count} units queued at ${name}.`);
  }
  return { error: null, count, facilitiesUsed };
}

export function orderCommandUpgrade(state) {
  const command = state.buildings[0];
  const tier = (command.tier ?? 1) + 1;
  const upgrade = COMMAND_TIERS[tier];
  if (!upgrade) return 'Command is already Tier 3.';
  if (command.upgrade) return 'A Command upgrade is already in progress.';
  if (command.health <= 0) return 'Repair the Command Center before upgrading.';
  if (!canAfford(state, upgrade.cost)) return 'Insufficient resources for the Command upgrade.';
  spend(state, upgrade.cost);
  command.upgrade = { tier, remaining: upgrade.time };
  log(state, `Upgrading Command to Tier ${tier}.`);
  return null;
}

function operationalUplink(state, uplink) {
  return uplink?.type === 'uplink' && uplink.progress === 1 && uplink.health > 0 && state.buildings.includes(uplink);
}

export function setSurveyTarget(state, uplink, point) {
  if (!operationalUplink(state, uplink)) return 'Select an operational Orbital Uplink.';
  if (uplink.launch || uplink.satellite) return 'This uplink is already assigned to a satellite.';
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z) || point.x < MAP_MIN_X || point.x > MAP_MAX_X
    || point.z < MAP_MIN_Z || point.z > MAP_MAX_Z) return 'Choose a survey area on the map.';
  uplink.surveyTarget = { x: point.x, z: point.z };
  return null;
}

export function orderSurveySatellite(state, uplink) {
  if (!operationalUplink(state, uplink)) return 'Select an operational Orbital Uplink.';
  if (uplink.satellite || uplink.launch) return 'This uplink is already assigned to a satellite.';
  if (!uplink.surveyTarget) return 'Select a survey area before launching.';
  if (!canAfford(state, ORBITAL_SURVEY.cost)) return 'Insufficient resources for a Survey Satellite.';
  spend(state, ORBITAL_SURVEY.cost);
  uplink.launch = { target: { ...uplink.surveyTarget }, remaining: ORBITAL_SURVEY.time };
  log(state, 'Survey Satellite launch sequence started.');
  return null;
}

export function orbitalVision(state) {
  return state.research.has('network') ? 40 : ORBITAL_SURVEY.vision;
}

export function orderResearch(state, id) {
  if (!Object.hasOwn(RESEARCH, id)) return 'Choose a research project.';
  const definition = RESEARCH[id];
  const command = state.buildings[0];
  if (command.tier < definition.tier) return `Upgrade to Tier ${definition.tier} to begin research.`;
  if (command.health <= 0) return 'Repair the Command Center before starting research.';
  if (state.research.has(id)) return 'This project is already complete.';
  if (state.researchProject) return 'Another research project is already in progress.';
  if (!canAfford(state, definition.cost)) return 'Insufficient resources for this project.';
  spend(state, definition.cost);
  state.researchProject = { id, remaining: definition.time };
  log(state, `Research started · ${definition.name}.`);
  return null;
}

function advanceResearch(state, dt) {
  const project = state.researchProject;
  if (!project || state.buildings[0].health <= 0) return;
  project.remaining -= dt;
  if (project.remaining > 1e-8) return;
  state.research.add(project.id);
  state.researchProject = null;
  if (project.id === 'network') {
    for (const satellite of state.satellites) satellite.vision = orbitalVision(state);
  }
  log(state, `Research complete · ${RESEARCH[project.id].name}.`);
}

function advanceCommandUpgrade(state, dt) {
  const command = state.buildings[0];
  const upgrade = command.upgrade;
  if (!upgrade || command.health <= 0) return;
  upgrade.remaining -= dt;
  if (upgrade.remaining > 1e-8) return;
  const oldHealth = maxBuildingHealth(command);
  command.tier = upgrade.tier;
  command.health += maxBuildingHealth(command) - oldHealth;
  command.upgrade = null;
  log(state, `Command reached Tier ${command.tier}. Tier ${command.tier} construction unlocked.`);
}

export function setProductionRepeat(command, enabled) {
  command.repeatProduction = enabled;
  if (!enabled) command.repeatBacklog.length = 0;
}

export const isMilitary = (entity) => Boolean(UNITS[entity.type]?.combat);

function intrudingUnits(state, other) {
  return state.units.filter((unit) => unit.health > 0 && isMilitary(unit) && territoryOwner(state.world, unit) === other);
}

function militaryStrength(state) {
  return [...state.units, ...state.buildings].reduce((total, entity) => {
    const weapon = (UNITS[entity.type] ?? BUILDINGS[entity.type]).combat;
    return total + (weapon && entity.health > 0 && (entity.progress ?? 1) === 1
      ? (entity.health / 12 + weapon.damage / weapon.cooldown) * (entity.progress === undefined ? 1 : 0.65) : 0);
  }, 0);
}

// How tempting a rival's deposits are. Distance is judged relative to how far apart the two
// colonies are, so deposits on the near side of a distant rival's territory still count.
// Strength that can actually take the field: units only, no towers or command batteries.
function fieldStrength(state) {
  return state.units.reduce((total, unit) => {
    const weapon = UNITS[unit.type].combat;
    return total + (weapon && unit.health > 0 ? unit.health / 12 + weapon.damage / weapon.cooldown : 0);
  }, 0);
}

function territorialValue(state, other) {
  const gap = Math.max(35, distance(state.home, other.home));
  let value = 0;
  for (const site of state.world.deposits) {
    if (!site.amount || territoryOwner(state.world, site) !== other.country) continue;
    const reach = distance(state.home, site) / gap;
    value += Math.max(0, 1.6 - reach) * (state.resources[site.type] < 80 ? 1 : 0.4);
  }
  return Math.min(value, 12);
}

function orderDestination(order) {
  return order?.target ?? order?.building ?? order;
}

function crossesTerritory(world, start, end, predicate) {
  const length = distance(start, end);
  const steps = Math.max(1, Math.ceil(length));
  for (let step = 1; step <= steps; step++) {
    const x = start.x + (end.x - start.x) * step / steps;
    const z = start.z + (end.z - start.z) * step / steps;
    if (predicate(territoryOwner(world, { x, z }))) return true;
  }
  return false;
}

function cancelAttacks(state, other) {
  const targetsFaction = (order) => (order?.kind === 'attack' && order.target.factionId === other)
    || (state.world.defeatedFactions.has(other) && order?.intentFaction === other);
  for (const unit of state.units) {
    unit.queuedOrders = unit.queuedOrders.filter((order) => !targetsFaction(order));
    if (targetsFaction(unit.order)) finishUnitOrder(unit);
  }
}

function retreatDestination(state, unit, other) {
  const heading = Math.atan2(state.home.z - unit.z, state.home.x - unit.x);
  let best;
  let bestDistance = Infinity;
  for (let direction = 0; direction < 16; direction++) {
    const angle = heading + direction * Math.PI / 8;
    for (let length = 1; length <= Math.min(bestDistance, MAP_WIDTH); length += 1) {
      const point = { x: unit.x + Math.cos(angle) * length, z: unit.z + Math.sin(angle) * length };
      if (point.x < MAP_MIN_X || point.x > MAP_MAX_X || point.z < MAP_MIN_Z || point.z > MAP_MAX_Z) break;
      const owner = territoryOwner(state.world, point);
      if (owner === other) continue;
      if (!owner || owner === state.country) {
        best = point;
        bestDistance = length;
      }
      break;
    }
  }
  return best ?? state.home;
}

function retreatUnit(state, unit, other) {
  setUnitOrder(unit, { kind: 'withdraw', fromFaction: other, ...retreatDestination(state, unit, other) });
}

function withdrawForces(state, other) {
  for (const unit of state.units.filter(isMilitary)) {
    if (territoryOwner(state.world, unit) === other) {
      retreatUnit(state, unit, other);
      continue;
    }
    const enters = (order) => {
      const destination = orderDestination(order);
      return order?.intentFaction === other || (destination && crossesTerritory(state.world, unit, destination, (id) => id === other));
    };
    unit.queuedOrders = unit.queuedOrders.filter((order) => !enters(order));
    if (enters(unit.order)) finishUnitOrder(unit);
  }
}

function protectedBorder(state, other) {
  const pair = state.diplomacy.between(state.country, other);
  return pair && (pair.state === STANCE.CEASEFIRE || (pair.state !== STANCE.WAR && pair.cooldownUntil > state.time));
}

function trackMilitaryTerritory(state, unit, order) {
  const owner = territoryOwner(state.world, unit);
  if (owner && owner !== state.country && protectedBorder(state, owner) && order?.kind !== 'withdraw') {
    unit.territory = owner;
    retreatUnit(state, unit, owner);
    return;
  }
  if (owner === unit.territory) return;
  unit.territory = owner;
  if (!owner || owner === state.country || state.diplomacy.canAttack(state.country, owner)) return;
  if (order?.kind !== 'withdraw') {
    const deliberate = order?.intentFaction === owner || (state.controller === 'human'
      && order?.kind === 'move' && territoryOwner(state.world, order) === owner);
    state.diplomacy.beginIncident(state.country, owner, 'border', deliberate);
  }
}

function advanceUnit(state, unit, target, dt, range, reachCheck, order = unit.order) {
  const { world, country, diplomacy } = state;
  const military = isMilitary(unit);
  const plannedAI = state.controller === 'ai' && (order?.patrol || order?.intentFaction || order?.kind === 'attack');
  const allowed = military ? (point) => {
    const owner = territoryOwner(world, point);
    if (!owner || owner === country || owner === order?.fromFaction) return true;
    if (protectedBorder(state, owner)) return false;
    return !plannedAI || owner === order?.intentFaction || diplomacy.canAttack(country, owner);
  } : null;
  const canReach = reachCheck ?? (['attack', 'build', 'repair', 'harvest', 'capture'].includes(order?.kind)
    ? (point) => world.navigation.clearShot(point, target) : null);
  const radius = unitHitRadius(unit.type);
  const speed = UNITS[unit.type].speed;
  const neighbors = nearbyUnits(state, unit, speed * dt + 4, unit);
  const traffic = neighbors.length ? (from, to) => unitInPath(neighbors, from, to, radius) : null;
  if (order?.kind === 'move' && distance(unit, target) < 2) {
    const blocker = traffic?.(target, target);
    if (blocker && !blocker.order) range = Math.max(range, radius + unitHitRadius(blocker.type) + distance(blocker, target) + 0.05);
  }
  const reached = travelEntity(world, unit, target, dt, state.time,
    speed, unitClearance(unit.type), range, allowed, canReach, traffic);
  if (military) trackMilitaryTerritory(state, unit, order);
  return reached;
}

function travelEntity(world, entity, target, dt, time, speed, clearance, range, allowed, canReach, traffic) {
  const { navigation } = world;
  const arrived = () => distance(entity, target) <= range + 0.0001 && (!canReach || canReach(entity));
  if (arrived()) return true;
  let route = entity.route;
  if (!route || distance(route.goal, target) > 1.25 || (!route.reaches && route.revision !== navigation.revision)
    || (!route.points.length && (route.reaches || time >= route.retryAt))) {
    route = { ...navigation.route(entity, target, clearance, range, allowed, canReach),
      goal: { x: target.x, z: target.z }, revision: navigation.revision, retryAt: time + 4 };
    entity.route = route;
  }
  let travel = speed * dt;
  while (travel > 0.0001 && route.points.length && !arrived()) {
    const waypoint = route.points[0];
    const gap = distance(entity, waypoint);
    if (gap < 0.0001) { route.points.shift(); continue; }
    const step = Math.min(travel, gap);
    const dx = (waypoint.x - entity.x) * step / gap;
    const dz = (waypoint.z - entity.z) * step / gap;
    const next = { x: entity.x + dx, z: entity.z + dz };
    if (!navigation.clearLine(entity, next, clearance, allowed)) {
      entity.route = null;
      return false;
    }
    if (traffic?.(entity, next)) {
      if (time >= (route.avoidAt ?? 0)) {
        let destination = target;
        let bypass = -1;
        let from = entity;
        let lookAhead = 8;
        for (const [index, point] of route.points.entries()) {
          const length = distance(from, point);
          if (length > lookAhead) {
            const fraction = lookAhead / length;
            destination = { x: from.x + (point.x - from.x) * fraction, z: from.z + (point.z - from.z) * fraction };
            bypass = index;
            break;
          }
          lookAhead -= length;
          from = point;
        }
        const local = bypass >= 0;
        const detour = navigation.route(entity, destination, clearance, local ? 0.05 : range,
          allowed, local ? null : canReach, (from, to) => !traffic(from, to));
        route.avoidAt = time + (detour.reaches ? 0.35 : 0.7);
        if (detour.reaches && local) route.points.splice(0, bypass, ...detour.points);
        else if (detour.reaches) Object.assign(route, detour);
      }
      return false;
    }
    entity.heading = Math.atan2(next.x - entity.x, next.z - entity.z);
    Object.assign(entity, next);
    travel -= step;
    if (distance(entity, waypoint) < 0.0001) route.points.shift();
  }
  return arrived();
}

const constructionReach = (building) => Math.max(1.5, buildingFootprint(building).radius + unitClearance('rover') + 0.26);

export function orderFactionAttack(state, units, target, append = false) {
  const enemy = state.factions.get(target?.factionId);
  const attackers = units.filter((unit) => unit.factionId === state.country && unit.health > 0 && isMilitary(unit));
  if (!attackers.length) return { error: 'Select a military unit to attack.' };
  if (!enemy || enemy === state || target.health <= 0 || (!enemy.units.includes(target) && !enemy.buildings.includes(target))) {
    return { error: 'Choose a foreign unit or structure.' };
  }
  if (!state.diplomacy.canAttack(state.country, enemy.country)) {
    const error = state.diplomacy.beginIncident(state.country, enemy.country, 'attack');
    return error ? { error } : { incident: true };
  }
  for (const unit of attackers) setUnitOrder(unit, { kind: 'attack', target }, append);
  return {};
}

function gatherResources(state, unit, site, aim, dt, limit = Infinity) {
  const { world } = state;
  const range = site.kind === 'tree' ? site.radius + unitClearance(unit.type) + 0.28 : site.kind === 'rock' ? 1.35 : 2.26;
  const reach = site.kind ? (point) => !world.navigation.intersects(point, site, 0, (shape) => shape.entity !== site)
    : (point) => world.navigation.clearShot(point, aim);
  if (!advanceUnit(state, unit, aim, dt, range, reach)) return 0;
  const amount = Math.min(site.surface, limit, dt * 2.8);
  unit.work = 'harvest';
  site.surface -= amount;
  state.resources[site.type] += amount;
  state.gathered[site.type] += amount;
  if (site.kind && site.surface === 0) {
    world.navigation.removeStructure(site);
    world.harvestedGatherables.push(site);
  }
  return amount;
}

function inPatrolArea(point, area) {
  if (point.x < area.minX || point.x > area.maxX || point.z < area.minZ || point.z > area.maxZ) return false;
  if (!area.corners) return true;
  let inside = false;
  for (let index = 0, previous = area.corners.length - 1; index < area.corners.length; previous = index++) {
    const a = area.corners[previous];
    const b = area.corners[index];
    if ((a.z > point.z) === (b.z > point.z)) continue;
    if (point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function findPatrolResource(state, unit, { area, corners, blocked }) {
  const claimed = new Set(state.units.filter((other) => other !== unit)
    .map(({ order }) => order?.kind === 'harvest' ? order.deposit : order?.kind === 'harvestPatrol' ? order.target : null));
  let best;
  let nearest = Infinity;
  const available = (site) => site.surface > 0 && (blocked.get(site) ?? 0) <= state.time;
  const consider = (site) => {
    const gap = distance(unit, site);
    if (gap < nearest) { best = site; nearest = gap; }
  };
  let localResources = false;
  for (const sites of [state.world.gatherables, state.world.deposits]) {
    for (const site of sites) {
      if (!available(site) || !inPatrolArea(site, area)) continue;
      localResources = true;
      if (!claimed.has(site)) consider(site);
    }
  }
  if (localResources) return best;

  const margin = PATROL_SEARCH_MARGIN;
  for (const site of state.world.gatherables) {
    if (!available(site) || (site.kind !== 'tree' && site.kind !== 'rock') || claimed.has(site)
      || site.x < area.minX - margin || site.x > area.maxX + margin || site.z < area.minZ - margin || site.z > area.maxZ + margin) continue;
    if (corners.some((corner, index) => pointSegmentDistance(site, corner, corners[(index + 1) % corners.length]) <= margin)) consider(site);
  }
  return best;
}

function progressHarvestPatrol(state, unit, order, dt) {
  if (order.target?.surface === 0) {
    order.target = null;
    order.searchAt = state.time;
    unit.route = null;
  }
  if (!order.target && state.time >= order.searchAt) {
    order.target = findPatrolResource(state, unit, order) ?? null;
    order.searchAt = state.time + 1;
    if (order.target) unit.route = null;
  }
  if (order.target) {
    gatherResources(state, unit, order.target, order.target, dt);
    if (unit.route && !unit.route.reaches && !unit.route.points.length && !unit.work) {
      order.blocked.set(order.target, state.time + 9);
      order.target = null;
      unit.route = null;
    }
    return;
  }
  if (state.time < order.walkAt) return;
  const reachedCorner = advanceUnit(state, unit, order.corners[order.corner], dt, 0.75);
  const blockedCorner = unit.route && !unit.route.reaches && !unit.route.points.length;
  if (reachedCorner || blockedCorner) {
    if (blockedCorner) order.walkAt = state.time + 1;
    order.corner = (order.corner + 1) % order.corners.length;
    unit.route = null;
  }
}

function progressOrder(state, unit, order, dt) {
  switch (order.kind) {
    case 'move':
    case 'withdraw':
      return advanceUnit(state, unit, order, dt, order.kind === 'withdraw' ? 0 : 0.06);
    case 'harvest': {
      const { deposit } = order;
      if (deposit.surface > 0 && order.remaining > 0) {
        order.remaining -= gatherResources(state, unit, deposit, deposit.kind ? deposit : order, dt, order.remaining);
      }
      return deposit.surface <= 0 || order.remaining <= 0;
    }
    case 'harvestPatrol':
      progressHarvestPatrol(state, unit, order, dt);
      return false;
    case 'build': {
      const building = order.building;
      if (building.progress === 1) return true;
      if (!hasConstructionAccess(state, building)) return false;
      const shape = isBlueprint(building) ? buildingFootprint(building) : null;
      const canReach = shape ? (point) => !insideFootprint(unit, point, shape) && state.world.navigation.clearShot(point, building) : null;
      if (!advanceUnit(state, unit, building, dt, constructionReach(building), canReach, order)) return false;
      return construct(state, unit, building, dt);
    }
    case 'repair': {
      const { building } = order;
      const maximum = maxBuildingHealth(building);
      if (building.health < maximum && advanceUnit(state, unit, building, dt, constructionReach(building), undefined, order)) {
        unit.work = 'repair';
        building.health = Math.min(maximum, building.health + dt * 12);
      }
      return building.health === maximum;
    }
    case 'attack': {
      const weapon = UNITS[unit.type].combat;
      if (!weapon || !mayEngage(state, order.target)) return true;
      advanceUnit(state, unit, order.target, dt, weapon.range - 0.04);
      return false;
    }
    case 'capture': {
      const relay = order.target;
      if (relay.owner || unit.type !== 'rover') return true;
      if (!advanceUnit(state, unit, relay, dt, 1.5, undefined, order)) return false;
      unit.work = 'capture';
      order.remaining -= dt;
      if (order.remaining > 1e-8) return false;
      relay.owner = state.country;
      log(state, `${relay.name} captured. Area survey online.`);
      return true;
    }
    default:
      return false;
  }
}

function construct(state, unit, building, dt) {
  const blueprint = isBlueprint(building);
  const shape = blueprint ? buildingFootprint(building) : null;
  if (blueprint) {
    building.blockedFootprint = unitsInFootprint(state, shape);
    if (building.blockedFootprint) return false;
    if (building.fundingRetryAt > state.time) return false;
    const crew = state.units.filter((worker) => {
      const task = worker.health > 0 && unitTask(worker);
      return task?.kind === 'build' && task.building === building;
    });
    building.materialShortage = constructionFunding(state, building.type, building, crew);
    if (building.materialShortage) {
      building.fundingRetryAt = state.time + 0.5;
      return false;
    }
  }
  const remaining = 1 - building.progress;
  let work = Math.min(remaining, dt / buildDuration(state, building.type, building));
  const cost = Object.entries(BUILDINGS[building.type].cost);
  building.materialShortage = undefined;
  if (building.paidProgress !== undefined) {
    for (const [resource, amount] of cost) {
      const affordableWork = state.resources[resource] / amount;
      if (affordableWork >= work) continue;
      work = affordableWork;
      building.materialShortage = resource;
    }
    if (work <= 0) return false;
    const charged = remaining - work < 1e-10 ? remaining : work;
    for (const [resource, amount] of cost) state.resources[resource] = Math.max(0, state.resources[resource] - charged * amount);
    building.paidProgress = Math.min(1, building.paidProgress + charged);
  }
  if (work <= 0) return false;
  if (blueprint) {
    building.health = maxBuildingHealth(building);
    state.world.navigation.addStructure(building, shape);
  }
  unit.work = 'build';
  building.progress = remaining - work < 1e-10 ? 1 : building.progress + work;
  if (building.progress === 1) log(state, `${BUILDINGS[building.type].name} online.`);
  return building.progress === 1;
}

function progressRoverAssist(state, unit, order, dt) {
  const leader = assistLeader(unit, order.target);
  const task = leader?.order;
  if (!leader || (!task && unit.queuedOrders.length)) {
    finishUnitOrder(unit);
    return;
  }
  const patrolResource = task?.kind === 'harvestPatrol' && task.target?.surface > 0 ? task.target : null;
  const shareTask = ['build', 'repair', 'harvest', 'capture'].includes(task?.kind);
  const destination = patrolResource ?? (shareTask ? orderDestination(task) : leader);
  if (order.destination !== destination) {
    order.destination = destination;
    unit.route = null;
  }
  if (patrolResource) gatherResources(state, unit, patrolResource, patrolResource, dt);
  else if (!shareTask) advanceUnit(state, unit, leader, dt, 2.15);
  else if (progressOrder(state, unit, task, dt)) finishUnitOrder(leader);
}

function progressOrders(state, dt) {
  const assistants = [];
  for (const unit of state.units) {
    if (isMilitary(unit)) trackMilitaryTerritory(state, unit, unit.order);
    unit.work = null;
    const order = unit.order;
    if (!order) continue;
    if (order.kind === 'assist') assistants.push(unit);
    else if (progressOrder(state, unit, order, dt) && unit.order === order) finishUnitOrder(unit);
  }
  for (const unit of assistants) progressRoverAssist(state, unit, unit.order, dt);
}

function mayEngage(state, target) {
  if (!(target?.health > 0)) return false;
  return target.factionId ? state.diplomacy.canAttack(state.country, target.factionId) : state.hostiles.includes(target);
}

function leaveUnitRemains(state, unit) {
  state.world.unitRemains.push({ type: unit.type ?? unit.kind, factionId: unit.factionId,
    x: unit.x, z: unit.z, heading: unit.heading ?? 0, expiresAt: state.time + UNIT_REMAINS_LIFETIME });
}

function checkDefeat(colony) {
  const command = colony.buildings[0];
  if (colony.defeat || command.health > 0 || colony.units.some((unit) => unit.type === 'rover' && unit.health > 0)) return;
  colony.defeat = { time: colony.time, by: command.disabledBy ?? null };
  colony.lastAction = 'Defeated';
  const { world, country } = colony;
  world.defeatedFactions.add(country);
  colony.diplomacy.endForDefeat(country);
  colony.units = colony.units.filter((unit) => {
    if (unit.health <= 0) {
      leaveUnitRemains(colony, unit);
      return false;
    }
    setUnitOrder(unit, null);
    return true;
  });
  for (const site of colony.buildings.filter(isBlueprint)) discardBuilding(colony, site);
  for (const relay of world.outposts) if (relay.owner === country) relay.owner = null;
  world.territoryMap = createTerritoryMap(world);
  log(colony, 'Colony defeated. Command is disabled and no Construction Rovers remain.');
  const victor = colony.factions.get(colony.defeat.by);
  if (victor) log(victor, `${colony.name} has been defeated. Your forces have stood down.`);
  for (const other of colony.factions.values()) {
    if (other !== colony && other !== victor && other.knownFactions.has(colony.country)) {
      log(other, `News: ${colony.name} has fallen${victor ? ` to ${victor.name}` : ''}.`);
    }
  }
}

export const STRUCTURE_SMALL_ARMS_FACTOR = 0.35;

function applyCombatDamage(state, attacker, target, amount) {
  // Structures are armoured: small arms barely scratch them, while shell-firing siege units hit in full.
  const structure = target.progress !== undefined;
  const smallArms = !(UNITS[attacker.type] ?? BUILDINGS[attacker.type])?.combat?.shell;
  target.health -= structure && smallArms ? amount * STRUCTURE_SMALL_ARMS_FACTOR : amount;
  const victim = state.factions.get(target.factionId);
  if (victim) {
    victim.lastAttackedAt = state.time;
    victim.lastAttackSource = { x: attacker.x, z: attacker.z };
  }
}

function reportCombatLoss(state, target) {
  target.health = 0;
  if (!target.factionId) {
    leaveUnitRemains(state, target);
    log(state, 'Hostile reptile defeated.');
    return;
  }
  const victim = state.factions.get(target.factionId);
  const building = target.progress !== undefined;
  if (building || isMilitary(target)) state.diplomacy.reportLoss(state.country, victim.country, building);
  const name = (UNITS[target.type] ?? BUILDINGS[target.type]).name;
  const outcome = target.type === 'command' ? 'disabled' : 'destroyed';
  log(state, `${victim.name} lost a ${name} in battle.`);
  log(victim, `${name} ${outcome} by ${state.name}.`);
  if (target.type === 'command') target.disabledBy = state.country;
  if (building && target.type !== 'command') discardBuilding(victim, target);
  if (target.type === 'command' || target.type === 'rover') checkDefeat(victim);
}

function progressCombat(state, dt, shots) {
  const opponents = state.diplomacy.wars(state.country).map((pair) =>
    state.factions.get(pair.factions.find((id) => id !== state.country)));
  const targets = opponents.flatMap((enemy) => [...enemy.units.filter(isMilitary), ...enemy.buildings.filter((building) => building.type !== 'wall')]);
  const civilianTargets = opponents.flatMap((enemy) => enemy.units.filter((unit) => !isMilitary(unit)));
  const { navigation } = state.world;
  for (const defender of [...state.units, ...state.buildings]) {
    const weapon = (UNITS[defender.type] ?? BUILDINGS[defender.type]).combat;
    if (!weapon || defender.health <= 0 || (defender.progress ?? 1) < 1) continue;
    defender.cooldown = (defender.cooldown ?? 0) - dt;
    if (defender.cooldown > 0) continue;
    const orderedTarget = defender.order?.kind === 'attack' ? defender.order.target : null;
    const inRange = (enemy) => enemy.health > 0 && !state.world.defeatedFactions.has(enemy.factionId)
      && distance(defender, enemy) < weapon.range && navigation.clearShot(defender, enemy);
    const target = mayEngage(state, orderedTarget) && inRange(orderedTarget) ? orderedTarget
      : targets.find(inRange) ?? civilianTargets.find(inRange) ?? state.hostiles.find(inRange);
    if (!target) continue;
    applyCombatDamage(state, defender, target, weapon.damage);
    shots?.push({ weapon: defender.type, source: { x: defender.x, z: defender.z, factionId: defender.factionId },
      impact: { x: target.x, z: target.z, factionId: target.factionId, destroyed: target.health <= 0 } });
    const aim = Math.atan2(target.x - defender.x, target.z - defender.z);
    if (weapon.shell) {
      defender.aim = aim;
      state.world.shells.push({ type: defender.type, factionId: defender.factionId, aim,
        from: { x: defender.x, z: defender.z }, to: { x: target.x, z: target.z },
        fired: state.time, duration: weapon.shell });
    } else defender.heading = aim;
    defender.cooldown = weapon.cooldown;
    defender.fired = state.time;
    defender.shotTarget = { x: target.x, z: target.z };
    if (target.health <= 0) reportCombatLoss(state, target);
  }
}

function progressWildlife(state, dt) {
  const { world } = state;
  const targets = [...state.factions.values()].filter((colony) => !colony.defeat)
    .flatMap((colony) => [...colony.units, ...colony.buildings.filter((building) => building.type !== 'command' && building.type !== 'wall')]);
  for (const enemy of state.hostiles) {
    if (enemy.health <= 0) continue;
    enemy.cooldown -= dt;
    const allowed = (point) => distance(enemy.den, point) <= enemy.leash
      && world.settlementHomes.every((home) => distance(home, point) >= LANDING_CLEARANCE);
    const target = targets.find((item) => item.health > 0 && distance(item, enemy) < 9 && allowed(item)
      && world.navigation.clearShot(enemy, item));
    const clearance = enemy.kind === 'ancient' ? 0.9 : 0.66;
    const angle = enemy.phase + state.time * 0.13;
    const roam = { x: enemy.den.x + Math.cos(angle) * 8, z: enemy.den.z + Math.sin(angle) * 8 };
    const patrol = world.navigation.clearLine(enemy.den, roam, clearance, allowed) ? roam : enemy.den;
    const range = target?.progress !== undefined ? buildingFootprint(target).radius + clearance + 0.3 : 1.75;
    const reached = travelEntity(world, enemy, target ?? patrol, dt, state.time,
      target ? enemy.speed : enemy.speed * 0.52, clearance, target ? range : 0.8, allowed,
      target ? (point) => world.navigation.clearShot(point, target) : null);
    if (target && reached && enemy.cooldown <= 0) {
      applyCombatDamage(state, enemy, target, enemy.damage);
      enemy.heading = Math.atan2(target.x - enemy.x, target.z - enemy.z);
      enemy.cooldown = 1.45;
      if (target.health <= 0) {
        target.health = 0;
        log(state.factions.get(target.factionId), target.progress === undefined ? `${UNITS[target.type].name} lost beyond the perimeter.` : `${BUILDINGS[target.type].name} disabled. Send a rover to repair it.`);
      }
    }
  }
}

export const FAMINE_DEPARTURE_INTERVAL = 30;

// Food upkeep scales with population. Warn before stores run dry; once they are empty and
// still shrinking, colonists periodically leave until upkeep matches production again.
function advanceFoodSupply(state, foodRate, dt) {
  const food = state.resources.food;
  if (food >= 40 || foodRate >= 0) state.foodWarned = false;
  if (foodRate < 0 && food > 0 && food < 20 && !state.foodWarned) {
    state.foodWarned = true;
    log(state, `Food reserves are running low (${Math.ceil(food / -foodRate)}s left). Build a Farm to feed the colony.`);
  }
  if (foodRate >= 0 || food > 0) { state.famine = 0; return; }
  state.famine = (state.famine || 0) + dt;
  const floor = Math.max(4, state.units.length);
  if (state.famine < FAMINE_DEPARTURE_INTERVAL || state.population <= floor) return;
  state.famine = 0;
  state.population--;
  log(state, `Food stores are empty. A colonist has left the colony. Population ${state.population}.`);
}

function advanceColony(state, dt) {
  state.units = state.units.filter((unit) => {
    if (unit.health > 0) return true;
    leaveUnitRemains(state, unit);
    return false;
  });
  advanceCommandUpgrade(state, dt);
  advanceResearch(state, dt);
  const { rates } = productionDetails(state, dt);
  for (const [resource, rate] of Object.entries(rates)) state.resources[resource] = Math.max(0, state.resources[resource] + rate * dt);
  for (const building of state.buildings) {
    if (building.progress !== 1 || building.health <= 0 || !building.deposit) continue;
    building.deposit.amount = Math.max(0, building.deposit.amount - dt * buildingOutput(state, building));
  }
  advanceFoodSupply(state, rates.food, dt);
  if (state.population < capacity(state) && rates.food > 0 && state.resources.food >= 36 && state.time >= (state.nextColonist || 0)) {
    state.population++;
    state.resources.food -= 8;
    state.nextColonist = state.time + 16;
    log(state, `A new colonist has arrived. Population ${state.population}.`);
  }
  for (const facility of state.buildings) {
    if (facility.progress !== 1 || facility.health <= 0) continue;
    if (BUILDINGS[facility.type].trains) advanceTraining(state, facility, dt);
    if (facility.launch) advanceLaunch(state, facility, dt);
  }
  const command = state.buildings[0];
  while (command.repeatBacklog.length && !queueUnit(state, command.repeatBacklog[0])) {
    command.repeatBacklog.shift();
  }
}

function advanceLaunch(state, uplink, dt) {
  uplink.launch.remaining -= dt;
  if (uplink.launch.remaining > 1e-8) return;
  const satellite = { ...uplink.launch.target, vision: orbitalVision(state), launchedAt: state.time };
  state.satellites.push(satellite);
  uplink.satellite = satellite;
  uplink.launch = null;
  log(state, 'Survey Satellite online. Orbital coverage is now active.');
}

function advanceTraining(state, facility, dt) {
  const queue = trainingQueue(state, facility);
  const training = queue[0];
  if (!training) return;
  training.remaining = Math.max(0, training.remaining - dt);
  if (training.remaining > 1e-8) return;
  const separation = buildingFootprint(facility).radius + unitClearance(training.type) + 0.6;
  let point;
  for (let index = 0; index < 16; index++) {
    const angle = 0.85 + index * Math.PI / 8 + (state.recruited % 4) * 0.17;
    const candidate = { x: facility.x + Math.sin(angle) * separation, z: facility.z + Math.cos(angle) * separation };
    if (!unitInPath(nearbyUnits(state, candidate, 2), candidate, candidate, unitHitRadius(training.type))
      && state.world.navigation.inBounds(candidate) && !state.world.navigation.intersects(facility, candidate,
      unitClearance(training.type), (shape) => shape.entity !== facility)) { point = candidate; break; }
  }
  if (!point) return;
  const recruit = addUnit(state, training.type, point.x, point.z);
  for (const point of facility.rallyPoints) setUnitOrder(recruit, { kind: 'move', ...point }, true);
  queue.shift();
  state.recruited++;
  if (facility.repeatProduction) facility.repeatBacklog.push(training.type);
  const name = facility.type === 'command' ? 'Command' : BUILDINGS[facility.type].name;
  log(state, facility.rallyPoints.length ? `${UNITS[training.type].name} following the rally route.` : `${UNITS[training.type].name} ready at ${name}.`);
}

function bestConstructionSite(colony, type, rovers) {
  let best;
  let bestScore = -Infinity;
  const scoreSite = (point) => {
    if (colony.blockedSites?.some((blocked) => distance(blocked, point) < 6)) return;
    const site = buildingSite(colony, type, point);
    if (site.error) return;
    // Only consider sites a rover can drive straight to; this keeps crews off plateaus behind ridges.
    if (!site.deposit && !rovers.some((rover) => colony.world.navigation.clearLine(rover, site, unitClearance('rover')))) return;
    const travel = Math.min(...rovers.map((rover) => distance(rover, site))) / UNITS.rover.speed;
    const biome = colony.world.sample(site.x, site.z);
    const output = siteOutput(type, biome);
    // Non-producing structures (factories, towers, habitats) just go where crews can build them quickly.
    const yieldRate = BUILDINGS[type].produces && output > 0 ? output : 1;
    const supplyBonus = site.deposit ? 0.9 + Math.min(site.deposit.amount / 940, 1) * 0.1 : 1;
    const score = yieldRate * supplyBonus / (BUILDINGS[type].time / (BIOMES[biome].buildSpeed ?? 1) + travel);
    if (score > bestScore) { best = site; bestScore = score; }
  };
  if (BUILDINGS[type].deposit) {
    // Prefer surveyed supply sites; fall back to any owned deposit (crystal and vents have no surface supply).
    const owned = colony.supplySites.some((site) => site.type === BUILDINGS[type].deposit) ? colony.supplySites
      : colony.world.deposits.filter((site) => territoryOwner(colony.world, site) === colony.country);
    for (const site of owned) if (site.type === BUILDINGS[type].deposit) scoreSite(site);
  } else {
    for (let dx = -27; dx <= 27; dx += 3) {
      for (let dz = -27; dz <= 27; dz += 3) {
        scoreSite({ x: colony.home.x + dx, z: colony.home.z + dz });
      }
    }
  }
  return best;
}

// Housing beyond this only feeds an idle population; surplus goes into development instead.
const populationTarget = (colony) => 20 + (colony.buildings[0].tier ?? 1) * 10;

// Spends surplus on progression: upgrades, advanced production, extractors and research.
function planDevelopment(colony, rates, rovers) {
  const command = colony.buildings[0];
  const tier = command.tier ?? 1;
  const owns = (type) => colony.buildings.some((building) => building.type === type);
  const build = (type) => {
    if (!rovers.length || !canAfford(colony, BUILDINGS[type].cost)) return false;
    const site = bestConstructionSite(colony, type, rovers);
    if (!site || orderBuilding(colony, type, site, rovers.slice(0, 2))) return false;
    colony.lastAction = `Building a ${BUILDINGS[type].name}`;
    return true;
  };
  // Colonies without a biomass grove convert surplus food into biomass instead of stalling.
  const reclaimer = colony.buildings.find((building) => building.type === 'reclaimer' && building.progress === 1);
  if (reclaimer) {
    const recipe = colony.resources.biomass < 120 && colony.resources.food > 200 ? 'biomass'
      : colony.resources.metal < 120 && colony.resources.biomass > 250 ? 'metal' : 'off';
    if (reclaimer.recipe !== recipe) setConverterRecipe(colony, reclaimer, recipe);
  }
  if (tier >= 2 && !owns('reclaimer') && !owns('bio') && colony.resources.biomass < 120 && build('reclaimer')) return true;
  if (colony.resources.metal < 140) return false;
  const upgrade = (next, after) => tier === next - 1 && !command.upgrade && colony.time > after
    && canAfford(colony, COMMAND_TIERS[next].cost) && !orderCommandUpgrade(colony);
  if (upgrade(2, 600) || upgrade(3, 1500)) { colony.lastAction = `Upgrading Command to Tier ${tier + 1}`; return true; }
  if (tier >= 2) {
    if (!owns('factory') && build('factory')) return true;
    if (!owns('crystalTap') && build('crystalTap')) return true;
    if (!owns('geoTap') && build('geoTap')) return true;
    if (!owns('hydro') && rates.food < 0.8 && build('hydro')) return true;
    if (!colony.researchProject) {
      const project = Object.entries(RESEARCH).find(([id, item]) => item.tier <= tier && !colony.research.has(id) && canAfford(colony, item.cost));
      if (project && !orderResearch(colony, project[0])) { colony.lastAction = `Researching ${project[1].name}`; return true; }
    }
  }
  if (tier >= 3 && !owns('foundry') && build('foundry')) return true;
  const bastions = colony.buildings.filter((building) => building.type === 'bastion').length;
  if (tier >= 3 && bastions < 1 + (colony.personality.military > 0.75 ? 1 : 0)) {
    const site = towerSite(colony);
    if (site && canAfford(colony, BUILDINGS.bastion.cost) && !orderBuilding(colony, 'bastion', site, rovers.slice(0, 2))) {
      colony.lastAction = 'Building a Defense Bastion';
      return true;
    }
  }
  return false;
}

// Cancels blueprints no crew can reach (e.g. behind a ridge) and remembers the spot so it is not chosen again.
function abandonUnreachableSites(colony) {
  for (const building of colony.buildings.filter((item) => item.progress === 0 && !BUILDINGS[item.type].deposit)) {
    const crew = colony.units.filter((unit) => unit.order?.kind === 'build' && unit.order.building === building);
    if (!crew.length || !crew.every((unit) => unit.route && !unit.route.reaches)) { building.stuckSince = undefined; continue; }
    building.stuckSince ??= colony.time;
    if (colony.time - building.stuckSince < 12) continue;
    (colony.blockedSites ??= []).push({ x: building.x, z: building.z });
    removeBuilding(colony, building, 'cancel');
    colony.lastAction = `Abandoning an unreachable ${BUILDINGS[building.type].name} site`;
  }
}

function planIndustry(colony, rates, rovers) {
  abandonUnreachableSites(colony);
  if (!rovers.length) return;
  // Resume blueprints whose crew was lost; otherwise they block that building type forever.
  const crewed = new Set(colony.units.map((unit) => unit.order?.kind === 'build' && unit.order.building).filter(Boolean));
  const stalled = colony.buildings.find((building) => building.progress < 1 && !crewed.has(building)
    && (!building.materialShortage || colony.resources[building.materialShortage] >= 20));
  if (stalled && !assistConstruction(colony, stalled, [rovers[0]])) {
    colony.lastAction = `Resuming ${BUILDINGS[stalled.type].name} construction`;
    return;
  }
  const has = (type) => colony.buildings.some((building) => building.type === type && (!building.deposit || building.deposit.amount > 0));
  const underConstruction = (type) => colony.buildings.some((building) => building.type === type && building.progress < 1);
  const plans = [
    ['mine', !has('mine')],
    ['bio', !has('bio')],
    ['solar', !has('solar') || (rates.energy < 0.4 && !underConstruction('solar'))],
    ['farm', !has('farm') || (rates.food < 0.35 && !underConstruction('farm'))],
    ['habitat', colony.population >= capacity(colony) - 1 && capacity(colony) < populationTarget(colony) && !underConstruction('habitat')],
  ];
  // Fund a reachable, unpaid extractor before starting anything (other than food) that competes for metal.
  const funding = colony.buildings.some((building) => building.progress < 1 && BUILDINGS[building.type].deposit
    && building.materialShortage && colony.units.some((unit) => unit.order?.building === building && unit.route?.reaches !== false));
  for (const [type, needed] of plans) {
    if (!needed || (funding && type !== 'farm')) continue;
    // Until a mine works, keep enough metal in reserve to pay for one.
    const reserve = type !== 'mine' && !colony.buildings.some((building) => building.type === 'mine' && building.progress === 1)
      ? BUILDINGS.mine.cost.metal : 0;
    if (colony.resources.metal - (BUILDINGS[type].cost.metal ?? 0) < reserve) continue;
    const site = bestConstructionSite(colony, type, rovers);
    if (!site || orderBuilding(colony, type, site, rovers)) continue;
    colony.lastAction = `Building a ${BUILDINGS[type].name}`;
    return;
  }
  if (colony.buildings.filter((building) => building.progress < 1).length < 2) planDevelopment(colony, rates, rovers);
}

function sendIdleRovers(colony) {
  const stockTargets = { metal: 105, biomass: 75 };
  const assigned = new Map();
  for (const unit of colony.units) {
    if (unit.order?.kind === 'harvest') assigned.set(unit.order.deposit, (assigned.get(unit.order.deposit) || 0) + unit.order.remaining);
  }
  for (const rover of colony.units) {
    if (rover.type !== 'rover' || rover.order) continue;
    let best;
    let bestScore = 0;
    for (const site of colony.supplySites) {
      // A deposit under a blueprint or extractor cannot be hand-harvested; skip it instead of idling there.
      if (colony.buildings.some((building) => building.deposit === site)) continue;
      const target = stockTargets[site.type];
      const shortage = Math.max(0, target - colony.resources[site.type]) / target;
      const amount = Math.min(20, site.surface - (assigned.get(site) || 0));
      const tripTime = distance(site, rover) / UNITS.rover.speed;
      const score = amount * shortage / (tripTime + 20 / 2.8);
      if (score > bestScore) { best = site; bestScore = score; }
    }
    if (!best) continue;
    const amount = Math.min(20, best.surface - (assigned.get(best) || 0));
    assigned.set(best, (assigned.get(best) || 0) + amount);
    setUnitOrder(rover, { kind: 'harvest', deposit: best, x: best.x, z: best.z, remaining: amount });
    colony.lastAction = `Gathering ${RESOURCES[best.type].name.toLowerCase()}`;
  }
}

function clearGroves(colony, rovers) {
  if (colony.buildings.some((building) => building.type === 'bio' && building.deposit?.amount > 0)) return;
  const worker = rovers.find((rover) => !rover.order);
  if (!worker || rovers.some((rover) => rover.order?.deposit?.kind === 'tree')) return;
  const grove = colony.supplySites.filter((site) => site.type === 'biomass' && site.amount > 0)
    .reduce((nearest, site) => !nearest || distance(colony.home, site) < distance(colony.home, nearest) ? site : nearest, null);
  if (!grove) return;
  const tree = colony.world.gatherables.filter((node) => node.kind === 'tree' && node.surface > 0 && distance(node, grove) < 2.3)
    .reduce((nearest, node) => !nearest || distance(worker, node) < distance(worker, nearest) ? node : nearest, null);
  if (!tree) return;
  setUnitOrder(worker, { kind: 'harvest', deposit: tree, x: tree.x, z: tree.z, remaining: tree.surface });
  colony.lastAction = 'Clearing a biomass grove';
}

function planRecruits(colony, rates, underThreat) {
  // Without rovers there is no metal income, so always rebuild one first instead of waiting on income.
  const stranded = ![...colony.units, ...colony.queue].some((unit) => unit.type === 'rover');
  if (stranded && colony.queue.length < 2 && canAfford(colony, UNITS.rover.cost)) {
    if (!queueUnit(colony, 'rover')) colony.lastAction = 'Training a replacement Construction Rover';
    return;
  }
  if (colony.queue.length >= 2 || rates.metal <= 0 || rates.food <= 0) return;
  if (colony.units.length + colony.queue.length >= colony.population - 1) return;
  const roster = [...colony.units, ...colony.queue];
  const count = (type) => roster.filter((unit) => unit.type === type).length;
  // Standing armies are capped by temperament so wars are contests, not massacres of 90-unit hordes.
  const armyCap = Math.round(6 + colony.personality.military * 12) + (underThreat ? 6 : 0);
  const basic = (unit) => unit.type === 'infantry';
  // Advanced units get their own slots so a colony that unlocks a factory improves its army's quality.
  const advancedSlots = (colony.buildings.some((building) => building.type === 'factory' && building.progress === 1) ? 3 : 0)
    + (colony.buildings.some((building) => building.type === 'foundry' && building.progress === 1) ? 3 : 0)
    + Math.round(colony.personality.military * 3);
  const advancedCount = roster.filter((unit) => UNITS[unit.type].combat && !basic(unit)).length;
  const army = roster.filter((unit) => UNITS[unit.type].combat).length - (advancedCount < advancedSlots ? advancedSlots : advancedCount);
  const rovers = count('rover') < Math.min(5, Math.ceil(colony.population / 4));
  const type = (underThreat || (colony.personality.military > 0.75 && count('infantry') < 3)) && army < armyCap ? 'infantry'
    : rovers ? 'rover' : count('scout') < 2 ? 'scout' : army < armyCap ? 'infantry' : null;
  if (!type) return;
  // Advanced facilities turn the same army cap into a stronger force rather than a larger one.
  const ready = (kind) => colony.buildings.find((building) => building.type === kind && building.progress === 1 && building.health > 0);
  let trainee = type;
  let facility = colony.buildings[0];
  if (type === 'infantry') {
    const heavy = ready('foundry');
    const light = ready('factory');
    const pick = (options) => options.find((option) => canAfford(colony, UNITS[option].cost));
    const advanced = heavy && pick(army % 4 === 3 ? ['siege', 'vanguard'] : ['vanguard'])
      || light && pick(army % 2 ? ['sentinel', 'skirmisher'] : ['skirmisher', 'sentinel']);
    if (advanced) { trainee = advanced; facility = heavy && ['vanguard', 'siege'].includes(advanced) ? heavy : light; }
  }
  if (colony.resources.metal < (UNITS[trainee].cost.metal ?? 0) + 42 || !canAfford(colony, UNITS[trainee].cost)) return;
  if (!queueUnit(colony, trainee, 1, facility)) colony.lastAction = `Training ${UNITS[trainee].name}`;
}

function planMilitary(colony) {
  const { diplomacy, country, world } = colony;
  const combat = colony.units.filter(isMilitary);
  const available = combat.filter((unit) => !unit.order || unit.order.patrol);
  if (!available.length) return;
  for (const pair of diplomacy.wars(country)) {
    const other = colony.factions.get(pair.factions.find((id) => id !== country));
    const intruders = intrudingUnits(other, country);
    const targets = intruders.length ? intruders : [...other.units.filter(isMilitary), ...other.buildings]
      .filter((target) => target.type !== 'wall' && target.health > 0);
    // Only march out with a clear field advantage; otherwise hold near home where towers and Command help.
    const outnumber = fieldStrength(colony) > fieldStrength(other) * (1.35 - colony.personality.aggression * 0.4);
    const canAdvance = colony.conquestTarget === other.country
      || (outnumber && (colony.personality.aggression > 0.6 || combat.some((unit) => territoryOwner(world, unit) === other.country)));
    for (const unit of available) {
      const target = targets.reduce((nearest, enemy) => !nearest || distance(unit, enemy) < distance(unit, nearest) ? enemy : nearest, null);
      if (!target || (!canAdvance && !intruders.length && distance(unit, target) > 22)
        || crossesTerritory(world, unit, target, (id) => id && id !== country && !diplomacy.canAttack(country, id))) continue;
      orderFactionAttack(colony, [unit], target);
    }
    if (available.some((unit) => unit.order?.kind === 'attack')) return;
  }
  // Clear wildlife that threatens the colony's workers and build sites.
  const pest = colony.hostiles.filter((hostile) => hostile.health > 0 && distance(hostile, colony.home) < 45)
    .sort((a, b) => distance(a, colony.home) - distance(b, colony.home))[0];
  if (pest) {
    const hunters = available.filter((unit) => !crossesTerritory(world, unit, pest,
      (id) => id && id !== country && !diplomacy.canAttack(country, id))).slice(0, 4);
    for (const unit of hunters) setUnitOrder(unit, { kind: 'attack', target: pest });
    if (hunters.length) { colony.lastAction = 'Clearing hostile wildlife'; return; }
  }
  if (combat.length < 3 || available.length < 2) return;
  const candidate = [...colony.knownFactions].map((id) => ({ id, score: intrusionScore(diplomacy, country, id) }))
    .filter(({ score }) => score >= 37).sort((a, b) => b.score - a.score)[0];
  if (!candidate || combat.some((unit) => unit.order?.intentFaction === candidate.id)) return;
  const target = colony.factions.get(candidate.id);
  const canApproach = (unit, point) => !crossesTerritory(world, unit, point, (id) => id && id !== country && id !== candidate.id);
  for (const unit of available.filter((unit) => canApproach(unit, target.home)).slice(0, 3)) {
    const gap = distance(unit, target.home);
    if (!gap) continue;
    const steps = Math.ceil(gap);
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const point = { x: unit.x + (target.home.x - unit.x) * progress, z: unit.z + (target.home.z - unit.z) * progress };
      if (territoryOwner(world, point) !== candidate.id) continue;
      setUnitOrder(unit, { kind: 'move', ...point, intentFaction: candidate.id });
      colony.lastAction = `Sending a military detachment toward ${target.name}`;
      break;
    }
  }
}

// Keeps a rover on hand to patch up any structure that has taken real damage.
function planRepairs(colony) {
  const repairing = new Set(colony.units.filter((unit) => unit.order?.kind === 'repair').map((unit) => unit.order.building));
  const damaged = colony.buildings.filter((building) => building.progress === 1 && building.type !== 'wall'
    && building.health > 0 && building.health < maxBuildingHealth(building) * 0.7 && !repairing.has(building))
    .sort((a, b) => (b.type === 'command') - (a.type === 'command') || a.health / maxBuildingHealth(a) - b.health / maxBuildingHealth(b))[0];
  if (!damaged) return;
  const rover = colony.units.filter((unit) => unit.type === 'rover' && unit.health > 0 && unit.order?.kind !== 'build')
    .sort((a, b) => distance(a, damaged) - distance(b, damaged))[0];
  if (!rover) return;
  setUnitOrder(rover, { kind: 'repair', building: damaged });
  colony.lastAction = `Repairing ${BUILDINGS[damaged.type].name}`;
}

function towerSite(colony) {
  const command = colony.buildings[0];
  const rivals = [...colony.knownFactions].map((id) => colony.factions.get(id)).filter((rival) => rival && !rival.defeat);
  const threat = rivals.sort((a, b) => distance(a.home, command) - distance(b.home, command))[0];
  const facing = threat ? Math.atan2(threat.home.z - command.z, threat.home.x - command.x) : 0;
  for (const radius of [7, 9.5, 12]) {
    for (let step = 0; step < 12; step++) {
      const angle = facing + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.55;
      const site = buildingSite(colony, 'tower', { x: command.x + Math.cos(angle) * radius, z: command.z + Math.sin(angle) * radius });
      if (!site.error) return site;
    }
  }
  return null;
}

// Threatened or mature colonies upgrade Command and ring it with Defense Towers.
function planDefenses(colony, rovers, threatened) {
  const command = colony.buildings[0];
  const tier = command.tier ?? 1;
  const mature = colony.time > 900;
  if (!threatened && !mature) return;
  if (tier < 2 && !command.upgrade && canAfford(colony, COMMAND_TIERS[2].cost)) {
    if (!orderCommandUpgrade(colony)) colony.lastAction = 'Upgrading Command to Tier II';
    return;
  }
  if (tier < 2 || !rovers.length) return;
  const towers = colony.buildings.filter((building) => building.type === 'tower');
  const wanted = (threatened ? 2 : 1) + (colony.personality.military > 0.75 ? 1 : 0);
  if (towers.length >= wanted || towers.some((tower) => tower.progress < 1) || !canAfford(colony, BUILDINGS.tower.cost)) return;
  const site = towerSite(colony);
  if (site && !orderBuilding(colony, 'tower', site, rovers.slice(0, 2))) colony.lastAction = 'Building a Defense Tower';
}

function planColony(colony) {
  if (colony.time < colony.nextDecision) return;
  colony.nextDecision = colony.time + 2;
  const command = colony.buildings[0];
  if (command.health <= 0) {
    const rovers = colony.units.filter((unit) => unit.type === 'rover');
    if (!rovers.some((unit) => unit.order?.kind === 'repair' && unit.order.building === command)) {
      const rover = rovers.sort((a, b) => distance(a, command) - distance(b, command))[0];
      if (rover) {
        setUnitOrder(rover, { kind: 'repair', building: command });
        colony.lastAction = 'Repairing Command';
      }
    }
    planMilitary(colony);
    return;
  }
  const rates = production(colony);
  const builders = colony.units.filter((unit) => unit.type === 'rover' && !['build', 'repair'].includes(unit.order?.kind));
  const threatened = colony.diplomacy.incidentsFor(colony.country).some(({ incident }) => incident.defender === colony.country)
    || colony.diplomacy.warCount(colony.country) > 0;
  planRepairs(colony);
  planDefenses(colony, builders, threatened);
  planIndustry(colony, rates, builders);
  clearGroves(colony, builders);
  sendIdleRovers(colony);
  planRecruits(colony, rates, threatened);
  planMilitary(colony);
  for (const unit of colony.units) {
    if (unit.type === 'rover' || unit.order) continue;
    // Scouts range steadily farther from home so AI colonies eventually meet their neighbours.
    const radius = unit.type === 'scout' ? Math.min(MAP_MAX_X * 0.9, 22 + Math.max(0, colony.time - 90) * 0.12) : 10;
    const angle = Math.floor(colony.time / (unit.type === 'scout' ? 9 : 2)) * (unit.type === 'scout' ? 0.9 : 1) + unit.id * 2.4;
    const point = { x: clamp(colony.home.x + Math.cos(angle) * radius, MAP_MIN_X, MAP_MAX_X),
      z: clamp(colony.home.z + Math.sin(angle) * radius, MAP_MIN_Z, MAP_MAX_Z) };
    if (colony.world.navigation.intersects(point, point, unitClearance(unit.type))) continue;
    if (isMilitary(unit) && crossesTerritory(colony.world, unit, point,
      (id) => id && id !== colony.country && !colony.diplomacy.canAttack(colony.country, id))) continue;
    setUnitOrder(unit, { kind: 'move', ...point, patrol: true });
  }
}

export function surveyFaction(state, id) {
  if (state.sightings.has(id)) state.surveyedFactions.set(id, state.time + CONTACT_SURVEY_TIME);
}

export function updateGame(state, dt, shots) {
  const time = state.time + dt;
  for (const colony of state.factions.values()) {
    colony.time = time;
    checkDefeat(colony);
  }
  state.diplomacy.advance(time);
  for (const colony of state.factions.values()) if (!colony.defeat) progressOrders(colony, dt);
  advanceDiplomaticAI(state.diplomacy);
  for (const colony of state.factions.values()) if (!colony.defeat) progressCombat(colony, dt, shots);
  progressWildlife(state, dt);
  for (const colony of state.factions.values()) {
    checkDefeat(colony);
    if (colony.defeat) continue;
    advanceColony(colony, dt);
    if (colony.controller === 'ai') planColony(colony);
  }
  for (const colony of state.factions.values()) if (!colony.defeat) discoverContacts(colony);
  const shells = state.world.shells;
  if (shells.some((shell) => time - shell.fired >= shell.duration + 0.16)) {
    state.world.shells = shells.filter((shell) => time - shell.fired < shell.duration + 0.16);
  }
  const remains = state.world.unitRemains;
  let expired = 0;
  while (remains[expired]?.expiresAt <= time) expired++;
  if (expired) remains.splice(0, expired);
}

function discoverContacts(state) {
  let sources;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  const visible = (point) => {
    if (!sources) {
      sources = sightSources(state);
      for (const source of sources) {
        const radius = visionRadius(source);
        left = Math.min(left, source.x - radius);
        right = Math.max(right, source.x + radius);
        top = Math.min(top, source.z - radius);
        bottom = Math.max(bottom, source.z + radius);
      }
    }
    return point.x >= left && point.x <= right && point.z >= top && point.z <= bottom && inSight(point, sources);
  };
  for (const foreign of state.factions.values()) {
    if (foreign === state || foreign.defeat || state.sightings.has(foreign.country)) continue;
    if (!foreign.buildings.some((building) => !isBlueprint(building) && visible(building)) && !foreign.units.some(visible)) continue;
    state.sightings.add(foreign.country);
    state.knownFactions.add(foreign.country);
    foreign.knownFactions.add(state.country);
    state.contacts++;
    log(state, `First contact with ${foreign.name}. Diplomatic channels are open.`);
  }
  if (state.country !== state.world.localFaction) return;
  for (const outpost of state.world.outposts) {
    if (outpost.discovered || !visible(outpost)) continue;
    outpost.discovered = true;
    state.contacts++;
    log(state, outpost.relay ? `${outpost.name} found. Right-click it with a rover to capture it.`
      : `First contact established with ${outpost.name}.`);
  }
}

export function missionProgress(state) {
  const built = (type) => state.buildings.some((building) => building.type === type && building.progress === 1);
  return [state.gathered.metal >= 10 && state.gathered.biomass >= 10,
    built('mine') && built('solar'), built('habitat') && built('farm'), state.recruited > 0, state.contacts > 0];
}
