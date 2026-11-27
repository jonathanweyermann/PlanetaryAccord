import {
  BIOMES, BUILDINGS, COMMAND_TIERS, ORBITAL_SURVEY, RESEARCH, RESOURCES, UNITS, MAP_WIDTH, MAP_DEPTH, MAP_MIN_X, MAP_MAX_X, MAP_MIN_Z, MAP_MAX_Z,
  FOG_WIDTH, FOG_DEPTH,
  aimedWallSite, assistConstruction, availableConstructionDeposits, availableCrew, buildingLineSites, buildingSite, canAfford, capacity, constructionFundingError, createFog, createGame, distance,
  hasConstructionAccess, highlightedMines, inSight, isBlueprint, isMilitary, maxBuildingHealth, orderFactionAttack,
  orbitalVision, orderBuilding, orderCommandUpgrade, orderHarvestPatrol, orderResearch, orderRoverAssist, orderSurveySatellite, preferredConstructionBiome, productionDetails, queueTraining, recommendedConstructionDeposits, removeBuilding,
  setConverterRecipe, setProductionRepeat, setRallyPoint, setSurveyTarget, setUnitOrder, sightSources, surveyFaction, trainingQueue, trainingTime,
  territoryOwner, unitHitRadius, unitTask, updateFog, updateGame, wallStrokeSites,
} from './world.mjs';
import { pointSegmentDistance } from './navigation.mjs';
import { loadUnitModels } from './models.mjs';
import { blendTerrainColor, terrainBiomes, terrainPaint, toSrgbByte } from './terrain-visuals.mjs';
import { audio } from './audio.mjs';
import { CHAPTERS, missionGuide } from './tutorial.mjs';
import { createDiplomacyUI } from './diplomacy-ui.mjs';
import { STANCE } from './diplomacy.mjs';
import { ATTACK_BORDER_COLOR, TERRITORY_FOG_LIMIT, attackBorderPoint, attackBorderWeight } from './territory.mjs';

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const TRAIN_BATCH = 5;
const GROUP_SELECT_RADIUS = 12;
const PATROL_CLICK_RADIUS = 7;
const EDGE_SCROLL_ZONE = 56;
const EDGE_SCROLL_SPEED = 114;
const KEYBOARD_PAN_SPEED = 19;
const BUILD_SHORTCUT_MS = 2800;
const SIMULATION_STEP_MS = 40;
const SIMULATION_TIMER_MS = 250;
const ATTACK_MARKER_MS = 5000;
const BUILD_ICONS = { command: 'home', mine: 'mine', solar: 'solar', habitat: 'habitat', farm: 'farm', bio: 'biomass',
  wall: 'wall',
  factory: 'factory', relay: 'radio', hydro: 'farm', tower: 'tower', crystalTap: 'crystal', geoTap: 'energy',
  foundry: 'factory', fusion: 'energy', bastion: 'tower', uplink: 'radio', reclaimer: 'convert', synthesizer: 'convert' };
const BUILD_TYPES = Object.keys(BUILDINGS).filter((type) => BUILDINGS[type].tier);
const unitIcon = (type) => UNITS[type]?.model ?? type;
const COST_LABELS = { metal: 'M', biomass: 'B', food: 'F', energy: 'E', crystal: 'C', vent: 'G' };
const completedLessons = new Set();

const canvas = $('world');
const gameElement = $('game');
const viewport = $('viewport');
const minimap = $('minimap');
const mini = minimap.getContext('2d');
const terrainMap = document.createElement('canvas');
terrainMap.width = minimap.width;
terrainMap.height = minimap.height;
const terrainMini = terrainMap.getContext('2d');
const fogMap = document.createElement('canvas');
fogMap.width = FOG_WIDTH;
fogMap.height = FOG_DEPTH;
const fogMini = fogMap.getContext('2d');
const fogPixels = fogMini.createImageData(FOG_WIDTH, FOG_DEPTH);
const borderMap = document.createElement('canvas');
borderMap.width = FOG_WIDTH;
borderMap.height = FOG_DEPTH;
const borderMini = borderMap.getContext('2d');
let borderPixels;
let borderTerritory;
const selected = new Set();
const keys = new Set();
const speeds = [1, 2, 4];
let view;
let game;
let diplomacyUI;
let fog;
let placement = null;
let buildTier = 1;
let lastCommandTier = 1;
let buildShortcutUntil = 0;
let orderMode = false;
let patrolMode = false;
let pointer = null;
let hoverPoint = null;
let orderTarget = null;
let attackAlert = null;
let paused = false;
let modalOpen = false;
let speedIndex = 0;
let previousFrame = 0;
let lastSimulationTick = 0;
let pendingSimulationMs = 0;
let nextUi = 0;
let nextMini = 0;
let lastSelection = '';
let lastActions = '';
let lastGuide = '';
let tutorialFocus = null;
let lastLog = null;
let lastTraining = '';
let contactsAnnounced = new Set();
let toastTimer;

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const factoryNames = { factory: 'Combat Factories', foundry: 'Heavy Foundries' };

function unitStats(type, health) {
  const definition = UNITS[type];
  const hp = health === undefined ? `${definition.health} HP` : `${Math.ceil(health)}/${definition.health} HP`;
  const weapon = definition.combat;
  return weapon ? `${hp} · ${weapon.damage} damage per shot · Range ${weapon.range}` : `${hp} · Unarmed`;
}

function timeLabel(value) {
  const seconds = Math.floor(value);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function notice(message, error = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  if (error) audio.play('error');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2800);
}

function initControls() {
  window.addEventListener('pointerdown', () => audio.wake(), { capture: true, passive: true });
  window.addEventListener('keydown', (event) => { if (!event.repeat) audio.wake(); }, { capture: true });
  const AUDIO_KEY = 'planetary-accord:audio';
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? 'null');
    if (saved) { $('sound-effects').checked = saved.effects !== false; $('music').checked = saved.music !== false; }
  } catch { /* storage unavailable: keep defaults */ }
  const updateAudio = () => {
    const settings = { effects: $('sound-effects').checked, music: $('music').checked };
    audio.configure(settings);
    try { localStorage.setItem(AUDIO_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  };
  $('sound-effects').addEventListener('change', updateAudio);
  $('music').addEventListener('change', updateAudio);
  updateAudio();
  const resourcePanel = $('resources');
  for (const [type, resource] of Object.entries({ ...RESOURCES, people: { name: 'Population', color: '#bcd0c4' } })) {
    const item = document.createElement('div');
    item.className = 'resource';
    item.style.setProperty('--resource', resource.color);
    item.innerHTML = `${icon(type === 'vent' ? 'energy' : type)}<span class="resource-label">${resource.label ?? resource.name}</span><strong id="value-${type}"></strong><small id="rate-${type}"></small>`;
    resourcePanel.append(item);
  }
  for (const type of ['rover', 'scout', 'infantry', 'command']) {
    const button = document.createElement('button');
    const label = type === 'command' ? 'Command' : UNITS[type].label;
    button.type = 'button';
    button.id = `quick-${type}`;
    button.title = `Select ${type === 'command' ? BUILDINGS.command.name : UNITS[type].name}`;
    button.innerHTML = `${icon(type === 'command' ? 'home' : type)}<span>${label}</span><small></small>`;
    button.addEventListener('click', () => { selectType(type); audio.play('select'); });
    button.addEventListener('dblclick', () => {
      const entity = ownSelection()[0];
      if (entity) view.center(entity.x, entity.z);
    });
    $('squad').append(button);
  }

  $('pause').addEventListener('click', togglePause);
  $('speed').addEventListener('click', () => {
    advanceSimulation();
    speedIndex = (speedIndex + 1) % speeds.length;
    $('speed').innerHTML = `${speeds[speedIndex]}<i>×</i>`;
    $('speed').setAttribute('aria-label', `Simulation speed ${speeds[speedIndex]} times. Click to change.`);
  });
  $('select-rovers').addEventListener('click', () => { selectType('rover'); audio.play('select'); });
  $('idle-workers').addEventListener('click', (event) => {
    if (event.detail < 2) selectIdleWorkers();
  });
  $('idle-workers').addEventListener('dblclick', () => selectIdleWorkers(true));
  $('camera-home').addEventListener('click', () => view.resetCamera());
  $('building-names').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? 'Hide building names' : 'Show building names';
    view.setBuildingNames(enabled);
  });
  $('neighbor-inspect').addEventListener('click', () => {
    const contact = firstContact();
    if (!contact) return;
    surveyFaction(game, contact.country);
    view.center(contact.home.x, contact.home.z);
    updateMinimap();
    renderNeighbor();
  });
  $('zoom-in').addEventListener('click', () => view.setZoom(view.zoom * 1.19 ** 3));
  $('zoom-out').addEventListener('click', () => view.setZoom(view.zoom / 1.19 ** 3));
  $('settings').addEventListener('click', () => {
    $('new-seed').value = game.world.seed;
    showGameDialog('world-dialog');
  });
  $('tech-open').addEventListener('click', openTechnologyTree);
  diplomacyUI = createDiplomacyUI(() => game, () => showGameDialog('diplomacy-dialog'));
  $('tech-tree').addEventListener('click', (event) => {
    const button = event.target.closest('[data-research]');
    if (!button) return;
    const id = button.dataset.research;
    const error = orderResearch(game, id);
    if (error) {
      $('tech-message').hidden = false;
      $('tech-message').textContent = error;
      audio.play('error');
      return;
    }
    $('tech-dialog').close();
    notice(`Research started · ${RESEARCH[id].name}.`);
    audio.play('upgrade');
  });
  $('guide-enabled').addEventListener('change', renderMissionGuide);
  $('guide-locate').addEventListener('click', () => {
    if (tutorialFocus) {
      view.center(tutorialFocus.point.x, tutorialFocus.point.z);
      updateMinimap();
    }
  });
  $('siting-guide').addEventListener('change', () => {
    if (placement) updatePlacementHint();
    refreshSitingGuide();
  });
  for (const id of ['world-dialog', 'tech-dialog', 'diplomacy-dialog']) {
    $(id).addEventListener('close', () => {
      if ($(id).open) return;
      advanceSimulation();
      modalOpen = Boolean(document.querySelector('dialog[open]'));
    });
  }
  $('defeat-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('defeat-restart').addEventListener('click', () => {
    $('defeat-dialog').close();
    modalOpen = false;
    start(randomSeed());
  });
  $('random-seed').addEventListener('click', () => { $('new-seed').value = randomSeed(); });
  $('world-form').addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'generate') return;
    start(Number($('new-seed').value));
  });
  $('repeat-production').addEventListener('click', () => {
    const command = game.buildings[0];
    setProductionRepeat(command, !command.repeatProduction);
    refreshSelection();
  });
  $('build-tiers').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tier]');
    if (!button) return;
    buildTier = Number(button.dataset.tier);
    if (placement && BUILDINGS[placement].tier !== buildTier) clearMode();
    refreshSelection();
  });
  $('actions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.mode === 'upgrade') {
      const error = orderCommandUpgrade(game);
      if (error) notice(error, true);
      else audio.play('upgrade');
      renderUi();
    } else if (button.dataset.mode === 'launch') {
      const error = orderSurveySatellite(game, selectedUplink());
      if (error) notice(error, true);
      else {
        clearMode();
        audio.play('upgrade');
      }
      renderUi();
    } else if (button.dataset.mode === 'train') {
      const facilities = selectedTrainingBuildings();
      if (!facilities.length) return;
      const { error, count, facilitiesUsed } = queueTraining(game, button.dataset.action, event.shiftKey ? TRAIN_BATCH : 1, facilities);
      if (error) notice(error, true);
      else {
        audio.play('queue');
        if (facilities.length > 1) notice(`${count} queued across ${facilitiesUsed} of ${facilities.length} selected factories.`);
        else if (event.shiftKey) notice(`${count} added to the training queue.`);
      }
      renderUi();
    } else if (button.dataset.mode === 'convert') {
      const error = setConverterRecipe(game, selectedConverter(), button.dataset.action);
      if (error) notice(error, true);
      else clearMode();
      renderUi();
    } else {
      enterPlacement(button.dataset.action);
    }
  });
  $('selected-unit').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-building]');
    if (remove) {
      const selection = ownSelection();
      const building = selection[0];
      if (selection.length !== 1 || building.id !== Number(remove.dataset.buildingId)) return;
      const error = removeBuilding(game, building, remove.dataset.removeBuilding);
      if (error) {
        notice(error, true);
        return;
      }
      const name = BUILDINGS[building.type].name;
      setSelection([]);
      orderTarget = null;
      updateMinimap();
      renderUi();
      notice(remove.dataset.removeBuilding === 'cancel' ? `${name} canceled. Materials refunded.` : `${name} dismantled. Site cleared.`);
      return;
    }
    if (event.target.closest('.clear-rally')) {
      for (const facility of selectedTrainingBuildings()) facility.rallyPoints.length = 0;
      clearMode();
      refreshSelection();
      return;
    }
    if (event.target.closest('.patrol-button')) {
      toggleHarvestPatrolMode();
      return;
    }
    if (!event.target.closest('.order-button')) return;
    if (orderMode) clearMode();
    else {
      clearMode();
      orderMode = true;
      gameElement.classList.add('ordering');
      $('placement-hint').textContent = selectedUplink() ? 'Click the world map or sector map to set the satellite survey area'
        : selectedTrainingBuildings().length
        ? 'Click the world map or sector map to set a rally point · Shift-click to add a waypoint'
        : 'Click to issue an order · Shift-click to queue it';
      $('placement-hint').hidden = false;
    }
    refreshSelection();
  });
}

