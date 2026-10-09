/* Ghost Runner - iPhone web version (ported from the Android app) */
'use strict';

const $ = (id) => document.getElementById(id);
const MILE = 1609.344;
const now = () => performance.now() / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ======================= Formatting ======================= */
const Fmt = {
  unit: (mi) => (mi ? 'mi' : 'km'),
  clock(d) {
    if (!(d >= 0)) d = 0;
    const r = Math.round(d), h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  },
  pace(secPerM, mi) {
    if (!(secPerM > 0) || !isFinite(secPerM)) return '--:--';
    const p = secPerM * (mi ? MILE : 1000);
    return p > 3599 ? '--:--' : Fmt.clock(p);
  },
  dist: (m, mi) => (m / (mi ? MILE : 1000)).toFixed(2),
  distName(d, mi) {
    if (Math.abs(d - 5000) < 1) return '5K';
    if (Math.abs(d - 10000) < 1) return '10K';
    if (Math.abs(d - 21097.5) < 5) return 'Half marathon';
    if (Math.abs(d - 42195) < 5) return 'Marathon';
    if (Math.abs(d - MILE) < 1) return '1 mile';
    if (d < 1000) return `${Math.round(d)} m`;
    return Fmt.dist(d, mi).replace(/\.?0+$/, '') + ' ' + Fmt.unit(mi);
  },
  spoken(d) {
    const r = Math.round(Math.max(0, d)), h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
    let out = '';
    if (h > 0) out += h + (h === 1 ? ' hour ' : ' hours ');
    if (m > 0) out += m + (m === 1 ? ' minute ' : ' minutes ');
    if (s > 0 || !out) out += s + (s === 1 ? ' second' : ' seconds');
    return out.trim();
  },
};

