/* engage.js — Bet B (optional second bet, both modes) + Hourly Cup (Demo / play-money only).
   Additive: reads the page's globals and never edits the game. Any failure is swallowed so the
   page keeps working. ES5 on purpose (older Android WebViews). */
(function () {
  'use strict';

  function safe(fn) { try { fn(); } catch (e) { try { console.warn('[engage]', e); } catch (_) {} } }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function money(n) { return (n >= 0 ? '+' : '-') + 'ZK ' + Math.abs(n).toFixed(0); }
  function mmss(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function plog(t) { try { if (typeof log === 'function') log(t); } catch (e) {} }

  /* ── styles ─────────────────────────────────────── */
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.kb2tog{align-self:flex-start;background:none;border:none;color:var(--cyan,#00e5ff);font-weight:800;font-size:.74rem;cursor:pointer;padding:2px 0;pointer-events:auto}' +
      '.kb2row{display:none}.kb2row.show{display:flex}' +
      '#kbe-cup{position:fixed;right:10px;top:84px;z-index:9980;display:flex;flex-direction:column;align-items:flex-end;font:13px system-ui,sans-serif;color:#e8f1ff}' +
      '#kbe-pill{background:rgba(10,20,40,.92);border:1px solid #2a4a7a;border-radius:20px;padding:7px 12px;cursor:pointer;white-space:nowrap}' +
      '#kbe-pan{display:none;margin-top:8px;width:244px;max-height:60vh;overflow:auto;background:rgba(10,20,40,.96);border:1px solid #2a4a7a;border-radius:12px;padding:12px}' +
      '#kbe-pan h4{margin:0 0 4px;font-size:13px}' +
      '#kbe-pan .kbe-s{font-size:11px;opacity:.65;line-height:1.45;margin-bottom:8px}' +
      '#kbe-pan .kbe-r{display:flex;justify-content:space-between;gap:8px;margin:3px 0}' +
      '#kbe-pan .kbe-me{color:#4ade80;font-weight:700}' +
      '#kbe-pan .kbe-hr{height:1px;background:#1b2c4a;margin:8px 0}' +
      '#kbe-t{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none;width:max-content;max-width:92vw}' +
      '.kbe-toast{background:#0b1a33;border:1px solid #3b82f6;color:#fff;padding:9px 14px;border-radius:10px;font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);text-align:center}';
    document.head.appendChild(s);
  }
  function toast(msg) {
    safe(function () {
      var c = document.getElementById('kbe-t');
      if (!c) { c = el('div'); c.id = 'kbe-t'; document.body.appendChild(c); }
      var d = el('div', 'kbe-toast', msg); c.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 5200);
    });
  }

  /* ═════════════ BET B ═════════════ */
  var bState = 'NONE';          // NONE | PLACED | CASHED | LOST
  var bAmt = 0, bPend = 0, bBusy = false, bBusyT = null;
  var bTog, bRow, bBtn, bInp;

  function setBusy(v) {
    bBusy = v;
    if (bBusyT) { clearTimeout(bBusyT); bBusyT = null; }
    if (v) bBusyT = setTimeout(function () { bBusy = false; refreshB(); }, 3000);
  }
  function openB(v) {
    if (!bRow) return;
    if (!v && bState === 'PLACED') return;                 // cannot hide while a bet is live
    bRow.classList.toggle('show', v);
    bTog.textContent = v ? '\u2212 Hide 2nd bet' : '\uFF0B Add 2nd bet';
  }
  function refreshB() {
    if (!bBtn) return;
    var st = gameStatus, cls = 'ab bdis', txt = 'BET B', dis = true;
    if (bState === 'PLACED') {
      if (st === 'IN_FLIGHT') { cls = 'ab bco'; txt = 'CASH OUT B (ZK ' + (bAmt * mult).toFixed(2) + ')'; dis = false; }
      else if (st === 'BETTING') { txt = 'B SECURED'; }
      else { txt = 'B LOST'; }
    } else if (bState === 'CASHED') { txt = 'B SECURED'; }
    else if (bState === 'LOST') { txt = 'B LOST'; }
    else if (st === 'BETTING') { cls = 'ab bbet'; txt = 'BET B'; dis = false; }
    else if (st === 'IN_FLIGHT') { txt = 'IN FLIGHT'; }
    else if (st === 'CRASHED') { txt = 'ROUND OVER'; }
    else { txt = 'CONNECTING\u2026'; }
    if (bBusy) { cls = 'ab bdis'; dis = true; txt = '\u2026'; }
    bBtn.className = cls; bBtn.textContent = txt; bBtn.disabled = dis;
    bInp.disabled = (bState === 'PLACED' || bBusy);
  }
  function buildB() {
    var bip = document.querySelector('.bip'); if (!bip) return;
    bTog = el('button', 'kb2tog', '\uFF0B Add 2nd bet'); bTog.type = 'button';
    bRow = el('div', 'ir kb2row');
    bRow.innerHTML = '<div class="aiw"><span>ZK</span><input type="number" id="kb2amt" class="bif" value="10" min="1" max="10000" step="1"></div>' +
                     '<button type="button" id="kb2btn" class="ab bdis">BET B</button>';
    bip.appendChild(bTog); bip.appendChild(bRow);
    bInp = bRow.querySelector('#kb2amt'); bBtn = bRow.querySelector('#kb2btn');
    bTog.onclick = function () { openB(!bRow.classList.contains('show')); };
    bBtn.onclick = function () {
      safe(function () { if (typeof resumeAC === 'function') resumeAC(); });
      if (bBusy) return;
      if (gameStatus === 'BETTING' && bState === 'NONE') {
        var amt = parseInt(bInp.value, 10);
        if (!(amt >= 1)) { toast('Enter a valid amount for bet B'); return; }
        if (amt > walletBalance) {
          if (IS_DEMO) socket.emit('demo_refill');
          else if (typeof openWallet === 'function') openWallet('deposit');
          return;
        }
        bPend = amt; setBusy(true); refreshB();
        socket.emit('place_bet_b', { amount: amt, vehicle: typeof vehicle !== 'undefined' ? vehicle : 'balloon' });
      } else if (gameStatus === 'IN_FLIGHT' && bState === 'PLACED') {
        setBusy(true); refreshB();
        socket.emit('cash_out_b');
      }
    };
  }
  function hookB(s) {
    s.on('betting_phase_started', function () { bState = 'NONE'; setBusy(false); refreshB(); });
    s.on('game_started', function () { refreshB(); });
    s.on('multiplier_tick', function () { if (bState === 'PLACED') refreshB(); });
    s.on('game_crashed', function () {
      if (bState === 'PLACED') { bState = 'LOST'; plog('Bet B lost'); }
      setBusy(false); refreshB();
    });
    s.on('bet_b_confirmed', function (d) {
      bState = 'PLACED'; bAmt = bPend; setBusy(false);
      safe(function () { if (typeof setBalance === 'function') setBalance(d.newBalance); });
      safe(function () { if (typeof sfxBet === 'function') sfxBet(); });
      plog('Bet B placed: ZK ' + bAmt.toFixed(2));
      openB(true); refreshB();
    });
    s.on('cash_out_b_success', function (d) {
      bState = 'CASHED'; setBusy(false);
      safe(function () { if (typeof setBalance === 'function') setBalance(d.newBalance); });
      safe(function () { if (typeof sfxCashout === 'function') sfxCashout(); });
      safe(function () { if (typeof coinBurst === 'function') coinBurst(cX, cY, d.payout); });
      toast('Bet B secured: +ZK ' + Number(d.payout).toFixed(2) + ' at ' + Number(d.atMultiplier).toFixed(2) + 'x');
      plog('Bet B secured at ' + Number(d.atMultiplier).toFixed(2) + 'x: ZK ' + Number(d.payout).toFixed(2));
      refreshB();
    });
    s.on('error_message', function () { setBusy(false); refreshB(); });
    s.on('disconnect', function () { setBusy(false); refreshB(); });
    s.on('connect_error', function () { setBusy(false); refreshB(); });
  }

  /* ═════════════ HOURLY CUP (demo only) ═════════════ */
  var cup = { endAt: 0, you: null, top: [], last: null, minRounds: 5, entrants: 0 };
  var cupOpen = false, pillEl, panEl;
  var BESTK = 'kbe_best';

  function bestFinish() { try { var b = parseInt(localStorage.getItem(BESTK), 10); return b > 0 ? b : null; } catch (e) { return null; } }

  function renderCup() {
    if (!pillEl) return;
    var left = cup.endAt ? cup.endAt - Date.now() : 0;
    if (!cup.you) { pillEl.textContent = '\uD83C\uDFC6 Hourly Cup'; }
    else if (cup.you.rank) { pillEl.textContent = '\uD83C\uDFC6 #' + cup.you.rank + ' \u00B7 ' + mmss(left); }
    else { pillEl.textContent = '\uD83C\uDFC6 Cup \u00B7 ' + mmss(left); }
    if (!cupOpen) return;
    panEl.textContent = '';
    panEl.appendChild(el('h4', null, '\uD83C\uDFC6 Hourly Cup'));
    panEl.appendChild(el('div', 'kbe-s', 'Play-money ranking. Most net profit this hour wins. Place at least ' + cup.minRounds + ' bets to qualify. Ranking only, no prizes.'));
    panEl.appendChild(el('div', 'kbe-r', 'Ends in ' + mmss(left)));
    panEl.appendChild(el('div', 'kbe-hr'));
    if (!cup.top.length) panEl.appendChild(el('div', 'kbe-s', 'No qualified players yet. Be the first!'));
    cup.top.forEach(function (e, i) {
      var me = cup.you && e.name === cup.you.name;
      var r = el('div', 'kbe-r' + (me ? ' kbe-me' : ''));
      r.appendChild(el('span', null, '#' + (i + 1) + ' ' + e.name + (me ? ' (you)' : '')));
      r.appendChild(el('span', null, money(e.net)));
      panEl.appendChild(r);
    });
    panEl.appendChild(el('div', 'kbe-hr'));
    if (cup.you) {
      if (cup.you.rank) {
        var inTop = cup.top.some(function (e) { return e.name === cup.you.name; });
        if (!inTop) panEl.appendChild(el('div', 'kbe-r kbe-me', 'You: #' + cup.you.rank + ' of ' + cup.entrants + '  ' + money(cup.you.net)));
      } else {
        var need = Math.max(0, cup.minRounds - cup.you.rounds);
        panEl.appendChild(el('div', 'kbe-s', need > 0 ? ('Place ' + need + ' more bet' + (need === 1 ? '' : 's') + ' to qualify.') : 'Not ranked yet.'));
      }
    }
    if (cup.last) panEl.appendChild(el('div', 'kbe-s', 'Last champion: ' + cup.last.name + ' (' + money(cup.last.net) + ')'));
    var b = bestFinish(); if (b) panEl.appendChild(el('div', 'kbe-s', 'Your best finish: #' + b));
  }
  function buildCup() {
    var root = el('div'); root.id = 'kbe-cup';
    pillEl = el('div'); pillEl.id = 'kbe-pill';
    panEl = el('div'); panEl.id = 'kbe-pan';
    root.appendChild(pillEl); root.appendChild(panEl);
    document.body.appendChild(root);
    pillEl.onclick = function () { cupOpen = !cupOpen; panEl.style.display = cupOpen ? 'block' : 'none'; renderCup(); };
    setInterval(function () { safe(renderCup); }, 1000);
    renderCup();
  }
  function hookCup(s) {
    s.on('tournament_update', function (d) {
      safe(function () {
        cup.endAt = Date.now() + (d.msLeft || 0);
        cup.you = d.you || null; cup.top = d.top || []; cup.last = d.last || null;
        cup.minRounds = d.minRounds || 5; cup.entrants = d.entrants || 0;
        renderCup();
      });
    });
    s.on('tournament_result', function (d) {
      safe(function () {
        var msg;
        if (d.rank) {
          msg = '\uD83C\uDFC6 Hourly Cup finished! You placed #' + d.rank + ' of ' + d.of + ' (' + money(d.net) + ').';
          try { var b = bestFinish(); if (!b || d.rank < b) localStorage.setItem(BESTK, String(d.rank)); } catch (e) {}
        } else {
          msg = '\uD83C\uDFC6 Hourly Cup finished. You placed ' + d.rounds + ' bet' + (d.rounds === 1 ? '' : 's') + ' \u2014 ' + d.minRounds + ' needed to qualify.';
        }
        if (d.champion) msg += ' Champion: ' + d.champion.name + ' (' + money(d.champion.net) + ').';
        toast(msg);
      });
    });
    function ask() { try { s.emit('tournament_get'); } catch (e) {} }
    s.on('connect', ask);
    if (s.connected) ask();
  }

  /* ── start once the page's globals exist ───────── */
  function init() {
    safe(css);
    safe(buildB);
    if (IS_DEMO) safe(buildCup);
    safe(function () { hookB(socket); });
    if (IS_DEMO) safe(function () { hookCup(socket); });
    safe(refreshB);
  }
  var tries = 0, iv = setInterval(function () {
    try {
      if (typeof IS_DEMO !== 'undefined' && typeof socket !== 'undefined' && socket && socket.on && document.querySelector('.bip')) {
        clearInterval(iv); init(); return;
      }
    } catch (e) {}
    if (++tries > 150) clearInterval(iv);
  }, 200);
})();
