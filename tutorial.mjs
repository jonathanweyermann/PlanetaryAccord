import {
  BUILDINGS, COMMAND_TIERS, ORBITAL_SURVEY, RESOURCES, availableCrew, buildingSite, distance, territoryOwner,
} from './world.mjs';

const built = (game, type) => game.buildings.some((building) => building.type === type && building.progress >= 1);
const command = (game) => game.buildings[0];
const uplink = (game) => game.buildings.find((building) => building.type === 'uplink' && building.progress >= 1 && building.health > 0);
const relays = (game) => game.world.outposts.filter((site) => site.relay);

function nearestHome(game, points) {
  return points.reduce((nearest, point) => !nearest || distance(game.home, point) < distance(game.home, nearest) ? point : nearest, null);
}

function deposit(game, resource, type) {
  const candidates = game.world.deposits.filter((site) => site.type === resource
    && territoryOwner(game.world, site) === game.country
    && (type ? site.amount > 0 && !buildingSite(game, type, site).error : site.surface > 0));
  return nearestHome(game, candidates);
}

function locate(point, label) {
  return point ? { point, label } : null;
}

function costStatus(game, cost) {
  const missing = Object.entries(cost).filter(([resource, amount]) => game.resources[resource] < amount)
    .map(([resource, amount]) => `${Math.ceil(amount - game.resources[resource])} ${RESOURCES[resource].name.toLowerCase()}`);
  return missing.length ? `Still needed · ${missing.join(' · ')}` : 'Materials ready';
}

function buildingLesson(type, title, instruction, focus, { id = type, count = 1 } = {}) {
  const definition = BUILDINGS[type];
  return {
    id,
    title,
    complete: (game) => game.buildings.filter((building) => building.type === type && building.progress >= 1).length >= count,
    describe(game) {
      const pending = game.buildings.find((building) => building.type === type && building.progress < 1);
      return pending ? {
        instruction: 'Wait for your rover to finish. If you redirected it, select a rover and issue an order on the construction site to resume.',
        status: `Construction · ${Math.floor(pending.progress * 100)}%`,
        focus: locate(pending, 'Locate construction'),
      } : { instruction, status: costStatus(game, definition.cost), focus: focus?.(game) };
    },
  };
}

function upgradeLesson(tier) {
  return {
    id: `tier-${tier}`,
    title: `Upgrade Command to Tier ${tier}`,
    complete: (game) => command(game).tier >= tier,
    describe(game) {
      const upgrade = command(game).upgrade;
      return {
        instruction: upgrade ? 'The upgrade runs alongside training and construction. Continue developing your colony while it finishes.'
          : `Select Command in Quick Select, then choose Upgrade to Tier ${tier}. The upgrade adds housing capacity, health, vision, and new blueprints.`,
        status: upgrade ? `${Math.ceil(upgrade.remaining)}s remaining` : costStatus(game, COMMAND_TIERS[tier].cost),
        focus: locate(command(game), 'Locate Command'),
      };
    },
  };
}