/* ======================= Storage (on this phone only) ======================= */
const Store = {
  get(k, def) { try { const v = localStorage.getItem('gr.' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem('gr.' + k, JSON.stringify(v)); } catch (e) {} },
  has(k) { try { return localStorage.getItem('gr.' + k) !== null; } catch (e) { return false; } },
  pr(goal) { return this.get('pr' + Math.round(goal), -1); },
  runs() { return this.get('runs', []).slice().reverse(); },
  saveRun(run) {
    const pr = this.pr(run.goal);
    const isPr = run.finished && (pr < 0 || run.time < pr);
    if (isPr) this.set('pr' + Math.round(run.goal), run.time);
    run.pr = isPr;
    const all = this.get('runs', []);
    all.push(run);
    this.set('runs', all.slice(-150));
    return isPr;
  },
  clearRuns() { try { localStorage.removeItem('gr.runs'); } catch (e) {} },
};

/* ======================= Geo + GPS smoothing filter ======================= */
class Geo {
  setOrigin(lat, lon) { this.lat0 = lat; this.lon0 = lon; this.cos0 = Math.cos(lat * Math.PI / 180); this.has = true; }
  x(lat, lon) { return (lon - this.lon0) * Math.PI / 180 * 6371008.8 * this.cos0; }
  y(lat, lon) { return (lat - this.lat0) * Math.PI / 180 * 6371008.8; }
}

class PosFilter {
  constructor() {
    this.init = false; this.lastT = 0; this.rejected = 0; this.q = 0.5;
    this.s = [[0, 0], [0, 0]];
    this.P = [[[0, 0], [0, 0]], [[0, 0], [0, 0]]];
    this.x = this.y = this.vx = this.vy = 0;
  }
  update(t, mx, my, acc) {
    const a = Math.max(4, Math.min(acc, 40)), R = a * a * 0.6, m = [mx, my];
    if (!this.init) {
      for (let i = 0; i < 2; i++) { this.s[i] = [m[i], 0]; this.P[i] = [[R, 0], [0, 16]]; }
      this.init = true; this.lastT = t; this.publish(); return true;
    }
    const dt = Math.max(0.05, Math.min(t - this.lastT, 5)), q2 = this.q * this.q;
    const pred = [], inn = [], S = [];
    for (let i = 0; i < 2; i++) {
      const P = this.P[i];
      const a00 = P[0][0] + (P[0][1] + P[1][0]) * dt + dt * dt * P[1][1] + q2 * dt ** 4 / 4;
      S[i] = a00 + R;
      pred[i] = this.s[i][0] + this.s[i][1] * dt;
      inn[i] = m[i] - pred[i];
    }
    if ((inn[0] ** 2 / S[0] + inn[1] ** 2 / S[1] > 14 || Math.hypot(inn[0], inn[1]) > 16) && this.rejected < 3) {
      this.rejected++; return false;
    }
    this.rejected = 0;
    for (let i = 0; i < 2; i++) {
      const P = this.P[i];
      const a00 = P[0][0] + (P[0][1] + P[1][0]) * dt + dt * dt * P[1][1] + q2 * dt ** 4 / 4;
      const a01 = P[0][1] + dt * P[1][1] + q2 * dt ** 3 / 2;
      const a10 = P[1][0] + dt * P[1][1] + q2 * dt ** 3 / 2;
      const a11 = P[1][1] + q2 * dt * dt;
      const Sx = a00 + R, K0 = a00 / Sx, K1 = a10 / Sx;
      this.s[i] = [pred[i] + K0 * inn[i], this.s[i][1] + K1 * inn[i]];
      P[0][0] = (1 - K0) * a00; P[0][1] = (1 - K0) * a01;
      P[1][0] = a10 - a00 * K1; P[1][1] = a11 - K1 * a01;
    }
    this.lastT = t; this.publish(); return true;
  }
  publish() { this.x = this.s[0][0]; this.y = this.s[1][0]; this.vx = this.s[0][1]; this.vy = this.s[1][1]; }
  speed() { return Math.hypot(this.vx, this.vy); }
}

/* ======================= Run engine (the ghost pacer) ======================= */
const EV = { LAP: 1, YOU_PASS: 2, GHOST_PASS: 3, FINISH: 4, LOCK_ON: 5, LOCK_OFF: 6, START: 7 };
const ZONE_CENTER = 2.5, ZONE_ENTER = 1.5, ZONE_EXIT = 2.3, CORRECTION = 0.35;

class RunEngine {
  constructor(miles, goalDist, goalTime) {
    this.miles = miles; this.goalDist = goalDist; this.goalTime = goalTime;
    this.ghostSpeed = goalDist / goalTime;
    this.calloutEvery = miles ? 402.336 : 250;
    this.geo = new Geo(); this.filter = new PosFilter();
    this.dist = 0; this.gpsDist = 0; this.runTime = 0; this.speed = 0; this.vUsed = 0;
    this.started = this.paused = this.finished = false; this.finishTime = 0;
    this.gpsSeen = false; this.gpsAccuracy = 99; this.lastFixT = -1e9; this.lastTick = -1;
    this.anchorSet = false; this.anchorDist = 0; this.ax = 0; this.ay = 0;
    this.wt = []; this.wd = []; this.lastW = -1;
    this.nextCallout = 1; this.lastCalloutTime = 0; this.ghostSide = 0;
    this.splitTimes = []; this.splitGaps = []; this.events = [];
    this.locked = false; this.lockStart = 0; this.lockTotal = 0; this.bestStreak = 0; this.outSince = -1;
    this.catchUpUntil = 0;
  }
  start(t) { if (this.started) return; this.started = true; this.lastTick = t; this.events.push({ type: EV.START }); }
  pause(p) { this.paused = p; this.lastTick = -1; }

  onFix(t, lat, lon, acc) {
    this.gpsAccuracy = acc;
    if (acc > 35) return;
    this.gpsSeen = true;
    if (!this.geo.has) this.geo.setOrigin(lat, lon);
    if (!this.filter.update(t, this.geo.x(lat, lon), this.geo.y(lat, lon), acc)) return;
    this.lastFixT = t;
    if (this.started && !this.paused && !this.finished) {
      if (!this.anchorSet) { this.ax = this.filter.x; this.ay = this.filter.y; this.anchorSet = true; }
      let h = Math.hypot(this.filter.x - this.ax, this.filter.y - this.ay);
      if (h >= 20) { this.anchorDist += h; this.ax = this.filter.x; this.ay = this.filter.y; h = 0; }
      this.gpsDist = Math.max(this.gpsDist, this.anchorDist + h);
      // After the phone was locked / app in background, jump straight to where GPS says you are.
      if (t < this.catchUpUntil && this.gpsDist > this.dist) this.dist = Math.min(this.gpsDist, this.goalDist - 0.5);
    }
  }

  tick(t) {
    if (!this.started || this.finished) return;
    if (this.paused) { this.lastTick = t; return; }
    if (this.lastTick < 0) { this.lastTick = t; return; }
    const raw = Math.max(t - this.lastTick, 0);
    this.lastTick = t;
    if (raw <= 0) return;
    // Phone was asleep: the ghost kept running. Count the whole gap, and let GPS catch you up.
    const dt = raw > 2 ? raw : Math.min(raw, 0.25);
    if (raw > 2) this.catchUpUntil = t + 25;
    this.runTime += dt;

    let spd = t - this.lastFixT < 6 ? this.filter.speed() : 0;
    if (spd < 0.4) spd = 0;
    this.vUsed += (spd - this.vUsed) * (1 - Math.exp(-Math.min(dt, 0.25) / 0.5));
    const v = this.vUsed < 0.15 ? 0 : this.vUsed;
    this.speed = v;
    const corr = this.gpsSeen ? clamp((this.gpsDist - this.dist) * CORRECTION, -1.5, ZONE_ENTER) : 0;
    const prev = this.dist;
    this.dist = Math.max(prev, prev + (corr + v) * Math.min(dt, 0.25));

    if (this.runTime - this.lastW >= 0.5) {
      this.lastW = this.runTime;
      this.wt.push(this.runTime); this.wd.push(this.dist);
      if (this.wt.length > 64) { this.wt.shift(); this.wd.shift(); }
    }

    // split call-outs
    while (this.nextCallout * this.calloutEvery <= this.dist && this.nextCallout * this.calloutEvery < this.goalDist - 1) {
      const mark = this.nextCallout * this.calloutEvery;
      const frac = this.dist - prev > 1e-9 ? (mark - prev) / (this.dist - prev) : 1;
      const tc = this.runTime - (1 - frac) * Math.min(dt, 0.25);
      const gap = this.ghostSpeed > 0 ? (this.ghostSpeed * tc - mark) / this.ghostSpeed : 0;
      this.splitTimes.push(tc); this.splitGaps.push(gap);
      this.events.push({ type: EV.LAP, n: this.nextCallout, a: tc - this.lastCalloutTime, b: tc, c: gap });
      this.lastCalloutTime = tc; this.nextCallout++;
    }

    // passing
    const g = this.ghostDist() - this.dist;
    if (this.ghostSide >= 0 && g < -3 && this.runTime > 15) { this.ghostSide = -1; this.events.push({ type: EV.YOU_PASS, a: -g }); }
    else if (this.ghostSide <= 0 && g > 3 && this.runTime > 15) { this.ghostSide = 1; this.events.push({ type: EV.GHOST_PASS, a: g }); }
    else if (this.ghostSide === 0 && g < -3) this.ghostSide = -1;

    // "locked in" zone: ghost 1-4 m ahead
    const off = Math.abs(g - ZONE_CENTER);
    if (!this.locked && off <= ZONE_ENTER) {
      this.locked = true; this.lockStart = this.runTime; this.outSince = -1; this.events.push({ type: EV.LOCK_ON });
    } else if (this.locked) {
      if (off > ZONE_EXIT) {
        if (this.outSince < 0) this.outSince = this.runTime;
        else if (this.runTime - this.outSince > 0.6) {
          this.locked = false;
          this.lockTotal += this.runTime - this.lockStart;
          this.bestStreak = Math.max(this.bestStreak, this.runTime - this.lockStart);
          this.outSince = -1; this.events.push({ type: EV.LOCK_OFF });
        }
      } else this.outSince = -1;
    }

    if (this.dist >= this.goalDist) {
      this.finished = true;
      this.finishTime = this.runTime - (this.dist - this.goalDist) / Math.max(v, 0.5);
      this.dist = this.goalDist;
      if (this.locked) {
        this.lockTotal += this.runTime - this.lockStart;
        this.bestStreak = Math.max(this.bestStreak, this.runTime - this.lockStart);
        this.locked = false;
      }
      this.events.push({ type: EV.FINISH, a: this.finishTime, b: this.goalTime - this.finishTime });
    }
  }
  drain() { const e = this.events; this.events = []; return e; }
  ghostDist() { return Math.min(this.goalDist, this.ghostSpeed * this.runTime); }
  gap() { return this.ghostDist() - this.dist; }
  gapSeconds() { return this.ghostSpeed > 0 ? this.gap() / this.ghostSpeed : 0; }
  smoothPace() {
    const n = this.wt.length; if (n < 2) return 0;
    let i = 0; while (i < n - 1 && this.runTime - this.wt[i] > 12) i++;
    const dd = this.wd[n - 1] - this.wd[i], dt = this.wt[n - 1] - this.wt[i];
    return dd >= 2 && dt >= 2 ? dt / dd : 0;
  }
  currentStreak() { return this.locked ? this.runTime - this.lockStart : 0; }
  lockedTotal() { return this.lockTotal + this.currentStreak(); }
  toJSON() {
    return {
      when: Date.now(), mode: 0, track: false, miles: this.miles, goal: this.goalDist, goalTime: this.goalTime,
      dist: this.dist, finished: this.finished, time: this.finished ? this.finishTime : this.runTime,
      lapLen: this.calloutEvery, lockTotal: this.lockedTotal(),
      bestStreak: Math.max(this.bestStreak, this.currentStreak()),
      splits: this.splitTimes.slice(), splitGaps: this.splitGaps.slice(),
    };
  }
}

/* ======================= Voice, sound, haptics ======================= */
const Speaker = {
  enabled: true,
  unlock() { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {} },
  say(text) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    try { const u = new SpeechSynthesisUtterance(text); u.rate = 1.0; speechSynthesis.speak(u); } catch (e) {}
  },
  stop() { try { speechSynthesis.cancel(); } catch (e) {} },
};
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const b = audioCtx.createBuffer(1, 1, 22050), s = audioCtx.createBufferSource(); s.buffer = b; s.connect(audioCtx.destination); s.start(0);
  } catch (e) {}
}
function chime() {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    [[880, 0], [1320, 0.08]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.18, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.15);
      o.connect(g); g.connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.17);
    });
  } catch (e) {}
}
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