function showGameDialog(id) {
  if (modalOpen) return;
  advanceSimulation();
  keys.clear();
  buildShortcutUntil = 0;
  $(id).showModal();
  modalOpen = true;
}

function togglePause() {
  advanceSimulation();
  paused = !paused;
  document.body.classList.toggle('paused', paused);
  $('pause').innerHTML = icon(paused ? 'play' : 'pause');
  $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
  renderCommandStatus();
}

function renderCommandStatus() {
  const status = game.defeat ? 'COLONY DEFEATED' : paused ? 'SIMULATION PAUSED'
    : game.buildings[0].health <= 0 ? 'COMMAND DISABLED' : 'COMMAND ONLINE';
  const element = $('colony-status');
  if (element.dataset.status === status) return;
  element.dataset.status = status;
  element.innerHTML = `<i></i> ${status}`;
}

function start(seed) {
  game = createGame(seed);
  diplomacyUI.reset();
  buildTier = 1;
  lastCommandTier = 1;
  fog = createFog();
  selected.clear();
  for (const unit of game.units) if (unit.type === 'rover') selected.add(unit.id);
  keys.clear();
  buildShortcutUntil = 0;
  pointer = null;
  hoverPoint = null;
  orderTarget = null;
  attackAlert = null;
  pendingSimulationMs = 0;
  nextUi = 0;
  nextMini = 0;
  lastSelection = '';
  lastActions = '';
  completedLessons.clear();
  lastGuide = '';
  tutorialFocus = null;
  lastLog = null;
  lastTraining = '';
  contactsAnnounced.clear();
  clearMode();
  if (paused) togglePause();
  speedIndex = 0;
  $('speed').innerHTML = '1<i>×</i>';
  $('speed').setAttribute('aria-label', 'Simulation speed 1 time. Click to change.');
  const names = ['Kestrel Basin', 'Tamarack Vale', 'Peregrine Reach', 'Meridian Plain', 'Sable Basin', 'Juniper Crossing'];
  $('sector-name').textContent = names[seed % names.length];
  $('seed-label').textContent = String(seed);
  showTerrainAt(game.home);
  $('toast').hidden = true;
  view.setWorld(game.world);
  paintTerrainMap();
  renderUi();
  updateMinimap();
  lastSimulationTick = performance.now();
}

function ownSelection() {
  return [...game.units, ...game.buildings].filter((entity) => selected.has(entity.id));
}

function selectedTrainingBuildings(selection = ownSelection()) {
  const facility = selection[0];
  if (facility?.progress !== 1 || !BUILDINGS[facility.type]?.trains) return [];
  if (selection.length === 1) return selection;
  return factoryNames[facility.type]
    && selection.every((building) => building.type === facility.type && building.progress === 1) ? selection : [];
}

function selectedUplink(selection = ownSelection()) {
  const station = selection[0];
  return selection.length === 1 && station.type === 'uplink' && station.progress === 1 ? station : null;
}

function selectedConverter(selection = ownSelection()) {
  const building = selection[0];
  return selection.length === 1 && BUILDINGS[building.type]?.conversion ? building : null;
}

function showTerrain(biome, ridge = false) {
  const terrain = ridge ? { name: 'Rock ridge', advantage: 'Impassable · Move around the ridge to cross' } : BIOMES[biome];
  const label = $('terrain-label');
  const name = terrain.name.toUpperCase();
  const advantage = $('terrain-advantage');
  if (label.textContent !== name) label.textContent = name;
  if (advantage.textContent !== terrain.advantage) advantage.textContent = terrain.advantage;
}

function showTerrainAt(point) {
  const { world } = game;
  showTerrain(world.sample(point.x, point.z),
    world.navigation.intersects(point, point, 0, (shape) => shape.kind === 'ridge'));
  const owner = territoryOwner(world, point);
  const x = Math.floor(point.x - MAP_MIN_X);
  const z = Math.floor(point.z - MAP_MIN_Z);
  const explored = x >= 0 && x < FOG_WIDTH && z >= 0 && z < FOG_DEPTH && fog.explored[z * FOG_WIDTH + x];
  const label = $('territory-label');
  label.textContent = owner === game.country || explored
    ? game.factions.get(owner)?.name ?? 'Contested frontier' : 'Uncharted territory';
}

function selectableRovers() {
  const rovers = game.units.filter((unit) => unit.type === 'rover' && selected.has(unit.id));
  return rovers.length ? rovers : game.units.filter((unit) => unit.type === 'rover');
}

function setSelection(entities, append = false) {
  clearMode();
  if (!append) selected.clear();
  for (const entity of entities) {
    if (append && selected.has(entity.id)) selected.delete(entity.id);
    else selected.add(entity.id);
  }
  refreshSelection();
}

function selectType(type) {
  const entities = type === 'command' ? [game.buildings[0]] : game.units.filter((unit) => unit.type === type);
  if (!entities.length) {
    notice(`No ${UNITS[type].label.toLowerCase()} units available.`, true);
    return;
  }
  setSelection(entities);
}

function idleWorkers() {
  return game.units.filter((unit) => unit.type === 'rover' && unit.health > 0 && !unit.order && !unit.queuedOrders.length);
}

function selectIdleWorkers(all = false) {
  const workers = idleWorkers();
  if (!workers.length) return;
  setSelection(all ? workers : [nearest(workers, view.focus, Infinity)]);
  audio.play('select');
}

function renderIdleWorkers() {
  const button = $('idle-workers');
  const badge = $('idle-worker-count');
  const count = idleWorkers().length;
  if (badge.textContent === String(count)) return;
  badge.textContent = count;
  button.disabled = !count;
  button.setAttribute('aria-label', count
    ? `${count} idle worker${count === 1 ? '' : 's'}. Click to select the closest worker. Double-click to select all idle workers.`
    : 'No idle workers');
}

function costString(cost) {
  return Object.entries(cost).map(([resource, value]) => `${value}${COST_LABELS[resource]}`).join(' · ');
}

function fullCost(cost) {
  return Object.entries(cost).map(([resource, value]) => `${value} ${RESOURCES[resource].name.toLowerCase()}`).join(' and ');
}

function recipeFormula(resource, recipe) {
  return `${fullCost(recipe.inputs)} → ${recipe.output} ${RESOURCES[resource].name.toLowerCase()} per minute`;
}

