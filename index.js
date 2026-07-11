/**
 * Vyeta Kwacha Balloon Adventures
 * Complete Game + Payment Server
 * 
 * SETUP (run once):
 *   npm install express http socket.io cors axios uuid
 * 
 * ENV VARS — set these in Render dashboard, never hardcode:
 *   LENCO_SECRET_KEY   = 993bed87f9d592566a6cce2cefd79363d1b7e95af3e1e6642b294ce5fc8c59f6  (sandbox)
 *   LENCO_ACCOUNT_ID   = <your 36-char Lenco account UUID — get from GET /accounts>
 *   LENCO_SANDBOX      = true   (set to false when going live)
 *   WEBHOOK_SECRET     = kba-vyeta-2025   (set same string in Lenco dashboard → Webhooks)
 *   PORT               = 3000
 */

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const axios    = require('axios');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ─── Lenco Config ────────────────────────────────────────────────────────────
const LENCO_KEY        = process.env.LENCO_SECRET_KEY;
const LENCO_ACCOUNT_ID = process.env.LENCO_ACCOUNT_ID; // your account UUID for withdrawals
const IS_SANDBOX       = process.env.LENCO_SANDBOX !== 'false';
const LENCO_BASE       = IS_SANDBOX
    ? 'https://sandbox.lenco.co/access/v2'
    : 'https://api.lenco.co/access/v2';

async function lenco(method, path, body = null) {
    try {
        const res = await axios({
            method,
            url: `${LENCO_BASE}${path}`,
            headers: {
                'Authorization': LENCO_KEY,   // Lenco uses raw key, not Bearer
                'Content-Type':  'application/json'
            },
            data: body || undefined,
            timeout: 15000
        });
        return { ok: true, data: res.data };
    } catch (err) {
        const msg = err.response?.data?.message || err.message || 'Lenco API error';
        console.error(`[Lenco] ${method} ${path} →`, msg);
        return { ok: false, error: msg, raw: err.response?.data };
    }
}

// ─── Player Store ─────────────────────────────────────────────────────────────
// In-memory for now. Replace Map with DB calls (Supabase/Postgres) when scaling.
const players       = new Map(); // playerId → { balance, transactions, pendingDeposits }
const activeRoundBets = new Map(); // playerId → { amount, vehicle, callsign }

function getPlayer(id) {
    if (!players.has(id)) {
        players.set(id, {
            balance: 0,          // real money — starts at 0, grows via deposits
            transactions: [],
            pendingDeposits: {}  // tx_ref → { amount, phone, operator, credited }
        });
    }
    return players.get(id);
}

function fmt(n) {
    return Math.round(parseFloat(n) * 100) / 100;
}

// ─── Game State ───────────────────────────────────────────────────────────────
let gameStatus        = 'BETTING';
let currentMultiplier = 1.00;
let lifecycleInterval = null;
let crashPoint        = 1.00;

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    res.json({
        status:        'online',
        mode:          IS_SANDBOX ? 'SANDBOX' : 'LIVE',
        activePlayers: players.size,
        gameStage:     gameStatus,
        lenco_key_set: !!LENCO_KEY,
        account_set:   !!LENCO_ACCOUNT_ID
    });
});

// ── GET /api/balance ──────────────────────────────────────────────────────────
app.get('/api/balance', (req, res) => {
    const { player_id } = req.query;
    if (!player_id) return res.status(400).json({ error: 'player_id required' });
    res.json({ balance: getPlayer(player_id).balance });
});

// ── GET /api/transactions ─────────────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
    const { player_id, limit = 20 } = req.query;
    if (!player_id) return res.status(400).json({ error: 'player_id required' });
    const p = getPlayer(player_id);
    res.json({ transactions: p.transactions.slice(0, parseInt(limit)) });
});

