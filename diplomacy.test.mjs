import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STANCE } from './diplomacy.mjs';
import { evaluatePeaceOffer, intrusionScore, respondToPeaceOffer } from './diplomacy-ai.mjs';
import { addUnit, createGame, orderBuilding, orderFactionAttack, setUnitOrder, territoryOwner, updateGame } from './world.mjs';

function setup(controllers = ['human', 'human', 'ai'], diplomacy = {}, personalities = []) {
  const sites = [['landing', 0, -15, 15], ['vesper', 32, 20, 55], ['outreach', -32, -55, -20]];
  const factions = sites.map(([id, x], index) => ({
    id, home: { x, z: 0 }, controller: controllers[index], personality: personalities[index],
    resources: { metal: 450, biomass: 100, food: 180, energy: 150 },
  }));
  const territories = sites.map(([faction, , minX, maxX]) => ({ faction, minX, maxX, minZ: -30, maxZ: 30 }));
  const game = createGame(14, { factions, territories, diplomacy, gatherables: [] });
  game.hostiles.length = 0;
  for (const faction of game.factions.values()) faction.nextDecision = Infinity;
  return {
    game, rules: game.diplomacy,
    a: game.factions.get('landing'), b: game.factions.get('vesper'), c: game.factions.get('outreach'),
  };
}

function ticks(game, seconds) {
  const steps = Math.ceil(seconds / 0.1);
  for (let i = 0; i < steps; i++) updateGame(game, seconds / steps);
}

const soldier = (faction) => faction.units.find(({ type }) => type === 'infantry');
const point = (x, z = 0) => ({ x, z });
const move = (unit, x, z) => setUnitOrder(unit, { kind: 'move', ...point(x, z) });
const terms = (offered = {}, requested = {}, duration = 600) => ({ offered, requested, duration });

test('military crossing opens one bilateral incident and applies a directional penalty once', () => {
  const { game, rules, a, b, c } = setup();
  assert.equal(rules.pairs.size, 3);
  const troops = a.units.filter(({ type }) => type === 'infantry');
  for (const [index, unit] of troops.entries()) {
    Object.assign(unit, point(13, index));
    move(unit, 24, index);
  }
  ticks(game, 1);
  assert.equal(territoryOwner(game.world, troops[0]), null);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEUTRAL);
  ticks(game, 2);
  const pair = rules.between(a.country, b.country);
  assert.equal(pair, rules.between(b.country, a.country));
  assert.equal(pair.state, STANCE.NEGOTIATING);
  assert.equal(pair.incident.aggressor, a.country);
  assert.equal(pair.incident.defender, b.country);
  assert.equal(pair.incident.deadline - pair.incident.openedAt, 30);
  assert.equal(pair.incident.deliberate, true);
  const id = pair.incident.id;
  ticks(game, 2);
  assert.equal(pair.incident.id, id);
  assert.equal(rules.incidentsFor(a.country).length, 1);
  assert.equal(rules.opinion(b.country, a.country), -10);
  assert.equal(rules.opinion(a.country, b.country), 0);
  assert.equal(rules.between(a.country, c.country).state, STANCE.NEUTRAL);
});

test('scouts, civilian rovers, and unclaimed ground do not trigger incidents', () => {
  const { game, rules, a, b } = setup();
  for (const unit of a.units.filter(({ type }) => type === 'scout' || type === 'rover')) move(unit, 26);
  const infantry = soldier(a);
  move(infantry, 17);
  ticks(game, 10);
  assert.equal(territoryOwner(game.world, infantry), null);
  assert(a.units.some((unit) => unit.type === 'scout' && territoryOwner(game.world, unit) === b.country));
  assert(a.units.some((unit) => unit.type === 'rover' && territoryOwner(game.world, unit) === b.country));
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEUTRAL);
  assert.equal(rules.incidentsFor(a.country).length, 0);
});

