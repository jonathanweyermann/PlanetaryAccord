import { STANCE, TRADE_STANCES, bound, isTrade } from './diplomacy.mjs';

export const PERSONALITIES = Object.freeze({
  balanced: { aggression: 0.42, expansion: 0.4, economy: 0.65, military: 0.5, diplomacy: 0.65, risk: 0.45, trust: 0.7 },
  commercial: { aggression: 0.16, expansion: 0.24, economy: 0.96, military: 0.3, diplomacy: 0.93, risk: 0.25, trust: 0.9 },
  expansionist: { aggression: 0.68, expansion: 0.95, economy: 0.6, military: 0.7, diplomacy: 0.4, risk: 0.7, trust: 0.5 },
  defensive: { aggression: 0.22, expansion: 0.16, economy: 0.63, military: 0.86, diplomacy: 0.68, risk: 0.36, trust: 0.76 },
  militaristic: { aggression: 0.94, expansion: 0.85, economy: 0.38, military: 0.96, diplomacy: 0.24, risk: 0.88, trust: 0.38 },
  opportunistic: { aggression: 0.66, expansion: 0.76, economy: 0.7, military: 0.63, diplomacy: 0.44, risk: 0.4, trust: 0.47 },
});

const STOCK_TARGET = { metal: 150, biomass: 95, food: 125, energy: 110, crystal: 35, vent: 35 };
const PRICE = { metal: 1, biomass: 0.75, food: 0.85, energy: 0.7, crystal: 2.3, vent: 2.3 };
export const tradeValue = (amounts) => Object.entries(amounts).reduce((value, [type, amount]) => value + (PRICE[type] ?? 1) * amount, 0);

function advantage(diplomacy, id, other) {
  const strength = (key) => diplomacy.rules.strength(diplomacy.factions.get(key));
  return bound(Math.log2((strength(id) + 20) / (strength(other) + 20)), -2, 2);
}

function stockValue(faction) {
  return tradeValue(Object.fromEntries(Object.entries(faction.resources)
    .map(([type, amount]) => [type, Math.min(amount, (STOCK_TARGET[type] ?? 100) * 3)])));
}

function stockPressure(faction, resource) {
  const target = STOCK_TARGET[resource] ?? 100;
  return bound(1 - faction.resources[resource] / target, 0, 1);
}

export function intrusionScore(diplomacy, attacker, defender) {
  const faction = diplomacy.factions.get(attacker);
  const opponent = diplomacy.factions.get(defender);
  const pair = diplomacy.between(attacker, defender);
  // New colonies get a settling-in period before rivals deliberately probe their borders.
  if (diplomacy.time < diplomacy.config.settlementGrace) return -Infinity;
  if (!pair || pair.incident || pair.treaty || pair.state === STANCE.WAR || pair.state === STANCE.DEFEATED || pair.cooldownUntil > diplomacy.time
    || pair.factions.some((id) => diplomacy.warCount(id) >= diplomacy.config.maxWars)) return -Infinity;
  const p = faction.personality;
  const opinion = diplomacy.opinion(attacker, defender);
  const history = pair.views.get(attacker);
  const economy = bound((stockValue(faction) - stockValue(opponent)) / 120, -4, 4);
  const conquest = faction.conquestTarget === defender ? 20 : 0;
  if (history.agreements && opinion >= -19 && !conquest) return -Infinity;
  const opportunity = diplomacy.rules.territorialValue(faction, opponent) * p.expansion;
  // A large standing army that has nothing to do makes aggressive leaders restless.
  const restless = p.aggression * bound(Math.log2((diplomacy.rules.strength(faction) + 20) / 150), 0, 2) * 12;
  return (p.aggression - 0.5) * 32 + (p.expansion - 0.5) * 30 + restless
    + advantage(diplomacy, attacker, defender) * (9 + p.risk * 8) + conquest + economy + opportunity
    - opinion * 0.35 - p.economy * p.diplomacy * 13 - history.agreements * (7 + p.trust * 11)
    - history.demands * 8 - (history.withdrawals ?? 0) * 7 - Math.min(history.trades ?? 0, 5) * (2 + p.trust * 3) - diplomacy.warCount(attacker) * 25;
}