function renderMissionGuide() {
  const panel = $('mission-guide');
  const enabled = $('guide-enabled').checked;
  panel.hidden = !enabled;
  const { chapterIndex, lesson, total } = missionGuide(game, completedLessons);
  if (!enabled) { tutorialFocus = null; return; }

  const chapter = CHAPTERS[chapterIndex];
  const hint = lesson?.describe(game);
  tutorialFocus = hint?.focus ?? null;
  const key = `${chapterIndex}/${[...completedLessons].join(',')}`;
  if (key !== lastGuide) {
    $('objective-count').textContent = `${completedLessons.size} / ${total}`;
    $('guide-phase').textContent = chapter?.title ?? 'Orbital survey online';
    $('guide-lesson').textContent = lesson?.title ?? 'Mission complete';
    $('guide-checklist').hidden = !chapter;
    $('guide-phases').innerHTML = CHAPTERS.map(({ title, lessons }, index) => {
      const done = lessons.filter((item) => completedLessons.has(item.id)).length;
      return `<span class="guide-phase${index === chapterIndex ? ' active' : ''}" title="${title} · ${done}/${lessons.length}" style="--completion:${done / lessons.length * 100}%"></span>`;
    }).join('');
    $('objectives').innerHTML = chapter?.lessons.map((item, index) => {
      const done = completedLessons.has(item.id);
      return `<li class="objective ${done ? 'complete' : item === lesson ? 'current' : ''}" ${item === lesson ? 'aria-current="step"' : ''}><span class="objective-marker">${done ? icon('check') : index + 1}</span><strong>${item.title}</strong></li>`;
    }).join('') ?? '';
    lastGuide = key;
  }
  const instruction = hint?.instruction ?? 'Your satellite keeps its survey area visible. Continue expanding, deploy more satellites, or train advanced units at the Heavy Foundry.';
  const status = hint?.status ?? '';
  if ($('guide-instruction').textContent !== instruction) $('guide-instruction').textContent = instruction;
  if ($('guide-status').textContent !== status) $('guide-status').textContent = status;
  $('guide-status').hidden = !status;
  $('guide-locate').hidden = !tutorialFocus;
  if (tutorialFocus && $('guide-locate').textContent !== tutorialFocus.label) $('guide-locate').textContent = tutorialFocus.label;
}

function techCost(cost) {
  return Object.entries(cost).map(([resource, value]) =>
    `<span style="--resource:${RESOURCES[resource].color}" title="${RESOURCES[resource].name}" aria-label="${value} ${RESOURCES[resource].name}">${value} ${COST_LABELS[resource]}</span>`).join('');
}

function techUnit(type) {
  const { name, role, combat, cost, vision } = UNITS[type];
  const extra = combat ? `${Math.round(combat.damage / combat.cooldown * 10) / 10} sustained damage/s` : `Vision ${vision}`;
  return `<article class="tech-node tech-unit"><h4>${icon(unitIcon(type))}${name}</h4><p>${role}</p><p class="tech-unit-stats">${unitStats(type)} · ${extra}</p><div class="tech-cost">${techCost(cost)}</div></article>`;
}

function openTechnologyTree() {
  const currentTier = game.buildings[0].tier;
  const currentProject = game.researchProject;
  $('tech-message').hidden = !currentProject;
  if (currentProject) $('tech-message').textContent = 'Close the technology tree to resume research.';
  const names = ['Landing', 'Frontier industry', 'Orbital program'];
  const summaries = ['Workers, scouts, and low-cost defense.', 'Faster vehicles, tougher infantry, and advanced scouts.',
    'Frontline tanks, long-range siege guns, and wide-area reconnaissance.'];
  const seenUnits = new Set();
  $('tech-tree').innerHTML = names.map((name, index) => {
    const tier = index + 1;
    const upgrade = COMMAND_TIERS[tier];
    const roster = Object.values(BUILDINGS).filter((building) => (building.tier ?? 1) === tier && building.trains)
      .map((building) => {
        const units = building.trains.filter((type) => !seenUnits.has(type));
        units.forEach((type) => seenUnits.add(type));
        return units.length ? `<div class="tech-trainer">Train at ${building.name}</div>${units.map(techUnit).join('')}` : '';
      }).join('');
    const cards = BUILD_TYPES.filter((type) => BUILDINGS[type].tier === tier).map((type) => {
      const definition = BUILDINGS[type];
      const cardDetail = definition.trains ? `Trains ${definition.trains.map((unit) => UNITS[unit].name).join(', ')}.` : definition.description;
      const recipes = Object.entries(definition.conversion ?? {}).map(([resource, recipe]) => `<p>${recipeFormula(resource, recipe)}</p>`).join('');
      return `<article class="tech-node"><h4>${icon(BUILD_ICONS[type])}${definition.name}</h4><p>${cardDetail}</p>${recipes}<div class="tech-cost">${techCost(definition.cost)}</div></article>`;
    });
    if (tier === 3) {
      cards.push(`<article class="tech-node tech-satellite"><h4>${icon('compass')}Survey Satellite</h4><p>Launch from an Orbital Uplink to keep a chosen area visible.</p><div class="tech-cost">${techCost(ORBITAL_SURVEY.cost)}</div></article>`);
    }
    const gate = upgrade.cost ? `<div class="tech-gate"><span>Command upgrade · ${upgrade.time}s</span><div class="tech-cost">${techCost(upgrade.cost)}</div></div>`
      : '<div class="tech-gate">Available at touchdown</div>';
    const research = Object.entries(RESEARCH).filter(([, project]) => project.tier === tier).map(([id, project]) => {
      const completed = game.research.has(id);
      const active = currentProject?.id === id;
      const unavailable = tier > currentTier || completed || Boolean(currentProject);
      const status = completed ? 'Researched' : active ? `${Math.ceil(currentProject.remaining)}s remaining`
        : tier > currentTier ? 'Locked' : currentProject ? 'Research slot busy' : `Research · ${project.time}s`;
      return `<article class="tech-node tech-research"><h4>${icon('layers')}${project.name}</h4><p>${project.description}</p><div class="tech-cost">${techCost(project.cost)}</div><button type="button" data-research="${id}" ${unavailable ? 'disabled' : ''}>${status}</button></article>`;
    }).join('');
    return `<section class="tech-tier" ${tier > currentTier ? 'data-locked' : ''}><header><h3>${tier} · ${name}</h3><span>${tier <= currentTier ? 'Unlocked' : 'Locked'}</span></header>${gate}<p class="tech-tier-summary">${summaries[index]}</p><div class="tech-roster">${roster}</div><div class="tech-nodes">${research}${cards.join('')}</div></section>`;
  }).join('');
  showGameDialog('tech-dialog');
}

function renderUi() {
  renderCommandStatus();
  const defeatDialog = $('defeat-dialog');
  if (game.defeat && !defeatDialog.open) {
    document.querySelector('dialog[open]')?.close();
    modalOpen = false;
    clearMode();
    const victor = game.factions.get(game.defeat.by);
    $('defeat-summary').textContent = victor
      ? `${victor.name} disabled your Command Center. With no Construction Rovers left to repair it, your colony has been defeated.`
      : 'Your Command Center is disabled and no Construction Rovers remain to repair it.';
    showGameDialog('defeat-dialog');
  }
  const tier = game.buildings[0].tier;
  if (tier > lastCommandTier) {
    buildTier = tier;
    lastCommandTier = tier;
    audio.play('upgrade');
    notice(`Tier ${tier} construction unlocked.`);
  }
  const { rates, conversions } = productionDetails(game);
  for (const type of Object.keys(RESOURCES)) {
    $(`value-${type}`).textContent = Math.floor(game.resources[type]);
    const rate = $(`rate-${type}`);
    const perMinute = Math.round(rates[type] * 60);
    rate.textContent = perMinute === 0 ? '' : `${perMinute > 0 ? '+' : '−'}${Math.abs(perMinute)}`;
    rate.classList.toggle('negative', perMinute < 0);
    $(`value-${type}`).parentElement.title = `${RESOURCES[type].name} · ${perMinute} per minute from buildings and upkeep`;
  }
  $('value-people').textContent = `${game.population}/${capacity(game)}`;
  $('value-people').parentElement.title = `${availableCrew(game)} colonists available for recruitment`;
  $('clock').textContent = timeLabel(game.time);
  $('tech-open').classList.toggle('research-active', Boolean(game.researchProject));
  renderMissionGuide();
  const recent = game.messages.at(-1);
  if (recent !== lastLog) {
    const content = $('log');
    content.replaceChildren(...game.messages.slice(-8).reverse().map(({ time, message }) => {
      const entry = document.createElement('div');
      entry.className = 'event';
      const stamp = document.createElement('time');
      stamp.textContent = timeLabel(time);
      entry.append(stamp, document.createTextNode(message));
      return entry;
    }));
    content.scrollTop = 0;
    lastLog = recent;
  }
  renderIdleWorkers();
  renderNeighbor();
  refreshSelection(conversions);
  diplomacyUI.render();
}

function firstContact() {
  return game.factions.get(game.sightings.values().next().value);
}

function renderNeighbor() {
  const neighbor = firstContact();
  const panel = $('neighbor-debug');
  panel.hidden = !neighbor;
  if (!neighbor) return;
  const surveyUntil = game.surveyedFactions.get(neighbor.country);
  const revealActive = surveyUntil > game.time;
  const stage = neighbor.defeat ? 'defeated' : revealActive ? 'reveal' : 'live';
  $('neighbor-name').textContent = neighbor.name;
  if (panel.dataset.stage !== stage) {
    panel.dataset.stage = stage;
    $('neighbor-status').textContent = neighbor.defeat ? 'DEFEATED' : revealActive ? 'SURVEY ACTIVE' : 'CONTACT';
    $('neighbor-inspect').hidden = Boolean(neighbor.defeat);
  }
  const complete = neighbor.buildings.filter((building) => building.progress === 1).length;
  const building = neighbor.buildings.filter((site) => !isBlueprint(site)).length - complete;
  $('neighbor-metrics').textContent = `${complete} structures · ${neighbor.units.length} units${building ? ` · +${building} building` : ''}`;
  $('neighbor-supply').textContent = Object.entries(neighbor.resources)
    .filter(([resource]) => resource !== 'crystal' && resource !== 'vent')
    .map(([resource, amount]) => `${Math.floor(amount)}${COST_LABELS[resource]}`).join(' · ');
  $('neighbor-action').textContent = neighbor.lastAction;
  const relation = game.diplomacy.between(game.country, neighbor.country).state;
  $('neighbor-contact').textContent = `${relation}${revealActive ? ` · ${Math.ceil(surveyUntil - game.time)}s survey` : ''}`;
  for (const id of game.sightings) {
    if (contactsAnnounced.has(id)) continue;
    contactsAnnounced.add(id);
    notice(`First contact with ${game.factions.get(id).name}. Diplomacy is available.`);
  }
}