/* Keep the screen awake during a run */
const Wake = {
  lock: null,
  async on() {
    try { if ('wakeLock' in navigator) { this.lock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  },
  off() { try { this.lock && this.lock.release(); } catch (e) {} this.lock = null; },
};

/* ======================= 3D runner model ======================= */
const ANCHOR = [[0, 0, 0], [0, 1.7, 0], [0, 1.7, 0], [0, 0.95, -0.05], [0, 0.95, -0.05]];

class RunnerModel {
  static parse(buf) {
    const dv = new DataView(buf); let o = 4;
    const m = new RunnerModel();
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const u8 = () => dv.getUint8(o++);
    m.nV = i32(); m.nI = i32(); m.nB = i32();
    const nV = m.nV;
    m.pos = new Float32Array(nV * 3); m.nrm = new Float32Array(nV * 3); m.uv = new Float32Array(nV * 2);
    m.misc = new Float32Array(nV * 4); m.colA = new Uint8Array(nV * 4); m.colB = new Uint8Array(nV * 4);
    m.joints = new Uint8Array(nV * 4); m.weights = new Float32Array(nV * 4); m.group = new Uint8Array(nV); m.dynW = new Float32Array(nV);
    for (let v = 0; v < nV; v++) {
      for (let k = 0; k < 3; k++) m.pos[v * 3 + k] = f32();
      for (let k = 0; k < 3; k++) m.nrm[v * 3 + k] = f32();
      m.uv[v * 2] = f32(); m.uv[v * 2 + 1] = f32();
      for (let k = 0; k < 3; k++) m.colA[v * 4 + k] = u8(); m.colA[v * 4 + 3] = 255;
      const pm = u8() / 255;
      for (let k = 0; k < 3; k++) m.colB[v * 4 + k] = u8(); m.colB[v * 4 + 3] = 255;
      o++;
      const cut = f32();
      for (let k = 0; k < 4; k++) m.joints[v * 4 + k] = u8();
      for (let k = 0; k < 4; k++) m.weights[v * 4 + k] = f32();
      m.group[v] = u8(); m.dynW[v] = u8() / 255; const spec = u8() / 255; o++;
      m.misc[v * 4] = cut; m.misc[v * 4 + 1] = pm; m.misc[v * 4 + 2] = spec;
    }
    m.idx = new Uint16Array(m.nI);
    for (let i = 0; i < m.nI; i++) { m.idx[i] = dv.getUint16(o, true); o += 2; }
    m.headBone = i32(); m.hipsBone = i32(); i32();
    m.nAnim = i32(); m.speed = []; m.cycleSec = []; m.frames = []; m.mats = [];
    for (let a = 0; a < m.nAnim; a++) {
      const fps = f32(); m.frames[a] = i32(); m.speed[a] = f32(); m.cycleSec[a] = m.frames[a] / fps;
      const n = m.frames[a] * m.nB * 12;
      m.mats[a] = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4;
    }
    m.out = new Float32Array(nV * 6); // interleaved pos+normal
    m.cur = -1; m.phase = 0; m.lastSpeed = 0;
    m.sp = [0, 1, 2, 3, 4].map(() => [0, 0, 0]); m.sv = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
    m.lastAnchor = [0, 1, 2, 3, 4].map(() => [0, 0, 0]); m.lastVel = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
    m.haveAnchor = false; m.bones = new Float32Array(m.nB * 12);
    return m;
  }
  static targetCadence(s) { return clamp(s * 10 + 138, 150, 186); }
  pickVariant(s) {
    let best = -1, bestE = 1e9;
    for (let i = 0; i < this.nAnim; i++) {
      const r = s / this.speed[i];
      if (r >= 0.55 && r <= 1.6) {
        let e = Math.abs((r / this.cycleSec[i]) * 120 - RunnerModel.targetCadence(s));
        if (i === this.cur) e -= 7;
        if (e < bestE) { best = i; bestE = e; }
      }
    }
    if (best < 0) { let d = 1e9; best = 0; for (let i = 0; i < this.nAnim; i++) if (Math.abs(this.speed[i] - s) < d) { d = Math.abs(this.speed[i] - s); best = i; } }
    return best;
  }
  advance(s, dt) {
    s = Math.max(0.3, s); this.lastSpeed = s; this.cur = this.pickVariant(s);
    const c = this.cur;
    this.phase += dt * clamp(s / this.speed[c], 0.3, 1.8) / this.cycleSec[c];
    this.phase -= Math.floor(this.phase);
  }
  skin(dt) {
    const fr = this.frames[this.cur], p = this.phase * fr;
    const f0 = Math.floor(p) % fr, f1 = (f0 + 1) % fr, w = p - Math.floor(p);
    const M = this.mats[this.cur], nB = this.nB, B = this.bones;
    for (let b = 0; b < nB; b++) {
      const i0 = (f0 * nB + b) * 12, i1 = (f1 * nB + b) * 12;
      for (let k = 0; k < 12; k++) B[b * 12 + k] = M[i0 + k] * (1 - w) + M[i1 + k] * w;
    }
    this.updateSprings(B, dt);
    const pos = this.pos, nrm = this.nrm, J = this.joints, W = this.weights, out = this.out, grp = this.group, dyn = this.dynW, sp = this.sp;
    for (let v = 0; v < this.nV; v++) {
      const v3 = v * 3, x = pos[v3], y = pos[v3 + 1], z = pos[v3 + 2], nx = nrm[v3], ny = nrm[v3 + 1], nz = nrm[v3 + 2];
      let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
      for (let k = 0; k < 4; k++) {
        const wt = W[v * 4 + k];
        if (wt > 0) {
          const j = J[v * 4 + k] * 12;
          const a0 = B[j], a1 = B[j + 1], a2 = B[j + 2], b0 = B[j + 4], b1 = B[j + 5], b2 = B[j + 6], c0 = B[j + 8], c1 = B[j + 9], c2 = B[j + 10];
          px += (a0 * x + a1 * y + a2 * z + B[j + 3]) * wt;
          py += (b0 * x + b1 * y + b2 * z + B[j + 7]) * wt;
          pz += (c0 * x + c1 * y + c2 * z + B[j + 11]) * wt;
          qx += (a0 * nx + a1 * ny + a2 * nz) * wt;
          qy += (b0 * nx + b1 * ny + b2 * nz) * wt;
          qz += (c0 * nx + c1 * ny + c2 * nz) * wt;
        }
      }
      const g = grp[v];
      if (g > 0) { const d = dyn[v], s = sp[g]; px += s[0] * d; py += s[1] * d; pz += s[2] * d; }
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz) + 1e-9, o = v * 6;
      out[o] = px; out[o + 1] = py; out[o + 2] = pz; out[o + 3] = qx / l; out[o + 4] = qy / l; out[o + 5] = qz / l;
    }
  }
  // springy bits (side curls and fringes) that bounce with the stride
  updateSprings(B, dtIn) {
    const dt = clamp(dtIn, 0.001, 0.05);
    for (let i = 1; i <= 4; i++) {
      const j = (i <= 2 ? this.headBone : this.hipsBone) * 12, A = ANCHOR[i];
      const ax = B[j] * A[0] + B[j + 1] * A[1] + B[j + 2] * A[2] + B[j + 3];
      const ay = B[j + 4] * A[0] + B[j + 5] * A[1] + B[j + 6] * A[2] + B[j + 7];
      const az = B[j + 8] * A[0] + B[j + 9] * A[1] + B[j + 10] * A[2] + B[j + 11];
      const la = this.lastAnchor[i], vel = [(ax - la[0]) / dt, (ay - la[1]) / dt, (az - la[2]) / dt], acc = [0, 0, 0];
      if (this.haveAnchor) for (let k = 0; k < 3; k++) acc[k] = clamp((vel[k] - this.lastVel[i][k]) / dt, -60, 60);
      la[0] = ax; la[1] = ay; la[2] = az; this.lastVel[i] = vel;
      const K = i <= 2 ? 150 : 110, D = i <= 2 ? 7 : 5, L = i <= 2 ? 0.07 : 0.09;
      const n = Math.ceil(dt / 0.004), h = dt / n, p = this.sp[i], s = this.sv[i];
      for (let st = 0; st < n; st++) for (let k = 0; k < 3; k++) {
        s[k] += (-K * p[k] - s[k] * D - acc[k] * 0.6) * h;
        p[k] += s[k] * h;
        if (p[k] > L) { p[k] = L; s[k] = 0; }
        if (p[k] < -L) { p[k] = -L; s[k] = 0; }
      }
    }
    this.haveAnchor = true;
  }
}

/* ======================= WebGL renderer for the runner ======================= */
const VS = 'uniform mat4 uVP; uniform mat4 uM; uniform vec3 uCam; attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv; attribute vec4 aMisc; attribute vec4 aA; attribute vec4 aB;varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vMisc; varying vec3 vA; varying vec3 vB;void main(){ vec4 w=uM*vec4(aPos,1.0); vV=uCam-w.xyz; vN=mat3(uM[0].xyz,uM[1].xyz,uM[2].xyz)*aNrm; vUv=aUv; vMisc=aMisc.xyz; vA=aA.rgb; vB=aB.rgb; gl_Position=uVP*w; }';
const FS = 'precision mediump float; varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vMisc; varying vec3 vA; varying vec3 vB;uniform sampler2D uTex; uniform vec3 uLight;void main(){ vec3 base=mix(vA,vB,smoothstep(-0.0025,0.0025,vMisc.x)); if(vMisc.y>0.01){ vec3 t=texture2D(uTex,vec2(1.0-vUv.x,vUv.y)).rgb; base=mix(base,t*0.96,clamp(vMisc.y,0.0,1.0)); } vec3 n=normalize(vN); vec3 v=normalize(vV); float d=max(dot(n,uLight),0.0); float hemi=0.5+0.5*n.y; vec3 c=base*(0.34+0.26*hemi+0.62*d); vec3 h=normalize(uLight+v); c+=vec3(pow(max(dot(n,h),0.0),22.0)*vMisc.z*0.55); c+=vec3(pow(1.0-max(dot(n,v),0.0),3.0)*0.10)*vec3(0.75,0.85,1.0); gl_FragColor=vec4(c,1.0); }';
const SVS = 'uniform mat4 uVP; attribute vec3 aPos; attribute vec2 aUv; varying vec2 vUv; void main(){ vUv=aUv; gl_Position=uVP*vec4(aPos,1.0); }';
const SFS = 'precision mediump float; varying vec2 vUv; uniform float uAlpha; void main(){ float r=length(vUv-0.5)*2.0; gl_FragColor=vec4(0.0,0.0,0.0,uAlpha*(1.0-smoothstep(0.15,1.0,r))); }';

class RunnerGL {
  constructor(canvas) {
    this.canvas = canvas; this.ready = false;
    const gl = this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, depth: true });
    if (!gl) return;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = (v, f) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link'); return p; };
    this.prog = prog(VS, FS); this.sprog = prog(SVS, SFS);
    const P = this.prog, S = this.sprog;
    this.a = {}; ['aPos', 'aNrm', 'aUv', 'aMisc', 'aA', 'aB'].forEach((n) => (this.a[n] = gl.getAttribLocation(P, n)));
    this.u = {}; ['uVP', 'uM', 'uLight', 'uCam', 'uTex'].forEach((n) => (this.u[n] = gl.getUniformLocation(P, n)));
    this.sa = { aPos: gl.getAttribLocation(S, 'aPos'), aUv: gl.getAttribLocation(S, 'aUv') };
    this.su = { uVP: gl.getUniformLocation(S, 'uVP'), uAlpha: gl.getUniformLocation(S, 'uAlpha') };
    this.shadowBuf = gl.createBuffer();
  }
  setModel(m, img) {
    const gl = this.gl; if (!gl) return;
    this.m = m;
    const mk = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage); return b; };
    this.dynBuf = mk(m.out.byteLength, gl.DYNAMIC_DRAW);
    this.uvBuf = mk(m.uv, gl.STATIC_DRAW); this.miscBuf = mk(m.misc, gl.STATIC_DRAW);
    this.aBuf = mk(m.colA, gl.STATIC_DRAW); this.bBuf = mk(m.colB, gl.STATIC_DRAW);
    this.idxBuf = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (img) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
      c.getContext('2d').drawImage(img, 0, 0, 512, 1024);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([26, 32, 42, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, img ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.ready = true;
  }
  clear() { const gl = this.gl; if (!gl) return; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); }
  draw(vp, model, gx, gy, gz, cam) {
    if (!this.ready) return;
    const gl = this.gl, m = this.m;
    // soft shadow
    const sq = [[-1, -1, 0, 0], [1, -1, 1, 0], [-1, 1, 0, 1], [1, 1, 1, 1]], sd = new Float32Array(20);
    sq.forEach((q, i) => sd.set([gx + q[0] * 0.62, gy + 0.01, gz + q[1] * 0.62, q[2], q[3]], i * 5));
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.sprog);
    gl.uniformMatrix4fv(this.su.uVP, false, vp); gl.uniform1f(this.su.uAlpha, 0.42);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf); gl.bufferData(gl.ARRAY_BUFFER, sd, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.sa.aPos); gl.vertexAttribPointer(this.sa.aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.sa.aUv); gl.vertexAttribPointer(this.sa.aUv, 2, gl.FLOAT, false, 20, 12);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(this.sa.aPos); gl.disableVertexAttribArray(this.sa.aUv);
    // body
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uVP, false, vp); gl.uniformMatrix4fv(this.u.uM, false, model);
    gl.uniform3f(this.u.uLight, 0.35, 0.82, -0.45); gl.uniform3f(this.u.uCam, cam[0], cam[1], cam[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.u.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.out);
    const A = this.a;
    gl.enableVertexAttribArray(A.aPos); gl.vertexAttribPointer(A.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(A.aNrm); gl.vertexAttribPointer(A.aNrm, 3, gl.FLOAT, false, 24, 12);
    const bind = (loc, buf, n, type, norm) => { if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, type, norm, 0, 0); };
    bind(A.aUv, this.uvBuf, 2, gl.FLOAT, false); bind(A.aMisc, this.miscBuf, 4, gl.FLOAT, false);
    bind(A.aA, this.aBuf, 4, gl.UNSIGNED_BYTE, true); bind(A.aB, this.bBuf, 4, gl.UNSIGNED_BYTE, true);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.drawElements(gl.TRIANGLES, m.nI, gl.UNSIGNED_SHORT, 0);
    Object.values(A).forEach((l) => l >= 0 && gl.disableVertexAttribArray(l));
  }
}