export function evaluatePeaceOffer(diplomacy, offer) {
  const { from, to, offered, requested, duration } = offer;
  const pair = diplomacy.between(from, to);
  const receiver = diplomacy.factions.get(to);
  const personality = receiver.personality;
  const history = pair.views.get(to);
  const militaryEdge = advantage(diplomacy, to, from);
  const otherWars = diplomacy.warCount(to) - Number(pair.state === STANCE.WAR);
  const receiveValue = Object.entries(offered).reduce((value, [type, amount]) =>
    value + tradeValue({ [type]: amount }) * (1 + stockPressure(receiver, type) * 0.9), 0);
  const payValue = Object.entries(requested).reduce((value, [type, amount]) =>
    value + tradeValue({ [type]: amount }) * (1 + stockPressure(receiver, type) * 1.7), 0);
  const net = receiveValue - payValue;
  const economicPressure = (stockPressure(receiver, 'metal') + stockPressure(receiver, 'food') + stockPressure(receiver, 'energy')) / 3;
  const conquest = receiver.conquestTarget === from;
  const intruding = pair.incident?.aggressor === from;
  const threat = intruding ? diplomacy.rules.intruders(from, to).length : 0;
  const strategic = (conquest ? 44 : 0) + personality.expansion * Math.max(0, militaryEdge) * 9;
  const score = 12 + bound(net / 4, -100, 105) + history.score * 0.25
    - militaryEdge * (13 + personality.risk * 8) - strategic - personality.aggression * 25
    + otherWars * 15 + personality.diplomacy * 20 + personality.economy * (7 + economicPressure * 14)
    + (receiver.buildings[0].upgrade || receiver.researchProject ? 8 : 0)
    + history.agreements * personality.trust * 3 - history.treatyViolations * 16
    - Math.max(0, history.incursions - 1) * 5 - (threat && payValue > receiveValue ? 6 : 0)
    + bound((duration - diplomacy.config.ceasefireDuration) / 160, -4, 6) * (1 - personality.aggression * 1.5);
  if (score >= 23) return { accepted: true, reason: net >= 30 ? 'The offered resources make peace worthwhile.' : 'The faction sees more value in peace.' };
  const reason = payValue > receiveValue * 1.25 && payValue >= 15 ? 'The requested payment is too costly.'
    : conquest ? 'The faction is pursuing a territorial objective.'
      : militaryEdge > 0.75 ? 'The faction believes it has the military advantage.'
        : history.score < -30 || history.treatyViolations ? 'The faction does not trust the proposal.'
          : 'The offer does not provide enough incentive for peace.';
  return { accepted: false, reason };
}

// Values a peacetime exchange from the receiver's point of view: scarce goods are worth more,
// parting with scarce goods costs more, and goodwill shifts the threshold a little.
export function evaluateTradeOffer(diplomacy, offer) {
  const { from, to, offered, requested } = offer;
  const receiver = diplomacy.factions.get(to);
  const p = receiver.personality;
  const history = diplomacy.between(from, to).views.get(to);
  const weigh = (amounts, pressure) => Object.entries(amounts).reduce((value, [type, amount]) =>
    value + tradeValue({ [type]: amount }) * (1 + stockPressure(receiver, type) * pressure), 0);
  const receiveValue = weigh(offered, 0.9);
  const payValue = weigh(requested, 1.7);
  const short = Object.keys(requested).find((type) => (requested[type] ?? 0) > 0
    && receiver.resources[type] - requested[type] < (STOCK_TARGET[type] ?? 100) * 0.35);
  const score = receiveValue - payValue * (1.12 - p.economy * 0.12) + history.score * 0.12 + p.diplomacy * 4
    - history.treatyViolations * 15;
  if (history.score <= -60) return { accepted: false, reason: 'The faction refuses to trade with a hostile rival.' };
  if (short) return { accepted: false, reason: `The faction cannot spare that much ${diplomacy.rules.resourceName(short).toLowerCase()}.` };
  if (score >= 2) return { accepted: true, reason: receiveValue > payValue * 1.3 ? 'A generous exchange.' : 'A fair exchange for both colonies.' };
  return { accepted: false, reason: payValue > 0 && receiveValue < payValue ? 'The exchange favours your colony too heavily.' : 'The faction sees little value in this exchange.' };
}

export function evaluateOffer(diplomacy, offer) {
  return isTrade(offer) ? evaluateTradeOffer(diplomacy, offer) : evaluatePeaceOffer(diplomacy, offer);
}

export function respondToPeaceOffer(diplomacy, offer) {
  if (diplomacy.factions.get(offer.to).controller !== 'ai') return null;
  const result = evaluateOffer(diplomacy, offer);
  return result.accepted
    ? diplomacy.accept(offer.to, offer.from, offer.id)
    : diplomacy.reject(offer.to, offer.from, offer.id, result.reason);
}

