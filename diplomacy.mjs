export const STANCE = Object.freeze({
  NEUTRAL: 'Neutral', NEGOTIATING: 'Negotiating', WAR: 'At War',
  CEASEFIRE: 'Ceasefire', FRIENDLY: 'Friendly', ALLIED: 'Allied',
  DEFEATED: 'Defeated',
});

export const DIPLOMACY_DEFAULTS = Object.freeze({
  gracePeriod: 30, ceasefireDuration: 600, minCeasefire: 60, maxCeasefire: 1800,
  incidentCooldown: 90, maxWars: 2, tradeOfferLifetime: 60,
  modifiers: Object.freeze({
    mutuallyBeneficialTrade: 3, generousTrade: 10, peace: 5, honouredCeasefire: 5,
    incursion: -10, militaryLoss: -5, buildingLoss: -15, declaration: -20, treatyViolation: -40,
  }),
});

export const TRADE_STANCES = Object.freeze([STANCE.NEUTRAL, STANCE.FRIENDLY, STANCE.ALLIED, STANCE.CEASEFIRE]);
export const isTrade = (offer) => offer?.kind === 'trade';

export const bound = (value, min, max) => Math.max(min, Math.min(max, value));

export function opinionLabel(score) {
  return score < -59 ? 'Hostile' : score < -19 ? 'Unfriendly' : score < 20 ? 'Neutral'
    : score < 60 ? 'Friendly' : 'Trusted';
}

export class Diplomacy {
  constructor(factions, rules, options = {}) {
    this.factions = factions;
    this.rules = rules;
    this.config = { ...DIPLOMACY_DEFAULTS, ...options,
      modifiers: { ...DIPLOMACY_DEFAULTS.modifiers, ...options.modifiers } };
    this.time = 0;
    this.pairs = new Map();
    this.nextId = 1;
    const ids = [...factions.keys()];
    this.pairsByFaction = new Map(ids.map((id) => [id, []]));
    for (const [index, id] of ids.entries()) {
      for (const other of ids.slice(index + 1)) {
        const pair = {
          factions: [id, other], state: STANCE.NEUTRAL, incident: null, treaty: null,
          lastOffer: null, cooldownUntil: 0,
          views: new Map([id, other].map((faction) => [faction, {
            score: 0, incursions: 0, agreements: 0, trades: 0, rejectedOffers: 0, treatyViolations: 0, demands: 0,
          }])),
        };
        this.pairs.set(this.pairKey(id, other), pair);
        this.pairsByFaction.get(id).push(pair);
        this.pairsByFaction.get(other).push(pair);
      }
    }
    for (const { a, b, state, aToB = 0, bToA = 0, duration } of options.initialRelations ?? []) {
      const pair = this.between(a, b);
      if (!pair) throw new Error('Initial diplomacy references an unknown faction pair.');
      pair.views.get(a).score = bound(aToB, -100, 100);
      pair.views.get(b).score = bound(bToA, -100, 100);
      if ([STANCE.NEUTRAL, STANCE.FRIENDLY, STANCE.WAR].includes(state)) pair.state = state;
      if (state === STANCE.CEASEFIRE) this.setCeasefire(pair, duration ?? this.config.ceasefireDuration);
    }
  }

  pairKey(a, b) { return JSON.stringify([a, b].sort()); }
  between(a, b) { return this.pairs.get(this.pairKey(a, b)); }
  opinion(a, b) { return this.between(a, b)?.views.get(a)?.score ?? 0; }
  canAttack(a, b) { return this.between(a, b)?.state === STANCE.WAR; }
  relations(id) { return this.pairsByFaction.get(id) ?? []; }
  warCount(id) { return this.wars(id).length; }
  wars(id) { return this.relations(id).filter((pair) => pair.state === STANCE.WAR); }
  incidentsFor(id) { return this.relations(id).filter((pair) => pair.incident); }

  changeOpinion(pair, who, event) {
    const view = pair.views.get(who);
    view.score = bound(view.score + this.config.modifiers[event], -100, 100);
  }

  peacefulState(pair) {
    return pair.factions.every((id) => pair.views.get(id).score >= 20) ? STANCE.FRIENDLY : STANCE.NEUTRAL;
  }

  announce(pair, message) {
    for (const id of pair.factions) this.rules.log(this.factions.get(id), message);
  }

  name(id) { return this.factions.get(id).name; }