// ── POST /api/deposit ─────────────────────────────────────────────────────────
// Initiates a Lenco mobile money collection (STK push to player's phone)
app.post('/api/deposit', async (req, res) => {
    const { player_id, amount, phone, operator } = req.body;

    // Validate
    if (!player_id || !amount || !phone || !operator) {
        return res.status(400).json({ error: 'player_id, amount, phone, operator are required' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 10 || amt > 10000) {
        return res.status(400).json({ error: 'Amount must be between ZK 10 and ZK 10,000' });
    }
    const validOperators = ['airtel', 'mtn', 'zamtel'];
    if (!validOperators.includes(operator.toLowerCase())) {
        return res.status(400).json({ error: 'operator must be airtel, mtn, or zamtel' });
    }

    const tx_ref = `KBA-DEP-${uuidv4()}`;
    const cleanPhone = phone.replace(/[\s\+\-]/g, '');

    // Call Lenco — POST /collections/mobile-money
    const result = await lenco('POST', '/collections/mobile-money', {
        reference: tx_ref,
        amount:    amt,
        phone:     cleanPhone,
        operator:  operator.toLowerCase(),
        country:   'zm',
        bearer:    'merchant'   // we absorb the fee
    });

    if (!result.ok) {
        return res.status(502).json({ error: 'Payment provider error', message: result.error });
    }

    // Store pending so we can credit on webhook / poll
    const p = getPlayer(player_id);
    p.pendingDeposits[tx_ref] = {
        amount:   amt,
        phone:    cleanPhone,
        operator: operator.toLowerCase(),
        credited: false,
        createdAt: new Date().toISOString()
    };

    console.log(`[Deposit] Player ${player_id.slice(0,8)} | ZK${amt} | ${operator} | ref:${tx_ref}`);

    res.json({
        status:  'pending',
        tx_ref,
        message: 'Payment prompt sent. Ask customer to approve on their phone.',
        data:    result.data?.data || result.data
    });
});

// ── GET /api/verify-payment ───────────────────────────────────────────────────
// Frontend polls this every 5 seconds after initiating deposit
app.get('/api/verify-payment', async (req, res) => {
    const { tx_ref, player_id } = req.query;
    if (!tx_ref || !player_id) {
        return res.status(400).json({ error: 'tx_ref and player_id required' });
    }

    // Ask Lenco for current status — GET /collections/status/:reference
    const result = await lenco('GET', `/collections/status/${tx_ref}`);
    if (!result.ok) {
        return res.status(502).json({ error: 'Could not verify', status: 'unknown' });
    }

    const txData   = result.data?.data || result.data;
    const txStatus = (txData?.status || '').toLowerCase();

    // Credit player if successful and not already done
    if (txStatus === 'successful') {
        const p       = getPlayer(player_id);
        const pending = p.pendingDeposits[tx_ref];
        if (pending && !pending.credited) {
            pending.credited = true;
            const creditAmt  = fmt(pending.amount);
            p.balance        = fmt(p.balance + creditAmt);
            p.transactions.unshift({
                id:          tx_ref,
                type:        'deposit',
                amount:      creditAmt,
                operator:    pending.operator,
                phone:       pending.phone,
                status:      'completed',
                createdAt:   pending.createdAt,
                completedAt: new Date().toISOString()
            });
            console.log(`[Deposit ✅] Player ${player_id.slice(0,8)} credited ZK${creditAmt}`);

            // Push live balance update to any connected socket for this player
            io.sockets.sockets.forEach(s => {
                if (s.userId === player_id) {
                    s.emit('balance_update', { balance: p.balance });
                }
            });
        }
        return res.json({ status: 'successful', amount: pending?.amount, newBalance: getPlayer(player_id).balance });
    }

    res.json({ status: txStatus || 'pending', data: txData });
});

// ── POST /api/withdraw ────────────────────────────────────────────────────────
// Sends winnings to player's mobile money via Lenco transfer
app.post('/api/withdraw', async (req, res) => {
    const { player_id, amount, phone, operator } = req.body;

    if (!player_id || !amount || !phone || !operator) {
        return res.status(400).json({ error: 'player_id, amount, phone, operator are required' });
    }
    if (!LENCO_ACCOUNT_ID) {
        return res.status(500).json({ error: 'LENCO_ACCOUNT_ID env var not set on server' });
    }

    const amt = parseFloat(amount);
    const FEE = 3; // ZK 3 flat fee covers Lenco transfer cost
    const total = fmt(amt + FEE);

    const p = getPlayer(player_id);
    if (total > p.balance) {
        return res.status(400).json({
            error: `Insufficient balance. Need ZK ${total} (ZK${amt} + ZK${FEE} fee), have ZK ${p.balance}`
        });
    }
    if (amt < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal is ZK 10' });
    }

    // Deduct from balance immediately (prevent double-spend)
    p.balance = fmt(p.balance - total);

    const tx_ref     = `KBA-WD-${uuidv4()}`;
    const cleanPhone = phone.replace(/[\s\+\-]/g, '');

    // Call Lenco — POST /transfers/mobile-money
    const result = await lenco('POST', '/transfers/mobile-money', {
        accountId:  LENCO_ACCOUNT_ID,
        reference:  tx_ref,
        amount:     amt,
        phone:      cleanPhone,
        operator:   operator.toLowerCase(),
        country:    'zm',
        narration:  `Kwacha Balloon winnings - ${player_id.slice(0,8)}`
    });

    if (!result.ok) {
        // Refund on failure
        p.balance = fmt(p.balance + total);
        console.error(`[Withdraw FAILED] Player ${player_id.slice(0,8)} | ${result.error}`);
        return res.status(502).json({ error: 'Withdrawal failed', message: result.error });
    }

    p.transactions.unshift({
        id:        tx_ref,
        type:      'withdraw',
        amount:    amt,
        fee:       FEE,
        operator:  operator.toLowerCase(),
        phone:     cleanPhone,
        status:    'completed',
        createdAt: new Date().toISOString()
    });

    console.log(`[Withdraw ✅] Player ${player_id.slice(0,8)} | ZK${amt} → ${phone} via ${operator}`);

    res.json({
        status:     'success',
        tx_ref,
        amount:     amt,
        newBalance: p.balance,
        message:    `ZK ${amt.toFixed(2)} sent to ${phone}`
    });
});

// ── POST /api/webhook/lenco ───────────────────────────────────────────────────
// Register this URL in Lenco dashboard → Settings → Webhooks:
//   https://kids-games-o79b.onrender.com/api/webhook/lenco
app.post('/api/webhook/lenco', (req, res) => {
    // Verify signature if you set WEBHOOK_SECRET in both env and Lenco dashboard
    const sig    = req.headers['x-lenco-signature'] || req.headers['x-webhook-signature'];
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && sig) {
        const expected = crypto.createHmac('sha256', secret)
            .update(JSON.stringify(req.body)).digest('hex');
        if (sig !== expected) {
            console.warn('[Webhook] Signature mismatch — rejected');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    const body     = req.body;
    const txRef    = body?.data?.reference || body?.reference;
    const txStatus = (body?.data?.status || body?.status || '').toLowerCase();
    const amount   = parseFloat(body?.data?.amount || body?.amount || 0);

    console.log(`[Webhook] event:${body?.event} ref:${txRef} status:${txStatus}`);

    // Credit deposit if successful
    if (txStatus === 'successful' && txRef?.startsWith('KBA-DEP-')) {
        for (const [playerId, p] of players.entries()) {
            const pending = p.pendingDeposits[txRef];
            if (pending && !pending.credited) {
                pending.credited = true;
                const creditAmt  = fmt(amount || pending.amount);
                p.balance        = fmt(p.balance + creditAmt);
                p.transactions.unshift({
                    id:          txRef,
                    type:        'deposit',
                    amount:      creditAmt,
                    operator:    pending.operator,
                    phone:       pending.phone,
                    status:      'completed',
                    createdAt:   pending.createdAt,
                    completedAt: new Date().toISOString()
                });
                console.log(`[Webhook ✅] Credited player ${playerId.slice(0,8)} ZK${creditAmt}`);

                // Push to live socket
                io.sockets.sockets.forEach(s => {
                    if (s.userId === playerId) {
                        s.emit('balance_update', { balance: p.balance });
                    }
                });
                break;
            }
        }
    }

    res.json({ received: true }); // Always 200 fast so Lenco doesn't retry
});

// ─── Socket.io — Game Logic ───────────────────────────────────────────────────
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication failed: missing token'));
    socket.userId        = token;
    socket.pilotCallsign = `Pilot-${token.slice(0, 6).toUpperCase()}`;
    next();
});

io.on('connection', (socket) => {
    const p = getPlayer(socket.userId);

    socket.emit('initial_state', {
        balance:      p.balance,
        callsign:     socket.pilotCallsign,
        currentStage: gameStatus
    });

    // ── Place Bet ──────────────────────────────────────────────────────────────
    socket.on('place_bet', (data) => {
        if (gameStatus !== 'BETTING') {
            return socket.emit('error_message', { message: 'Betting is closed for this round.' });
        }
        if (activeRoundBets.has(socket.userId)) {
            return socket.emit('error_message', { message: 'You already have an active bet.' });
        }

        const amount = parseFloat(data.amount);
        const p      = getPlayer(socket.userId);

        if (isNaN(amount) || amount <= 0) {
            return socket.emit('error_message', { message: 'Invalid bet amount.' });
        }
        if (amount > p.balance) {
            return socket.emit('error_message', {
                message: `Insufficient balance. You have ZK ${p.balance.toFixed(2)}. Please deposit to play.`
            });
        }

        p.balance = fmt(p.balance - amount);
        p.transactions.unshift({
            id:        `BET-${uuidv4()}`,
            type:      'bet',
            amount:    amount,
            status:    'placed',
            createdAt: new Date().toISOString()
        });

        activeRoundBets.set(socket.userId, {
            amount,
            vehicle:  data.vehicle || 'balloon',
            callsign: socket.pilotCallsign
        });

        socket.emit('bet_confirmed', { newBalance: p.balance });
        io.emit('ledger_update', `${socket.pilotCallsign} purchased a flight ticket`);
    });

    // ── Cash Out ───────────────────────────────────────────────────────────────
    socket.on('cash_out', () => {
        if (gameStatus !== 'IN_FLIGHT') {
            return socket.emit('error_message', { message: 'No active flight to cash out from.' });
        }
        if (!activeRoundBets.has(socket.userId)) {
            return socket.emit('error_message', { message: 'No active bet found.' });
        }

        const bet    = activeRoundBets.get(socket.userId);
        const payout = fmt(bet.amount * currentMultiplier);
        const p      = getPlayer(socket.userId);
        p.balance    = fmt(p.balance + payout);

        // Record win transaction
        p.transactions.unshift({
            id:          `WIN-${uuidv4()}`,
            type:        'win',
            amount:      payout,
            atMultiplier: parseFloat(currentMultiplier.toFixed(2)),
            status:      'completed',
            createdAt:   new Date().toISOString()
        });

        activeRoundBets.delete(socket.userId);

        socket.emit('cash_out_success', {
            payout,
            atMultiplier: parseFloat(currentMultiplier.toFixed(2)),
            newBalance:   p.balance
        });

        io.emit('ledger_update',
            `${socket.pilotCallsign} secured ZK ${payout.toFixed(2)} at ${currentMultiplier.toFixed(2)}x!`
        );
    });

    socket.on('disconnect', () => {
        // Balance is preserved — player can reconnect and keep playing
    });
});

// ─── Game Loop ────────────────────────────────────────────────────────────────
function startNewRound() {
    activeRoundBets.clear();
    gameStatus        = 'BETTING';
    currentMultiplier = 1.00;
    crashPoint        = generateCrashPoint();

    console.log(`[Game] New round | Crash target: ${crashPoint.toFixed(2)}x`);

    io.emit('betting_phase_started', { countdown: 7 });

    setTimeout(startFlight, 7000);
}

function startFlight() {
    gameStatus = 'IN_FLIGHT';
    io.emit('game_started');

    let lastTick = Date.now();

    lifecycleInterval = setInterval(() => {
        const delta       = (Date.now() - lastTick) / 1000;
        lastTick          = Date.now();
        const accel       = 0.065 * Math.pow(currentMultiplier, 0.35);
        currentMultiplier = Math.round((currentMultiplier + accel * delta * 10) * 100) / 100;

        if (currentMultiplier >= crashPoint) {
            crash(crashPoint);
        } else {
            io.emit('multiplier_tick', { multiplier: currentMultiplier });
        }
    }, 90);
}

function crash(at) {
    clearInterval(lifecycleInterval);
    gameStatus = 'CRASHED';

    // Any player who didn't cash out loses their bet (already deducted on place_bet)
    activeRoundBets.forEach((bet, playerId) => {
        const p = getPlayer(playerId);
        p.transactions.unshift({
            id:        `LOSS-${uuidv4()}`,
            type:      'loss',
            amount:    bet.amount,
            status:    'lost',
            createdAt: new Date().toISOString()
        });
    });

    io.emit('game_crashed', { crashedAt: parseFloat(at.toFixed(2)) });
    console.log(`[Game] Crashed at ${at.toFixed(2)}x`);

    setTimeout(startNewRound, 5000);
}

function generateCrashPoint() {
    const r = Math.random();
    if (r < 0.03) return 1.00;
    if (r < 0.58) return fmt(1.01 + Math.random() * 1.8);
    if (r < 0.90) return fmt(2.8 + Math.random() * 4.2);
    return fmt(7.0 + Math.random() * 45.0);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════');
    console.log(` Kwacha Balloon Game Server — Port ${PORT}`);
    console.log(` Mode: ${IS_SANDBOX ? '🟡 SANDBOX' : '🟢 LIVE'}`);
    console.log(` Lenco key: ${LENCO_KEY ? '✅ Set' : '❌ MISSING'}`);
    console.log(` Account ID: ${LENCO_ACCOUNT_ID ? '✅ Set' : '❌ MISSING (withdrawals won\'t work)'}`);
    console.log('═══════════════════════════════════════════════');
    startNewRound();
});