function proportionalPayment(payer, recipient, share, maximum) {
  const payment = {};
  for (const type of ['metal', 'food', 'energy', 'biomass']) {
    const reserve = STOCK_TARGET[type] * 0.45;
    const need = 0.45 + stockPressure(recipient, type) * 0.55;
    const surplus = Math.max(0, payer.resources[type] - reserve);
    const amount = Math.floor(Math.min(surplus * share * need, (maximum - tradeValue(payment)) / PRICE[type]));
    if (amount > 0) payment[type] = amount;
  }
  return payment;
}

function propose(diplomacy, from, to, offered, requested = {}) {
  const { offer } = diplomacy.propose(from.country, to.country, {
    offered, requested, duration: diplomacy.config.ceasefireDuration,
  });
  if (offer) respondToPeaceOffer(diplomacy, offer);
  return offer;
}

function resolveAggressor(diplomacy, pair, aggressor, defender) {
  const incident = pair.incident;
  const ours = aggressor.country;
  const theirs = defender.country;
  const p = aggressor.personality;
  const edge = advantage(diplomacy, ours, theirs);
  const strategic = edge * 23 + p.aggression * 27 + p.expansion * 16
    + (aggressor.conquestTarget === theirs ? 28 : 0) - diplomacy.opinion(ours, theirs) * 0.25
    - diplomacy.warCount(ours) * 28 + (pair.views.get(ours).withdrawals ?? 0) * 11;
  if (!incident.deliberate) { diplomacy.withdraw(ours, theirs); return; }
  if (incident.aggressorActed) {
    if (strategic > 63 && (incident.demand || diplomacy.time >= incident.deadline - diplomacy.config.gracePeriod * 0.25)
      && !diplomacy.proceedToWar(ours, theirs)) return;
    if (incident.demand || incident.aggressorActed && !diplomacy.pendingOffer(pair)) diplomacy.withdraw(ours, theirs);
    return;
  }
  incident.aggressorActed = true;
  const history = pair.views.get(ours);
  if (edge > 0.7 && strategic > 47 && !history.demands && !history.agreements) {
    const demand = proportionalPayment(defender, aggressor, 0.12, 55);
    if (Object.keys(demand).length && propose(diplomacy, aggressor, defender, {}, demand)) {
      history.demands++;
      return;
    }
  }
  const compensation = proportionalPayment(aggressor, defender, 0.18, 90);
  if (edge < 0.6 || p.diplomacy >= 0.5) {
    if (propose(diplomacy, aggressor, defender, compensation)) return;
  }
  if (strategic <= 63 || diplomacy.proceedToWar(ours, theirs)) diplomacy.withdraw(ours, theirs);
}

function resolveDefender(diplomacy, pair, aggressor, defender) {
  const incident = pair.incident;
  const ours = defender.country;
  const theirs = aggressor.country;
  if (incident.defenderActed) {
    const edge = advantage(diplomacy, ours, theirs);
    const remaining = incident.deadline - diplomacy.time;
    const intruders = diplomacy.rules.intruders(theirs, ours).length;
    if (incident.demand && incident.deliberate && intruders >= 2 && edge >= 0.4
      && defender.personality.aggression >= 0.7 && remaining <= diplomacy.config.gracePeriod * 0.2) {
      diplomacy.proceedToWar(ours, theirs);
    }
    return;
  }
  incident.defenderActed = true;
  const threat = diplomacy.rules.intruders(theirs, ours).length;
  const edge = advantage(diplomacy, ours, theirs);
  if (incident.deliberate && (threat >= 2 || incident.cause !== 'border') && edge < -0.55 && !pair.views.get(ours).agreements) {
    const tribute = proportionalPayment(defender, aggressor, 0.2, 85);
    if (tradeValue(tribute) >= 9 && propose(diplomacy, defender, aggressor, tribute)) return;
  }
  diplomacy.demandWithdrawal(ours, theirs);
}

export const TRADE_INTERVAL = 75;

