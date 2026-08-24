(() => {
'use strict';

// ================= tunables =================
const W = 800, H = 450;
const G = 1800;                 // gravity, px/s^2
const JUMP_VY = -496;           // jump impulse, px/s
const BOWL_R = 34;              // half-circle radius, px
const BALL_R = 10;              // ball radius, px
const BOWL_X = 220;             // fixed screen x of the bowl
const BASE_SCROLL = 220;        // world scroll speed, px/s
const SCROLL_RAMP = 0.02;       // +2% speed per pipe
const PIPE_W = 70;
const BASE_GAP = 190;
const GAP_RAMP = 1.5;           // gap shrinks per pipe
const MIN_GAP = 170;            // never below (gap must fit one full flap)
const PIPE_SPACING = 320;       // horizontal distance between pipes
const PIPE_MARGIN = 40;         // min distance of gap edge from floor/ceiling
const OMEGA_MAX = 4;            // max spin speed, rad/s
const ANG_ACC = 9.6;            // spin-up rate, rad/s^2
const OMEGA_DECAY = 3.5;        // spin decay on release, 1/s
const ROLL_GAIN = 0.2;          // ball rolls with g*sin(theta) * this
const CENTRIFUGAL = 0.15;       // ball flung outward while spinning
const RESTITUTION = 0.55;       // ball-bowl bounce energy
const TANGENT_FRICTION = 0.98;  // tangential velocity kept on bounce
const REATTACH_SPEED = 250;     // slow enough on the flat top to re-catch
const WOBBLE_AMP = 0.5;         // ambient tilt torque, rad/s^2 (makes balancing a real task)
const DT = 1 / 120;             // fixed physics step

// ================= dom =================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const rand = (a, b) => a + Math.random() * (b - a);

// ================= state =================
let S;
const keys = { left: false, right: false };
let botOn = false;
let botAcc = 0; // PWM accumulator for the bot's balance control

const STARS = Array.from({ length: 40 }, () => ({
  x: Math.random() * W, y: Math.random() * H, r: rand(0.6, 1.8), p: rand(0.3, 1),
}));

function bestScore() {
  try { return +(localStorage.getItem('floppy-bowl-best') || 0); } catch { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem('floppy-bowl-best', String(v)); } catch { /* ignore */ }
}

function reset(phase = 'menu') {
  S = {
    phase,                       // 'menu' | 'playing' | 'dead'
    t: 0,
    score: 0,
    best: bestScore(),
    deadCause: null,
    deadAt: 0,
    flash: 0,
    bowl: { x: BOWL_X, y: H * 0.5, vy: 0, theta: 0, omega: 0 },
    ball: { mode: 'surface', s: rand(-8, 8), sv: 0, x: 0, y: 0, vx: 0, vy: 0, hits: 0 },
    pipes: [],
    nextPipeX: W + 400,
  };
  botAcc = 0;
  syncBallPos();
}

// bowl local frame: theta = 0 -> flat top horizontal, +theta = clockwise (screen)
// surface dir d = (cos, sin), flat-top normal n = (sin, -cos) (points at the ball)
function syncBallPos() {
  const B = S.bowl, bl = S.ball;
  if (bl.mode !== 'surface') return;
  const c = Math.cos(B.theta), s = Math.sin(B.theta);
  bl.x = B.x + bl.s * c + BALL_R * s;
  bl.y = B.y + bl.s * s - BALL_R * c;
}

// ================= pipes =================
function makePipe(x) {
  const gapH = Math.max(MIN_GAP, BASE_GAP - GAP_RAMP * S.score);
  const gapY = rand(PIPE_MARGIN, H - PIPE_MARGIN - gapH);
  return { x, gapY, gapH, scored: false };
}
function pipeRects(p) {
  return [
    { x: p.x, y: 0, w: PIPE_W, h: p.gapY },
    { x: p.x, y: p.gapY + p.gapH, w: PIPE_W, h: H - (p.gapY + p.gapH) },
  ];
}

// ================= collisions =================
function circleRectHit(cx, cy, r, rc) {
  const px = clamp(cx, rc.x, rc.x + rc.w);
  const py = clamp(cy, rc.y, rc.y + rc.h);
  const dx = cx - px, dy = cy - py;
  return dx * dx + dy * dy < r * r;
}

// half-disk (bowl) vs axis-aligned rect. exact for our geometry.
function halfDiskRectHit(cx, cy, theta, rc) {
  const inRect = cx >= rc.x && cx <= rc.x + rc.w && cy >= rc.y && cy <= rc.y + rc.h;
  if (inRect) return true; // bowl center sits on the flat top edge -> overlap
  const c = Math.cos(theta), s = Math.sin(theta);
  const insideBowl = (px, py) => {
    const dx = px - cx, dy = py - cy;
    const lx = c * dx + s * dy, ly = -s * dx + c * dy;
    return lx * lx + ly * ly <= BOWL_R * BOWL_R && ly >= -1e-6;
  };
  const px = clamp(cx, rc.x, rc.x + rc.w);
  const py = clamp(cy, rc.y, rc.y + rc.h);
  const dx = cx - px, dy = cy - py;
  if (dx * dx + dy * dy <= BOWL_R * BOWL_R && insideBowl(px, py)) return true;
  return insideBowl(rc.x, rc.y) || insideBowl(rc.x + rc.w, rc.y) ||
         insideBowl(rc.x, rc.y + rc.h) || insideBowl(rc.x + rc.w, rc.y + rc.h);
}

// free ball vs bowl (half-disk). returns contact + resolves bounce / re-catch.
function ballBowlCollide() {
  const B = S.bowl, bl = S.ball;
  const c = Math.cos(B.theta), s = Math.sin(B.theta);
  const dx = bl.x - B.x, dy = bl.y - B.y;
  const lx = c * dx + s * dy, ly = -s * dx + c * dy; // ball center in bowl frame
  const toWorld = (vx, vy) => [c * vx - s * vy, s * vx + c * vy];

  let nx = 0, ny = 0, pen = 0, flat = false;

  if (ly <= 0 && Math.abs(lx) <= BOWL_R) {
    pen = BALL_R + ly; // flat top
    if (pen > 0) { flat = true; [nx, ny] = toWorld(0, -1); }
  } else if (ly < 0) {
    const qx = Math.sign(lx) * BOWL_R; // rim corner
    const ddx = lx - qx, ddy = ly;
    const dist = Math.hypot(ddx, ddy);
    if (dist < BALL_R) {
      pen = BALL_R - dist;
      [nx, ny] = toWorld(ddx / dist, ddy / dist);
    }
  } else {
    const r = Math.hypot(lx, ly); // curved side
    let nlx, nly;
    if (r < 1e-6) {
      nlx = 0; nly = -1; pen = BOWL_R + BALL_R;
    } else if (r <= BOWL_R) {
      nlx = lx / r; nly = ly / r; pen = BOWL_R + BALL_R - r;
    } else {
      const dist = r - BOWL_R;
      if (dist >= BALL_R) return;
      pen = BALL_R - dist;
      nlx = lx / r; nly = ly / r;
    }
    [nx, ny] = toWorld(nlx, nly);
  }
  if (pen <= 0) return;

  bl.x += nx * pen;
  bl.y += ny * pen;
  const vn = bl.vx * nx + bl.vy * ny;
  if (vn < 0) {
    const tx = -ny, ty = nx;
    const vt = (bl.vx * tx + bl.vy * ty) * TANGENT_FRICTION;
    const vnn = -vn * RESTITUTION;
    bl.vx = nx * vnn + tx * vt;
    bl.vy = ny * vnn + ty * vt;
    bl.hits++;
  }
  if (flat) {
    const speed = Math.hypot(bl.vx, bl.vy);
    if (speed < REATTACH_SPEED) { // settle back on the flat top
      bl.mode = 'surface';
      bl.s = clamp(lx, -BOWL_R, BOWL_R);
      bl.sv = bl.vx * Math.cos(B.theta) + bl.vy * Math.sin(B.theta);
      syncBallPos();
    }
  }
}

// ================= physics =================
function normTheta(t) {
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return t;
}

function jump() {
  if (S.phase === 'playing') S.bowl.vy = JUMP_VY;
}

function stepBall(dt) {
  const B = S.bowl, bl = S.ball;
  if (bl.mode === 'surface') {
    const acc = G * Math.sin(B.theta) * ROLL_GAIN + CENTRIFUGAL * B.omega * B.omega * bl.s;
    bl.sv += acc * dt;
    bl.s += bl.sv * dt;
    if (Math.abs(bl.s) > BOWL_R) {
      bl.mode = 'free';
      const c = Math.cos(B.theta), s = Math.sin(B.theta);
      bl.vx = bl.sv * c - B.omega * bl.s * s;
      bl.vy = B.vy + bl.sv * s + B.omega * bl.s * c;
    }
    syncBallPos();
  } else {
    bl.vy += G * dt;
    bl.x += bl.vx * dt;
    bl.y += bl.vy * dt;
    ballBowlCollide();
  }
}

function checkDeath() {
  const B = S.bowl, bl = S.ball;
  const mid = Math.abs(normTheta(B.theta)) <= Math.PI / 2;
  const ext = mid ? BOWL_R : BOWL_R * Math.abs(Math.sin(B.theta));
  const bottom = B.y + (mid ? BOWL_R : ext);
  const top = B.y - (mid ? ext : BOWL_R);
  if (bottom >= H) return die('bowl:floor');
  if (top <= 0) return die('bowl:ceiling');
  for (const p of S.pipes)
    for (const r of pipeRects(p))
      if (halfDiskRectHit(B.x, B.y, B.theta, r)) return die('bowl:pipe');
  if (bl.y + BALL_R >= H) return die('ball:floor');
  if (bl.y - BALL_R <= 0) return die('ball:ceiling');
  for (const p of S.pipes)
    for (const r of pipeRects(p))
      if (circleRectHit(bl.x, bl.y, BALL_R, r)) return die('ball:pipe');
}

function die(cause) {
  S.phase = 'dead';
  S.deadCause = cause;
  S.deadAt = S.t;
  S.flash = 1;
  keys.left = false;
  keys.right = false;
  if (S.score > S.best) { S.best = S.score; saveBest(S.best); }
}

// smooth bounded pseudo-random tilt torque: keeps the bowl from being
// trivially stable so balancing the ball is an active task
function wobbleTorque(t) {
  return WOBBLE_AMP * (0.6 * Math.sin(t * 0.9) + 0.4 * Math.sin(t * 1.7 + 1.3));
}

function step(dt) {
  S.t += dt;
  const B = S.bowl;
  const speed = BASE_SCROLL * (1 + SCROLL_RAMP * S.score);

  if (botOn) botThink();

  B.vy += G * dt;
  B.y += B.vy * dt;
  if (keys.left) B.omega = Math.max(B.omega - ANG_ACC * dt, -OMEGA_MAX);
  if (keys.right) B.omega = Math.min(B.omega + ANG_ACC * dt, OMEGA_MAX);
  if (!keys.left && !keys.right) B.omega *= Math.exp(-OMEGA_DECAY * dt);
  B.omega += wobbleTorque(S.t) * dt;
  B.theta = normTheta(B.theta + B.omega * dt);

  stepBall(dt);

  S.nextPipeX -= speed * dt;
  while (S.nextPipeX <= W + 80) {
    S.pipes.push(makePipe(W + 80));
    S.nextPipeX += PIPE_SPACING;
  }
  for (const p of S.pipes) p.x -= speed * dt;
  while (S.pipes.length && S.pipes[0].x + PIPE_W < -80) S.pipes.shift();
  for (const p of S.pipes)
    if (!p.scored && p.x + PIPE_W < B.x + BOWL_R) {
      p.scored = true;
      S.score++;
    }

  checkDeath();
}

// simple auto-player used by the e2e playability check
function botThink() {
  const B = S.bowl;
  // altitude: aim at the gap center of the next pipe, else mid-screen
  let ty = H * 0.5;
  let next = null;
  for (const p of S.pipes) {
    if (p.x + PIPE_W > B.x - 30) { next = p; break; }
  }
  if (next) ty = next.gapY + next.gapH / 2;
  if (B.y > ty + 30 && B.vy > 20) jump();
  // balance: feedforward-cancel the wobble + PD on tilt/spin, delivered as
  // PWM over the on/off spin keys (the actuator is much stronger than the
  // torque we need, so we pulse it for a small fraction of each step).
  const a_req = -wobbleTorque(S.t) - B.theta * 3 - B.omega * 1.5;
  botAcc += a_req * DT;
  keys.left = false;
  keys.right = false;
  const q = ANG_ACC * DT;
  if (botAcc >= q) { keys.right = true; botAcc -= q; }
  else if (botAcc <= -q) { keys.left = true; botAcc += q; }
  botAcc = clamp(botAcc, -2 * q, 2 * q);
}

// ================= input =================
window.addEventListener('keydown', (e) => {
  const code = e.code;
  if (code === 'Space' || code === 'ArrowLeft' || code === 'ArrowRight') e.preventDefault();
  if (e.repeat) return;
  if (code === 'ArrowLeft' || code === 'KeyA') keys.left = true;
  else if (code === 'ArrowRight' || code === 'KeyD') keys.right = true;
  else if (code === 'Space' || code === 'Enter') {
    if (S.phase === 'menu') reset('playing');
    else if (S.phase === 'dead' && S.t - S.deadAt > 0.4) reset('playing');
    else jump();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
});

// ================= render =================
const CAUSE_TXT = {
  'bowl:floor': 'the bowl hit the floor',
  'bowl:ceiling': 'the bowl hit the ceiling',
  'bowl:pipe': 'the bowl hit a pipe',
  'ball:floor': 'the ball hit the floor',
  'ball:ceiling': 'the ball hit the ceiling',
  'ball:pipe': 'the ball hit a pipe',
};

function drawPipe(p) {
  for (const r of pipeRects(p)) {
    if (r.h <= 0) continue;
    const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
    g.addColorStop(0, '#166534');
    g.addColorStop(0.5, '#22c55e');
    g.addColorStop(1, '#14532d');
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const capY = r.y === 0 ? r.y + r.h - 16 : r.y;
    ctx.fillStyle = '#15803d';
    ctx.fillRect(r.x - 5, capY, r.w + 10, 16);
    ctx.strokeStyle = '#052e16';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x - 5, capY, r.w + 10, 16);
  }
}

function drawBowl() {
  const { x, y, theta } = S.bowl;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, BOWL_R, theta, theta + Math.PI);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -BOWL_R, 0, BOWL_R);
  g.addColorStop(0, '#7dd3fc');
  g.addColorStop(1, '#075985');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#bae6fd';
  ctx.lineWidth = 2;
  ctx.stroke();
  // flat-top rim
  ctx.beginPath();
  ctx.moveTo(BOWL_R * Math.cos(theta), BOWL_R * Math.sin(theta));
  ctx.lineTo(-BOWL_R * Math.cos(theta), -BOWL_R * Math.sin(theta));
  ctx.strokeStyle = '#e0f2fe';
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.restore();
}