/* ======================= Camera pose from motion sensors ======================= */
const Motion = {
  alpha: 0, beta: 75, gamma: 0, have: false, listening: false,
  async request() {
    // iOS requires asking inside a tap
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch (e) { return false; }
    this.listen(); return true;
  },
  listen() {
    if (this.listening) return; this.listening = true;
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta === null) return;
      this.alpha = e.alpha || 0; this.beta = e.beta; this.gamma = e.gamma || 0; this.have = true;
    });
  },
  // Returns camera basis in a Y-up world (x=east, y=up, z=south)
  basis() {
    const d = Math.PI / 180, a = this.alpha * d, b = this.beta * d, g = this.gamma * d;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // R = Rz(a) * Rx(b) * Ry(g)  (device -> earth ENU)
    let R = [
      ca * cg - sa * sb * sg, -cb * sa, ca * sg + cg * sa * sb,
      cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb,
      -cb * sg, sb, cb * cg,
    ];
    const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * d;
    if (ang) { // rotate device frame into screen frame
      const c = Math.cos(-ang), s = Math.sin(-ang);
      R = [R[0] * c + R[1] * s, -R[0] * s + R[1] * c, R[2], R[3] * c + R[4] * s, -R[3] * s + R[4] * c, R[5], R[6] * c + R[7] * s, -R[6] * s + R[7] * c, R[8]];
    }
    const col = (i) => [R[i], R[3 + i], R[6 + i]];
    const toW = (v) => [v[0], v[2], -v[1]];
    const right = toW(col(0)), up = toW(col(1)), back = toW(col(2));
    return { right, up, back };
  },
};