export const CHAPTERS = [
  {
    title: 'Landing operations',
    lessons: [
      {
        id: 'gather', title: 'Collect metal and biomass',
        complete: (game) => (game.gathered.metal >= 10 || built(game, 'mine')) && (game.gathered.biomass >= 10 || built(game, 'bio')),
        describe(game) {
          const metal = game.gathered.metal >= 10 || built(game, 'mine');
          const active = metal ? 'biomass' : 'metal';
          return {
            instruction: `Select a Rover (R). ${metal ? 'Right-click a tree to start a nearby harvest patrol.' : 'Right-click an ore-bearing rock or Iron Deposit.'} Press P and drag to choose a patrol area.`,
            status: `Metal ${metal ? 10 : Math.min(10, Math.floor(game.gathered.metal))}/10 · Biomass ${built(game, 'bio') ? 10 : Math.min(10, Math.floor(game.gathered.biomass))}/10`,
            focus: locate(deposit(game, active), metal ? 'Locate biomass' : 'Locate iron'),
          };
        },
      },
      buildingLesson('mine', 'Automate metal production', 'With a Rover selected, choose Mine (1). Click a metal deposit to place it. Each completed Mine adds metal to your stockpile.',
        (game) => locate(deposit(game, 'metal', 'mine'), 'Locate a metal site')),
      buildingLesson('solar', 'Generate more power', 'Choose Solar Array (2), then click open ground. Mint terrain marks desert sites with the best solar output.',
        (game) => locate(nearestHome(game, game.world.regions.filter((region) => region.type === 'desert' && territoryOwner(game.world, region) === game.country)), 'Locate desert')),
    ],
  },
  {
    title: 'A growing colony',
    lessons: [
      buildingLesson('farm', 'Grow food', 'Choose Farm (4) and place it on open ground. Fertile plains give the best food output. Check the rate beside Food at the top of the screen.'),
      buildingLesson('habitat', 'Make room for colonists', 'Choose Habitat (3) to add five housing slots. With spare housing and a food surplus, more colonists arrive.'),
      {
        id: 'train', title: 'Train a recruit',
        complete: (game) => game.recruited > 0,
        describe(game) {
          const active = game.queue[0];
          return {
            instruction: 'Select Command, then choose Rover, Scout, or Infantry. Right-click with Command selected to set where recruits go after training.',
            status: active ? `${Math.ceil(active.remaining)}s remaining for the first recruit` : `${availableCrew(game)} colonists available for training`,
            focus: locate(command(game), 'Locate Command'),
          };
        },
      },
      {
        id: 'scout', title: 'Find a frontier relay',
        complete: (game) => relays(game).some((site) => site.discovered),
        describe(game) {
          const site = nearestHome(game, relays(game));
          const sector = site && { x: Math.round(site.x / 12) * 12, z: Math.round(site.z / 12) * 12 };
          return {
            instruction: 'Select Scout in Quick Select. Click the sector map to move the camera, then send the Scout into the search area. A relay appears once a unit gets close.',
            focus: locate(sector, 'Show search area'),
          };
        },
      },
    ],
  },
  {
    title: 'Frontier industry',
    lessons: [
      upgradeLesson(2),
      {
        id: 'capture', title: 'Capture a frontier relay',
        complete: (game) => relays(game).some((site) => site.owner === game.country),
        describe(game) {
          const site = nearestHome(game, relays(game).filter((relay) => relay.discovered && !relay.owner));
          return {
            instruction: 'Select a Rover and issue an order on a discovered relay. Keep the rover there until capture finishes. The relay will continue revealing the area when the rover leaves.',
            focus: locate(site, 'Locate discovered relay'),
          };
        },
      },
      buildingLesson('mine', 'Secure a second metal deposit', 'Place a second Mine on a different metal deposit. If you need metal to get started, order rovers to gather from the deposit first. Tier III needs a steady supply.',
        (game) => locate(deposit(game, 'metal', 'mine'), 'Locate another deposit'), { id: 'expand-metal', count: 2 }),
      buildingLesson('crystalTap', 'Extract crystal', 'Select a Rover and open construction Tier II. Place a Crystal Extractor directly on a violet crystal formation. Crystal pays for advanced structures and launch hardware.',
        (game) => locate(deposit(game, 'crystal', 'crystalTap'), 'Locate crystal')),
      buildingLesson('geoTap', 'Collect geothermal charge', 'Place a Geothermal Tap on a vent in Tier II. The orange deposits provide the geothermal charge required for fusion and orbital launches.',
        (game) => locate(deposit(game, 'vent', 'geoTap'), 'Locate a vent')),
      {
        id: 'defenses', title: 'Protect your expansion',
        complete: (game) => built(game, 'tower') || built(game, 'factory'),
        describe(game) {
          const pending = game.buildings.find((building) => (building.type === 'tower' || building.type === 'factory') && building.progress < 1);
          return {
            instruction: 'Build a Defense Tower or a Combat Factory from Tier II. Towers protect nearby sites automatically. Select a completed factory to train a mobile force.',
            status: pending ? `Construction · ${Math.floor(pending.progress * 100)}%` : '',
            focus: locate(pending, 'Locate construction'),
          };
        },
      },
    ],
  },
  {
    title: 'Orbital program',
    lessons: [
      upgradeLesson(3),
      buildingLesson('uplink', 'Build an Orbital Uplink', 'Select a Rover, open Tier III, and place an Orbital Uplink. Stockpile crystal and geothermal charge for the structure and its satellite.'),
      {
        id: 'satellite', title: 'Launch a Survey Satellite',
        complete: (game) => game.satellites.length > 0,
        describe(game) {
          const station = uplink(game);
          return {
            instruction: station?.launch ? 'The launch is in progress. When the satellite reaches orbit, its survey area will stay visible.'
              : 'Select the Orbital Uplink. Right-click the world map or sector map to choose a survey area, then select Launch Satellite. Place the survey over a frontier you want to explore.',
            status: station?.launch ? `Launch · ${Math.ceil(station.launch.remaining)}s remaining`
              : station ? costStatus(game, ORBITAL_SURVEY.cost) : 'Repair the Orbital Uplink to launch',
            focus: locate(station ?? game.buildings.find((building) => building.type === 'uplink'), 'Locate Uplink'),
          };
        },
      },
    ],
  },
];

export function missionGuide(game, completed) {
  let chapterIndex = -1;
  let lesson;
  for (const [index, chapter] of CHAPTERS.entries()) {
    for (const item of chapter.lessons) {
      if (item.complete(game)) completed.add(item.id);
      if (!lesson && !completed.has(item.id)) {
        chapterIndex = index;
        lesson = item;
      }
    }
  }
  return { chapterIndex, lesson, total: CHAPTERS.reduce((count, chapter) => count + chapter.lessons.length, 0) };
}
