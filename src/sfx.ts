// ============ COBALT SECTOR — effets sonores WebAudio (synthèse, zéro asset) ============
import type { GameState, V2, WeaponId } from './core';
import { dist, clamp } from './core';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function initAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
  // buffer de bruit blanc réutilisable
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

export function setVolume(v: number) { if (master) master.gain.value = v; }

function osc(type: OscillatorType, freq: number, dur: number, vol: number, slideTo?: number) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slideTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), ctx.currentTime + dur);
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + dur);
}

function noise(dur: number, vol: number, filterFreq: number, slideTo?: number) {
  if (!ctx || !master || !noiseBuf) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(filterFreq, ctx.currentTime);
  if (slideTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 10), ctx.currentTime + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(f).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur);
}

export const sfx = {
  shoot(wid: WeaponId, vol = 1) {
    switch (wid) {
      case 'canon': osc('square', 320, 0.12, 0.16 * vol, 90); break;
      case 'canon_auto': osc('square', 480, 0.06, 0.08 * vol, 200); break;
      case 'canon_lourd': osc('square', 160, 0.25, 0.22 * vol, 50); noise(0.15, 0.1 * vol, 900, 200); break;
      case 'laser': osc('sawtooth', 880, 0.14, 0.1 * vol, 220); break;
      case 'stase': osc('sine', 220, 0.3, 0.12 * vol, 660); break;
      case 'torpille': noise(0.3, 0.14 * vol, 700, 150); break;
      case 'plasma': osc('sawtooth', 140, 0.2, 0.16 * vol, 420); break;
      case 'missile': noise(0.5, 0.2 * vol, 1400, 300); osc('sawtooth', 300, 0.4, 0.1 * vol, 90); break;
    }
  },
  explosion(big: boolean, vol = 1) {
    noise(big ? 0.8 : 0.35, (big ? 0.5 : 0.25) * vol, big ? 500 : 900, 60);
    osc('triangle', big ? 70 : 110, big ? 0.5 : 0.25, 0.2 * vol, 30);
  },
  impact(vol = 1) { noise(0.08, 0.08 * vol, 1600, 300); },
  jump(vol = 1) { osc('sine', 100, 0.5, 0.2 * vol, 900); noise(0.4, 0.1 * vol, 2000, 200); },
  alarm() { osc('square', 660, 0.15, 0.12); setTimeout(() => osc('square', 520, 0.15, 0.12), 170); },
  ui() { osc('sine', 700, 0.06, 0.08, 900); },
  buy() { osc('sine', 520, 0.08, 0.1); setTimeout(() => osc('sine', 780, 0.1, 0.1), 80); },
  error() { osc('square', 180, 0.16, 0.1, 120); },
  mine(vol = 1) { osc('sine', 900, 0.05, 0.05 * vol); },
  salvage() { osc('sine', 620, 0.07, 0.1, 940); },
  wave(vol = 1) { noise(1.2, 0.3 * vol, 300, 2000); },
  bigBoom() { noise(2.2, 0.6, 260, 40); osc('triangle', 46, 1.8, 0.35, 22); },
  // --- verrouillage missile ---
  lockTick() { osc('square', 1150, 0.03, 0.05); },
  lockOn() { osc('sine', 880, 0.09, 0.12); setTimeout(() => osc('sine', 1320, 0.12, 0.12), 90); },
  lockWarn() { osc('sawtooth', 520, 0.14, 0.09, 480); },
  missileWarn(urgency: number) { osc('square', 760 + urgency * 480, 0.07, 0.1 + urgency * 0.06); },
  // --- radio ---
  radioOn() { osc('sine', 300, 0.08, 0.09, 1400); },
  radioStatic() { noise(0.35, 0.12, 2600, 800); },
  bipbip() { osc('sine', 1050, 0.06, 0.1); setTimeout(() => osc('sine', 1050, 0.06, 0.1), 140); },
  siren() {
    osc('sawtooth', 420, 0.5, 0.14, 780);
    setTimeout(() => osc('sawtooth', 780, 0.5, 0.14, 420), 500);
  },
  thunder(vol = 1) { noise(0.7, 0.35 * vol, 400, 60); osc('triangle', 60, 0.5, 0.15 * vol, 25); },
};

// ---------- Moteur du vaisseau (boucle continue) ----------
let engOsc: OscillatorNode | null = null;
let engGain: GainNode | null = null;
export function engineLevel(level: number) {
  if (!ctx || !master) return;
  if (!engOsc) {
    engOsc = ctx.createOscillator();
    engOsc.type = 'sawtooth';
    engOsc.frequency.value = 38;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 140;
    engGain = ctx.createGain();
    engGain.gain.value = 0;
    engOsc.connect(f).connect(engGain).connect(master);
    engOsc.start();
  }
  engGain!.gain.setTargetAtTime(clamp(level, 0, 1) * 0.1, ctx.currentTime, 0.12);
  engOsc.frequency.setTargetAtTime(34 + clamp(level, 0, 1) * 55, ctx.currentTime, 0.12);
}

/** Joue les sons de la frame, atténués par la distance au point d'écoute. */
export function playFx(gs: GameState, listener: V2) {
  const HEAR = 780;   // rayon d'écoute
  const att = (pos: V2 | undefined): number => {
    if (!pos) return 1;
    return clamp(1 - dist(pos, listener) / HEAR, 0, 1);
  };
  let explosions = 0, shots = 0;
  for (const f of gs.fx) {
    const v = att(f.pos);
    switch (f.type) {
      case 'tir': if (v > 0.04 && shots++ < 3 && f.wid) sfx.shoot(f.wid, v); break;
      case 'beam': if (v > 0.04 && shots++ < 3 && f.wid) sfx.shoot(f.wid, v); break;
      case 'explosion': if (v > 0.04 && explosions++ < 2) sfx.explosion((f.size ?? 0) > 16, v); break;
      case 'saut': if (v > 0.04) sfx.jump(v); break;
      case 'onde': sfx.wave(Math.max(v, 0.35)); break;   // les grandes ondes s'entendent de loin
      case 'frappe': sfx.explosion(true, Math.max(v, 0.4)); break;
      case 'impact': if (v > 0.04 && shots++ < 4) sfx.impact(v); break;
      case 'eclair': sfx.thunder(Math.max(v, 0.25)); break;
    }
  }
}