/* ======================= Ghost overlay scene ======================= */
const CAM_H = 1.4;          // phone height above the ground (m)
const CAM_FOV_LONG = 66;    // back camera field of view across the long side (deg)

const Scene = {
  rx: 0, rz: -1, dirInit: false, lastT: 0, lastGhostT: 0,
  init() {
    this.glCanvas = $('gl'); this.ov = $('ov'); this.ctx = this.ov.getContext('2d');
    try { this.rgl = new RunnerGL(this.glCanvas); } catch (e) { this.rgl = null; }
  },
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5), w = innerWidth, h = innerHeight;
    [this.glCanvas, this.ov].forEach((c) => { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); });
    this.dpr = dpr; this.w = w; this.h = h;
  },
  focal() { // focal length in CSS px matching the cover-scaled camera video
    const v = $('cam'), vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      const fv = Math.max(vw, vh) / 2 / Math.tan(CAM_FOV_LONG * Math.PI / 360);
      return fv * Math.max(this.w / vw, this.h / vh);
    }
    return this.h / 2 / Math.tan(30 * Math.PI / 180);
  },
  frame(t, eng, cameraOn) {
    if (!this.w || this.w !== innerWidth || this.h !== innerHeight) this.resize();
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h);
    if (this.rgl) this.rgl.clear();
    if (!cameraOn || !eng) return;

    const dt = this.lastT ? clamp(t - this.lastT, 0.001, 0.1) : 0.016; this.lastT = t;
    const B = Motion.basis();
    const fwd = [-B.back[0], -B.back[1], -B.back[2]];
    // running direction: where the phone points (horizontal), smoothed
    let hx = fwd[0] + B.up[0], hz = fwd[2] + B.up[2]; const hl = Math.hypot(hx, hz);
    if (hl > 0.05) {
      hx /= hl; hz /= hl;
      if (!this.dirInit || this.dirReset) { this.rx = hx; this.rz = hz; this.dirInit = true; this.dirReset = false; }
      else {
        const k = 1 - Math.exp(-dt / 0.9);
        let nx = this.rx + (hx - this.rx) * k, nz = this.rz + (hz - this.rz) * k; const nl = Math.hypot(nx, nz);
        if (nl > 0.2) { this.rx = nx / nl; this.rz = nz / nl; } else { this.rx = hx; this.rz = hz; }
      }
    }
    const cam = [0, CAM_H, 0], r = B.right, u = B.up, b = B.back;
    const view = new Float32Array([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0,
      -(r[1] * CAM_H), -(u[1] * CAM_H), -(b[1] * CAM_H), 1]);
    const f = this.focal(), W = this.w, H = this.h, n = 0.05, fa = 120;
    const proj = new Float32Array([2 * f / W, 0, 0, 0, 0, 2 * f / H, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]);
    const vp = mul4(proj, view);
    const project = (x, y, z) => {
      const X = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], Y = vp[1] * x + vp[5] * y + vp[9] * z + vp[13], Wc = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (Wc < 0.15) return null;
      return [((X / Wc) * 0.5 + 0.5) * W, (0.5 - (Y / Wc) * 0.5) * H, Wc];
    };

    const gap = eng.started ? eng.gap() : ZONE_CENTER;
    const side = clamp((3 - gap) / 3, 0, 1) * 1.2;
    const px = -this.rz, pz = this.rx; // to the right of the running line
    const gx = this.rx * gap + px * side, gz = this.rz * gap + pz * side;
    const locked = eng.locked;

    // target halo: where you should be (2.5 m behind the ghost)
    if (eng.started && gap > 0.2) {
      const cx = gx - this.rx * 2.5, cz = gz - this.rz * 2.5, pts = [];
      for (let i = 0; i < 24; i++) {
        const a = i * Math.PI * 2 / 24, c = Math.cos(a) * 0.85, s = Math.sin(a) * 0.85;
        const p = project(cx + this.rx * c + px * s, 0, cz + this.rz * c + pz * s);
        if (!p) { pts.length = 0; break; } pts.push(p);
      }
      if (pts.length) drawHalo(ctx, pts, locked, t);
    }

    // 3D ghost
    const m = this.model;
    if (m && this.rgl && this.rgl.ready && gap > -1.5) {
      m.advance(eng.ghostSpeed, dt); m.skin(dt);
      const s = 0.97, R = this.rx, Z = this.rz;
      const model = new Float32Array([Z * s, 0, -R * s, 0, 0, s, 0, 0, R * s, 0, Z * s, 0, gx, 0, gz, 1]);
      this.rgl.draw(vp, model, gx, 0, gz, cam);
    }

    // tether from you to the ghost's hips
    const hip = project(gx, 0.95, gz);
    if (eng.started && hip && gap > 0) drawTether(ctx, W, H, hip, gap, locked, t);
  },
};

function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

function drawHalo(ctx, pts, locked, t) {
  const col = locked ? '#1fa463' : '#f0a020', p = Math.sin(t * (locked ? 5 : 2.5)) * 0.5 + 0.5;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
  ctx.fillStyle = rgba(col, ((locked ? 70 : 38) + p * 30) / 255); ctx.fill();
  ctx.lineWidth = locked ? 5 : 3.5; ctx.strokeStyle = rgba(col, 235 / 255); ctx.stroke();
}
function drawTether(ctx, W, H, hip, gap, locked, t) {
  const sx = W / 2, sy = H * 0.97, far = gap > 10, col = locked ? '#1fa463' : '#f0a020';
  const slack = locked ? 0 : clamp((gap - 3.8) / 6, 0, 1), wob = Math.sin(t * 3) * 10;
  const path = () => { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo((sx + hip[0]) / 2 + wob * slack, (sy + hip[1]) / 2 + 60 * slack, hip[0], hip[1]); };
  ctx.lineCap = 'round';
  if (far) {
    ctx.setLineDash([10, 22]); ctx.strokeStyle = rgba(col, 120 / 255); ctx.lineWidth = 3; path(); ctx.stroke(); ctx.setLineDash([]); return;
  }
  const w = locked ? 5 : 4 - slack * 2;
  ctx.strokeStyle = 'rgba(0,0,0,.33)'; ctx.lineWidth = w + 3; path(); ctx.stroke();
  ctx.strokeStyle = rgba(col, 235 / 255); ctx.lineWidth = w; path(); ctx.stroke();
  if (locked) {
    ctx.setLineDash([4, 26]); ctx.lineDashOffset = t * 160; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; path(); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
  }
}