function refreshSelection(conversions) {
  const list = ownSelection();
  const primary = list[0];
  const allOneType = list.length && list.every((item) => item.type === primary.type);
  const facilities = selectedTrainingBuildings(list);
  const facility = facilities[0];
  const groupTraining = facilities.length > 1;
  const canTrain = facilities.some((building) => building.health > 0);
  const queues = facilities.map((building) => ({ facility: building, queue: trainingQueue(game, building) }));
  const station = selectedUplink(list);
  const converter = selectedConverter(list);
  const canPatrol = list.some((entity) => entity.type === 'rover');
  const canTarget = station?.health > 0 && !station.launch && !station.satellite;
  const train = Boolean(facility);
  const isCommand = facility?.type === 'command';
  const command = game.buildings[0];
  const tier = command.tier;
  const upgrade = COMMAND_TIERS[tier + 1];
  const selectedBuild = list.length === 1 && primary.progress !== undefined;
  const rallyCount = facility?.rallyPoints.length ?? 0;
  const hasRally = facilities.some((building) => building.rallyPoints.length > 0);
  let symbol = 'compass';
  let name = 'Select a unit';
  let detail = 'Click a unit or drag to select a squad.';
  if (primary) {
    symbol = allOneType ? BUILD_ICONS[primary.type] || unitIcon(primary.type) : 'people';
    const primaryName = (UNITS[primary.type] || BUILDINGS[primary.type]).name;
    const pluralName = factoryNames[primary.type] ?? `${primaryName}${primary.type === 'infantry' ? '' : 's'}`;
    name = list.length === 1 ? primaryName : allOneType ? `${list.length} ${pluralName}` : `${list.length} units selected`;
    if (selectedBuild && primary.progress < 1) {
      if (!hasConstructionAccess(game, primary)) detail = 'Construction paused · Territory access';
      else {
        const crew = game.units.filter((unit) => {
          const task = unitTask(unit);
          return (task?.kind === 'build' && task.building === primary)
            || unit.queuedOrders.some((order) => order.kind === 'build' && order.building === primary);
        }).length;
        const progress = primary.progress ? `${Math.floor(primary.progress * 100)}% complete` : 'Blueprint queued';
        const waiting = primary.blockedFootprint ? 'Waiting for a clear site'
          : primary.materialShortage ? `Waiting for ${RESOURCES[primary.materialShortage].name.toLowerCase()}` : '';
        detail = `${progress} · ${waiting || (crew ? `${crew} rover${crew === 1 ? '' : 's'} assigned` : 'Right-click with rovers to build')}`;
      }
    } else if (station) {
      detail = station.satellite ? 'Orbital survey online' : station.launch ? 'Launch in progress'
        : station.health <= 0 ? 'Disabled · Order a rover to repair' : station.surveyTarget ? 'Survey area selected' : 'Right-click to choose a survey area';
    } else if (groupTraining) {
      detail = 'Right-click to rally all';
    } else if (train) {
      detail = rallyCount ? `${rallyCount} rally waypoint${rallyCount === 1 ? '' : 's'}` : 'Right-click to set a rally point';
      if (isCommand) detail = `Tier ${tier} · ${detail}`;
      if (facility.health <= 0) detail = 'Disabled · Right-click with a rover to repair';
    } else if (selectedBuild) {
      const range = BUILDINGS[primary.type].combat?.range;
      detail = primary.health <= 0 ? 'Disabled · Right-click with a rover to repair'
        : `Operational · ${Math.ceil(primary.health)} HP${range ? ` · Range ${range}` : ''}`;
    } else if (list.length === 1) {
      const order = primary.order?.kind;
      const workNames = { harvest: 'Harvesting', build: 'Building', repair: 'Repairing', capture: 'Capturing relay' };
      const orderNames = { harvest: 'Heading to resources', harvestPatrol: 'Harvest patrol', move: 'Moving', withdraw: 'Withdrawing',
        attack: 'Engaging', build: 'Heading to build site', repair: 'Heading to repair site', capture: 'Heading to relay' };
      const status = order === 'build' && !hasConstructionAccess(game, primary.order.building) ? 'Construction paused'
        : primary.route && !primary.route.reaches && !primary.route.points.length
        ? 'Route blocked' : workNames[primary.work] || orderNames[order] || 'Ready for orders';
      const assignment = order !== 'assist' ? status
        : primary.work || status === 'Route blocked' ? `Assisting rover · ${status}` : 'Assisting rover';
      detail = `${assignment} · ${unitStats(primary.type, primary.health)}`;
      if (primary.queuedOrders.length) detail += ` · ${primary.queuedOrders.length} queued`;
    } else {
      const queued = Math.max(...list.map((unit) => unit.queuedOrders?.length || 0));
      const work = [['harvest', 'harvesting'], ['build', 'building'], ['repair', 'repairing']]
        .map(([type, label]) => [list.filter((unit) => unit.work === type).length, label])
        .filter(([count]) => count)
        .map(([count, label]) => `${count} ${label}`).join(' · ');
      const assignment = work || `${list.filter((unit) => unit.order).length} on assignment`;
      detail = queued ? `${assignment} · ${queued} queued per route` : work || `${assignment} · Right-click to order`;
      if (allOneType && UNITS[primary.type]) detail += ` · Per unit: ${unitStats(primary.type)}`;
    }
  }
  const selectionType = station ? 'ORBITAL CONTROL' : converter ? 'RESOURCE CONVERSION' : isCommand ? 'HEADQUARTERS' : train ? 'PRODUCTION' : 'SELECTION';
  const orderLabel = primary && (train || canTarget || !selectedBuild)
    ? orderMode ? 'Cancel order' : canTarget ? 'Set survey area' : train ? 'Set rally' : 'Issue order' : '';
  const removeMode = selectedBuild && primary.type !== 'command' ? primary.progress < 1 ? 'cancel' : 'dismantle' : '';
  const selectionKey = `${symbol}/${name}/${selectionType}/${orderLabel}/${hasRally}/${removeMode}/${primary?.id}/${canPatrol}/${patrolMode}`;
  const selectionPanel = $('selected-unit');
  if (selectionKey !== lastSelection) {
    const orderButton = orderLabel ? `<button type="button" class="order-button" aria-pressed="${orderMode}">${orderLabel}</button>` : '';
    const patrolButton = canPatrol ? `<button type="button" class="patrol-button" aria-pressed="${patrolMode}" aria-keyshortcuts="P" title="Harvest the area first, then nearby trees and rocks (P)">Harvest patrol</button>` : '';
    const clearRally = hasRally ? '<button type="button" class="clear-rally">Clear rally</button>' : '';
    const removeLabel = removeMode === 'cancel' ? 'Cancel construction' : 'Dismantle';
    const removeTitle = removeMode === 'cancel' ? 'Clear this site and refund its construction materials' : 'Clear this site without a refund for the finished building';
    const removeButton = removeMode ? `<button type="button" class="structure-remove" data-remove-building="${removeMode}" data-building-id="${primary.id}" title="${removeTitle}">${removeLabel}</button>` : '';
    selectionPanel.innerHTML = `<div class="selection-emblem">${icon(symbol)}</div><div><div class="selection-name">${name}</div><div class="selection-detail"></div>${orderButton}${patrolButton}${clearRally}${removeButton}</div>`;
    $('selection-type').textContent = selectionType;
    lastSelection = selectionKey;
  }
  const detailNode = selectionPanel.querySelector('.selection-detail');
  if (detailNode.textContent !== detail) detailNode.textContent = detail;

  const actionKey = station ? 'orbital' : converter ? converter.type : train ? `${facility.type}/${tier}/${groupTraining}` : `build/${buildTier}/${tier}`;
  const tierControls = $('build-tiers');
  tierControls.hidden = train || Boolean(station || converter);
  for (const button of tierControls.children) button.setAttribute('aria-pressed', String(Number(button.dataset.tier) === buildTier));
  const types = station || converter ? [] : train ? BUILDINGS[facility.type].trains : BUILD_TYPES.filter((type) => BUILDINGS[type].tier === buildTier);
  if (lastActions !== actionKey) {
    $('action-title').textContent = station ? 'ORBITAL UPLINK' : converter ? 'CONVERSION RECIPES'
      : isCommand ? 'TRAIN AT COMMAND' : groupTraining ? factoryNames[facility.type].toUpperCase() : train ? BUILDINGS[facility.type].name.toUpperCase() : 'CONSTRUCTION';
    const cards = types.map((type) => {
      const definition = train ? UNITS[type] : BUILDINGS[type];
      const locked = !train && definition.tier > tier;
      const shortcut = !train && `Press ${definition.key ? `${definition.key} or ` : ''}B then ${definition.shortcut.toUpperCase()}.`;
      const title = groupTraining ? `Queue ${definition.name} at each selected facility for ${fullCost(definition.cost)} per unit. ${definition.role} ${unitStats(type)}. Shift-click to queue up to ${TRAIN_BATCH} per facility.`
        : train ? `Train ${definition.name} for ${fullCost(definition.cost)}. ${definition.role} ${unitStats(type)}. Shift-click to queue up to ${TRAIN_BATCH}.`
        : `${definition.description} ${locked ? `Requires Command Tier ${definition.tier}. ` : ''}Costs ${fullCost(definition.cost)}. ${shortcut}`;
      return `<button type="button" class="action" data-mode="${train ? 'train' : 'build'}" data-action="${type}" title="${title}" aria-label="${train ? 'Train ' : 'Build '}${definition.name}">${icon(train ? unitIcon(type) : BUILD_ICONS[type])}${!train && definition.key ? `<kbd>${definition.key}</kbd>` : ''}<strong>${train ? definition.label : definition.name}</strong><span class="cost">${locked ? `Tier ${definition.tier}` : costString(definition.cost)}</span></button>`;
    });
    if (isCommand && upgrade) {
      cards.push(`<button type="button" class="action upgrade-action" data-mode="upgrade" data-action="upgrade" title="+5 population capacity, more health and vision. Takes ${upgrade.time} seconds. Costs ${fullCost(upgrade.cost)}.">${icon('home')}<strong>Upgrade to Tier ${tier + 1}</strong><span class="cost"></span></button>`);
    }
    if (station) {
      cards.push(`<button type="button" class="action upgrade-action" data-mode="launch" data-action="launch" title="Permanent vision in the chosen area. Takes ${ORBITAL_SURVEY.time} seconds. Costs ${fullCost(ORBITAL_SURVEY.cost)}.">${icon('radio')}<strong>Launch Satellite</strong><span class="cost"></span></button>`);
    }
    if (converter) {
      for (const [resource, recipe] of Object.entries(BUILDINGS[converter.type].conversion)) {
        cards.push(`<button type="button" class="action conversion-action" data-mode="convert" data-action="${resource}" title="${recipeFormula(resource, recipe)}">${icon(resource)}<strong>Make ${RESOURCES[resource].name}</strong><span class="cost">${costString(recipe.inputs)} → ${recipe.output}${COST_LABELS[resource]}/min</span></button>`);
      }
      cards.push(`<button type="button" class="action conversion-action" data-mode="convert" data-action="off">${icon('pause')}<strong>Pause conversion</strong></button>`);
    }
    $('actions').innerHTML = cards.join('');
    lastActions = actionKey;
  }
  const repeatButton = $('repeat-production');
  repeatButton.hidden = !isCommand;
  if (station) {
    $('action-status').textContent = station.satellite ? 'SATELLITE ONLINE' : station.health <= 0 ? 'UPLINK DISABLED'
      : station.launch ? 'LAUNCH SEQUENCE' : station.surveyTarget ? 'SURVEY AREA SET' : 'SELECT A SURVEY AREA';
  } else if (converter) {
    const result = (conversions ?? productionDetails(game).conversions).get(converter);
    const resource = RESOURCES[converter.recipe]?.name;
    const limiting = result?.limitingResource && RESOURCES[result.limitingResource].name.toLowerCase();
    $('action-status').textContent = converter.progress < 1 ? 'UNDER CONSTRUCTION'
      : converter.health <= 0 ? 'CONVERTER DISABLED'
        : !result ? 'CONVERSION PAUSED'
          : !result.produced ? `NEEDS ${limiting.toUpperCase()}`
            : `${Number(result.produced.toFixed(1))} ${resource}/min${limiting ? ` · limited by ${limiting}` : ''}`;
  } else if (groupTraining) {
    const queued = queues.reduce((total, { queue }) => total + queue.length, 0);
    const training = queues.filter(({ facility: factory, queue }) => factory.health > 0 && queue.length).length;
    $('action-status').textContent = !canTrain ? 'TRAINING PAUSED'
      : queued ? `${queued} queued · ${training} training` : 'SHIFT-CLICK TO BATCH';
  } else if (train) {
    const waiting = isCommand ? command.repeatBacklog.length : 0;
    if (isCommand) {
      repeatButton.setAttribute('aria-pressed', String(command.repeatProduction));
      repeatButton.title = waiting ? `${waiting} repeat orders waiting for resources or crew` : 'Repeat the production queue';
    }
    const { queue } = queues[0];
    const waitFor = availableCrew(game) ? 'RESOURCES' : 'CREW';
    $('action-status').textContent = facility.health <= 0 ? 'TRAINING PAUSED'
      : queue.length ? `${queue.length} queued · ${Math.ceil(queue[0].remaining)}s`
        : waiting ? `WAITING FOR ${waitFor}` : `SHIFT-CLICK TO QUEUE ${TRAIN_BATCH}`;
  } else {
    $('action-status').textContent = buildTier > tier ? `TIER ${buildTier} LOCKED` : placement ? 'SELECT A SITE' : '';
  }
  renderTrainingQueue(queues);
  for (const button of $('actions').children) {
    const type = button.dataset.action;
    if (button.dataset.mode === 'convert') {
      button.setAttribute('aria-pressed', String(type === (converter.recipe ?? 'off')));
      continue;
    }
    if (button.dataset.mode === 'launch') {
      button.disabled = !canTarget || !station.surveyTarget;
      button.classList.toggle('unaffordable', canTarget && !canAfford(game, ORBITAL_SURVEY.cost));
      button.querySelector('.cost').textContent = station.satellite ? 'In orbit'
        : station.launch ? `${Math.ceil(station.launch.remaining)}s remaining` : costString(ORBITAL_SURVEY.cost);
      continue;
    }
    if (button.dataset.mode === 'upgrade') {
      button.disabled = Boolean(command.upgrade) || command.health <= 0;
      button.classList.toggle('unaffordable', !command.upgrade && !canAfford(game, upgrade.cost));
      button.querySelector('.cost').textContent = command.upgrade ? `${Math.ceil(command.upgrade.remaining)}s remaining` : costString(upgrade.cost);
      continue;
    }
    const definition = (train ? UNITS : BUILDINGS)[type];
    button.disabled = train ? !canTrain : definition.tier > tier;
    button.classList.toggle('unaffordable', train && !canAfford(game, definition.cost));
    if (!train) button.setAttribute('aria-pressed', String(placement === type));
  }
  for (const type of ['rover', 'scout', 'infantry', 'command']) {
    const button = $(`quick-${type}`);
    const count = game.units.filter((unit) => unit.type === type).length;
    button.querySelector('small').textContent = type === 'command' ? '' : count;
    button.setAttribute('aria-pressed', String(list.some((entity) => entity.type === type)));
  }
}