  beginIncident(aggressor, defender, cause, deliberate = true) {
    const pair = this.between(aggressor, defender);
    if (!pair) return 'Choose another faction.';
    if (pair.state === STANCE.DEFEATED) return 'This conflict has ended in defeat.';
    if (!['attack', 'border', 'declaration'].includes(cause)) return 'Choose a valid cause for the incident.';
    if (pair.state === STANCE.WAR) return 'This faction is already at war with yours.';
    if (pair.state === STANCE.CEASEFIRE) return 'An active ceasefire protects this faction.';
    if (pair.incident) return null;
    if (cause === 'border' && pair.cooldownUntil > this.time) return 'A diplomatic cooldown is in effect.';

    if (pair.warOffer) {
      pair.warOffer.status = 'closed';
      pair.lastOffer = pair.warOffer;
      pair.warOffer = null;
    }
    pair.incident = {
      id: this.nextId++, aggressor, defender, cause, deliberate, openedAt: this.time,
      deadline: this.time + this.config.gracePeriod, demand: null, offer: null,
    };
    pair.state = STANCE.NEGOTIATING;
    if (cause === 'border') {
      this.changeOpinion(pair, defender, 'incursion');
      pair.views.get(defender).incursions++;
    }
    this.rules.contact?.(aggressor, defender);
    this.announce(pair, cause === 'border'
      ? `${this.name(aggressor)} military forces entered ${this.name(defender)} territory.`
      : `${this.name(aggressor)} signalled hostile intent toward ${this.name(defender)}.`);
    return null;
  }

  proceedToWar(actor, other) {
    const pair = this.between(actor, other);
    if (!pair?.incident) return 'There is no active incident to escalate.';
    if (pair.factions.some((id) => this.warCount(id) >= this.config.maxWars)) return 'A faction has reached its simultaneous war limit.';
    this.changeOpinion(pair, other, 'declaration');
    pair.state = STANCE.WAR;
    pair.warSince = this.time;
    pair.lastOverture = null;
    this.closeIncident(pair);
    this.announce(pair, `${this.name(actor)} went to war with ${this.name(other)}.`);
    return null;
  }

  closeIncident(pair) {
    if (pair.incident?.offer) {
      pair.incident.offer.status = 'closed';
      pair.lastOffer = pair.incident.offer;
    }
    pair.incident = null;
  }

  endForDefeat(id) {
    for (const pair of this.relations(id)) {
      this.closeIncident(pair);
      if (pair.warOffer) pair.warOffer.status = 'closed';
      pair.warOffer = null;
      pair.treaty = null;
      pair.cooldownUntil = 0;
      pair.state = STANCE.DEFEATED;
      this.rules.stopAttacks(...pair.factions);
    }
  }

  resolveWithdrawal(pair, message) {
    const { aggressor, defender } = pair.incident;
    this.closeIncident(pair);
    pair.state = this.peacefulState(pair);
    pair.cooldownUntil = this.time + this.config.incidentCooldown;
    this.rules.withdraw(aggressor, defender);
    this.rules.stopAttacks(aggressor, defender);
    this.announce(pair, message);
  }

  withdraw(actor, other) {
    const pair = this.between(actor, other);
    if (pair?.incident?.aggressor !== actor) return 'Only the aggressor can withdraw from this incident.';
    this.resolveWithdrawal(pair, `${this.name(actor)} ordered a withdrawal. The incident is closed.`);
    return null;
  }

  demandWithdrawal(actor, other) {
    const pair = this.between(actor, other);
    if (pair?.incident?.defender !== actor) return 'Only the defender can demand withdrawal.';
    if (!pair.incident.demand) {
      pair.incident.demand = { from: actor, time: this.time };
      this.announce(pair, `${this.name(actor)} demanded that ${this.name(other)} withdraw.`);
    }
    return null;
  }

