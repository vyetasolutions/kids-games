/* game_upgrades.js — graphics, controls, social and sound upgrades layered over index.html.
   Does not edit the page. Each part is guarded; if drawing fails 3 frames in a row it hands back to the original loop. */
(function () {
  'use strict';
  if (typeof loop !== 'function' || typeof resize !== 'function' || typeof ctx === 'undefined') return;
  if (document.readyState === 'complete') return; /* loaded too late to take over the loop */

  var origLoop = loop, origResize = resize, origUpdatePos = updatePos;
  var LOW = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 4) <= 2;
  var DPR_CAP = LOW ? 1.5 : 2;
  var dprUsed = 1, dm = 1, lastTick = 0, lastTxt = '', fails = 0, TW = 800;
  var layers = [], cityC = null, cloudSp = [], streaks = [];
  var debris = [], smoke = [], chutes = [], trail = [];
  var sx = 0, spd = 40, dtF = 0.016, lastF = performance.now();
  var launchT = -99, cdStart = 0, cdTot = 7, lastRev = 99, mtPulse = 0, flashA = 0, flashCol = '255,255,255', crashV = 0, lastReached = 0;
  function speedOf(m) { return 90 + 170 * Math.log(Math.max(m, 1)); }          /* px/s, one speed for everything */
  function climbF(m) { return Math.min(1, Math.log(Math.max(m, 1)) / Math.log(60)); }
  function colFor(m) {
    var a = m < 3 ? [0, 229, 255] : m < 8 ? [245, 158, 11] : [239, 68, 68], b = m < 3 ? [245, 158, 11] : [239, 68, 68], k = m < 3 ? (m - 1) / 2 : m < 8 ? (m - 3) / 5 : 1;
    k = Math.max(0, Math.min(1, k)); return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * k); }).join(',');
  }
  var muted = false, autoFired = false, hist = [];
  function $(id) { return document.getElementById(id); }
  function mk(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function safe(f) { try { f(); } catch (e) { try { console.warn('[upgrades]', e); } catch (_) {} } }

  /* ── performance: cap shadow blur (off entirely on weak phones) ── */
  safe(function () {
    var proto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    var d = proto && Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
    if (d && d.set) Object.defineProperty(ctx, 'shadowBlur', {
      configurable: true,
      get: function () { return d.get.call(ctx); },
      set: function (v) { d.set.call(ctx, LOW ? 0 : Math.min(v, 14)); }
    });
  });

  /* ── pre-rendered scenery ───────────────────────── */
  function rebuild(W, H) {
    TW = Math.ceil(W + 240);
    layers = [0, 1].map(function (l) {
      var c = mk(TW * dprUsed, H * dprUsed), x = c.getContext('2d'); x.scale(dprUsed, dprUsed);
      var base = H * (l ? 0.20 : 0.30), amp = H * (l ? 0.14 : 0.22);
      var k = l ? [5, 11, 19] : [3, 7, 13], p = [Math.random() * 6, Math.random() * 6, Math.random() * 6], wt = [0.55, 0.3, 0.15];
      x.beginPath(); x.moveTo(0, H);
      for (var px = 0; px <= TW; px += 6) {
        var h = 0; for (var i = 0; i < 3; i++) h += wt[i] * (1 - Math.abs(Math.sin(Math.PI * k[i] * px / TW + p[i])));
        x.lineTo(px, H - (base * 0.55 + amp * h));
      }
      x.lineTo(TW, H); x.closePath();
      var g = x.createLinearGradient(0, H * 0.4, 0, H);
      g.addColorStop(0, l ? 'rgba(22,30,64,0.62)' : 'rgba(48,62,120,0.38)');
      g.addColorStop(1, l ? 'rgba(8,12,28,0.7)' : 'rgba(14,20,46,0.5)');
      x.fillStyle = g; x.fill(); return c;
    });
    cityC = mk(TW * dprUsed, H * dprUsed);
    var cx = cityC.getContext('2d'); cx.scale(dprUsed, dprUsed);
    var cy = H * 0.74, bx = 0;
    while (bx < TW) {
      var bw = 18 + Math.random() * 38, bh = 28 + Math.random() * Math.min(85, H * 0.16);
      cx.fillStyle = 'rgba(7,11,26,0.92)'; cx.fillRect(bx, cy - bh, bw, bh);
      for (var wy = cy - bh + 5; wy < cy - 5; wy += 9) for (var wx = bx + 3; wx < bx + bw - 3; wx += 7)
        if (Math.random() > 0.62) { cx.fillStyle = 'rgba(255,218,90,' + (0.22 + Math.random() * 0.3) + ')'; cx.fillRect(wx, wy, 3, 4); }
      if (Math.random() > 0.8) { cx.fillStyle = 'rgba(239,68,68,0.8)'; cx.fillRect(bx + bw / 2 - 1, cy - bh - 5, 2, 3); }
      bx += bw + 3 + Math.random() * 10;
    }
    var gg = cx.createLinearGradient(0, cy, 0, H); gg.addColorStop(0, 'rgba(8,12,28,0.9)'); gg.addColorStop(1, 'rgba(3,5,12,0.98)');
    cx.fillStyle = gg; cx.fillRect(0, cy, TW, H - cy);
    cloudSp = [0, 1, 2].map(function () {
      var c = mk(256, 96), x = c.getContext('2d');
      for (var i = 0; i < 7; i++) {
        var px = 30 + i * 32 + Math.random() * 10, py = 52 + Math.sin(i * 1.3) * 14, r = 24 + Math.random() * 16;
        var g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, 'rgba(210,222,255,0.55)'); g.addColorStop(1, 'rgba(210,222,255,0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 6.2832); x.fill();
      }
      return c;
    });
    streaks = []; for (var s = 0; s < (LOW ? 10 : 22); s++) streaks.push({ x: Math.random() * W, y: Math.random() * H * 0.8, l: 20 + Math.random() * 50, s: 0.7 + Math.random() * 1.3 });
  }

  function newResize() {
    var r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
    dprUsed = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.round(r.width * dprUsed); canvas.height = Math.round(r.height * dprUsed);
    ctx.setTransform(dprUsed, 0, 0, dprUsed, 0, 0);
    var W = r.width, H = r.height; safeTop = 64; safeBottom = H - 16;
    if (gameStatus !== 'IN_FLIGHT') { cY = H * 0.62; tY = cY; }
    buildScene(W, H); rebuild(W, H);
  }

  /* ── drawing ────────────────────────────────────── */
  function drawSky2(W, H, t) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgb(' + (6 + t * 22) + ',' + (9 + t * 6) + ',' + (18 + t * 55) + ')');
    g.addColorStop(0.55, 'rgb(' + (14 + t * 38) + ',' + (20 + t * 14) + ',' + (50 + t * 75) + ')');
    g.addColorStop(1, 'rgb(' + (10 + t * 28) + ',' + (15 + t * 10) + ',' + (35 + t * 55) + ')');
    ctx.fillStyle = g; ctx.fillRect(-12, -12, W + 24, H + 24);
    if (t < 0.4) {
      var a = 0.17 * (1 - t * 2.5), dg = ctx.createRadialGradient(W * 0.3, H * 0.84, 0, W * 0.3, H * 0.84, H * 0.62);
      dg.addColorStop(0, 'rgba(255,150,80,' + a + ')'); dg.addColorStop(1, 'rgba(255,150,80,0)');
      ctx.fillStyle = dg; ctx.fillRect(0, 0, W, H);
    }
    if (!LOW && dm > 3) {
      var aA = Math.min((dm - 3) / 14, 0.14), ph = Date.now() * 0.0004;
      [['rgba(0,229,255', 0.08], ['rgba(168,85,247', 0.17], ['rgba(16,185,129', 0.26]].forEach(function (b, i) {
        var yy = H * b[1] + Math.sin(ph + i) * H * 0.012, ag = ctx.createLinearGradient(0, yy, 0, yy + H * 0.1);
        ag.addColorStop(0, b[0] + ',0)'); ag.addColorStop(0.5, b[0] + ',' + aA + ')'); ag.addColorStop(1, b[0] + ',0)');
        ctx.fillStyle = ag; ctx.fillRect(0, yy, W, H * 0.12);
      });
    }
  }
  function drawRays(W, H, t) {
    var a = 0.05 * (1 - t * 3); if (a <= 0) return;
    for (var i = 0; i < 3; i++) {
      var x0 = W * (0.1 + i * 0.28), w = W * 0.1, g = ctx.createLinearGradient(x0, 0, x0 + w * 2, H * 0.7);
      g.addColorStop(0, 'rgba(255,220,160,' + a + ')'); g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 + w, 0); ctx.lineTo(x0 + w * 2.6, H * 0.7); ctx.lineTo(x0 + w * 1.2, H * 0.7); ctx.closePath(); ctx.fill();
    }
  }
  function drawMoon(W, H) {
    if (gameStatus !== 'IN_FLIGHT' || dm < 15) return;
    var a = Math.min((dm - 15) / 25, 0.9), x = W * 0.78, y = H * 0.2, r = Math.min(W, H) * 0.07;
    ctx.save(); ctx.globalAlpha = a;
    var g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r * 1.1); g.addColorStop(0, '#fffbe6'); g.addColorStop(1, '#cbd5e1');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(100,116,139,0.35)';
    [[-0.3, -0.1, 0.18], [0.25, 0.2, 0.22], [0.05, -0.4, 0.12]].forEach(function (c) { ctx.beginPath(); ctx.arc(x + c[0] * r, y + c[1] * r, c[2] * r, 0, 6.2832); ctx.fill(); });
    ctx.restore();
  }
  function drawClouds2(W) {
    clouds.forEach(function (c, i) {
      c.x -= spd * c.sp * 0.5 * dtF; if (c.x < -c.w - 60) c.x = W + 60;
      ctx.globalAlpha = Math.min(0.9, c.a * 3.2);
      ctx.drawImage(cloudSp[i % 3], c.x, c.y - c.w * 0.19, c.w * 1.2, c.w * 0.45);
    });
    ctx.globalAlpha = 1;
  }
  function drawTiled(img, sf, H) { var off = (sx * sf) % TW; ctx.drawImage(img, -off, 0, TW, H); ctx.drawImage(img, TW - off, 0, TW, H); }
  function drawStreaks(W, H) {
    if (gameStatus !== 'IN_FLIGHT' || dm <= 1.5) return;
    ctx.strokeStyle = 'rgba(0,229,255,' + Math.min((dm - 1.5) * 0.03, 0.16) + ')'; ctx.lineWidth = 0.9; ctx.beginPath();
    var st = 0.5 + spd / 400;
    streaks.forEach(function (s) {
      s.x -= spd * s.s * 1.4 * dtF; if (s.x < -s.l * 2) { s.x = W + Math.random() * 50; s.y = Math.random() * H * 0.8; }
      ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + s.l * st, s.y);
    });
    ctx.stroke();
  }
  function updTrail(fl) {
    for (var i = 0; i < trail.length; i++) trail[i].x -= spd * dtF * 0.9;
    while (trail.length && trail[0].x < -20) trail.shift();
    if (fl) { trail.push({ x: cX - 14, y: cY + 12 }); if (trail.length > (LOW ? 50 : 90)) trail.shift(); }
    else if (gameStatus === 'BETTING') trail.length = 0;
  }
  function drawTrail() {
    if (trail.length < 2) return;
    var c = colFor(dm); ctx.save(); ctx.lineCap = 'round';
    [[7, 0.07], [2.5, 0.3]].forEach(function (w) {
      ctx.beginPath(); ctx.moveTo(trail[0].x, trail[0].y); for (var i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
      ctx.strokeStyle = 'rgba(' + c + ',' + w[1] + ')'; ctx.lineWidth = w[0]; ctx.stroke();
    });
    ctx.restore();
  }
  function drawStars2(W, H, fl) {
    stars.forEach(function (s) {
      s.x -= spd * s.sp * 0.1 * dtF; if (s.x < -3) { s.x = W + 3; s.y = Math.random() * H * 0.8; }
      var tw = 0.3 + Math.abs(Math.sin(Date.now() * 0.0009 * (s.l + 1) + s.x * 0.01)) * 0.5;
      ctx.globalAlpha = s.br * tw * (fl ? Math.min(dm / 2.5, 1) : 0.45); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.2832); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
  function drawWarp(W, H) {
    if (LOW || gameStatus !== 'IN_FLIGHT' || dm <= 3) return;
    var a = Math.min((dm - 3) * 0.012, 0.12), cx = W * 0.5, cy = H * 0.55, R = Math.max(W, H) * 0.75;
    ctx.strokeStyle = 'rgba(200,235,255,' + a + ')'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (var i = 0; i < 18; i++) {
      var ang = i * 0.349 + 0.2 * Math.sin(i * 7.1), ph = (sx * 0.0025 + i * 0.173) % 1, r0 = R * (0.3 + ph * 0.65), r1 = r0 + R * 0.06 * (0.4 + ph);
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    }
    ctx.stroke();
  }
  function drawVignette(W, H) {
    var a = 0, col = '239,68,68';
    if (gameStatus === 'IN_FLIGHT') { a = Math.min(0.04 + (dm - 1) * 0.012, 0.26); col = colFor(dm); }
    if (crashV > a) { a = crashV; col = '239,68,68'; }
    if (a < 0.01) return;
    var g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(' + col + ',0)'); g.addColorStop(1, 'rgba(' + col + ',' + a + ')'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function drawFlash(W, H) { if (flashA < 0.01) return; ctx.fillStyle = 'rgba(' + flashCol + ',' + Math.min(flashA, 0.6) + ')'; ctx.fillRect(0, 0, W, H); }
  function myUpdate(W, H, fl) {
    if (fl) {
      var tX = 115 + (W * 0.56 - 115) * (1 - Math.exp(-(dm - 1) / 6)); cX += (tX - cX) * Math.min(1, dtF * 4);
      var top = safeTop + 34, bot = Math.min(safeBottom - 90, H * 0.66); tY = bot - (bot - top) * climbF(dm); cY += (tY - cY) * Math.min(1, dtF * 5);
      rampEngine(mult); if (Math.random() < 0.5 + 0.4 * climbF(dm)) spawnTrail();
    } else if (gameStatus === 'BETTING') {
      cX += (115 - cX) * Math.min(1, dtF * 5); tY = H * 0.62 + Math.sin(Date.now() * 0.0033) * 7; cY += (tY - cY) * Math.min(1, dtF * 7);
    }
  }
  function whoosh() {
    if (muted) return;
    safe(function () {
      var a = ac(), len = a.sampleRate * 0.7, b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / len);
      var s = a.createBufferSource(); s.buffer = b; var f = a.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(300, a.currentTime); f.frequency.exponentialRampToValueAtTime(3000, a.currentTime + 0.65);
      var g = a.createGain(); g.gain.value = 0.22; s.connect(f); f.connect(g); g.connect(a.destination); s.start();
    });
  }
  function launchFX() {
    for (var i = 0; i < (LOW ? 12 : 26); i++) particles.push({ x: cX - 10, y: cY + 14, vx: -(Math.random() * 5 + 1), vy: (Math.random() - 0.3) * 3, r: 2 + Math.random() * 3, col: 'rgba(255,200,120,0.9)', a: 1, d: 0.03 });
    shockwaves.push({ x: cX, y: cY, r: 0, maxR: 140, a: 0.5, col: 'rgba(255,255,255,' });
  }
  function drawGauge(W, H) {
    if (gameStatus !== 'IN_FLIGHT') return;
    var x = W - 16, y0 = safeTop + 24, y1 = safeBottom - 50;
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    for (var i = 0; i <= 6; i++) { var yy = y0 + (y1 - y0) * i / 6; ctx.moveTo(x - 4, yy); ctx.lineTo(x, yy); }
    ctx.stroke();
    var f = climbF(dm), my = y1 - (y1 - y0) * f;
    ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.moveTo(x - 4, my); ctx.lineTo(x - 11, my - 5); ctx.lineTo(x - 11, my + 5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 9px Inter,sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('ALT ' + Math.round((dm - 1) * 180).toLocaleString() + ' m', x + 6, y0 - 7); ctx.restore();
  }
  var DEB = { balloon: ['#e11d48', '#fbbf24', '#a16207', '#1d4ed8'], lwango: ['#d97706', '#fcd34d', '#78350f', '#a8a29e'], broom: ['#a16207', '#6d28d9', '#fbbf24', '#4c1d95'] };
  function crashFX(x, y) {
    var cols = DEB[vehicle] || DEB.balloon, i;
    for (i = 0; i < (LOW ? 9 : 16); i++) debris.push({ x: x, y: y, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 8 - 1, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, w: 4 + Math.random() * 7, h: 3 + Math.random() * 5, col: cols[i % 4], a: 1 });
    for (i = 0; i < (LOW ? 6 : 11); i++) smoke.push({ x: x + (Math.random() - 0.5) * 14, y: y, vx: (Math.random() - 0.5) * 1.2, vy: -Math.random() * 1.4 - 0.3, r: 8 + Math.random() * 10, a: 0.55 });
  }
  function chuteFX(x, y) { chutes.push({ x: x, y: y, ph: Math.random() * 6, life: 0, a: 1, col: ['#38bdf8', '#f472b6', '#fbbf24', '#4ade80'][Math.random() * 4 | 0] }); }
  function drawFX(H) {
    smoke = smoke.filter(function (p) {
      p.x += p.vx; p.y += p.vy; p.r += 0.35; p.a -= 0.007; if (p.a <= 0) return false;
      ctx.globalAlpha = p.a; ctx.fillStyle = '#464c5c'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill(); return true;
    });
    debris = debris.filter(function (p) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.rot += p.vr; p.a -= 0.012; if (p.a <= 0 || p.y > H + 20) return false;
      ctx.globalAlpha = p.a; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); return true;
    });
    chutes = chutes.filter(function (c) {
      c.life++; c.ph += 0.05; c.y += c.y < H * 0.78 ? 0.7 : 0; c.x += Math.sin(c.ph) * 0.5 - 0.3;
      if (c.life > 180) c.a -= 0.02; if (c.a <= 0) return false;
      ctx.globalAlpha = c.a; ctx.fillStyle = c.col; ctx.beginPath(); ctx.arc(c.x, c.y, 15, Math.PI, 0); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(c.x - 15, c.y); ctx.lineTo(c.x, c.y + 22); ctx.moveTo(c.x + 15, c.y); ctx.lineTo(c.x, c.y + 22); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y + 22); ctx.stroke();
      ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(c.x, c.y + 25, 3, 0, 6.2832); ctx.fill(); return true;
    });
    ctx.globalAlpha = 1;
  }

  function stepDisp() {
    if (gameStatus === 'IN_FLIGHT') {
      var dt = Math.min((performance.now() - lastTick) / 1000, 0.09);
      var tgt = mult + 0.65 * Math.pow(Math.max(mult, 1), 0.35) * dt;
      dm += (tgt - dm) * 0.35; if (dm < 1) dm = 1;
    } else dm = gameStatus === 'CRASHED' ? mult : 1;
  }

  function newLoop() {
    var real = mult, now = performance.now();
    dtF = Math.min((now - lastF) / 1000, 0.05); lastF = now;
    try {
      var W = canvas.width / dprUsed, H = canvas.height / dprUsed;
      if (W > 2 && cityC) {
        stepDisp(); mult = dm;
        var fl = gameStatus === 'IN_FLIGHT', cr = gameStatus === 'CRASHED';
        spd += ((fl ? speedOf(dm) : cr ? 0 : 40) - spd) * Math.min(1, dtF * (cr ? 14 : fl ? 4 : 2)); sx += spd * dtF;
        var t = fl ? Math.min(dm / 18, 1) : 0;
        if (typeof reached !== 'undefined' && reached.size !== lastReached) { if (reached.size > lastReached) { mtPulse = 0.1; flashA = Math.max(flashA, 0.12); flashCol = '168,85,247'; } lastReached = reached.size; }
        var cdRem = gameStatus === 'BETTING' ? cdTot - (now - cdStart) / 1000 : 99, sec = Math.ceil(cdRem);
        if (cdRem > 0 && sec <= 3 && sec !== lastRev) { lastRev = sec; tone(60 + (4 - sec) * 30, 0.5, 'sawtooth', 0.06); }
        var z = fl ? 1 + 0.045 * Math.min(1, Math.log(dm) / Math.log(30)) : 1, age = (now - launchT) / 1000;
        z += 0.07 * Math.exp(-Math.max(age, 0) * 7) * (age >= 0 && age < 2 ? 1 : 0) + mtPulse * 0.25;
        var jx = 0, jy = 0; if (!LOW && fl && dm >= 8) { var sh = Math.min((dm - 8) * 0.03, 1.2); jx = (Math.random() - 0.5) * 2 * sh; jy = (Math.random() - 0.5) * 2 * sh; }
        updTrail(fl); if (!cr) myUpdate(W, H, fl);
        ctx.clearRect(0, 0, W, H); ctx.save();
        ctx.translate(W / 2 + jx, H * 0.55 + jy); ctx.scale(z, z); ctx.translate(-W / 2, -H * 0.55);
        drawSky2(W, H, t); drawStars2(W, H, fl);
        if (!LOW && t < 0.3) drawRays(W, H, t);
        drawMoon(W, H); drawClouds2(W);
        drawTiled(layers[0], 0.10, H); drawTiled(layers[1], 0.05, H); drawTiled(cityC, 0.30, H);
        drawStreaks(W, H); drawWarp(W, H); drawTrail();
        drawShockwaves(); drawParticles(); drawCoins(); drawFX(H);
        if (!cr) {
          var rx = 0, ry = 0; if (cdRem > 0 && cdRem <= 3) { var k = (3 - cdRem) / 3; rx = (Math.random() - 0.5) * 3 * k; ry = (Math.random() - 0.5) * 3 * k; }
          var tilt = fl ? -(0.04 + 0.14 * climbF(dm)) + Math.sin(now * 0.004) * 0.012 : 0;
          ctx.save(); ctx.translate(cX + rx, cY + ry); ctx.rotate(tilt); ctx.translate(-cX, -cY); drawCraft(W, H); ctx.restore();
        }
        ctx.restore();
        drawVignette(W, H); drawGauge(W, H); drawFlash(W, H);
        flashA = Math.max(0, flashA - dtF * 2.2); crashV = Math.max(0, crashV - dtF * 0.6); mtPulse *= Math.exp(-dtF * 6);
        if (fl) {
          var s = dm.toFixed(2) + 'x'; if (s !== lastTxt) { mt.innerText = s; lastTxt = s; }
          mt.style.transform = 'scale(' + (1 + 0.06 * Math.min(1, Math.log(dm) / Math.log(20)) + mtPulse).toFixed(3) + ')';
        } else { lastTxt = ''; if (mt.style.transform) mt.style.transform = ''; }
        fails = 0;
      }
    } catch (e) {
      if (++fails >= 3) {
        mult = real; try { console.warn('[upgrades] falling back to original renderer', e); } catch (_) {}
        loop = origLoop; resize = origResize; updatePos = origUpdatePos; try { mt.style.transform = ''; } catch (_) {}
        origResize(); window.removeEventListener('resize', newResize); window.addEventListener('resize', origResize); requestAnimationFrame(origLoop); return;
      }
    }
    mult = real;
    requestAnimationFrame(newLoop);
  }

  /* ── notices, history, callouts ─────────────────── */
  function notice(m) {
    var c = $('kbn'); if (!c) return; var d = document.createElement('div'); d.className = 'kbnt'; d.textContent = m; c.appendChild(d);
    while (c.children.length > 3) c.firstChild.remove(); setTimeout(function () { d.remove(); }, 3600);
  }
  window.alert = function (m) { notice(String(m)); };
  function renderHist() {
    var h = $('kbh'); if (!h) return; h.innerHTML = '';
    hist.slice(-10).reverse().forEach(function (v) {
      var s = document.createElement('span'); s.className = 'kbc'; s.textContent = v.toFixed(2) + 'x';
      s.style.color = v >= 5 ? '#6ee7b7' : v >= 2 ? '#fbbf24' : '#fca5a5'; h.appendChild(s);
    });
  }
  function callout(txt, mine) {
    var gv = $('gv'); if (!gv) return; var d = document.createElement('div'); d.className = 'kbfl' + (mine ? ' me' : ''); d.textContent = txt;
    d.style.left = (4 + Math.random() * 50) + '%'; d.style.top = (32 + Math.random() * 20) + '%'; gv.appendChild(d);
    var all = gv.querySelectorAll('.kbfl'); if (all.length > 4) all[0].remove(); setTimeout(function () { d.remove(); }, 2700);
  }

  /* ── sound: mute, wind, nicer cash-out ──────────── */
  var _ac = ac, wind = null;
  ac = function () { var a = _ac(); if (muted && a.state === 'running') a.suspend(); return a; };
  resumeAC = function () { if (muted) return; try { ac().resume(); } catch (e) {} };
  function startWind() {
    if (wind || muted) return;
    safe(function () {
      var a = ac(), len = a.sampleRate * 2, b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var s = a.createBufferSource(); s.buffer = b; s.loop = true;
      var f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.6;
      var g = a.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(a.destination); s.start();
      g.gain.linearRampToValueAtTime(0.02, a.currentTime + 1); wind = { s: s, f: f, g: g };
    });
  }
  function stopWind() {
    var w = wind; wind = null; if (!w) return;
    safe(function () { w.g.gain.setTargetAtTime(0, ac().currentTime, 0.2); setTimeout(function () { try { w.s.stop(); } catch (e) {} }, 800); });
  }
  var _se = startEngine, _re = rampEngine, _xe = stopEngine;
  startEngine = function () { _se(); startWind(); };
  rampEngine = function (m) { _re(m); if (wind) safe(function () { var t = ac().currentTime; wind.f.frequency.setTargetAtTime(Math.min(450 + m * 110, 2400), t, 0.5); wind.g.gain.setTargetAtTime(Math.min(0.015 + m * 0.004, 0.07), t, 0.5); }); };
  stopEngine = function () { _xe(); stopWind(); };
  sfxCashout = function () {
    [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0.28, 'triangle', 0.11, i * 0.07); tone(f * 2, 0.2, 'sine', 0.04, i * 0.07 + 0.02); });
    tone(2093, 0.5, 'sine', 0.05, 0.38);
  };

  /* ── crash feel ─────────────────────────────────── */
  var _ex = explode;
  explode = function (x, y) {
    _ex(x, y); crashFX(x, y);
    if (betState === 'PLACED') { var g = $('gv'); if (g) { g.classList.remove('kbshake'); void g.offsetWidth; g.classList.add('kbshake'); } }
  };

  /* ── socket hooks ───────────────────────────────── */
  var me = 'Pilot-' + String(typeof PLAYER_ID !== 'undefined' ? PLAYER_ID : '').slice(0, 6).toUpperCase();
  var _wire = wire;
  wire = function () {
    _wire(); var s = socket;
    s.on('multiplier_tick', function (d) {
      lastTick = performance.now();
      var a = $('kbauto'), t = a ? parseFloat(a.value) : 0;
      if (betState === 'PLACED' && !autoFired && t >= 1.1 && d.multiplier >= t) { autoFired = true; s.emit('cash_out'); notice('Auto cash-out at ' + t.toFixed(2) + 'x'); }
    });
    s.on('betting_phase_started', function (d) { autoFired = false; cdStart = performance.now(); cdTot = (d && d.countdown) || 7; lastRev = 99; });
    s.on('game_started', function () { launchT = performance.now(); flashA = 0.2; flashCol = '255,255,255'; launchFX(); whoosh(); });
    s.on('bet_confirmed', function () { autoFired = false; });
    s.on('cash_out_success', function () { chuteFX(cX, cY); flashA = 0.22; flashCol = '251,191,36'; mtPulse = 0.08; });
    s.on('game_crashed', function (d) {
      if (betState === 'PLACED') { crashV = 0.42; flashA = 0.4; flashCol = '255,255,255'; } else crashV = 0.16;
      tone(48, 0.7, 'sine', 0.25);
      hist.push(+d.crashedAt); hist = hist.slice(-20); try { localStorage.setItem('kbx_hist', JSON.stringify(hist)); } catch (e) {} renderHist(); });
    s.on('ledger_update', function (d) {
      var txt = typeof d === 'string' ? d : (d && d.message) || '', m = /^(\S+) secured ZK ([\d.,]+) at ([\d.]+)x/.exec(txt);
      if (m) callout((m[1] === me ? 'You' : m[1]) + ' · ' + m[3] + 'x · ZK ' + m[2], m[1] === me);
    });
  };

  /* ── interface ──────────────────────────────────── */
  var CSS = '#gv{height:100vh;height:100dvh}' +
    '.kbq{display:flex;gap:6px;align-items:center;pointer-events:auto}' +
    '.kbq button{flex:0 0 auto;min-width:42px;padding:7px 9px;border-radius:9px;border:1px solid var(--border);background:var(--glass);color:var(--text);font-weight:800;font-size:.78rem;cursor:pointer}' +
    '.kbq button:active{transform:scale(.96)}.kbq button:disabled{opacity:.4}' +
    '.kba{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:.7rem;color:var(--muted);font-weight:700;white-space:nowrap}' +
    '.kba input{width:58px;background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:8px;padding:6px;color:#fff;font-weight:700;font-size:.8rem;outline:none}' +
    '.bco{font-size:1rem!important;padding:15px 20px!important}' +
    '#kbn{position:absolute;top:92px;left:50%;transform:translateX(-50%);z-index:120;display:flex;flex-direction:column;gap:6px;pointer-events:none;width:min(92vw,360px)}' +
    '.kbnt{background:rgba(13,21,37,.96);border:1px solid var(--border2);border-radius:12px;padding:10px 14px;font-size:.82rem;font-weight:600;animation:fadeIn .25s}' +
    '#kbh{position:absolute;top:50px;left:8px;right:46px;z-index:6;display:flex;gap:5px;overflow:hidden;pointer-events:none}' +
    '.kbc{flex:0 0 auto;padding:2px 8px;border-radius:99px;font-size:.66rem;font-weight:800;background:rgba(255,255,255,.07)}' +
    '#kbm{position:absolute;top:46px;right:8px;z-index:7;width:30px;height:30px;border-radius:99px;border:1px solid var(--border);background:var(--glass);color:var(--text);font-size:.85rem;cursor:pointer}' +
    '.kbfl{position:absolute;z-index:5;pointer-events:none;font-size:.74rem;font-weight:800;padding:4px 10px;border-radius:99px;background:rgba(16,185,129,.18);border:1px solid rgba(16,185,129,.35);color:#6ee7b7;animation:kbfloat 2.6s ease-out forwards;white-space:nowrap}' +
    '.kbfl.me{background:rgba(251,191,36,.2);border-color:rgba(251,191,36,.5);color:#fde68a}' +
    '@keyframes kbfloat{0%{opacity:0;transform:translateY(8px)}15%{opacity:1}100%{opacity:0;transform:translateY(-46px)}}' +
    '.kbshake{animation:screenShake .42s}#mt{transform-origin:50% 60%}';

  function ui() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var gv = $('gv'); if (!gv) return;
    ['kbn', 'kbh'].forEach(function (id) { var d = document.createElement('div'); d.id = id; gv.appendChild(d); });
    try { hist = JSON.parse(localStorage.getItem('kbx_hist')) || []; } catch (e) {} renderHist();
    var b = document.createElement('button'); b.id = 'kbm'; b.title = 'Sound on/off'; gv.appendChild(b);
    function setMute(m) {
      muted = m; window.kbMuted = m; b.textContent = m ? '🔇' : '🔊';
      try { localStorage.setItem('kbx_mute', m ? '1' : '0'); } catch (e) {}
      safe(function () { if (m) { if (typeof AC !== 'undefined' && AC) AC.suspend(); stopWind(); } else ac().resume(); });
    }
    b.onclick = function () { setMute(!muted); };
    var m0 = false; try { m0 = localStorage.getItem('kbx_mute') === '1'; } catch (e) {} muted = m0; window.kbMuted = m0; b.textContent = m0 ? '🔇' : '🔊';
    var ir = document.querySelector('.ir'), bi = $('BI'); if (!ir || !bi) return;
    var row = document.createElement('div'); row.className = 'kbq';
    row.innerHTML = '<button data-q="half">½</button><button data-q="dbl">2×</button><button data-q="p10">+10</button>' +
      '<label class="kba">Auto cash-out<input id="kbauto" type="number" min="1.1" step="0.1" placeholder="off" inputmode="decimal">x</label>';
    ir.insertAdjacentElement('afterend', row);
    var au = $('kbauto'); try { au.value = localStorage.getItem('kbx_auto') || ''; } catch (e) {}
    au.oninput = function () { try { localStorage.setItem('kbx_auto', au.value); } catch (e) {} };
    row.addEventListener('click', function (e) {
      var q = e.target.getAttribute && e.target.getAttribute('data-q'); if (!q || bi.disabled) return;
      var v = parseFloat(bi.value) || 10;
      v = q === 'half' ? Math.max(1, Math.floor(v / 2)) : q === 'dbl' ? Math.min(10000, Math.floor(v * 2)) : Math.min(10000, Math.floor(v + 10));
      bi.value = String(v);
    });
  }

  safe(ui);
  resize = newResize; loop = newLoop; updatePos = function () {};
  window.__kbu = { fails: function () { return fails; }, low: LOW, spd: function () { return spd; }, dm: function () { return dm; }, cx: function () { return cX; }, sx: function () { return sx; } };
})();