function renderTrainingQueue(queues) {
  const container = $('training-queue');
  const activeQueues = queues.filter(({ queue }) => queue.length > 0);
  container.hidden = !activeQueues.length;
  if (container.hidden) return;
  const key = activeQueues.map(({ queue }) => queue.map((order) => order.type).join(',')).join('/');
  if (key !== lastTraining) {
    container.innerHTML = activeQueues.map(({ queue }) => queue.map(({ type }, index) => {
      const label = `${UNITS[type].name}${index === 0 ? ' in training' : ' waiting'}`;
      return `<span class="training-item${index === 0 ? ' in-training' : ''}" title="${label}" aria-label="${label}">${icon(unitIcon(type))}</span>`;
    }).join('')).join('');
    lastTraining = key;
  }
  for (const [index, item] of container.querySelectorAll('.in-training').entries()) {
    const { facility, queue } = activeQueues[index];
    const { type, remaining } = queue[0];
    item.style.setProperty('--progress', `${100 * (1 - remaining / trainingTime(type, facility))}%`);
  }
}

function toggleHarvestPatrolMode() {
  if (!ownSelection().some((entity) => entity.type === 'rover')) {
    notice('Select a rover to start a harvest patrol.', true);
    return;
  }
  const wasActive = patrolMode;
  clearMode();
  if (!wasActive) {
    patrolMode = true;
    gameElement.classList.add('ordering');
    $('placement-hint').textContent = 'Drag over an area to patrol and harvest · Click for a small patrol · Esc to cancel';
    $('placement-hint').hidden = false;
  }
  refreshSelection();
}

function clearMode() {
  placement = null;
  orderMode = false;
  patrolMode = false;
  gameElement.classList.remove('placing', 'ordering');
  $('placement-hint').hidden = true;
  view?.showPlacement(null, null);
  view?.showConstructionLine([]);
  view?.showSitingGuide(null, []);
}

function enterPlacement(type) {
  if (placement === type) {
    clearMode();
    refreshSelection();
    return;
  }
  const definition = BUILDINGS[type];
  if (definition.tier > game.buildings[0].tier) { notice(`Upgrade Command to Tier ${definition.tier} first.`, true); return; }
  if (!selectableRovers().length) { notice('Recruit a Construction Rover first.', true); return; }
  if (!ownSelection().some((entity) => entity.type === 'rover')) selectType('rover');
  clearMode();
  buildTier = definition.tier;
  placement = type;
  gameElement.classList.add('placing');
  updatePlacementHint();
  refreshSitingGuide();
  $('placement-hint').hidden = false;
  $('toast').hidden = true;
  audio.play('select');
  refreshSelection();
}

function updatePlacementHint() {
  const definition = BUILDINGS[placement];
  const recommend = $('siting-guide').checked;
  const guide = definition.deposit ? recommend ? ' Gold marks open sites. Mint marks the highest yield.' : ' Gold marks open sites.'
    : recommend ? ' Mint highlights the best sites.' : '';
  const controls = placement === 'wall' ? 'Click to queue · Drag to aim one piece · Shift-drag to draw a wall'
    : 'Click to order construction · Shift-click to queue · Shift-drag for a row';
  $('placement-hint').textContent = `${definition.description}${guide} ${controls} · Esc to cancel`;
}

function refreshSitingGuide() {
  const recommend = $('siting-guide').checked;
  const extractor = placement && BUILDINGS[placement].deposit;
  const sites = extractor ? availableConstructionDeposits(game, placement) : [];
  const preferred = extractor && recommend ? recommendedConstructionDeposits(game, placement, sites) : [];
  const biome = placement && !extractor && recommend ? preferredConstructionBiome(placement) : null;
  view.showSitingGuide(biome, preferred, sites);
  return { sites, preferred };
}

function nearest(items, point, radius) {
  let result = null;
  let best = radius;
  for (const item of items) {
    const gap = distance(item, point);
    if (gap < best) {
      result = item;
      best = gap;
    }
  }
  return result;
}

function entityUnder(clientX, clientY, candidates) {
  const labeled = view.structureAtLabel(clientX, clientY, candidates);
  if (labeled) return labeled;
  const rect = canvas.getBoundingClientRect();
  const point = { x: clientX - rect.left, y: clientY - rect.top };
  let entity;
  let closest = Infinity;
  for (const item of candidates) {
    const height = item.type === 'command' ? 0.9 : item.type === 'mine' ? 0.38 + item.progress * 0.72 : 0.38;
    const at = view.screenAt(item, height);
    let pixels = Math.hypot(at.x - point.x, at.y - point.y);
    if (item.wall) {
      const a = view.screenAt(item.wall.a, 0.67);
      const b = view.screenAt(item.wall.b, 0.67);
      pixels = pointSegmentDistance({ x: point.x, z: point.y }, { x: a.x, z: a.y }, { x: b.x, z: b.y });
    }
    const radius = (item.type === 'command' ? 30 : item.type === 'mine' ? 22 : item.progress !== undefined ? 17 : 13) * view.zoom;
    if (pixels < radius && pixels / radius < closest) {
      entity = item;
      closest = pixels / radius;
    }
  }
  return entity;
}

function issueOrder(point, append, terrainEvent) {
  const units = game.units.filter((unit) => selected.has(unit.id));
  const station = selectedUplink();
  if (station) {
    const error = setSurveyTarget(game, station, point);
    if (error) notice(error, true);
    else finishMapOrder(point, false);
    return;
  }
  if (!units.length) {
    const facilities = selectedTrainingBuildings();
    if (!facilities.length) { notice('Select a unit or a training facility to issue an order.', true); return; }
    for (const facility of facilities) setRallyPoint(facility, point, append);
  } else if (!terrainEvent) {
    orderUnits(units, point, append);
  } else if (!issueTerrainOrder(units, point, terrainEvent, append)) {
    return;
  }
  finishMapOrder(point, append);
}