test('withdrawal and its cooldown prevent recurring reports or a second incursion', () => {
  const { game, rules, a, b } = setup();
  const infantry = soldier(a);
  Object.assign(infantry, point(19));
  move(infantry, 25);
  ticks(game, 1);
  const pair = rules.between(a.country, b.country);
  assert.equal(rules.demandWithdrawal(b.country, a.country), null);
  assert.equal(pair.incident.demand.from, b.country);
  assert.match(rules.withdraw(b.country, a.country), /Only the aggressor/);
  assert.equal(rules.withdraw(a.country, b.country), null);
  assert.equal(infantry.order.kind, 'withdraw');
  ticks(game, 2);
  assert.notEqual(territoryOwner(game.world, infantry), b.country);
  move(infantry, 25);
  ticks(game, 2);
  assert.equal(pair.state, STANCE.NEUTRAL);
  assert.equal(pair.incident, null);
  assert.notEqual(territoryOwner(game.world, infantry), b.country);
  assert.equal(rules.opinion(b.country, a.country), -10);
});

test('the negotiation deadline orders withdrawal and does not start war', () => {
  const { game, rules, a, b } = setup(['human', 'human', 'ai'], { gracePeriod: 3 });
  const infantry = soldier(a);
  Object.assign(infantry, point(20.2));
  ticks(game, 0.1);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEGOTIATING);
  ticks(game, 4);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEUTRAL);
  assert.notEqual(territoryOwner(game.world, infantry), b.country);
});

test('declined AI terms transfer nothing and a revised generous offer creates a ceasefire atomically', () => {
  const { rules, a, b } = setup(['human', 'ai', 'ai']);
  assert.equal(rules.beginIncident(a.country, b.country, 'declaration'), null);
  const balances = [{ ...a.resources }, { ...b.resources }];
  const rejected = rules.propose(a.country, b.country, terms({}, { metal: 300, food: 100 })).offer;
  assert.equal(evaluatePeaceOffer(rules, rejected).accepted, false);
  respondToPeaceOffer(rules, rejected);
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.reason, /payment/);
  assert.deepEqual([a.resources, b.resources], balances);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEGOTIATING);
  const accepted = rules.propose(a.country, b.country, terms({ metal: 300, food: 100 }, { biomass: 10 })).offer;
  assert.equal(evaluatePeaceOffer(rules, accepted).accepted, true);
  respondToPeaceOffer(rules, accepted);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(a.resources, { ...balances[0], metal: 150, food: 80, biomass: 110 });
  assert.deepEqual(b.resources, { ...balances[1], metal: 750, food: 280, biomass: 90 });
  assert.equal(rules.between(a.country, b.country).treaty.endsAt, 600);
  assert.equal(rules.between(a.country, b.country).incident, null);
  assert.match(rules.accept(b.country, a.country, accepted.id), /no longer available/);
  assert.equal(rules.opinion(b.country, a.country), 15);
  assert.equal(rules.opinion(a.country, b.country), 5);
});

test('acceptance revalidates both stockpiles and cannot partially transfer an underfunded offer', () => {
  const { rules, a, b } = setup();
  rules.beginIncident(a.country, b.country, 'declaration');
  assert.match(rules.propose(a.country, b.country, terms({ food: -10 })).error, /nonnegative/);
  assert.match(rules.propose(a.country, b.country, terms({ unknown: 1 })).error, /nonnegative/);
  const offer = rules.propose(a.country, b.country, terms({ metal: 300, food: 50 }, { energy: 100 })).offer;
  b.resources.energy = 99;
  const balances = [{ ...a.resources }, { ...b.resources }];
  assert.match(rules.accept(b.country, a.country, offer.id), /lacks the energy/);
  assert.equal(offer.status, 'rejected');
  assert.deepEqual([a.resources, b.resources], balances);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEGOTIATING);
});

