// ============ COBALT SECTOR — effets sonores WebAudio (synthèse, zéro asset) ============
import type { GameState, WeaponId } from './core';

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
  shoot(wid: WeaponId) {
    switch (wid) {
      case 'canon': osc('square', 320, 0.12, 0.16, 90); break;
      case 'canon_auto': osc('square', 480, 0.06, 0.08, 200); break;
      case 'canon_lourd': osc('square', 160, 0.25, 0.22, 50); noise(0.15, 0.1, 900, 200); break;
      case 'laser': osc('sawtooth', 880, 0.14, 0.1, 220); break;
      case 'stase': osc('sine', 220, 0.3, 0.12, 660); break;
      case 'torpille': noise(0.3, 0.14, 700, 150); break;
      case 'plasma': osc('sawtooth', 140, 0.2, 0.16, 420); break;
    }
  },
  explosion(big: boolean) {
    noise(big ? 0.8 : 0.35, big ? 0.5 : 0.25, big ? 500 : 900, 60);
    osc('triangle', big ? 70 : 110, big ? 0.5 : 0.25, 0.2, 30);
  },
  impact() { noise(0.08, 0.08, 1600, 300); },
  jump() { osc('sine', 100, 0.5, 0.2, 900); noise(0.4, 0.1, 2000, 200); },
  alarm() { osc('square', 660, 0.15, 0.12); setTimeout(() => osc('square', 520, 0.15, 0.12), 170); },
  ui() { osc('sine', 700, 0.06, 0.08, 900); },
  buy() { osc('sine', 520, 0.08, 0.1); setTimeout(() => osc('sine', 780, 0.1, 0.1), 80); },
  error() { osc('square', 180, 0.16, 0.1, 120); },
  mine() { osc('sine', 900, 0.05, 0.05); },
  salvage() { osc('sine', 620, 0.07, 0.1, 940); },
  wave() { noise(1.2, 0.3, 300, 2000); },
};

/** Joue les sons correspondant aux événements visuels de la frame. */
export function playFx(gs: GameState) {
  let explosions = 0, shots = 0;
  for (const f of gs.fx) {
    switch (f.type) {
      case 'tir': if (shots++ < 3 && f.wid) sfx.shoot(f.wid); break;
      case 'beam': if (shots++ < 3 && f.wid) sfx.shoot(f.wid); break;
      case 'explosion': if (explosions++ < 2) sfx.explosion((f.size ?? 0) > 16); break;
      case 'saut': sfx.jump(); break;
      case 'onde': sfx.wave(); break;
      case 'frappe': sfx.explosion(true); break;
      case 'impact': if (shots++ < 4) sfx.impact(); break;
    }
  }
}