// Deposit rocks are drawn wider than their centre point, and the tilted camera shifts ground picks behind them.
const DEPOSIT_PICK_RADIUS = 3;

function issueTerrainOrder(units, point, { clientX, clientY }, append) {
  const rovers = units.filter((unit) => unit.type === 'rover');
  const sight = sightSources(game);
  if (units.some(isMilitary)) {
    const targets = [...game.factions.values()].filter((faction) => faction !== game)
      .flatMap((faction) => [...faction.units, ...faction.buildings])
      .filter((target) => target.health > 0 && inSight(target, sight));
    const target = view.entityAtModel(clientX, clientY, targets)
      || entityUnder(clientX, clientY, targets) || nearest(targets, point, 1.35);
    if (target) {
      const { error, incident } = orderFactionAttack(game, units, target, append);
      if (error) notice(error, true);
      return !error && !incident;
    }
  }
  if (rovers.length) {
    const candidates = game.units.filter((unit) => unit.type === 'rover' && unit.health > 0);
    const rover = view.entityAtModel(clientX, clientY, candidates) || entityUnder(clientX, clientY, candidates);
    // A rover standing on a deposit must not turn a harvest click into an assist order,
    // and assisting a rover that is itself part of the selection is meaningless.
    const overResource = rovers.length && (gatherableUnder(point, clientX, clientY)
      || nearest(game.world.deposits.filter((item) => 'surface' in item && item.surface > 0), point, DEPOSIT_PICK_RADIUS));
    if (rover && !selected.has(rover.id) && !overResource && rovers.some((unit) => unit !== rover)) {
      const error = orderRoverAssist(game, rovers, rover, append);
      notice(error || (append ? 'Rover assistance queued.' : 'Rovers assigned to assist.'), Boolean(error));
      return !error;
    }
  }
  const building = view.constructionAtBar(clientX, clientY, game.buildings)
    || entityUnder(clientX, clientY, game.buildings) || nearest(game.buildings, point, 1.1);
  const natural = rovers.length ? gatherableUnder(point, clientX, clientY) : null;
  const deposit = building?.deposit && 'surface' in building.deposit ? building.deposit
    : natural ?? nearest(game.world.deposits.filter((item) => 'surface' in item), point, DEPOSIT_PICK_RADIUS);
  const visibleHostiles = game.hostiles.filter((item) => item.health > 0 && inSight(item, sight));
  const enemy = nearest(visibleHostiles.filter((item) => item.kind !== 'hive'), point, 1.4)
    ?? nearest(visibleHostiles.filter((item) => item.kind === 'hive'), point, 3.2);
  const relays = game.world.outposts.filter((site) => site.relay && site.discovered && !site.owner);
  const relay = entityUnder(clientX, clientY, relays) || nearest(relays, point, 2.4);
  if (relay && rovers.length) {
    const rover = nearest(rovers, relay, Infinity);
    setUnitOrder(rover, { kind: 'capture', target: relay, remaining: 4 }, append);
    notice(append ? 'Relay capture queued.' : `Rover dispatched to capture ${relay.name}.`);
  } else if (building && rovers.length && building.progress < 1) {
    const error = assistConstruction(game, building, rovers, append);
    notice(error || (append ? 'Construction order queued.' : `Construction crew assigned to ${BUILDINGS[building.type].name}.`), Boolean(error));
    if (error) return false;
  } else if (building && rovers.length && building.health < maxBuildingHealth(building)) {
    setUnitOrder(nearest(rovers, building, Infinity), { kind: 'repair', building }, append);
    notice(append ? 'Repair order queued.' : 'Repair order assigned.');
  } else if (deposit && rovers.length) {
    if (deposit.surface <= 0) { notice('Surface supplies exhausted. Build an extractor here.', true); return false; }
    const gatherers = append || rovers.length === 1 ? rovers : rovers.filter((rover) => unitTask(rover)?.kind !== 'build');
    if (!gatherers.length) { notice('All selected rovers are building.', true); return false; }
    if (deposit.kind === 'tree') {
      const area = harvestPatrolArea([deposit], PATROL_CLICK_RADIUS);
      const error = orderHarvestPatrol(game, gatherers, area, append, deposit);
      notice(error || (append ? 'Harvest patrol queued.' : 'Harvest patrol started around this tree.'), Boolean(error));
      return !error;
    }
    for (const [index, rover] of gatherers.entries()) {
      const angle = index / gatherers.length * Math.PI * 2;
      setUnitOrder(rover, { kind: 'harvest', deposit, remaining: deposit.kind ? deposit.surface : 20,
        x: deposit.x + Math.cos(angle) * 0.65, z: deposit.z + Math.sin(angle) * 0.65 }, append);
    }
    const resource = RESOURCES[deposit.type].name.toLowerCase();
    notice(append ? `Harvest order queued for ${resource}.` : `${gatherers.length === 1 ? 'Rover' : `${gatherers.length} rovers`} harvesting ${resource}.`);
  } else {
    orderUnits(units, point, append, enemy);
  }
  return true;
}

function gatherableUnder(point, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  let target;
  let closest = 15 * view.zoom;
  for (const node of game.world.gatherables) {
    if (node.surface <= 0 || distance(point, node) > 3.1) continue;
    const height = node.kind === 'tree' ? 0.68 + node.size * 0.66 : 0.3 + node.size * 0.27;
    const projected = view.screenAt(node, height);
    const gap = Math.hypot(projected.x + rect.left - clientX, projected.y + rect.top - clientY);
    if (gap < closest) { target = node; closest = gap; }
  }
  return target;
}

function orderUnits(units, point, append, enemy) {
  const spacing = Math.max(0.92, ...units.map((unit) => unitHitRadius(unit.type) * 2 + 0.13));
  for (const [index, unit] of units.entries()) {
    const x = Math.max(MAP_MIN_X + 0.1, Math.min(MAP_MAX_X - 0.1, point.x + (index % 3 - Math.min(units.length - 1, 2) / 2) * spacing));
    const z = Math.max(MAP_MIN_Z + 0.1, Math.min(MAP_MAX_Z - 0.1, point.z + Math.floor(index / 3) * spacing));
    setUnitOrder(unit, enemy && UNITS[unit.type].combat ? { kind: 'attack', target: enemy } : { kind: 'move', x, z }, append);
  }
  if (!append && units.some((unit) => unit.type === 'scout') && territoryOwner(game.world, point) !== game.country) {
    notice('Scout dispatched beyond your territory.');
  }
}

function finishMapOrder(point, append) {
  orderTarget = { ...point, until: performance.now() + 1100 };
  audio.play(append ? 'queue' : 'order');
  if (!append) clearMode();
  refreshSelection();
}

function placeConstruction(sites, append) {
  append ||= placement === 'wall';
  const rovers = selectableRovers();
  const buildAsCrew = !append && sites.length === 1 && rovers.filter((rover) => selected.has(rover.id)).length > 1;
  let count = 0;
  let firstError;
  for (const site of sites) {
    const error = site.error || orderBuilding(game, placement, site, rovers, append, buildAsCrew);
    if (error) {
      firstError ??= error;
      continue;
    }
    count++;
    orderTarget = { ...site, until: performance.now() + 900 };
  }
  if (!count) { notice(firstError || 'Drag between two points on the terrain.', true); return; }
  audio.play(append ? 'queue' : 'build');
  if (!append) clearMode();
  else if (sites.length === 1) notice(`${BUILDINGS[placement].name} construction queued.`);
  else {
    const skipped = sites.length - count;
    notice(skipped ? `${count} construction sites queued · ${skipped} skipped. ${firstError}` : `${count} construction sites queued.`);
  }
  renderUi();
}

function constructionDrag(drag, x, y) {
  return placement && drag?.buildType === placement
    && (drag.wallTrail?.length > 1 || Math.hypot(x - drag.x, y - drag.y) > 5);
}

function dragConstructionSites(drag, end) {
  if (drag.wallTrail?.length) return wallStrokeSites(game, end ? [...drag.wallTrail, end] : drag.wallTrail);
  if (drag.buildType === 'wall' && drag.buildStart && end) return [aimedWallSite(game, drag.buildStart, end)];
  return drag.buildStart && end ? buildingLineSites(game, placement, drag.buildStart, end) : [];
}

function previewConstruction(x, y, shift) {
  const point = view.pointAt(x, y);
  if (point) showTerrainAt(point);
  if (point && pointer?.wallTrail?.length && distance(pointer.wallTrail.at(-1), point) >= 0.72) pointer.wallTrail.push(point);
  const dragging = constructionDrag(pointer, x, y);
  if (dragging && pointer.shift) {
    view.showPlacement(placement, null);
    view.showConstructionLine(dragConstructionSites(pointer, point));
  } else {
    view.showConstructionLine([]);
    const site = dragging ? dragConstructionSites(pointer, point)[0] : point ? buildingSite(game, placement, point) : null;
    if (site && !site.error && placement !== 'wall' && !shift && !pointer?.shift) {
      const rovers = selectableRovers();
      const error = constructionFundingError(game, placement, site, rovers, rovers.filter((rover) => selected.has(rover.id)).length > 1);
      if (error) site.error = error;
    }
    view.showPlacement(placement, site);
  }
}

function useMap(event, append = false) {
  append ||= placement === 'wall';
  const { clientX, clientY } = event;
  if (!orderMode && (!placement || !append)) {
    const site = view.constructionAtBar(clientX, clientY, game.buildings);
    if (site) {
      setSelection([site], append);
      audio.play('select');
      return site;
    }
  }
  const point = view.pointAt(clientX, clientY);
  if (placement) {
    if (point) placeConstruction([buildingSite(game, placement, point)], append);
  } else if (orderMode && point) {
    issueOrder(point, append, event);
  } else {
    const entity = entityUnder(clientX, clientY, [...game.units, ...game.buildings]);
    setSelection(entity ? [entity] : [], append);
    if (entity) audio.play('select');
    if (point) showTerrainAt(point);
    return entity;
  }
}

function minimapPoint({ clientX, clientY }) {
  const rect = minimap.getBoundingClientRect();
  const x = (clientX - rect.left - minimap.clientLeft) / minimap.clientWidth;
  const z = (clientY - rect.top - minimap.clientTop) / minimap.clientHeight;
  return {
    x: MAP_MIN_X + Math.max(0, Math.min(1, x)) * MAP_WIDTH,
    z: MAP_MIN_Z + Math.max(0, Math.min(1, z)) * MAP_DEPTH,
  };
}