// Deterministic 0..1 jitter so trade timing varies between pairs without breaking replayable simulations.
function jitter(...parts) {
  let hash = 2166136261;
  for (const char of parts.join(':')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

// Picks the resource this faction most needs and pays with its largest surplus, adding a
// small premium so a partner that is not short of the payment is likely to agree.
export function planTrade(diplomacy, from, to) {
  const faction = diplomacy.factions.get(from);
  const partner = diplomacy.factions.get(to);
  const types = Object.keys(PRICE).filter((type) => type in faction.resources && type in partner.resources);
  const spare = (owner, type) => owner.resources[type] - (STOCK_TARGET[type] ?? 100) * 1.3;
  const needs = types.map((type) => ({ type, pressure: stockPressure(faction, type) }))
    .filter(({ pressure }) => pressure >= 0.35).sort((a, b) => b.pressure - a.pressure);
  for (const need of needs) {
    const pay = types.filter((type) => type !== need.type && spare(faction, type) > 0)
      .sort((a, b) => spare(faction, b) * PRICE[b] - spare(faction, a) * PRICE[a])[0];
    const available = Math.floor(Math.max(0, partner.resources[need.type] - (STOCK_TARGET[need.type] ?? 100) * 0.6));
    if (!pay || available < 10) continue;
    const want = Math.min(available, Math.ceil((STOCK_TARGET[need.type] ?? 100) * need.pressure * 0.6), 60);
    const premium = 1.15 + faction.personality.diplomacy * 0.15;
    const price = Math.ceil(want * PRICE[need.type] * premium / PRICE[pay]);
    if (price > spare(faction, pay) || want < 10) continue;
    return { kind: 'trade', offered: { [pay]: price }, requested: { [need.type]: want } };
  }
  return null;
}

function seekTrade(diplomacy, pair) {
  if (diplomacy.pendingOffer(pair) || pair.incident || !TRADE_STANCES.includes(pair.state)) return;
  const key = pair.factions.join('|');
  if (diplomacy.time < (pair.nextTrade ??= diplomacy.time + TRADE_INTERVAL * (0.5 + jitter(key)))) return;
  const roll = jitter(key, Math.floor(diplomacy.time));
  pair.nextTrade = diplomacy.time + TRADE_INTERVAL * (0.75 + roll * 0.5);
  const order = roll < 0.5 ? pair.factions : [...pair.factions].reverse();
  for (const [index, id] of order.entries()) {
    const faction = diplomacy.factions.get(id);
    const other = pair.factions.find((candidate) => candidate !== id);
    if (faction.controller !== 'ai' || !faction.knownFactions?.has(other)) continue;
    if (diplomacy.opinion(id, other) <= -40 || jitter(key, id, Math.floor(diplomacy.time), index) > 0.35 + faction.personality.economy * 0.5) continue;
    const terms = planTrade(diplomacy, id, other);
    if (!terms) continue;
    const { offer } = diplomacy.propose(id, other, terms);
    if (offer) respondToPeaceOffer(diplomacy, offer);
    return;
  }
}

export function advanceDiplomaticAI(diplomacy) {
  for (const pair of diplomacy.pairs.values()) {
    const offer = diplomacy.pendingOffer(pair);
    if (offer) {
      respondToPeaceOffer(diplomacy, offer);
      if (diplomacy.pendingOffer(pair)) continue;
    }
    seekTrade(diplomacy, pair);
    const incident = pair.incident;
    if (incident) {
      if (diplomacy.time < incident.openedAt + Math.min(3, diplomacy.config.gracePeriod * 0.15)) continue;
      const aggressor = diplomacy.factions.get(incident.aggressor);
      const defender = diplomacy.factions.get(incident.defender);
      if (defender.controller === 'ai') resolveDefender(diplomacy, pair, aggressor, defender);
      if (pair.incident && !diplomacy.pendingOffer(pair) && aggressor.controller === 'ai') {
        resolveAggressor(diplomacy, pair, aggressor, defender);
      }
    } else if (pair.state === STANCE.WAR) {
      // A faction whose command centre is badly damaged sues for peace sooner and pays more.
      const collapsing = (id) => (diplomacy.rules.commandIntegrity?.(id) ?? 1) < 0.6;
      const desperate = pair.factions.some((id) => diplomacy.factions.get(id).controller === 'ai' && collapsing(id));
      if (diplomacy.time < (pair.lastOverture ?? pair.warSince ?? 0) + (desperate ? 25 : 120)) continue;
      pair.lastOverture = diplomacy.time;
      for (const id of pair.factions) {
        const faction = diplomacy.factions.get(id);
        const other = diplomacy.factions.get(pair.factions.find((candidate) => candidate !== id));
        if (faction.controller !== 'ai') continue;
        const urgent = collapsing(id);
        const peacePressure = faction.personality.diplomacy * 30 - advantage(diplomacy, id, other.country) * 15
          + (diplomacy.warCount(id) - 1) * 15 + (urgent ? 30 : 0);
        const tribute = urgent ? proportionalPayment(faction, other, 0.4, 180) : proportionalPayment(faction, other, 0.15, 75);
        if (peacePressure > 22 && propose(diplomacy, faction, other, tribute)) break;
      }
    }
  }
}