/* Side bar showing how far ahead the ghost is */
function drawPosBar(c, gap, miles, locked) {
  const d = Math.min(window.devicePixelRatio || 1, 2.5), cw = 90, ch = 320;
  if (c.width !== cw * d) { c.width = cw * d; c.height = ch * d; }
  const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0); x.clearRect(0, 0, cw, ch);
  const cx = cw - 18, top = 10, bot = ch - 10, zero = top + (bot - top) * 0.74, k = (zero - top) / 50;
  x.fillStyle = 'rgba(255,255,255,.33)'; roundRect(x, cx - 3, top, 6, bot - top, 3); x.fill();
  x.fillStyle = 'rgba(255,255,255,.6)';
  for (let i = -10; i <= 50; i += 10) { const y = zero - i * k; if (y > top && y < bot) x.fillRect(cx - 8, y - 0.7, 5, 1.4); }
  const y = zero - clamp(gap, -13, 50) * k, col = locked ? '#1fa463' : gap > 0 ? '#f0a020' : '#4db6ff';
  x.fillStyle = rgba(col, 70 / 255); roundRect(x, cx - 5, Math.min(y, zero), 10, Math.abs(y - zero), 5); x.fill();
  circle(x, cx, zero, 9, '#fff'); circle(x, cx, zero, 5, '#2f7bf6');
  circle(x, cx, y, 10, '#fff'); circle(x, cx, y, 7, col);
  const a = Math.abs(gap) * (miles ? 3.28084 : 1);
  const label = gap > 50 ? 'far' : miles ? Math.round(a) + ' ft' : (a < 10 ? a.toFixed(1) : a.toFixed(0)) + ' m';
  x.font = '600 12px -apple-system,sans-serif'; x.textAlign = 'right'; x.fillStyle = '#fff';
  x.shadowColor = 'rgba(0,0,0,.53)'; x.shadowBlur = 4; x.shadowOffsetY = 1; x.fillText(label, cx - 16, y + 4); x.shadowColor = 'transparent';
}
function roundRect(x, l, t, w, h, r) { x.beginPath(); if (x.roundRect) x.roundRect(l, t, w, h, Math.min(r, h / 2)); else x.rect(l, t, w, h); }
function circle(x, cx, cy, r, col) { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = col; x.fill(); }

/* ======================= App: screens ======================= */
const presetM = [400, 800, MILE, 5000, 10000, 21097.5], presetN = ['400 m', '800 m', '1 mile', '5K', '10K', 'Half'];
const locMiles = /-(US|GB|LR)$/i.test(navigator.language || 'en-US');
const S = {
  goalDist: Store.get('goalDist', 5000), goalTime: Store.get('goalTime', 1500), byPace: Store.get('byPace', false),
  miles: Store.has('miles') ? Store.get('miles', true) : locMiles, voice: Store.get('voice', true),
};
const save = () => { for (const k in S) Store.set(k, S[k]); };

function show(id) { document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id)); }

const unitM = () => (S.miles ? MILE : 1000);
const paceSec = () => (S.goalTime / S.goalDist) * unitM();

function buildHome() {
  const box = $('chips'); box.innerHTML = '';
  presetN.forEach((n, i) => {
    const b = document.createElement('button'); b.className = 'chip press'; b.textContent = n;
    b.onclick = () => { S.goalDist = presetM[i]; save(); refresh(); }; box.appendChild(b);
  });
  $('distMinus').onclick = () => { S.goalDist = Math.max(200, S.goalDist - unitM() * 0.1); save(); refresh(); };
  $('distPlus').onclick = () => { S.goalDist = Math.min(100000, S.goalDist + unitM() * 0.1); save(); refresh(); };
  $('switchBtn').onclick = () => { S.byPace = !S.byPace; save(); refresh(); };
  $('tMinus').onclick = () => nudge(-1); $('tPlus').onclick = () => nudge(1);
  $('targetTap').onclick = openTypeIn;
  holdRepeat($('distMinus')); holdRepeat($('distPlus')); holdRepeat($('tMinus')); holdRepeat($('tPlus'));
  $('startBtn').onclick = startRun;
  $('setBtn').onclick = openSettings;
  $('histBtn').onclick = openHistory;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    $('installTip').innerHTML = 'Tip: tap <b>Share</b> then <b>Add to Home Screen</b> to use Ghost Runner like an app.';
    $('installTip').style.marginTop = '22px';
  }
  refresh();
}
function holdRepeat(el) { // press and hold to keep stepping
  let t1, t2;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  el.addEventListener('touchstart', () => { stop(); t1 = setTimeout(() => { t2 = setInterval(() => el.onclick(), 110); }, 450); }, { passive: true });
  ['touchend', 'touchcancel'].forEach((e) => el.addEventListener(e, stop));
}
function nudge(i) {
  if (S.byPace) S.goalTime = (clamp(paceSec() + i * 5, 120, 1800) / unitM()) * S.goalDist;
  else S.goalTime = Math.max(60, S.goalTime + i * (S.goalDist > 8000 ? 30 : 10));
  save(); refresh();
}
function refresh() {
  $('distBig').textContent = Fmt.dist(S.goalDist, S.miles);
  $('distUnit').textContent = S.miles ? 'miles' : 'kilometers';
  [...$('chips').children].forEach((c, i) => c.classList.toggle('sel', Math.abs(S.goalDist - presetM[i]) < 2));
  const u = S.miles ? 'mile' : 'km';
  if (S.byPace) {
    $('targetLbl').textContent = 'How fast?'; $('targetBig').textContent = Fmt.clock(paceSec());
    $('derived').textContent = `per ${u}  ·  finish in ${Fmt.clock(S.goalTime)}`; $('switchBtn').textContent = 'Set finish time';
  } else {
    $('targetLbl').textContent = 'In how long?'; $('targetBig').textContent = Fmt.clock(S.goalTime);
    $('derived').textContent = `${Fmt.pace(S.goalTime / S.goalDist, S.miles)} per ${u}`; $('switchBtn').textContent = 'Set pace instead';
  }
}

/* ---------- Type in a pace or finish time ---------- */
function openTypeIn() {
  const sh = $('typeSheet'), box = $('typeFields'), u = S.miles ? 'mile' : 'km';
  const field = (id, val, lab, max) => `<div><input id="${id}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" value="${val}" data-max="${max}" autocomplete="off"><span class="lab">${lab}</span></div>`;
  const colon = '<span class="colon">:</span>';
  let read;
  if (S.byPace) {
    const p = Math.round(paceSec());
    $('typeT').textContent = 'Type your pace';
    $('typeM').textContent = `Minutes and seconds per ${u}.`;
    box.innerHTML = field('fM', Math.floor(p / 60), 'MIN', 59) + colon + field('fS', String(p % 60).padStart(2, '0'), 'SEC', 59) + `<span class="unit">/${S.miles ? 'mi' : 'km'}</span>`;
    read = () => {
      const sec = num('fM') * 60 + num('fS');
      if (sec < 120 || sec > 1800) return `Pace must be between 2:00 and 30:00 per ${u}.`;
      S.goalTime = (sec / unitM()) * S.goalDist;
    };
  } else {
    const t = Math.round(S.goalTime);
    $('typeT').textContent = 'Type your finish time';
    $('typeM').textContent = `How long you want to take for ${Fmt.distName(S.goalDist, S.miles)}.`;
    box.innerHTML = field('fH', Math.floor(t / 3600), 'HR', 99) + colon + field('fM', String(Math.floor((t % 3600) / 60)).padStart(2, '0'), 'MIN', 59) + colon + field('fS', String(t % 60).padStart(2, '0'), 'SEC', 59);
    read = () => {
      const sec = num('fH') * 3600 + num('fM') * 60 + num('fS');
      if (sec < 60) return 'Finish time must be at least 1 minute.';
      const p = (sec / S.goalDist) * unitM();
      if (p < 120 || p > 1800) return `That works out to ${Fmt.clock(p)} per ${u}. Pick a time between 2:00 and 30:00 per ${u}.`;
      S.goalTime = sec;
    };
  }
  const inputs = [...box.querySelectorAll('input')];
  inputs.forEach((el, i) => {
    el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 2);
      if (+el.value > +el.dataset.max) el.value = el.dataset.max;
      $('typeErr').textContent = '';
      if (el.value.length === 2 && inputs[i + 1]) inputs[i + 1].focus();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('typeYes').onclick(); });
  });
  $('typeErr').textContent = '';
  const close = () => { document.activeElement && document.activeElement.blur(); sh.classList.remove('on'); };
  $('typeNo').onclick = close;
  $('typeYes').onclick = () => { const err = read(); if (err) { $('typeErr').textContent = err; return; } save(); refresh(); close(); };
  sh.onclick = (e) => { if (e.target === sh) close(); };
  sh.classList.add('on');
  const first = S.byPace ? inputs[0] : inputs[0];
  first.focus();
}
const num = (id) => parseInt($(id).value, 10) || 0;