function harvestPatrolArea(points, margin) {
  return {
    minX: Math.max(MAP_MIN_X + 0.2, Math.min(...points.map(({ x }) => x)) - margin),
    maxX: Math.min(MAP_MAX_X - 0.2, Math.max(...points.map(({ x }) => x)) + margin),
    minZ: Math.max(MAP_MIN_Z + 0.2, Math.min(...points.map(({ z }) => z)) - margin),
    maxZ: Math.min(MAP_MAX_Z - 0.2, Math.max(...points.map(({ z }) => z)) + margin),
  };
}

function applyHarvestPatrol(drag, event) {
  const left = Math.min(drag.x, event.clientX);
  const right = Math.max(drag.x, event.clientX);
  const top = Math.min(drag.y, event.clientY);
  const bottom = Math.max(drag.y, event.clientY);
  const points = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => view.pointAt(x, y)).filter(Boolean);
  if (!points.length) { notice('Choose a patrol area on the terrain.', true); return; }
  const dragged = right - left >= 5 && bottom - top >= 5;
  const area = harvestPatrolArea(points, dragged ? 0.5 : PATROL_CLICK_RADIUS);
  if (dragged && points.length === 4) area.corners = points;
  const error = orderHarvestPatrol(game, ownSelection(), area, drag.shift);
  if (error) { notice(error, true); return; }
  clearMode();
  audio.play(drag.shift ? 'queue' : 'order');
  refreshSelection();
  notice(drag.shift ? 'Harvest patrol queued.' : 'Harvest patrol assigned.');
}

function setMapEvents() {
  let selectionClick = null;
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  gameElement.addEventListener('pointermove', (event) => {
    hoverPoint = event.pointerType === 'mouse'
      ? { x: event.clientX, y: event.clientY, onCanvas: event.target === canvas }
      : null;
  });
  gameElement.addEventListener('pointerleave', () => { hoverPoint = null; });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 2) {
      event.preventDefault();
      if (placement || patrolMode) { clearMode(); refreshSelection(); return; }
      const point = view.pointAt(event.clientX, event.clientY);
      if (point) issueOrder(point, event.shiftKey, event);
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const pan = event.button === 1 || event.altKey;
    const buildType = !pan && (event.shiftKey || placement === 'wall') ? placement : null;
    const buildStart = buildType ? view.pointAt(event.clientX, event.clientY) : null;
    pointer = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, shift: event.shiftKey, patrol: patrolMode,
      buildType, buildStart, wallTrail: event.shiftKey && buildType === 'wall' && buildStart ? [buildStart] : null, pan, selecting: false };
  });
  canvas.addEventListener('pointermove', (event) => {
    const x = event.clientX;
    const y = event.clientY;
    if (pointer?.pan) {
      const factor = 34 / Math.max(1, canvas.clientHeight) / view.zoom;
      view.pan((pointer.lastX - x) * factor, (pointer.lastY - y) * factor);
      pointer.lastX = x;
      pointer.lastY = y;
      return;
    }
    if (placement) {
      previewConstruction(x, y, event.shiftKey);
    } else if (!orderMode && pointer && (pointer.selecting || Math.hypot(x - pointer.x, y - pointer.y) > 5)) {
      pointer.selecting = true;
      const rect = viewport.getBoundingClientRect();
      const box = $('selection-box');
      box.style.left = `${Math.min(x, pointer.x) - rect.left}px`;
      box.style.top = `${Math.min(y, pointer.y) - rect.top}px`;
      box.style.width = `${Math.abs(x - pointer.x)}px`;
      box.style.height = `${Math.abs(y - pointer.y)}px`;
      box.hidden = false;
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!pointer || (event.button !== 0 && event.button !== 1)) return;
    const drag = pointer;
    const previousClick = selectionClick;
    selectionClick = null;
    pointer = null;
    $('selection-box').hidden = true;
    if (drag.pan || (drag.buildType && drag.buildType !== placement)) return;
    if (drag.patrol) {
      if (patrolMode) applyHarvestPatrol(drag, event);
      return;
    }
    if (constructionDrag(drag, event.clientX, event.clientY)) {
      const sites = dragConstructionSites(drag, view.pointAt(event.clientX, event.clientY));
      view.showConstructionLine([]);
      placeConstruction(sites, drag.shift);
    } else if (drag.selecting) {
      const rect = canvas.getBoundingClientRect();
      const minX = Math.min(drag.x, event.clientX) - rect.left;
      const maxX = Math.max(drag.x, event.clientX) - rect.left;
      const minY = Math.min(drag.y, event.clientY) - rect.top;
      const maxY = Math.max(drag.y, event.clientY) - rect.top;
      const units = game.units.filter((unit) => {
        const point = view.screenAt(unit, 0.3);
        return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
      });
      setSelection(units, drag.shift);
      if (units.length) audio.play('select');
    } else {
      const entity = useMap(event, drag.shift);
      if (entity && (UNITS[entity.type] || (factoryNames[entity.type] && entity.progress === 1))) {
        selectionClick = { entity, repeated: previousClick?.entity === entity };
      }
    }
  });
  canvas.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || !selectionClick?.repeated) return;
    const { entity } = selectionClick;
    selectionClick = null;
    const candidates = factoryNames[entity.type] ? game.buildings.filter((building) => building.progress === 1) : game.units;
    if (!candidates.includes(entity)) return;
    const group = candidates.filter((other) => other.type === entity.type && distance(other, entity) <= GROUP_SELECT_RADIUS);
    setSelection(event.shiftKey ? [...ownSelection(), ...group] : group);
  });
  canvas.addEventListener('pointercancel', () => {
    pointer = null;
    selectionClick = null;
    view.showConstructionLine([]);
    $('selection-box').hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { if (placement) view.showPlacement(placement, null); });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!event.deltaY) return;
    view.setZoom(view.zoom * (event.deltaY < 0 ? 1.13 ** 3 : 1 / 1.13 ** 3), event);
  }, { passive: false });
  minimap.addEventListener('click', (event) => {
    const point = minimapPoint(event);
    if (orderMode && (selectedUplink() || selectedTrainingBuildings().length)) issueOrder(point, event.shiftKey);
    else view.center(point.x, point.z);
  });
  minimap.addEventListener('contextmenu', (event) => event.preventDefault());
  minimap.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) return;
    event.preventDefault();
    if (placement || patrolMode) { clearMode(); refreshSelection(); return; }
    issueOrder(minimapPoint(event), event.shiftKey);
  });
  minimap.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') view.resetCamera();
  });
  window.addEventListener('keydown', (event) => {
    if (modalOpen || event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (event.repeat) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const pending = performance.now() < buildShortcutUntil;
      buildShortcutUntil = 0;
      const building = pending && BUILD_TYPES.find((type) => BUILDINGS[type].shortcut === key);
      if (building) {
        event.preventDefault();
        $('toast').hidden = true;
        if (placement !== building) enterPlacement(building);
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        buildShortcutUntil = performance.now() + BUILD_SHORTCUT_MS;
        const shortcuts = BUILD_TYPES.filter((type) => BUILDINGS[type].tier === buildTier)
          .map((type) => `${BUILDINGS[type].shortcut.toUpperCase()} ${BUILDINGS[type].name}`);
        notice(`Build · ${shortcuts.join(' · ')}`);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        openTechnologyTree();
        return;
      }
      if (key === 'p') {
        event.preventDefault();
        toggleHarvestPatrolMode();
        return;
      }
    }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowright', 'arrowdown', 'arrowleft'].includes(key)) {
      keys.add(key);
      event.preventDefault();
    }
    if (key === 'escape') { clearMode(); refreshSelection(); }
    if (key === ' ' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); togglePause(); }
    if (key === 'h') view.resetCamera();
    if (key === 'r') selectType('rover');
    const type = BUILD_TYPES.find((item) => BUILDINGS[item].key === key);
    if (type) enterPlacement(type);
  });
  window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => { keys.clear(); hoverPoint = null; buildShortcutUntil = 0; });
}

const mapX = (value) => (value - MAP_MIN_X) / MAP_WIDTH * minimap.width;
const mapZ = (value) => (value - MAP_MIN_Z) / MAP_DEPTH * minimap.height;

function paintTerrainMap() {
  const { world } = game;
  const { width, height } = minimap;
  const pixels = terrainMini.createImageData(width, height);
  const weights = new Float64Array(terrainBiomes.length);
  const color = new Float64Array(3);
  for (let y = 0; y < height; y++) {
    const wz = MAP_MIN_Z + (y + 0.5) / height * MAP_DEPTH;
    for (let x = 0; x < width; x++) {
      const wx = MAP_MIN_X + (x + 0.5) / width * MAP_WIDTH;
      world.biomeWeights(wx, wz, weights);
      blendTerrainColor(weights, world.ridgeWeight(wx, wz), terrainPaint(wx, wz, world.seed), color);
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = toSrgbByte(color[channel]);
      pixels.data[offset + 3] = 255;
    }
  }
  terrainMini.putImageData(pixels, 0, 0);
  borderPixels = borderMini.createImageData(FOG_WIDTH, FOG_DEPTH);
  borderTerritory = null;
}

function currentAttackAlert(now = performance.now()) {
  if (!attackAlert || now >= attackAlert.expiresAt) return null;
  const age = Math.max(0, now - attackAlert.startedAt);
  const fade = Math.min(1, (attackAlert.expiresAt - now) / 850);
  return { ...attackAlert, age, strength: fade * (0.84 + 0.16 * Math.cos(age * 2 * Math.PI / 1150)) };
}