  validateOffer(from, to, terms) {
    const pair = this.between(from, to);
    const { duration, offered, requested } = terms ?? {};
    if (isTrade(terms)) {
      if (!pair || pair.incident || !TRADE_STANCES.includes(pair.state)) return 'Trade requires peaceful relations.';
      const total = (amounts) => Object.values(amounts ?? {}).reduce((sum, amount) => sum + (Number(amount) || 0), 0);
      if (!total(offered) && !total(requested)) return 'Add resources to the trade.';
    } else if (!pair?.incident && pair?.state !== STANCE.WAR) {
      return 'A ceasefire offer requires an incident or an active war.';
    } else if (!Number.isFinite(duration) || duration < this.config.minCeasefire || duration > this.config.maxCeasefire) {
      return 'Choose a ceasefire duration within the displayed limits.';
    }
    for (const [id, amounts] of [[from, offered], [to, requested]]) {
      if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) return 'Enter a valid resource offer.';
      for (const [resource, amount] of Object.entries(amounts)) {
        if (!this.rules.resources.includes(resource) || !Number.isSafeInteger(amount) || amount < 0) {
          return 'Resource amounts must be nonnegative whole numbers.';
        }
        if (this.factions.get(id).resources[resource] < amount) {
          return `${this.name(id)} lacks the ${this.rules.resourceName(resource)} for this deal.`;
        }
      }
    }
    return null;
  }

  pendingOffer(pair) { return pair?.incident ? pair.incident.offer : pair?.warOffer ?? null; }

  saveOffer(pair, offer) {
    if (pair.incident) pair.incident.offer = offer;
    else pair.warOffer = offer;
  }

  propose(from, to, terms) {
    const error = this.validateOffer(from, to, terms);
    if (error) return { error };
    const pair = this.between(from, to);
    if (this.pendingOffer(pair)) return { error: 'Resolve the pending offer before sending another.' };
    const trade = isTrade(terms);
    const offer = { id: this.nextId++, from, to, duration: terms.duration,
      offered: { ...terms.offered }, requested: { ...terms.requested }, status: 'pending' };
    if (trade) Object.assign(offer, { kind: 'trade', expiresAt: this.time + this.config.tradeOfferLifetime });
    this.saveOffer(pair, offer);
    pair.lastOffer = offer;
    this.announce(pair, `${this.name(from)} sent a ${trade ? 'trade proposal' : 'ceasefire offer'} to ${this.name(to)}.`);
    return { offer };
  }

  reject(actor, other, offerId, reason = 'The receiving faction declined the offer.') {
    const pair = this.between(actor, other);
    const offer = this.pendingOffer(pair);
    if (offer?.id !== offerId || offer?.to !== actor) return 'This offer is no longer available.';
    offer.status = 'rejected';
    offer.reason = reason;
    pair.views.get(other).rejectedOffers++;
    this.saveOffer(pair, null);
    this.announce(pair, `${this.name(actor)} declined a ${isTrade(offer) ? 'trade proposal' : 'ceasefire offer'}. ${reason}`);
    return null;
  }

  accept(actor, other, offerId) {
    const pair = this.between(actor, other);
    const offer = this.pendingOffer(pair);
    if (offer?.id !== offerId || offer?.to !== actor) return 'This offer is no longer available.';
    const error = this.validateOffer(other, actor, offer);
    if (error) {
      this.reject(actor, other, offerId, error);
      return error;
    }
    const sender = this.factions.get(other).resources;
    const receiver = this.factions.get(actor).resources;
    const giving = this.rules.value(offer.offered);
    const taking = this.rules.value(offer.requested);
    for (const resource of this.rules.resources) {
      const amount = (offer.offered[resource] ?? 0) - (offer.requested[resource] ?? 0);
      sender[resource] -= amount;
      receiver[resource] += amount;
    }
    offer.status = 'accepted';
    this.saveOffer(pair, null);
    const trade = isTrade(offer);
    if (!trade) this.closeIncident(pair);
    for (const id of pair.factions) {
      if (!trade) this.changeOpinion(pair, id, 'peace');
      // Trades build goodwill but are not peace treaties, so they are counted separately.
      pair.views.get(id)[trade ? 'trades' : 'agreements']++;
    }
    if (giving > 0 && taking > 0 && Math.max(giving, taking) <= Math.min(giving, taking) * 1.5) {
      for (const id of pair.factions) this.changeOpinion(pair, id, 'mutuallyBeneficialTrade');
    } else if (giving - taking >= 15) this.changeOpinion(pair, actor, 'generousTrade');
    else if (taking - giving >= 15) this.changeOpinion(pair, other, 'generousTrade');
    if (trade) {
      pair.lastTrade = this.time;
      if (pair.state !== STANCE.CEASEFIRE) pair.state = this.peacefulState(pair);
      this.announce(pair, `${this.name(actor)} and ${this.name(other)} completed a trade.`);
      return null;
    }
    this.setCeasefire(pair, offer.duration);
    this.announce(pair, `${this.name(actor)} and ${this.name(other)} agreed to a ceasefire.`);
    return null;
  }

  setCeasefire(pair, duration) {
    const [a, b] = pair.factions;
    pair.state = STANCE.CEASEFIRE;
    pair.treaty = { endsAt: this.time + duration, duration };
    pair.cooldownUntil = pair.treaty.endsAt + this.config.incidentCooldown;
    this.rules.stopAttacks(a, b);
    this.rules.withdraw(a, b);
    this.rules.withdraw(b, a);
  }

  reportLoss(attacker, defender, building) {
    if (!this.canAttack(attacker, defender)) return;
    this.changeOpinion(this.between(attacker, defender), defender, building ? 'buildingLoss' : 'militaryLoss');
  }

  advance(time) {
    this.time = time;
    for (const pair of this.pairs.values()) {
      if (pair.treaty && time >= pair.treaty.endsAt) {
        pair.treaty = null;
        for (const id of pair.factions) this.changeOpinion(pair, id, 'honouredCeasefire');
        pair.state = this.peacefulState(pair);
        this.announce(pair, 'The ceasefire expired. Peaceful relations continue.');
      }
      if (isTrade(pair.warOffer) && time >= pair.warOffer.expiresAt) {
        pair.warOffer.status = 'expired';
        pair.lastOffer = pair.warOffer;
        pair.warOffer = null;
      }
      const incident = pair.incident;
      if (!incident) continue;
      if (incident.cause === 'border' && !this.rules.intruders(incident.aggressor, incident.defender).length) {
        this.resolveWithdrawal(pair, `${this.name(incident.aggressor)} cleared the border. The incident is closed.`);
      } else if (time >= incident.deadline) {
        this.resolveWithdrawal(pair, 'Negotiations ended. The intruding forces were ordered to withdraw.');
      }
    }
  }
}
