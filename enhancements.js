/* enhancements.js — additive Demo-mode extras: ranks, achievements, daily challenges, effects.
   Self-contained. Does not modify the game. Any failure is swallowed so the page keeps working. */
(function () {
  'use strict';
  var KEY = 'kbx_v1';
  var RANKS = [['Cadet', 0], ['Pilot', 100], ['Captain', 300], ['Ace', 700], ['Legend', 1500]];
  var ACH = {
    first_flight: ['First Flight', 'Place your first bet'],
    first_cashout: ['Safe Landing', 'Cash out for the first time'],
    sky_high: ['Sky High', 'Cash out at 5x or more'],
    moonshot: ['Moonshot', 'Cash out at 10x or more'],
    hot_streak: ['Hot Streak', 'Cash out 3 rounds in a row'],
    regular: ['Regular', 'Play 10 rounds'],
    veteran: ['Veteran', 'Play 50 rounds']
  };
  var CHALL = [
    { id: 'rounds5', text: 'Play 5 rounds', goal: 5, xp: 40 },
    { id: 'cash3', text: 'Cash out 3 times', goal: 3, xp: 50 },
    { id: 'x2', text: 'Cash out at 2x or more', goal: 1, xp: 30 }
  ];

  function today() { return new Date().toISOString().slice(0, 10); }
  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && typeof s === 'object') return s; } catch (e) {}
    return null;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  var S = load() || { xp: 0, rounds: 0, cashouts: 0, best: 0, run: 0, ach: {}, day: today(), prog: {}, done: {}, streak: 0, last: '' };
  var inRound = false, cashed = false, started = Date.now(), REAL = false;

  function rankOf(xp) {
    var i = 0; for (var k = 0; k < RANKS.length; k++) if (xp >= RANKS[k][1]) i = k;
    var next = RANKS[i + 1];
    return { name: RANKS[i][0], from: RANKS[i][1], to: next ? next[1] : null };
  }

  /* ── UI ─────────────────────────────────────────── */
  var root, bar, rankEl, xpEl, chEl, achEl, stEl, open = false;
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '#kbx{position:fixed;left:10px;top:84px;display:flex;flex-direction:column-reverse;z-index:9990;font:13px system-ui,sans-serif;color:#e8f1ff}' +
      '#kbx-b{background:rgba(10,20,40,.92);border:1px solid #2a4a7a;border-radius:20px;padding:7px 12px;cursor:pointer;display:flex;gap:8px;align-items:center}' +
      '#kbx-p{display:none;margin-top:8px;width:250px;max-height:60vh;overflow:auto;background:rgba(10,20,40,.96);border:1px solid #2a4a7a;border-radius:12px;padding:12px}' +
      '#kbx-p h4{margin:10px 0 4px;font-size:12px;letter-spacing:.06em;color:#7fb2ff;text-transform:uppercase}' +
      '#kbx-p h4:first-child{margin-top:0}' +
      '.kbx-bar{height:6px;background:#1b2c4a;border-radius:4px;overflow:hidden;margin:4px 0}' +
      '.kbx-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#22d3ee,#3b82f6);transition:width .5s}' +
      '.kbx-r{display:flex;justify-content:space-between;gap:6px;margin:2px 0}' +
      '.kbx-d{opacity:.45}.kbx-ok{color:#4ade80}' +
      '#kbx-t{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none}' +
      '.kbx-toast{background:#0b1a33;border:1px solid #3b82f6;color:#fff;padding:9px 14px;border-radius:10px;font:13px system-ui,sans-serif;animation:kbxin .3s ease-out;box-shadow:0 6px 20px rgba(0,0,0,.4)}' +
      '@keyframes kbxin{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }
  function build() {
    css();
    var t = document.createElement('div'); t.id = 'kbx-t'; document.body.appendChild(t);
    root = document.createElement('div'); root.id = 'kbx';
    root.innerHTML = '<div id="kbx-p"></div><div id="kbx-b"><span id="kbx-rk"></span><span id="kbx-xp"></span></div>';
    document.body.appendChild(root);
    rankEl = root.querySelector('#kbx-rk'); xpEl = root.querySelector('#kbx-xp');
    root.querySelector('#kbx-b').onclick = function () { open = !open; root.querySelector('#kbx-p').style.display = open ? 'block' : 'none'; render(); };
  }
  function toast(msg) {
    try {
      var c = document.getElementById('kbx-t'), d = document.createElement('div');
      d.className = 'kbx-toast'; d.textContent = msg; c.appendChild(d);
      setTimeout(function () { d.remove(); }, 3500);
    } catch (e) {}
  }
  function render() {
    var r = rankOf(S.xp);
    if (rankEl) rankEl.textContent = '🎖 ' + r.name;
    if (xpEl) xpEl.textContent = S.xp + ' XP';
    if (!open) return;
    var pct = r.to ? Math.min(100, Math.round((S.xp - r.from) / (r.to - r.from) * 100)) : 100;
    var h = '<h4>Rank</h4><div>' + r.name + (r.to ? ' · ' + (r.to - S.xp) + ' XP to next' : ' · max rank') + '</div><div class="kbx-bar"><i style="width:' + pct + '%"></i></div>';
    h += '<h4>Daily challenges</h4>';
    CHALL.forEach(function (c) {
      var p = Math.min(S.prog[c.id] || 0, c.goal), d = S.done[c.id];
      h += '<div class="kbx-r ' + (d ? 'kbx-ok' : '') + '"><span>' + c.text + '</span><span>' + (d ? '✓' : p + '/' + c.goal) + '</span></div>';
    });
    h += '<h4>Achievements</h4>';
    Object.keys(ACH).forEach(function (k) {
      var on = S.ach[k];
      h += '<div class="kbx-r ' + (on ? 'kbx-ok' : 'kbx-d') + '"><span>' + ACH[k][0] + '</span><span>' + (on ? '✓' : '') + '</span></div>';
    });
    if (REAL) h += rgHtml();
    var mins = Math.floor((Date.now() - started) / 60000);
    h += '<h4>Stats</h4><div class="kbx-r"><span>Rounds</span><span>' + S.rounds + '</span></div>' +
      '<div class="kbx-r"><span>Cash-outs</span><span>' + S.cashouts + '</span></div>' +
      '<div class="kbx-r"><span>Best multiplier</span><span>' + (S.best ? S.best.toFixed(2) + 'x' : '-') + '</span></div>' +
      '<div class="kbx-r"><span>Day streak</span><span>' + S.streak + '</span></div>' +
      '<div class="kbx-r"><span>This session</span><span>' + mins + ' min</span></div>';
    root.querySelector('#kbx-p').innerHTML = h;
  }

  /* ── effects ────────────────────────────────────── */
  var AC; function tone(freqs, dur) {
    if (REAL || window.kbMuted) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var t = AC.currentTime;
      freqs.forEach(function (f, i) {
        var o = AC.createOscillator(), g = AC.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(AC.destination);
        g.gain.setValueAtTime(0.0001, t + i * dur); g.gain.exponentialRampToValueAtTime(0.12, t + i * dur + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * dur + dur);
        o.start(t + i * dur); o.stop(t + i * dur + dur + 0.02);
      });
    } catch (e) {}
  }
  function confetti(n) {
    if (REAL) return;
    try {
      var cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight;
      cv.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none';
      document.body.appendChild(cv);
      var x = cv.getContext('2d'), P = [], cols = ['#22d3ee', '#3b82f6', '#facc15', '#4ade80', '#f472b6'];
      for (var i = 0; i < n; i++) P.push({ x: innerWidth / 2, y: innerHeight * 0.6, vx: (Math.random() - .5) * 12, vy: -Math.random() * 12 - 3, c: cols[i % 5], s: 4 + Math.random() * 4 });
      var f = 0;
      (function step() {
        x.clearRect(0, 0, cv.width, cv.height);
        P.forEach(function (p) { p.x += p.vx; p.y += p.vy; p.vy += 0.35; x.fillStyle = p.c; x.fillRect(p.x, p.y, p.s, p.s); });
        if (++f < 80) requestAnimationFrame(step); else cv.remove();
      })();
    } catch (e) {}
  }


  /* ── responsible play (Real Money mode) ─────────── */
  var RGK = 'kbx_rg';
  var R = (function () {
    var d = { day: today(), bets: 0, pay: 0, mins: 0, limLoss: 0, limMins: 0, cool: 0 };
    try { var x = JSON.parse(localStorage.getItem(RGK)); if (x && typeof x === 'object') for (var k in x) d[k] = x[k]; } catch (e) {}
    if (d.day !== today()) { d.day = today(); d.bets = 0; d.pay = 0; d.mins = 0; }
    return d;
  })();
  function saveR() { try { localStorage.setItem(RGK, JSON.stringify(R)); } catch (e) {} }
  function blocked() {
    if (R.cool > Date.now()) return 'Break active until ' + new Date(R.cool).toLocaleTimeString() + '. Betting is paused.';
    if (R.limMins && R.mins >= R.limMins) return 'Your daily time limit is reached. Betting is paused until tomorrow.';
    if (R.limLoss && (R.bets - R.pay) >= R.limLoss) return 'Your daily loss limit is reached. Betting is paused until tomorrow.';
    return '';
  }
  function rgHtml() {
    var net = R.pay - R.bets;
    return '<h4>Responsible play</h4>' +
      '<div class="kbx-r"><span>Today</span><span>' + R.mins + ' min</span></div>' +
      '<div class="kbx-r"><span>Net result today</span><span>' + (net >= 0 ? '+' : '-') + 'ZK ' + Math.abs(net).toFixed(2) + '</span></div>' +
      '<div class="kbx-r"><span>Loss limit</span><span>' + (R.limLoss ? 'ZK ' + R.limLoss : 'none') + '</span></div>' +
      '<div class="kbx-r"><span>Time limit</span><span>' + (R.limMins ? R.limMins + ' min' : 'none') + '</span></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px"><button data-kbx="lim" style="flex:1">Set limits</button><button data-kbx="brk" style="flex:1">Take a break</button></div>' +
      '<div style="opacity:.6;margin-top:6px;font-size:11px">18+ only. Play only with money you can afford to lose.</div>';
  }
  function rgActions(e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute('data-kbx');
    if (a === 'lim') {
      var l = prompt('Daily loss limit in ZK (0 = none). Lowering is instant; raising is allowed.', R.limLoss || 0);
      if (l === null) return; var m = prompt('Daily time limit in minutes (0 = none)', R.limMins || 0); if (m === null) return;
      R.limLoss = Math.max(0, parseFloat(l) || 0); R.limMins = Math.max(0, parseInt(m, 10) || 0); saveR(); toast('Limits saved'); render();
    } else if (a === 'brk') {
      if (confirm('Pause betting for 24 hours?')) { R.cool = Date.now() + 864e5; saveR(); toast('Break started. Betting is paused for 24 hours.'); render(); }
    }
  }
  function rgHook(sock) {
    var pend = 0, orig = sock.emit;
    sock.emit = function (ev, data) {
      if (ev === 'place_bet') {
        var m = blocked(); if (m) { toast(m); return sock; }
        pend = parseFloat(data && data.amount) || 0;
      }
      return orig.apply(sock, arguments);
    };
    sock.on('bet_confirmed', function () { R.bets += pend; pend = 0; saveR(); render(); });
    sock.on('cash_out_success', function (d) { R.pay += +d.payout || 0; saveR(); render(); });
    root.addEventListener('click', rgActions);
    setInterval(function () {
      R.mins++; saveR();
      if (R.mins % 30 === 0) toast('You have played ' + R.mins + ' min today. Net: ' + (R.pay - R.bets >= 0 ? '+' : '-') + 'ZK ' + Math.abs(R.pay - R.bets).toFixed(2));
      render();
    }, 60000);
  }

  /* ── progression ────────────────────────────────── */
  function addXp(n) {
    var before = rankOf(S.xp).name; S.xp += n; var after = rankOf(S.xp).name;
    if (after !== before) { toast('🎖 Rank up: ' + after + '!'); tone([523, 659, 784, 1047], 0.12); confetti(60); }
  }
  function unlock(k) {
    if (S.ach[k]) return; S.ach[k] = 1; toast('🏆 ' + ACH[k][0] + ' — ' + ACH[k][1]); tone([660, 880], 0.1); addXp(25);
  }
  function bump(id, by) {
    var c = CHALL.filter(function (x) { return x.id === id; })[0]; if (!c || S.done[id]) return;
    S.prog[id] = (S.prog[id] || 0) + by;
    if (S.prog[id] >= c.goal) { S.done[id] = 1; toast('✅ Challenge done: ' + c.text + ' (+' + c.xp + ' XP)'); addXp(c.xp); }
  }
  function newDay() {
    var t = today();
    if (S.day !== t) { S.day = t; S.prog = {}; S.done = {}; }
    if (S.last !== t) {
      var y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      S.streak = (S.last === y) ? S.streak + 1 : 1; S.last = t;
      if (S.streak > 1) toast('🔥 ' + S.streak + '-day streak');
    }
  }

  function hook(sock) {
    sock.on('bet_confirmed', function () {
      try {
        inRound = true; cashed = false; S.rounds++; addXp(10);
        unlock('first_flight'); if (S.rounds >= 10) unlock('regular'); if (S.rounds >= 50) unlock('veteran');
        bump('rounds5', 1); save(); render();
      } catch (e) {}
    });
    sock.on('cash_out_success', function (d) {
      try {
        var m = +d.atMultiplier || 0; cashed = true; S.cashouts++; S.run++; if (m > S.best) S.best = m;
        addXp(20 + Math.floor(m * 10)); unlock('first_cashout');
        if (m >= 5) unlock('sky_high'); if (m >= 10) unlock('moonshot'); if (S.run >= 3) unlock('hot_streak');
        bump('cash3', 1); if (m >= 2) bump('x2', 1);
        if (m >= 3) confetti(Math.min(120, 30 + Math.floor(m * 10)));
        tone([784, 988, 1175], 0.09); save(); render();
      } catch (e) {}
    });
    sock.on('game_crashed', function () {
      try { if (inRound && !cashed) S.run = 0; inRound = false; save(); render(); } catch (e) {}
    });
  }

  function init() {
    try { REAL = !IS_DEMO; newDay(); build(); if (REAL) rgHook(socket); render(); hook(socket); save(); } catch (e) { try { console.warn('[kbx] disabled', e); } catch (_) {} }
  }
  /* wait for the page's globals; run only in Demo mode */
  var tries = 0, iv = setInterval(function () {
    try {
      if (typeof IS_DEMO !== 'undefined' && typeof socket !== 'undefined' && socket && socket.on) { clearInterval(iv); init(); return; }
    } catch (e) {}
    if (++tries > 100) clearInterval(iv);
  }, 200);
})();