test('ceasefire cancels active and queued attacks on both sides, withdraws military, and expires peacefully', () => {
  const { game, rules, a, b } = setup(['human', 'human', 'ai'], { incidentCooldown: 0, minCeasefire: 1 });
  const attacker = soldier(a);
  const defender = soldier(b);
  Object.assign(attacker, point(21));
  Object.assign(defender, point(14));
  rules.beginIncident(a.country, b.country, 'declaration');
  assert.equal(rules.proceedToWar(a.country, b.country), null);
  assert.deepEqual(orderFactionAttack(a, [attacker], defender), {});
  assert.deepEqual(orderFactionAttack(a, [attacker], b.buildings[0], true), {});
  assert.deepEqual(orderFactionAttack(b, [defender], attacker), {});
  const offer = rules.propose(a.country, b.country, terms({}, {}, 4)).offer;
  assert.equal(rules.accept(b.country, a.country, offer.id), null);
  assert.equal(attacker.order.kind, 'withdraw');
  assert.equal(defender.order.kind, 'withdraw');
  assert.equal(attacker.queuedOrders.length + defender.queuedOrders.length, 0);
  assert.match(orderFactionAttack(a, [attacker], defender).error, /ceasefire/);
  assert.match(rules.beginIncident(b.country, a.country, 'declaration'), /ceasefire/);
  const health = [attacker.health, defender.health];
  ticks(game, 2);
  assert.notEqual(territoryOwner(game.world, attacker), b.country);
  assert.notEqual(territoryOwner(game.world, defender), a.country);
  move(attacker, 25);
  ticks(game, 0.8);
  assert.notEqual(territoryOwner(game.world, attacker), b.country);
  assert.deepEqual([attacker.health, defender.health], health);
  ticks(game, 2);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEUTRAL);
  assert.equal(rules.canAttack(b.country, a.country), false);
  assert.equal(rules.opinion(a.country, b.country), 10);
  assert.equal(rules.opinion(b.country, a.country), -10);
  assert.equal(rules.beginIncident(a.country, b.country, 'declaration'), null);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEGOTIATING);
});

test('only war permits deliberate attacks, military losses, and destruction of foreign buildings', () => {
  const { game, rules, a, b } = setup();
  const attacker = soldier(a);
  const defender = soldier(b);
  Object.assign(attacker, point(21, 1));
  Object.assign(defender, point(23, 1));
  const health = [attacker.health, defender.health];
  assert.deepEqual(orderFactionAttack(a, [attacker], defender), { incident: true });
  ticks(game, 1);
  assert.deepEqual([attacker.health, defender.health], health);
  assert.equal(rules.proceedToWar(a.country, b.country), null);
  defender.health = 1;
  assert.deepEqual(orderFactionAttack(a, [attacker], defender), {});
  ticks(game, 0.2);
  assert(!b.units.includes(defender));
  assert.equal(rules.opinion(b.country, a.country), -25);
  const rover = b.units.find(({ type }) => type === 'rover');
  assert.equal(orderBuilding(b, 'farm', point(23, 2), [rover]), null);
  const farm = b.buildings.at(-1);
  farm.health = 1;
  attacker.cooldown = 0;
  assert.deepEqual(orderFactionAttack(a, [attacker], farm), {});
  ticks(game, 0.1);
  assert(!b.buildings.includes(farm));
  assert.equal(rover.order, null);
  assert.equal(rules.opinion(b.country, a.country), -40);
});

test('independent AI factions resolve accidental intrusions without involving the third pair', () => {
  const { game, rules, a, b, c } = setup(['ai', 'ai', 'ai']);
  const one = soldier(a);
  Object.assign(one, point(19.5));
  move(one, 24);
  const two = soldier(c);
  Object.assign(two, point(-15.5));
  move(two, -12);
  ticks(game, 1);
  assert.equal(rules.between(a.country, b.country).incident.deliberate, false);
  assert.equal(rules.between(c.country, a.country).incident.deliberate, false);
  assert.equal(rules.between(c.country, b.country).state, STANCE.NEUTRAL);
  ticks(game, 5);
  assert.equal(rules.incidentsFor(a.country).length, 0);
  assert.equal(rules.between(a.country, b.country).state, STANCE.NEUTRAL);
  assert.equal(rules.between(c.country, a.country).state, STANCE.NEUTRAL);
  assert.notEqual(territoryOwner(game.world, one), b.country);
  assert.notEqual(territoryOwner(game.world, two), a.country);
  assert.equal(rules.opinion(b.country, a.country), -10);
  assert.equal(rules.opinion(a.country, c.country), -10);
  assert.equal(rules.opinion(b.country, c.country), 0);
});