/*
═══════════════════════════════════════════════════════
  DEPLOYMENT CHECKLIST (Render.com)
═══════════════════════════════════════════════════════

1. Push this file to your GitHub repo as index.js

2. In Render dashboard → Environment Variables, add:
   LENCO_SECRET_KEY   = 993bed87f9d592566a6cce2cefd79363d1b7e95af3e1e6642b294ce5fc8c59f6
   LENCO_ACCOUNT_ID   = <get this by calling GET https://sandbox.lenco.co/access/v2/accounts>
   LENCO_SANDBOX      = true
   WEBHOOK_SECRET     = kba-vyeta-2025

3. In Lenco dashboard → Settings → Webhooks, add:
   URL: https://kids-games-o79b.onrender.com/api/webhook/lenco
   Secret: kba-vyeta-2025

4. Test a deposit:
   POST https://kids-games-o79b.onrender.com/api/deposit
   Body: { "player_id":"test123", "amount":10, "phone":"260971234567", "operator":"airtel" }

5. Check sandbox test accounts at:
   https://lenco-api.readme.io/v2.0/reference/test-cards-and-accounts

═══════════════════════════════════════════════════════
  TO GET YOUR LENCO_ACCOUNT_ID:
═══════════════════════════════════════════════════════
  Run this once from terminal or Postman:

  curl -X GET https://sandbox.lenco.co/access/v2/accounts \
    -H "Authorization: 993bed87f9d592566a6cce2cefd79363d1b7e95af3e1e6642b294ce5fc8c59f6"

  Copy the "id" field from the response and set it as LENCO_ACCOUNT_ID

═══════════════════════════════════════════════════════
*/