/* ---------- Settings / confirm sheets ---------- */
function openSettings() {
  const sh = $('setSheet'), m = $('togMiles'), v = $('togVoice');
  const paint = () => { m.lastChild.classList.toggle('on', S.miles); v.lastChild.classList.toggle('on', S.voice); };
  m.onclick = () => { S.miles = !S.miles; paint(); }; v.onclick = () => { S.voice = !S.voice; paint(); };
  $('setDone').onclick = () => { sh.classList.remove('on'); save(); refresh(); };
  sh.onclick = (e) => { if (e.target === sh) $('setDone').onclick(); };
  paint(); sh.classList.add('on');
}
function ask(title, msg, no, yes, onYes) {
  const sh = $('askSheet');
  $('askT').textContent = title; $('askM').textContent = msg; $('askNo').textContent = no; $('askYes').textContent = yes;
  $('askNo').onclick = () => sh.classList.remove('on');
  $('askYes').onclick = () => { sh.classList.remove('on'); onYes(); };
  sh.onclick = (e) => { if (e.target === sh) sh.classList.remove('on'); };
  sh.classList.add('on');
}

/* ---------- Run ---------- */
const R = { eng: null, watch: null, loopT: null, uiT: null, raf: 0, stream: null, cameraOn: false, camNote: '', motionOk: false, begun: false, paused: false, finishing: false, lastPulse: 0, saved: null };