function updateMinimap(sight = sightSources(game), alert = currentAttackAlert()) {
  updateFog(fog, sight);
  view.setFog(fog);
  const extractor = placement && BUILDINGS[placement].deposit ? refreshSitingGuide() : null;
  const occupied = new Set([...game.factions.values()].flatMap((faction) => faction.buildings
    .filter((building) => building.deposit && !isBlueprint(building) && (faction === game || inSight(building, sight))).map((building) => building.deposit.id)));
  for (let index = 0; index < fog.shade.length; index++) fogPixels.data[index * 4 + 3] = fog.shade[index];
  fogMini.putImageData(fogPixels, 0, 0);
  mini.drawImage(terrainMap, 0, 0);
  mini.drawImage(fogMap, 0, 0, minimap.width, minimap.height);
  const { edges, pixels } = game.world.territoryMap;
  if (borderTerritory !== game.world.territoryMap) {
    borderPixels.data.fill(0);
    for (const index of edges) {
      const offset = index * 4;
      borderPixels.data.set(pixels.subarray(offset, offset + 3), offset);
    }
    borderTerritory = game.world.territoryMap;
  }
  for (const index of edges) {
    const offset = index * 4;
    const own = pixels[offset + 3] === 255;
    borderPixels.data[offset + 3] = own || fog.shade[index] < TERRITORY_FOG_LIMIT ? 255 : 0;
    if (own) {
      const tint = alert?.border ? alert.strength * attackBorderWeight(index, alert.border) : 0;
      for (let channel = 0; channel < 3; channel++) {
        const color = pixels[offset + channel];
        borderPixels.data[offset + channel] = color + (ATTACK_BORDER_COLOR[channel] - color) * tint;
      }
    }
  }
  borderMini.putImageData(borderPixels, 0, 0);
  mini.drawImage(borderMap, 0, 0, minimap.width, minimap.height);
  for (const deposit of game.world.deposits) {
    if (occupied.has(deposit.id)) continue;
    const x = mapX(deposit.x);
    const y = mapZ(deposit.z);
    mini.fillStyle = RESOURCES[deposit.type].color;
    mini.beginPath();
    mini.moveTo(x, y - 4);
    mini.lineTo(x + 4, y);
    mini.lineTo(x, y + 4);
    mini.lineTo(x - 4, y);
    mini.fill();
  }
  for (const item of [...game.units, ...game.buildings, ...game.world.outposts.filter((outpost) => outpost.discovered && (outpost.relay || inSight(outpost, sight)))]) {
    mini.fillStyle = item.owner === game.country ? '#87ffe3' : item.discovered ? '#ffbe88' : item.type === 'command' ? '#fff2ba'
      : selected.has(item.id) ? '#bdffe3' : item.type === 'mine' ? '#ffcf83' : '#c0dcb9';
    const size = item.type === 'command' ? 8 : 5;
    if (isBlueprint(item)) {
      mini.strokeStyle = selected.has(item.id) ? '#bdffe3' : '#8bd6ed';
      mini.lineWidth = 1;
      mini.strokeRect(mapX(item.x) - size / 2, mapZ(item.z) - size / 2, size, size);
    } else mini.fillRect(mapX(item.x) - size / 2, mapZ(item.z) - size / 2, size, size);
  }
  for (const faction of game.factions.values()) {
    if (faction === game) continue;
    const relation = game.diplomacy.between(game.country, faction.country).state;
    mini.fillStyle = relation === STANCE.WAR ? '#ff7867' : relation === STANCE.CEASEFIRE ? '#9edcff' : '#ffb266';
    for (const item of [...faction.buildings, ...faction.units]) {
      if (isBlueprint(item) || !inSight(item, sight)) continue;
      const size = item.type === 'command' ? 8 : 4;
      mini.fillRect(mapX(item.x) - size / 2, mapZ(item.z) - size / 2, size, size);
    }
  }
  mini.fillStyle = '#e59a78';
  for (const reptile of game.hostiles) {
    if (!reptile.health || !inSight(reptile, sight)) continue;
    if (reptile.kind === 'hive') {
      mini.fillStyle = '#d06bff';
      mini.fillRect(mapX(reptile.x) - 4, mapZ(reptile.z) - 4, 8, 8);
      mini.fillStyle = '#e59a78';
      continue;
    }
    mini.fillRect(mapX(reptile.x) - 2, mapZ(reptile.z) - 2, 4, 4);
  }
  if (extractor) {
    const preferred = new Set(extractor.preferred.map((deposit) => deposit.id));
    for (const deposit of extractor.sites) drawSurveyArea(deposit, 4.7, preferred.has(deposit.id) ? '#9effdb' : '#ffd089');
  }
  for (const mine of highlightedMines(game, selected)) drawSurveyArea(mine, 4.7, '#ffd089');
  const focus = view.focus;
  const width = 62 * minimap.width / MAP_WIDTH / view.zoom;
  const depth = 58 * minimap.height / MAP_DEPTH / view.zoom;
  mini.strokeStyle = '#e1f8ed';
  mini.lineWidth = 1.5;
  mini.strokeRect(mapX(focus.x) - width / 2, mapZ(focus.z) - depth / 2, width, depth);
  const station = selectedUplink();
  const planned = station?.satellite ? null : station?.surveyTarget;
  for (const area of game.satellites) drawSurveyArea(area, area.vision, '#90eaffb3');
  if (planned) drawSurveyArea(planned, orbitalVision(game), '#f3c986d9');
  if (tutorialFocus) {
    mini.strokeStyle = '#ffe4a3';
    mini.lineWidth = 2;
    mini.strokeRect(mapX(tutorialFocus.point.x) - 5, mapZ(tutorialFocus.point.z) - 5, 10, 10);
  }
  if (orderTarget && orderTarget.until > performance.now()) {
    mini.strokeStyle = '#bdffe3';
    mini.lineWidth = 2;
    mini.beginPath();
    mini.arc(mapX(orderTarget.x), mapZ(orderTarget.z), 5, 0, Math.PI * 2);
    mini.stroke();
  }
  if (alert) drawAttackPing(alert);
}

function drawAttackPing({ source, age, strength }) {
  const x = mapX(source.x);
  const y = mapZ(source.z);
  mini.save();
  mini.globalAlpha = strength;
  mini.beginPath();
  mini.arc(x, y, 6 + (age % 1150) / 1150 * 7, 0, Math.PI * 2);
  mini.strokeStyle = '#38141b';
  mini.lineWidth = 4;
  mini.stroke();
  mini.strokeStyle = '#ff6052';
  mini.lineWidth = 2;
  mini.stroke();
  mini.fillStyle = '#ffd5bc';
  mini.fillRect(x - 2, y - 2, 4, 4);
  mini.restore();
}

function drawSurveyArea(point, radius, color) {
  mini.strokeStyle = color;
  mini.lineWidth = 1.25;
  mini.beginPath();
  mini.arc(mapX(point.x), mapZ(point.z), radius * minimap.width / MAP_WIDTH, 0, Math.PI * 2);
  mini.stroke();
}

function panCamera(dt) {
  const keyboardX = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
  const keyboardY = Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup'));
  let edgeX = 0;
  let edgeY = 0;
  if (hoverPoint && !pointer && !modalOpen) {
    const rect = canvas.getBoundingClientRect();
    const { x, y, onCanvas } = hoverPoint;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const strength = (gap) => Math.max(0, 1 - gap / EDGE_SCROLL_ZONE);
      if (onCanvas) edgeX = strength(rect.right - x) - strength(x - rect.left);
      edgeY = strength(rect.bottom - y) - strength(y - rect.top);
    }
  }
  const x = keyboardX || edgeX;
  const y = keyboardY || edgeY;
  if (!x && !y) return;
  const step = dt / view.zoom / Math.max(1, Math.hypot(x, y));
  view.pan(x * step * (keyboardX ? KEYBOARD_PAN_SPEED : EDGE_SCROLL_SPEED),
    y * step * (keyboardY ? KEYBOARD_PAN_SPEED : EDGE_SCROLL_SPEED));
  if (placement && hoverPoint?.onCanvas) {
    previewConstruction(hoverPoint.x, hoverPoint.y);
  }
}

function advanceSimulation() {
  const now = performance.now();
  const elapsed = now - lastSimulationTick;
  lastSimulationTick = now;
  const reviewingDiplomacy = $('diplomacy-dialog').open;
  if (game.defeat || paused || modalOpen && !reviewingDiplomacy) return;

  // Hidden tabs can delay the timer, so accrue elapsed time and process it in fixed steps.
  pendingSimulationMs += elapsed * (reviewingDiplomacy ? 1 : speeds[speedIndex]);
  const deadline = now + (document.hidden ? 80 : 8);
  const lastAttack = game.lastAttackedAt;
  const shots = audio.effects && !document.hidden ? [] : undefined;
  while (pendingSimulationMs >= SIMULATION_STEP_MS) {
    updateGame(game, SIMULATION_STEP_MS / 1000, shots);
    pendingSimulationMs -= SIMULATION_STEP_MS;
    if (game.defeat || performance.now() >= deadline) break;
  }
  if (game.lastAttackedAt > lastAttack) {
    const source = game.lastAttackSource;
    const startedAt = attackAlert && now < attackAlert.expiresAt ? attackAlert.startedAt : now;
    attackAlert = { source, border: attackBorderPoint(game.world, source), startedAt, expiresAt: now + ATTACK_MARKER_MS };
    audio.play('underAttack');
  }
  if (shots?.length) {
    const sight = sightSources(game);
    const heard = (point) => point && (point.factionId === game.country || inSight(point, sight));
    audio.playCombat(shots.filter(({ source, impact }) => heard(source) || heard(impact)), view?.focus ?? game.home);
  }
}

function animate(now) {
  const cameraDt = Math.min(0.06, (now - (previousFrame || now)) / 1000);
  previousFrame = now;
  advanceSimulation();
  panCamera(cameraDt);
  const sight = sightSources(game);
  const alert = currentAttackAlert(now);
  if (now >= nextUi) { renderUi(); nextUi = now + 130; }
  if (now >= nextMini) { updateMinimap(sight, alert); nextMini = now + 115; }
  view.draw(game, selected, orderTarget, sight, tutorialFocus?.point, alert);
  requestAnimationFrame(animate);
}

try {
  const { WorldView } = await import('./view.mjs');
  view = new WorldView(canvas, $('map-labels'));
  view.loadTerrainTextures();
  await Promise.all([view.loadTreeModels(), loadUnitModels()]);
  initControls();
  setMapEvents();
  const seed = new URLSearchParams(location.search).get('seed');
  start(seed !== null && /^\d+$/.test(seed) && Number(seed) <= 4294967295 ? Number(seed) : randomSeed());
  window.setInterval(advanceSimulation, SIMULATION_TIMER_MS);
  document.addEventListener('visibilitychange', () => {
    previousFrame = 0;
    audio.updateMix();
    advanceSimulation();
  });
  requestAnimationFrame(animate);
} catch (error) {
  console.error(error);
  $('load-error').textContent = 'Planetary Accord could not start. Open through a local web server in a browser with WebGL 2 enabled.';
  $('load-error').hidden = false;
}
