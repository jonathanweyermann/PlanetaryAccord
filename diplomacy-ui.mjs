import { STANCE, TRADE_STANCES, isTrade, opinionLabel } from './diplomacy.mjs';
import { evaluateOffer, respondToPeaceOffer } from './diplomacy-ai.mjs';
import { RESOURCES } from './world.mjs';

const element = (name) => document.getElementById(`diplomacy-${name}`);
const clock = (seconds) => {
  const remaining = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
};

function describeResources(amounts) {
  return Object.entries(amounts).filter(([, amount]) => amount > 0)
    .map(([type, amount]) => `${amount.toLocaleString()} ${RESOURCES[type].name.toLowerCase()}`).join(', ') || 'no resources';
}

export function createDiplomacyUI(getGame, openDialog) {
  const dialog = element('dialog');
  const peer = element('peer');
  const form = document.getElementById('peace-form');
  const duration = element('duration');
  const offerFields = new Map();
  const seenIncidents = new Set();
  let peerListKey = '';
  let offerFor = null;
  let feedback = '';
  let resetDuration = true;

  const grid = element('resources');
  for (const label of ['Resource', 'You offer', 'You request']) {
    const heading = document.createElement('strong');
    heading.textContent = label;
    grid.append(heading);
  }
  for (const [type, resource] of Object.entries(RESOURCES)) {
    const label = document.createElement('span');
    label.textContent = resource.name;
    grid.append(label);
    const fields = ['Offer', 'Request'].map((verb) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.placeholder = '0';
      input.setAttribute('aria-label', `${verb} ${resource.name.toLowerCase()}`);
      grid.append(input);
      return input;
    });
    offerFields.set(type, fields);
  }

  const trading = () => {
    const { pair } = pairContext();
    return Boolean(pair && !pair.incident && TRADE_STANCES.includes(pair.state));
  };

  function terms() {
    const offer = trading() ? { kind: 'trade', offered: {}, requested: {} }
      : { offered: {}, requested: {}, duration: Number(duration.value) * 60 };
    for (const [type, [offered, requested]] of offerFields) {
      if (offered.value !== '') offer.offered[type] = Number(offered.value);
      if (requested.value !== '') offer.requested[type] = Number(requested.value);
    }
    return offer;
  }

  function pairContext() {
    const { country, diplomacy } = getGame();
    return { country, diplomacy, pair: diplomacy.between(country, peer.value), other: peer.value };
  }

  function renderLikelihood() {
    const { country, diplomacy, other } = pairContext();
    const offer = { from: country, to: other, ...terms() };
    const error = diplomacy.validateOffer(country, other, offer);
    const likelihood = element('likelihood');
    if (error) {
      likelihood.textContent = error;
      likelihood.dataset.status = 'invalid';
    } else if (diplomacy.factions.get(other).controller === 'ai') {
      const { accepted, reason } = evaluateOffer(diplomacy, offer);
      likelihood.textContent = `${accepted ? 'Likely to accept' : 'Likely to decline'}. ${reason}`;
      likelihood.dataset.status = accepted ? 'accepted' : 'rejected';
    } else {
      likelihood.textContent = 'The receiving faction will review your offer.';
      likelihood.dataset.status = '';
    }
  }

  function renderDetails() {
    const { country, diplomacy, pair, other } = pairContext();
    element('empty').hidden = Boolean(pair);
    element('faction').hidden = !pair;
    if (!pair) return;
    const { incident, treaty, state, lastOffer } = pair;
    const pending = diplomacy.pendingOffer(pair);
    const negotiating = Boolean(incident);
    const peaceful = !negotiating && TRADE_STANCES.includes(state);
    const mayOffer = (negotiating || state === STANCE.WAR || peaceful) && !pending;
    const score = diplomacy.opinion(other, country);
    element('state').textContent = treaty ? `${state} · ${clock(treaty.endsAt - diplomacy.time)} remaining` : state;
    element('state').dataset.state = state;
    element('opinion').textContent = `Their opinion of you · ${opinionLabel(score)} (${score > 0 ? '+' : ''}${score})`;
    element('incident').hidden = !negotiating;
    if (incident) {
      const aggressor = diplomacy.name(incident.aggressor);
      const defender = diplomacy.name(incident.defender);
      const trigger = incident.cause === 'border' ? `${aggressor}'s military entered ${defender} territory.`
        : incident.cause === 'attack' ? `${aggressor} ordered an attack on ${defender}.`
          : `${aggressor} signalled intent to declare war on ${defender}.`;
      element('incident-summary').textContent = `${trigger} Negotiation window ${clock(incident.deadline - diplomacy.time)}.`;
      element('demand').hidden = !incident.demand;
      if (incident.demand) element('demand').textContent = `${defender} has demanded withdrawal.`;
    }
    element('declare').hidden = negotiating || state === STANCE.WAR || state === STANCE.CEASEFIRE || state === STANCE.DEFEATED;
    element('withdraw').hidden = incident?.aggressor !== country;
    element('demand-withdrawal').hidden = incident?.defender !== country;
    element('demand-withdrawal').disabled = Boolean(incident?.demand);
    element('escalate').hidden = !negotiating;
    element('escalate').disabled = pair.factions.some((id) => diplomacy.warCount(id) >= diplomacy.config.maxWars);
    element('escalate').title = element('escalate').disabled ? 'A faction has reached its simultaneous war limit.' : '';
    element('deal').hidden = !mayOffer || offerFor === other;
    element('deal').textContent = peaceful ? 'Propose Trade' : 'Reach a Deal';
    element('form-title').textContent = peaceful ? 'Trade proposal' : 'Ceasefire offer';
    element('duration-field').hidden = peaceful;
    duration.required = !peaceful;
    element('pending').hidden = !pending;
    if (pending) {
      const incoming = pending.to === country;
      const trade = isTrade(pending);
      element('offer-title').textContent = incoming ? `${trade ? 'Trade proposal' : 'Ceasefire offer'} from ${diplomacy.name(other)}` : 'Awaiting a decision';
      element('offer-summary').textContent = `${diplomacy.name(pending.from)} offers ${describeResources(pending.offered)} and requests ${describeResources(pending.requested)}. `
        + (trade ? `Expires in ${clock(pending.expiresAt - diplomacy.time)}.` : `Ceasefire duration ${clock(pending.duration)}.`);
      element('offer-actions').hidden = !incoming;
    }
    if (!mayOffer) offerFor = null;
    form.hidden = !mayOffer || offerFor !== other;
    if (!form.hidden) renderLikelihood();
    const outcome = lastOffer?.status === 'rejected' ? `Offer declined. ${lastOffer.reason}`
      : lastOffer?.status === 'accepted' && isTrade(lastOffer) ? 'Trade completed. Resources exchanged.'
        : lastOffer?.status === 'expired' ? 'The trade proposal expired.'
          : lastOffer?.status === 'accepted' && treaty ? 'Offer accepted. The ceasefire is in effect.' : '';
    const message = element('feedback');
    const text = feedback || outcome;
    message.hidden = !text;
    if (message.textContent !== text) message.textContent = text;
  }

  function render() {
    const { country, diplomacy, knownFactions } = getGame();
    const incidents = diplomacy.incidentsFor(country);
    const offers = diplomacy.relations(country).filter((pair) => diplomacy.pendingOffer(pair)?.to === country);
    const alerts = new Set([...incidents, ...offers]).size;
    element('alerts').hidden = !alerts;
    if (alerts) element('alerts').textContent = alerts;
    const ids = [...diplomacy.factions.keys()].filter((id) => id !== country
      && (knownFactions.has(id) || [STANCE.WAR, STANCE.CEASEFIRE].includes(diplomacy.between(country, id).state)));
    const key = JSON.stringify(ids);
    if (peerListKey !== key) {
      const selected = peer.value;
      peer.replaceChildren(...ids.map((id) => new Option(diplomacy.name(id), id)));
      if (ids.includes(selected)) peer.value = selected;
      peerListKey = key;
    }
    const newIncident = incidents.find(({ incident }) => !seenIncidents.has(incident.id));
    if (newIncident && !dialog.open && !document.querySelector('dialog[open]')) {
      const incidentPeer = newIncident.factions.find((id) => id !== country);
      if (peer.value !== incidentPeer) {
        form.reset();
        resetDuration = true;
      }
      peer.value = incidentPeer;
      feedback = '';
      offerFor = null;
      openDialog();
    }
    if (dialog.open) {
      const incident = diplomacy.between(country, peer.value)?.incident;
      if (incident) seenIncidents.add(incident.id);
      renderDetails();
    }
  }

  function action(run) {
    const { country, diplomacy, pair, other } = pairContext();
    if (!pair) return;
    feedback = run(diplomacy, country, other, pair) ?? '';
    renderDetails();
  }

  element('open').addEventListener('click', () => {
    openDialog();
    render();
  });
  peer.addEventListener('change', () => { offerFor = null; feedback = ''; resetDuration = true; form.reset(); render(); });
  element('declare').addEventListener('click', () => action((rules, from, to) => rules.beginIncident(from, to, 'declaration')));
  element('escalate').addEventListener('click', () => action((rules, from, to) => rules.proceedToWar(from, to)));
  element('withdraw').addEventListener('click', () => action((rules, from, to) => rules.withdraw(from, to)));
  element('demand-withdrawal').addEventListener('click', () => action((rules, from, to) => rules.demandWithdrawal(from, to)));
  element('accept').addEventListener('click', () => action((rules, from, to, pair) => rules.accept(from, to, rules.pendingOffer(pair)?.id)));
  element('reject').addEventListener('click', () => action((rules, from, to, pair) => rules.reject(from, to, rules.pendingOffer(pair)?.id)));
  element('deal').addEventListener('click', () => {
    const { diplomacy, other } = pairContext();
    if (resetDuration || offerFor !== other) {
      const { config } = diplomacy;
      duration.min = String(config.minCeasefire / 60);
      duration.max = String(config.maxCeasefire / 60);
      duration.step = 'any';
      if (resetDuration || !duration.value) duration.value = config.ceasefireDuration / 60;
      resetDuration = false;
    }
    offerFor = other;
    feedback = '';
    renderDetails();
    offerFields.values().next().value[0].focus();
  });
  element('cancel-offer').addEventListener('click', () => { offerFor = null; feedback = ''; renderDetails(); });
  form.addEventListener('input', renderLikelihood);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    action((rules, from, to) => {
      const { error, offer } = rules.propose(from, to, terms());
      if (error) return error;
      respondToPeaceOffer(rules, offer);
      if (offer.status === 'rejected') return `Offer declined. ${offer.reason}`;
      offerFor = null;
      return null;
    });
  });

  return {
    render,
    reset() {
      seenIncidents.clear();
      peerListKey = '';
      offerFor = null;
      feedback = '';
      resetDuration = true;
      form.reset();
    },
  };
}