function startRun() {
  // Everything iOS needs a tap for happens right here.
  const motionP = Motion.request();
  Speaker.unlock(); unlockAudio(); Wake.on();
  save();
  Speaker.enabled = S.voice;
  Object.assign(R, { eng: new RunEngine(S.miles, S.goalDist, S.goalTime), begun: false, paused: false, finishing: false, saved: null, cameraOn: false, camNote: 'Starting camera…' });
  Scene.dirReset = true;
  show('run');
  $('readyCard').style.display = ''; $('ctrl').style.display = 'none'; $('gapCard').style.display = 'none';
  $('stats').style.display = 'none'; $('posBar').style.display = 'none'; $('timeV').textContent = '0:00';
  setPauseIcon();
  motionP.then((ok) => { R.motionOk = ok; });
  startCamera();
  startGps();
  R.loopT = setInterval(engineLoop, 200);
  R.uiT = setInterval(updateUi, 100);
  cancelAnimationFrame(R.raf); R.raf = requestAnimationFrame(render);
  updateUi();
}
async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('none');
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const v = $('cam'); v.srcObject = R.stream; await v.play().catch(() => {});
    R.cameraOn = true; R.camNote = '';
  } catch (e) {
    R.cameraOn = false;
    R.camNote = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Camera permission is off' : 'Camera view off';
  }
}
function stopCamera() { try { R.stream && R.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} R.stream = null; $('cam').srcObject = null; R.cameraOn = false; }
function startGps() {
  if (!('geolocation' in navigator)) { R.gpsNote = 'This browser has no GPS access'; return; }
  R.gpsNote = '';
  R.watch = navigator.geolocation.watchPosition((p) => {
    const acc = p.coords.accuracy || 20; R.eng && R.eng.onFix(now(), p.coords.latitude, p.coords.longitude, acc);
  }, (err) => { if (err.code === 1) R.gpsNote = 'Location is off. Allow it in Settings > Privacy > Location Services > Safari Websites.'; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function stopGps() { if (R.watch !== null) { try { navigator.geolocation.clearWatch(R.watch); } catch (e) {} } R.watch = null; }

function engineLoop() {
  const e = R.eng; if (!e) return;
  e.tick(now());
  for (const ev of e.drain()) handleEvent(e, ev);
  if (e.finished && !R.saved) saveRun();
}
function handleEvent(e, ev) {
  const unitWord = S.miles ? 'mile' : 'kilometer';
  switch (ev.type) {
    case EV.START: Speaker.say('Go. Ghost is running.'); break;
    case EV.YOU_PASS: Speaker.say('You passed the ghost.'); break;
    case EV.GHOST_PASS: Speaker.say('The ghost passed you.'); break;
    case EV.LOCK_ON: chime(); buzz([35, 45, 35]); R.lastPulse = Date.now(); break;
    case EV.LOCK_OFF: buzz(170); break;
    case EV.FINISH: {
      const d = ev.b, r = Math.round(Math.abs(d));
      Speaker.say(`Finished. ${Fmt.spoken(ev.a)}. ${d > 0 ? 'You beat the ghost by ' : 'The ghost won by '}${r} seconds.`);
      break;
    }
    case EV.LAP: {
      const g = ev.c; let rel;
      if (Math.abs(g) < 1) rel = 'Level with the ghost.';
      else rel = g > 0 ? `${Math.round(g)} seconds behind the ghost.` : `${Math.round(-g)} seconds ahead of the ghost.`;
      const amt = +(ev.n * 0.25).toFixed(2);
      Speaker.say(`${amt} ${unitWord}${amt === 1 ? '' : 's'}. ${Fmt.spoken(ev.b)}. ${rel}`);
      break;
    }
  }
}
function saveRun() {
  const e = R.eng; if (!e || R.saved || !e.started) return;
  const j = e.toJSON(); Store.saveRun(j); R.saved = j;
}

function render() {
  R.raf = requestAnimationFrame(render);
  Scene.frame(now(), R.eng, R.cameraOn);
}

function updateUi() {
  const e = R.eng; if (!e) return;
  if (!R.begun) {
    const gpsOk = e.gpsSeen, g = $('gpsRow'), c = $('camRow');
    g.textContent = gpsOk ? '✓  GPS ready' : R.gpsNote ? '!  ' + R.gpsNote : `○  Looking for GPS signal…${e.gpsAccuracy < 99 ? ` (±${Math.round(e.gpsAccuracy)} m)` : ''}`;
    g.className = 'st ' + (gpsOk ? 'ok' : 'wait');
    if (R.cameraOn) { c.textContent = Motion.have ? '✓  Camera and motion ready' : '✓  Camera on (motion sensor off, ghost may float)'; c.className = 'st ' + (Motion.have ? 'ok' : 'wait'); }
    else { c.textContent = `–  ${R.camNote || 'Camera view off'}. Run works without the ghost overlay.`; c.className = 'st'; }
    $('goBtn').disabled = !gpsOk;
    return;
  }
  const gap = e.gap();
  $('timeV').textContent = Fmt.clock(e.runTime);
  $('distV').textContent = Fmt.dist(e.dist, S.miles); $('distL').textContent = S.miles ? 'MILES' : 'KM';
  $('paceV').textContent = Fmt.pace(e.smoothPace(), S.miles); $('paceL').textContent = S.miles ? 'PACE /MI' : 'PACE /KM';
  $('lapV').textContent = Math.round(e.calloutEvery - (e.dist % e.calloutEvery)) + ' m';
  const gv = $('gapV'), lv = $('lockV');
  if (e.finished) { gv.textContent = 'Finished'; gv.style.color = '#1fa463'; lv.textContent = ''; }
  else {
    const level = Math.abs(gap) <= 0.5, behind = gap > 0.5, secs = Math.round(Math.abs(e.gapSeconds()));
    gv.textContent = level ? 'LEVEL WITH GHOST' : (behind ? 'GHOST AHEAD  ' : 'YOU AHEAD  ') + secs + ' s';
    gv.style.color = e.locked ? '#3ddc84' : level ? '#fff' : behind ? '#ffb84d' : '#5bd9a0';
    lv.style.color = e.locked ? '#3ddc84' : '#cbd5e4';
    lv.textContent = e.locked ? 'LOCKED IN  ·  ' + Fmt.clock(e.currentStreak())
      : gap > 10 ? 'GHOST OUT OF RANGE' : gap > 4 ? `CATCH UP  ${Math.round(gap - 2.5)} m` : gap > 0 ? 'EASE OFF A LITTLE' : '';
    if (e.locked && Date.now() - R.lastPulse > 1800) { R.lastPulse = Date.now(); buzz(16); }
  }
  drawPosBar($('posBar'), e.ghostDist() - e.dist, S.miles, e.locked);
  if (e.finished && !R.finishing) { R.finishing = true; setTimeout(finishRun, 1800); }
}

function begin() {
  const e = R.eng; if (!e) return;
  Speaker.unlock(); unlockAudio(); Wake.on();
  R.begun = true; Scene.dirReset = true;
  e.start(now());
  $('readyCard').style.display = 'none';
  $('ctrl').style.display = 'flex'; $('gapCard').style.display = 'block'; $('stats').style.display = 'flex'; $('posBar').style.display = 'block';
}
function setPauseIcon() {
  $('pauseBtn').innerHTML = R.paused
    ? '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M7 4 20 12 7 20z" fill="#fff"/></svg>'
    : '<svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>';
}
function togglePause() { if (!R.eng) return; R.paused = !R.paused; R.eng.pause(R.paused); setPauseIcon(); }
function teardown() {
  clearInterval(R.loopT); clearInterval(R.uiT); cancelAnimationFrame(R.raf);
  stopGps(); stopCamera(); Wake.off();
}
function cancelRun() { teardown(); Speaker.stop(); R.eng = null; show('home'); }
function finishRun() {
  if (!R.eng) return;
  if (!R.saved && R.eng.started) saveRun();
  const j = R.saved; teardown(); R.eng = null;
  if (j) showSummary(j, true); else show('home');
}

/* ---------- Summary ---------- */
function showSummary(j, fromRun) {
  const mi = j.miles, el = $('sumBody');
  let html = `<div class="t">${j.finished ? 'Done!' : 'Run ended'}</div>`;
  html += `<div class="clock">${Fmt.clock(j.time)}</div>`;
  html += `<div class="d">${Fmt.dist(j.dist, mi)} ${mi ? 'miles' : 'km'}${j.finished ? '' : ' of ' + Fmt.distName(j.goal, mi)}</div>`;
  if (j.finished) {
    const d = j.goalTime - j.time, win = d > 0;
    html += `<div class="res" style="color:${win ? 'var(--green)' : 'var(--amber)'}">${win ? 'You beat the ghost by ' : 'The ghost won by '}${Math.round(Math.abs(d))} s</div>`;
    if (j.pr) html += `<div class="pr" style="margin-top:10px;font-size:13px;padding:4px 12px">NEW PR</div>`;
  }
  html += `<div class="srow">
    <div class="card"><div class="v">${Fmt.pace(j.dist > 5 ? j.time / j.dist : 0, mi)}</div><div class="l">AVG /${mi ? 'MI' : 'KM'}</div></div>
    <div class="card"><div class="v">${Fmt.clock(j.lockTotal || 0)}</div><div class="l">LOCKED IN</div></div>
    <div class="card"><div class="v">${Fmt.clock(j.bestStreak || 0)}</div><div class="l">BEST STREAK</div></div></div>`;
  if (j.splits && j.splits.length) {
    html += `<div class="card splits"><div class="hd">SPLITS</div>`;
    let prev = 0;
    j.splits.forEach((t, i) => {
      const g = j.splitGaps[i], amt = +((i + 1) * 0.25).toFixed(2) + ' ' + (mi ? 'mi' : 'km');
      const gs = Math.abs(g) < 1 ? '<span class="sub">level</span>' : g > 0 ? `<span style="color:var(--amber)">−${Math.round(g)} s</span>` : `<span style="color:var(--green)">+${Math.round(-g)} s</span>`;
      html += `<div class="sp"><span>${amt}</span><span class="sub">${Fmt.clock(t - prev)}</span><span>${gs}</span></div>`;
      prev = t;
    });
    html += `</div>`;
  }
  el.innerHTML = html; el.scrollTop = 0;
  $('doneBtn').onclick = () => (fromRun ? (refresh(), show('home')) : openHistory());
  show('summary');
}

/* ---------- History ---------- */
function openHistory() {
  const list = $('histList'), runs = Store.runs(); list.innerHTML = '';
  if (!runs.length) list.innerHTML = '<p class="sub" style="font-size:15px;margin:20px 4px">No runs yet. Your finished runs show up here.</p>';
  const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  runs.forEach((j) => {
    const mi = j.miles, b = document.createElement('button'); b.className = 'card run press';
    const name = Fmt.distName(j.finished ? j.goal : j.dist, mi) + (j.finished ? '' : '  (ended early)');
    b.innerHTML = `<div><div class="l1"></div><div class="l2">${df.format(new Date(j.when))}  ·  Street</div></div>
      <div class="r"><div class="rt">${Fmt.clock(j.time)}</div><div class="l2">${Fmt.pace(j.dist > 5 ? j.time / j.dist : 0, mi)} /${mi ? 'mi' : 'km'}</div>${j.pr ? '<div class="pr">PR</div>' : ''}</div>`;
    b.querySelector('.l1').textContent = name;
    b.onclick = () => showSummary(j, false);
    list.appendChild(b);
  });
  if (runs.length) {
    const c = document.createElement('button'); c.className = 'btn line press'; c.textContent = 'Clear history'; c.style.marginTop = '10px';
    c.onclick = () => ask('Clear history?', 'This deletes every saved run on this phone.', 'Cancel', 'Clear', () => { Store.clearRuns(); openHistory(); });
    list.appendChild(c);
  }
  $('backBtn').onclick = () => show('home');
  show('history');
}

/* ---------- Boot ---------- */
function boot() {
  buildHome();
  Scene.init();
  $('goBtn').onclick = begin;
  $('cancelBtn').onclick = cancelRun;
  $('pauseBtn').onclick = togglePause;
  $('stopBtn').onclick = () => ask('End this run?', 'Your run so far will be saved.', 'Keep running', 'End run', finishRun);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.eng) { Wake.on(); engineLoop(); } });
  window.addEventListener('pagehide', () => { if (R.eng && R.begun && !R.saved) { /* keep going if they come back */ } });
  // load the 3D runner in the background
  Promise.all([
    fetch('runner.bin').then((r) => r.arrayBuffer()),
    new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'shirt_back.png'; }),
  ]).then(([buf, img]) => {
    try { const m = RunnerModel.parse(buf); Scene.model = m; Scene.rgl && Scene.rgl.setModel(m, img); } catch (e) { console.warn('runner model', e); }
  }).catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
