const CHORDS = [
  [45, 52, 55, 59, 64], [41, 48, 52, 55, 60], [48, 55, 59, 62, 67], [43, 50, 55, 57, 62],
  [45, 52, 60, 64, 67], [38, 45, 53, 57, 60], [41, 48, 55, 60, 64], [43, 50, 55, 59, 62],
];
const EFFECTS = {
  select: [[510, 640, 0.09, 0]],
  order: [[400, 565, 0.13, 0], [650, 640, 0.09, 0.07]],
  queue: [[540, 680, 0.10, 0], [755, 905, 0.11, 0.09]],
  build: [[240, 330, 0.15, 0], [495, 620, 0.14, 0.10]],
  upgrade: [[320, 440, 0.14, 0], [495, 680, 0.16, 0.11], [680, 760, 0.22, 0.23]],
  error: [[270, 165, 0.16, 0]],
  underAttack: [[360, 540, 0.25, 0], [360, 540, 0.25, 0.26], [540, 395, 0.29, 0.55]],
};
const CHORD_SECONDS = 5;
const ATTACK_ALERT_COOLDOWN = 8;
const COMBAT_BURST_LIMIT = 4;
const COMBAT_BURST_SECONDS = 0.16;
const RIFLE_SOUND = { tone: [192, 70, 0.09], noise: [2300, 0.066] };
const PULSE_SOUND = { tone: [510, 127, 0.15], noise: [1360, 0.084] };
const HEAVY_SOUND = { tone: [176, 55, 0.24], noise: [730, 0.17] };
const WEAPON_SOUNDS = { infantry: RIFLE_SOUND, sentinel: RIFLE_SOUND, siege: HEAVY_SOUND, vanguard: HEAVY_SOUND, bastion: HEAVY_SOUND };
const pitch = (note) => 440 * 2 ** ((note - 69) / 12);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

class GameAudio {
  music = true;
  effects = true;
  chord = 0;
  nextChord = 0;
  nextAttackAlert = 0;
  combatBurstEnds = 0;
  combatBurstShots = 0;

  wake() {
    const Audio = window.AudioContext ?? window.webkitAudioContext;
    if (!Audio) return;
    if (!this.context) {
      try {
        this.context = new Audio();
        this.musicBus = this.context.createGain();
        this.musicBus.connect(this.context.destination);
        this.effectsBus = this.context.createGain();
        this.effectsBus.connect(this.context.destination);
      } catch {
        this.context = null;
        return;
      }
      this.updateMix();
      window.setInterval(() => this.scheduleMusic(), 250);
    }
    if (this.context.state === 'running') this.scheduleMusic();
    else this.context.resume().then(() => this.scheduleMusic()).catch(() => {});
  }

  configure({ music, effects }) {
    this.music = music;
    this.effects = effects;
    this.updateMix();
  }

  updateMix() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.musicBus.gain.setTargetAtTime(this.music && !document.hidden ? 0.6 : 0, now, 0.15);
    this.effectsBus.gain.setTargetAtTime(this.effects && !document.hidden ? 0.8 : 0, now, 0.025);
  }

  tone(bus, from, to, start, duration, level, attack, waveform = 'sine') {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(bus);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }

  play(name) {
    if (!this.effects || !this.context || document.hidden) return;
    const now = this.context.currentTime;
    const alert = name === 'underAttack';
    if (alert) {
      if (this.context.state !== 'running' || now < this.nextAttackAlert) return;
      this.nextAttackAlert = now + ATTACK_ALERT_COOLDOWN;
    }
    for (const [from, to, duration, delay] of EFFECTS[name]) {
      this.tone(this.effectsBus, from, to, now + 0.015 + delay, duration, alert ? 0.12 : 0.068, 0.018, 'triangle');
    }
  }

  noise(frequency, start, duration, level) {
    const context = this.context;
    if (!this.combatNoise) {
      this.combatNoise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.3), context.sampleRate);
      const samples = this.combatNoise.getChannelData(0);
      for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = this.combatNoise;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.64;
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.effectsBus);
    source.start(start, Math.random() * (this.combatNoise.duration - duration), duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); };
  }

  playCombat(shots, listener) {
    if (!this.effects || this.context?.state !== 'running' || document.hidden || !shots.length) return;
    const now = this.context.currentTime;
    if (now >= this.combatBurstEnds) {
      this.combatBurstEnds = now + COMBAT_BURST_SECONDS;
      this.combatBurstShots = 0;
    }
    const available = COMBAT_BURST_LIMIT - this.combatBurstShots;
    if (!available) return;
    const nearest = shots.map((shot) => ({ shot, gap: distance(shot.source, listener) }))
      .sort((first, second) => first.gap - second.gap).slice(0, available);
    for (const { shot, gap } of nearest) {
      const start = now + 0.012 + this.combatBurstShots * 0.014;
      this.combatBurstShots++;
      const level = Math.max(0.17, 1 - gap / 45);
      const { tone: [from, to, duration], noise: [frequency, noiseDuration] } = WEAPON_SOUNDS[shot.weapon] ?? PULSE_SOUND;
      this.tone(this.effectsBus, from, to, start, duration, 0.10 * level, 0.006, 'triangle');
      this.noise(frequency, start, noiseDuration, 0.20 * level);
      if (!shot.impact) continue;
      const contact = start + Math.min(0.22, 0.043 + distance(shot.source, shot.impact) * 0.012);
      const impactLevel = Math.max(0.17, 1 - distance(shot.impact, listener) / 45);
      this.noise(shot.impact.destroyed ? 520 : 900, contact, shot.impact.destroyed ? 0.20 : 0.095, 0.15 * impactLevel);
      if (shot.impact.destroyed) this.tone(this.effectsBus, 89, 42, contact, 0.22, 0.10 * impactLevel, 0.013);
    }
  }

  scheduleMusic() {
    if (!this.music || document.hidden || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    if (this.nextChord < now) this.nextChord = now + 0.05;
    if (this.nextChord - now > 0.45) return;
    const notes = CHORDS[this.chord % CHORDS.length];
    const start = this.nextChord;
    notes.forEach((note, index) => {
      const hz = pitch(note);
      this.tone(this.musicBus, hz, hz * 0.999, start + index * 0.06, 6.25,
        index === 0 ? 0.052 : 0.032, 1.5, index === 1 ? 'triangle' : 'sine');
    });
    for (const [index, offset] of [0.65, 1.8, 3.05, 3.8].entries()) {
      const hz = pitch(notes[[1, 3, 4, 2][index]] + 12);
      this.tone(this.musicBus, hz, hz, start + offset, 1.65, 0.040, 0.045);
      this.tone(this.musicBus, hz, hz, start + offset + 0.27, 1.25, 0.013, 0.06);
    }
    this.chord++;
    this.nextChord += CHORD_SECONDS;
  }
}

export const audio = new GameAudio();