function drawBall() {
  const bl = S.ball;
  const g = ctx.createRadialGradient(bl.x - 3, bl.y - 4, 1, bl.x, bl.y, BALL_R);
  g.addColorStop(0, '#fef08a');
  g.addColorStop(1, '#ca8a04');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(bl.x, bl.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#713f12';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function text(str, x, y, size, color, align = 'center', bold = true) {
  ctx.fillStyle = color;
  ctx.font = `${bold ? 'bold ' : ''}${size}px ui-monospace, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function render() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#10162b');
  g.addColorStop(1, '#1c2a4a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const st of STARS) {
    const x = (st.x - S.t * 30 * st.p) % W;
    const xx = x < 0 ? x + W : x;
    ctx.fillRect(xx, st.y, st.r, st.r);
  }

  for (const p of S.pipes) drawPipe(p);

  ctx.fillStyle = '#ef4444';
  ctx.fillRect(0, 0, W, 4);
  ctx.fillRect(0, H - 4, W, 4);

  drawBowl();
  drawBall();

  if (S.phase !== 'menu') {
    text(String(S.score), W / 2, 56, 44, 'rgba(255,255,255,0.92)');
  }

  if (S.phase === 'menu') {
    ctx.fillStyle = 'rgba(8,11,22,0.55)';
    ctx.fillRect(0, 0, W, H);
    text('floppy-bowl', W / 2, 150, 54, '#7dd3fc');
    text('space to start', W / 2, 215, 20, '#e2e8f0');
    text('left / right: balance the ball', W / 2, 265, 15, '#94a3b8');
    text('space: jump', W / 2, 290, 15, '#94a3b8');
    text(`best: ${S.best}`, W / 2, 330, 16, '#facc15');
  } else if (S.phase === 'dead') {
    ctx.fillStyle = 'rgba(8,11,22,0.6)';
    ctx.fillRect(0, 0, W, H);
    text('dead', W / 2, 150, 46, '#f87171');
    text(CAUSE_TXT[S.deadCause] || S.deadCause, W / 2, 200, 16, '#cbd5e1');
    text(`score ${S.score}   best ${S.best}`, W / 2, 245, 20, '#e2e8f0');
    if (S.t - S.deadAt > 0.4) text('space to restart', W / 2, 300, 16, '#94a3b8');
  }

  if (S.flash > 0) {
    ctx.fillStyle = `rgba(255,80,60,${(S.flash * 0.35).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
    S.flash = Math.max(0, S.flash - 0.04);
  }
}

// ================= loop =================
let last = performance.now();
let acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let d = (now - last) / 1000;
  last = now;
  if (d > 0.1) d = 0.1;
  acc += d;
  while (acc >= DT) {
    if (S.phase === 'playing') step(DT);
    else S.t += DT;
    acc -= DT;
  }
  render();
}

reset('menu');
requestAnimationFrame(frame);

// ================= debug / test hooks =================
window.__floppy = {
  state: () => ({
    phase: S.phase,
    score: S.score,
    best: S.best,
    t: S.t,
    deadCause: S.deadCause,
    bot: botOn,
    bowl: { x: S.bowl.x, y: S.bowl.y, vy: S.bowl.vy, theta: S.bowl.theta, omega: S.bowl.omega },
    ball: {
      mode: S.ball.mode, s: S.ball.s, x: S.ball.x, y: S.ball.y,
      vx: S.ball.vx, vy: S.ball.vy, hits: S.ball.hits,
    },
    pipes: S.pipes.map((p) => ({ x: p.x, gapY: p.gapY, gapH: p.gapH, scored: p.scored })),
    keys: { ...keys },
  }),
  reset: (phase) => reset(phase || 'playing'),
  jump,
  bot: (on) => {
    botOn = !!on;
    if (!on) { keys.left = false; keys.right = false; }
    else { botAcc = 0; }
  },
  setKeys: (l, r) => { keys.left = !!l; keys.right = !!r; },
  teleportBowl: (y, vy = 0, theta = 0) => {
    S.bowl.y = y; S.bowl.vy = vy; S.bowl.theta = theta; S.bowl.omega = 0;
    syncBallPos();
  },
  dropBall: (vx = 0, vy = 60, dx = 0, dy = 0) => {
    const bl = S.ball;
    bl.mode = 'free';
    bl.x += dx;
    bl.y += dy;
    bl.vx = vx;
    bl.vy = vy;
  },
  setBall: (x, y, vx, vy) => {
    const bl = S.ball;
    bl.mode = 'free';
    bl.x = x; bl.y = y; bl.vx = vx; bl.vy = vy;
  },
  spawnPipe: (x, gapY, gapH = BASE_GAP) => {
    S.pipes.push({ x, gapY: gapY == null ? H / 2 - gapH / 2 : gapY, gapH, scored: false });
  },
  addScore: (n) => { S.score += n; },
};

})();