test('weak AI defenders make proactive offers and negotiate proportionate terms with a stronger aggressor', () => {
  const { game, rules, a, b, c } = setup(['ai', 'ai', 'ai'], {}, ['expansionist', 'commercial', 'defensive']);
  for (let i = 0; i < 6; i++) addUnit(a, 'vanguard', 10, i);
  for (const [index, unit] of a.units.filter(({ type }) => type === 'infantry').entries()) {
    Object.assign(unit, point(19.5, index));
    setUnitOrder(unit, { kind: 'move', ...point(24, index), intentFaction: b.country });
  }
  const metal = a.resources.metal;
  ticks(game, 5);
  const pair = rules.between(a.country, b.country);
  assert.equal(pair.state, STANCE.CEASEFIRE);
  assert.equal(pair.lastOffer.status, 'accepted');
  assert.equal(pair.views.get(b.country).rejectedOffers, 1);
  assert.equal(pair.views.get(a.country).demands, 1);
  assert(pair.lastOffer.requested.metal > 0 && pair.lastOffer.requested.metal < 50);
  assert(a.resources.metal > metal);
  assert.equal(rules.between(a.country, c.country).state, STANCE.NEUTRAL);
});

test('war limits and relationship modifiers are configurable for all factions', () => {
  const { rules, a, b, c } = setup(['ai', 'ai', 'ai'], {
    maxWars: 1, modifiers: { declaration: -400 },
    initialRelations: [{ a: 'landing', b: 'vesper', state: STANCE.FRIENDLY, aToB: 50, bToA: 40 }],
  });
  assert.equal(rules.between(a.country, b.country).state, STANCE.FRIENDLY);
  assert.equal(rules.opinion(a.country, b.country), 50);
  rules.beginIncident(a.country, b.country, 'declaration');
  assert.equal(rules.proceedToWar(a.country, b.country), null);
  assert.equal(rules.opinion(b.country, a.country), -100);
  rules.beginIncident(c.country, a.country, 'declaration');
  assert.match(rules.proceedToWar(c.country, a.country), /war limit/);
  assert.equal(rules.between(c.country, a.country).state, STANCE.NEGOTIATING);
  assert.equal(rules.between(c.country, b.country).state, STANCE.NEUTRAL);
});

test('an honoured ceasefire can become friendly and prevents profitable repeat incursions', () => {
  const { game, rules, a, b } = setup(['ai', 'ai', 'ai'], {
    minCeasefire: 1, incidentCooldown: 0,
    initialRelations: [{ a: 'landing', b: 'vesper', aToB: 10, bToA: 10 }],
  }, ['militaristic', 'commercial']);
  for (let i = 0; i < 6; i++) addUnit(a, 'vanguard', 9, i);
  assert(intrusionScore(rules, a.country, b.country) >= 37);
  rules.beginIncident(a.country, b.country, 'declaration');
  const offer = rules.propose(a.country, b.country, terms({ metal: 20 }, { metal: 20 }, 2)).offer;
  assert.equal(rules.accept(b.country, a.country, offer.id), null);
  ticks(game, 2.1);
  assert.equal(rules.between(a.country, b.country).state, STANCE.FRIENDLY);
  assert.equal(rules.opinion(a.country, b.country), 23);
  assert.equal(rules.opinion(b.country, a.country), 23);
  assert.equal(intrusionScore(rules, a.country, b.country), -Infinity);
});

test('an aggressive AI plans an intrusion only against a strategically viable independent faction', () => {
  const { game, rules, a, b, c } = setup(['ai', 'ai', 'ai'], {
    initialRelations: [{ a: 'landing', b: 'outreach', state: STANCE.FRIENDLY, aToB: 90, bToA: 90 }],
  }, ['militaristic', 'commercial', 'commercial']);
  for (let i = 0; i < 6; i++) addUnit(a, 'vanguard', 7, i);
  a.knownFactions.add(b.country);
  a.knownFactions.add(c.country);
  a.nextDecision = 0;
  ticks(game, 0.1);
  const incursions = a.units.filter(({ order }) => order?.intentFaction);
  assert.equal(incursions.length, 3);
  assert(incursions.every(({ order }) => order.intentFaction === b.country));
  assert.equal(rules.between(a.country, c.country).state, STANCE.FRIENDLY);
});
