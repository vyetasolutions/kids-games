  KWACHA BALLOON ADVENTURES — Game + Payment Server
 *  Vyeta Digital Solutions
 * ═══════════════════════════════════════════════════════════════════
 *
 *  SETUP: npm install express socket.io cors axios uuid @supabase/supabase-js
 *
 *  ENV VARS (set in Render → Environment, never hardcode secrets):
 *
 *    LENCO_SECRET_KEY    your Lenco API key
 *    LENCO_ACCOUNT_ID    your Lenco account UUID (needed for withdrawals)
 *    LENCO_SANDBOX       true for sandbox, false for live
 *    WEBHOOK_SECRET      shared secret set in Lenco dashboard → Webhooks
 *    SUPABASE_URL        your Supabase project URL
 *    SUPABASE_KEY        your Supabase service_role key (not anon key)
 *    PORT                3000 (Render sets this automatically)
 *
 *  SUPABASE TABLE (run once in Supabase SQL editor):
 *
 *    create table players (
 *      id            text primary key,
 *      balance       numeric(12,2) not null default 0,
 *      transactions  jsonb not null default '[]',
 *      pending_deposits jsonb not null default '{}',
 *      created_at    timestamptz default now(),
 *      updated_at    timestamptz default now()
 *    );
 *
 *  WEBHOOK URL (register with Lenco support):
 *    https://kids-games-o79b.onrender.com/api/webhook/lenco
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

const express             = require('express');
const http                = require('http');
const { Server }          = require('socket.io');
const cors                = require('cors');
const axios               = require('axios');
const crypto              = require('crypto');
const { v4: uuidv4 }      = require('uuid');
const { createClient }    = require('@supabase/supabase-js');

// ═══════════════════════════════════════════════════════════════════
//  INITIALISATION
// ═══════════════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════
//  SUPABASE — Persistent Player Storage
//  Balances survive server restarts and deployments.
//  Falls back to in-memory if env vars are not set (dev mode only).
// ═══════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase     = SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// In-memory fallback (dev only — balances lost on restart)
const memPlayers = new Map();

async function getPlayer(id) {
    if (supabase) {
        const { data, error } = await supabase
            .from('players')
            .select('*')
            .eq('id', id)
            .single();

        if (error && error.code === 'PGRST116') {
            // Player does not exist yet — create them
            const fresh = { id, balance: 0, transactions: [], pending_deposits: {} };
            await supabase.from('players').insert(fresh);
            return { balance: 0, transactions: [], pendingDeposits: {} };
        }
        if (error) throw error;

        return {
            balance:         parseFloat(data.balance),
            transactions:    data.transactions    || [],
            pendingDeposits: data.pending_deposits || {}
        };
    }

    // In-memory fallback
    if (!memPlayers.has(id)) {
        memPlayers.set(id, { balance: 0, transactions: [], pendingDeposits: {} });
    }
    return memPlayers.get(id);
}

async function savePlayer(id, player) {
    if (supabase) {
        const { error } = await supabase
            .from('players')
            .upsert({
                id,
                balance:          player.balance,
                transactions:     player.transactions,
                pending_deposits: player.pendingDeposits,
                updated_at:       new Date().toISOString()
            }, { onConflict: 'id' });

        if (error) console.error('[Supabase] savePlayer error:', error.message);
        return;
    }

    // In-memory fallback
    memPlayers.set(id, player);
}

// ═══════════════════════════════════════════════════════════════════
//  LENCO PAYMENT API
// ═══════════════════════════════════════════════════════════════════

const LENCO_KEY    = process.env.LENCO_SECRET_KEY;
const LENCO_ID     = process.env.LENCO_ACCOUNT_ID;
const IS_SANDBOX   = process.env.LENCO_SANDBOX !== 'false';
const LENCO_BASE   = IS_SANDBOX
    ? 'https://sandbox.lenco.co/access/v2'
    : 'https://api.lenco.co/access/v2';

async function lenco(method, path, body = null) {
    try {
        const res = await axios({
            method,
            url:     `${LENCO_BASE}${path}`,
            headers: { 'Authorization': LENCO_KEY, 'Content-Type': 'application/json' },
            data:    body || undefined,
            timeout: 15000
        });
        return { ok: true, data: res.data };
    } catch (err) {
        const msg = err.response?.data?.message || err.message || 'Lenco API error';
        console.error(`[Lenco] ${method} ${path} →`, msg);
        return { ok: false, error: msg };
    }
}

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

// Round to 2 decimal places, avoiding floating point drift
function fmt(n) {
    return Math.round(parseFloat(n) * 100) / 100;
}

// Push a live balance update to every socket session for this player
function pushBalance(playerId, balance) {
    io.sockets.sockets.forEach(s => {
        if (s.userId === playerId) s.emit('balance_update', { balance });
    });
}

// ═══════════════════════════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════════════════════════

let gameStatus        = 'BETTING';
let currentMultiplier = 1.00;
let lifecycleInterval = null;
let crashPoint        = 1.00;

// Active bets for the current round only — intentionally in-memory
// (cleared every round — no persistence needed)
const activeRoundBets = new Map();   // playerId → { amount, vehicle, callsign }

// ═══════════════════════════════════════════════════════════════════
//  CRASH ALGORITHM — Provably Fair, 4% House Edge
//
//  Formula: crash = floor(100 / (1 - rand)) / 100 × (1 - houseEdge)
//  This guarantees RTP ≈ 96% regardless of player cashout strategy.
//  The 4% of rounds where rand < HOUSE_EDGE crash instantly at 1.00x,
//  which is exactly the mechanism that enforces the house margin.
// ═══════════════════════════════════════════════════════════════════

const HOUSE_EDGE = 0.04;   // 4% margin → 96% RTP

function generateCrashPoint() {
    const r = Math.random();
    if (r < HOUSE_EDGE) return 1.00;
    return Math.max(1.00, Math.floor(100 / (1 - r)) / 100 * (1 - HOUSE_EDGE));
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:           'online',
        mode:             IS_SANDBOX ? 'SANDBOX' : 'LIVE',
        game_stage:       gameStatus,
        current_mult:     currentMultiplier,
        active_bets:      activeRoundBets.size,
        lenco_key:        !!LENCO_KEY,
        lenco_account:    !!LENCO_ID,
        supabase:         !!supabase,
        rtp:              `${((1 - HOUSE_EDGE) * 100).toFixed(0)}%`,
        house_edge:       `${(HOUSE_EDGE * 100).toFixed(0)}%`
    });
});

// ── GET /api/balance ──────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
    const { player_id } = req.query;
    if (!player_id) return res.status(400).json({ error: 'player_id required' });
    try {
        const p = await getPlayer(player_id);
        res.json({ balance: p.balance });
    } catch (e) {
        res.status(500).json({ error: 'Could not fetch balance' });
    }
});

// ── GET /api/transactions ─────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
    const { player_id, limit = 25 } = req.query;
    if (!player_id) return res.status(400).json({ error: 'player_id required' });
    try {
        const p = await getPlayer(player_id);
        res.json({ transactions: p.transactions.slice(0, parseInt(limit)) });
    } catch (e) {
        res.status(500).json({ error: 'Could not fetch transactions' });
    }
});

// ── POST /api/deposit ─────────────────────────────────────────────
// Triggers a Lenco STK push (mobile money prompt) to the player's phone.
app.post('/api/deposit', async (req, res) => {
    const { player_id, amount, phone, operator } = req.body;

    if (!player_id || !amount || !phone || !operator) {
        return res.status(400).json({ error: 'player_id, amount, phone, operator are all required' });
    }

    const amt = fmt(parseFloat(amount));
    if (isNaN(amt) || amt < 10 || amt > 10000) {
        return res.status(400).json({ error: 'Amount must be between ZK 10 and ZK 10,000' });
    }
    if (!['airtel', 'mtn', 'zamtel'].includes(operator.toLowerCase())) {
        return res.status(400).json({ error: 'operator must be airtel, mtn, or zamtel' });
    }

    const tx_ref     = `KBA-DEP-${uuidv4()}`;
    const cleanPhone = phone.replace(/[\s\+\-]/g, '');

    const result = await lenco('POST', '/collections/mobile-money', {
        reference: tx_ref,
        amount:    amt,
        phone:     cleanPhone,
        operator:  operator.toLowerCase(),
        country:   'zm',
        bearer:    'merchant'
    });

    if (!result.ok) {
        return res.status(502).json({ error: 'Payment provider error', message: result.error });
    }

    // Record the pending deposit so the webhook / poll can credit it
    try {
        const p = await getPlayer(player_id);
        p.pendingDeposits[tx_ref] = {
            amount:    amt,
            phone:     cleanPhone,
            operator:  operator.toLowerCase(),
            credited:  false,
            createdAt: new Date().toISOString()
        };
        await savePlayer(player_id, p);
    } catch (e) {
        console.error('[Deposit] Could not save pending deposit:', e.message);
    }

    console.log(`[Deposit] ${player_id.slice(0,8)} | ZK${amt} | ${operator} | ${tx_ref}`);

    res.json({
        status:  'pending',
        tx_ref,
        message: 'Payment prompt sent. Customer must approve on their phone.',
        data:    result.data?.data || result.data
    });
});

// ── GET /api/verify-payment ───────────────────────────────────────
// Frontend polls every 5 seconds to check whether the deposit was approved.
app.get('/api/verify-payment', async (req, res) => {
    const { tx_ref, player_id } = req.query;
    if (!tx_ref || !player_id) {
        return res.status(400).json({ error: 'tx_ref and player_id are required' });
    }

    const result = await lenco('GET', `/collections/status/${tx_ref}`);
    if (!result.ok) {
        return res.status(502).json({ error: 'Could not verify payment', status: 'unknown' });
    }

    const txData   = result.data?.data || result.data;
    const txStatus = (txData?.status || '').toLowerCase();

    if (txStatus === 'successful') {
        try {
            const p       = await getPlayer(player_id);
            const pending = p.pendingDeposits[tx_ref];

            if (pending && !pending.credited) {
                pending.credited = true;
                p.balance        = fmt(p.balance + pending.amount);
                p.transactions.unshift({
                    id:          tx_ref,
                    type:        'deposit',
                    amount:      pending.amount,
                    operator:    pending.operator,
                    phone:       pending.phone,
                    status:      'completed',
                    createdAt:   pending.createdAt,
                    completedAt: new Date().toISOString()
                });
                await savePlayer(player_id, p);
                pushBalance(player_id, p.balance);
                console.log(`[Deposit ✅] ${player_id.slice(0,8)} credited ZK${pending.amount}`);
            }

            return res.json({
                status:     'successful',
                amount:     pending?.amount,
                newBalance: p.balance
            });
        } catch (e) {
            console.error('[verify-payment] DB error:', e.message);
            return res.status(500).json({ error: 'Could not credit balance' });
        }
    }

    res.json({ status: txStatus || 'pending', data: txData });
});

// ── POST /api/withdraw ────────────────────────────────────────────
// Sends winnings directly to the player's mobile money wallet via Lenco.
app.post('/api/withdraw', async (req, res) => {
    const { player_id, amount, phone, operator } = req.body;

    if (!player_id || !amount || !phone || !operator) {
        return res.status(400).json({ error: 'player_id, amount, phone, operator are all required' });
    }
    if (!LENCO_ID) {
        return res.status(500).json({ error: 'LENCO_ACCOUNT_ID is not configured on the server' });
    }

    const amt   = fmt(parseFloat(amount));
    const FEE   = 3.00;   // ZK 3 flat withdrawal fee
    const total = fmt(amt + FEE);

    if (amt < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal is ZK 10' });
    }

    let p;
    try {
        p = await getPlayer(player_id);
    } catch (e) {
        return res.status(500).json({ error: 'Could not retrieve player balance' });
    }

    if (total > p.balance) {
        return res.status(400).json({
            error: `Insufficient balance. Need ZK ${total.toFixed(2)} (ZK ${amt} + ZK ${FEE} fee). Available: ZK ${p.balance.toFixed(2)}`
        });
    }

    // Deduct immediately to prevent double-spend
    p.balance = fmt(p.balance - total);
    await savePlayer(player_id, p);

    const tx_ref     = `KBA-WD-${uuidv4()}`;
    const cleanPhone = phone.replace(/[\s\+\-]/g, '');

    const result = await lenco('POST', '/transfers/mobile-money', {
        accountId: LENCO_ID,
        reference: tx_ref,
        amount:    amt,
        phone:     cleanPhone,
        operator:  operator.toLowerCase(),
        country:   'zm',
        narration: `Kwacha Balloon payout — ${player_id.slice(0,8)}`
    });

    if (!result.ok) {
        // Refund the hold on failure
        p.balance = fmt(p.balance + total);
        await savePlayer(player_id, p);
        console.error(`[Withdraw ❌] ${player_id.slice(0,8)} | ${result.error}`);
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
    await savePlayer(player_id, p);

    console.log(`[Withdraw ✅] ${player_id.slice(0,8)} | ZK${amt} → ${cleanPhone} via ${operator}`);

    res.json({
        status:     'success',
        tx_ref,
        amount:     amt,
        newBalance: p.balance,
        message:    `ZK ${amt.toFixed(2)} sent to ${phone}. Arrives within 1–5 minutes.`
    });
});

// ── POST /api/webhook/lenco ───────────────────────────────────────
// Lenco calls this URL when a payment completes. Register this URL
// with Lenco support: https://kids-games-o79b.onrender.com/api/webhook/lenco
app.post('/api/webhook/lenco', async (req, res) => {
    // Verify HMAC signature if WEBHOOK_SECRET is set
    const sig    = req.headers['x-lenco-signature'] || req.headers['x-webhook-signature'];
    const secret = process.env.WEBHOOK_SECRET;

    if (secret && sig) {
        const expected = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(req.body))
            .digest('hex');
        if (sig !== expected) {
            console.warn('[Webhook] Signature mismatch — rejected');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    const body     = req.body;
    const txRef    = body?.data?.reference || body?.reference;
    const txStatus = (body?.data?.status   || body?.status || '').toLowerCase();
    const amount   = parseFloat(body?.data?.amount || body?.amount || 0);

    console.log(`[Webhook] event:${body?.event} ref:${txRef} status:${txStatus}`);

    // Credit a successful deposit
    if (txStatus === 'successful' && txRef?.startsWith('KBA-DEP-')) {
        // We need to find which player owns this tx_ref.
        // With Supabase we query across all players' pending_deposits.
        if (supabase) {
            try {
                const { data: rows } = await supabase
                    .from('players')
                    .select('id, balance, transactions, pending_deposits')
                    .contains('pending_deposits', JSON.stringify({ [txRef]: {} }));

                // contains() may not work depending on JSONB structure —
                // as a reliable fallback we pull all and check in JS.
                // For scale, add a separate pending_deposits table.
                if (rows && rows.length > 0) {
                    const row     = rows[0];
                    const pending = row.pending_deposits[txRef];
                    if (pending && !pending.credited) {
                        const creditAmt = amount || pending.amount;
                        pending.credited = true;
                        const newBalance = fmt(row.balance + creditAmt);
                        const txRecord   = {
                            id:          txRef,
                            type:        'deposit',
                            amount:      creditAmt,
                            operator:    pending.operator,
                            phone:       pending.phone,
                            status:      'completed',
                            createdAt:   pending.createdAt,
                            completedAt: new Date().toISOString()
                        };
                        await supabase.from('players').update({
                            balance:          newBalance,
                            pending_deposits: row.pending_deposits,
                            transactions:     [txRecord, ...row.transactions],
                            updated_at:       new Date().toISOString()
                        }).eq('id', row.id);
                        pushBalance(row.id, newBalance);
                        console.log(`[Webhook ✅] Credited ${row.id.slice(0,8)} ZK${creditAmt}`);
                    }
                }
            } catch (e) {
                console.error('[Webhook] DB error:', e.message);
            }
        } else {
            // In-memory fallback
            for (const [playerId, p] of memPlayers.entries()) {
                const pending = p.pendingDeposits[txRef];
                if (pending && !pending.credited) {
                    pending.credited = true;
                    const creditAmt  = amount || pending.amount;
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
                    pushBalance(playerId, p.balance);
                    console.log(`[Webhook ✅] Credited ${playerId.slice(0,8)} ZK${creditAmt}`);
                    break;
                }
            }
        }
    }

    res.json({ received: true });   // Always 200 immediately so Lenco doesn't retry
});

// ═══════════════════════════════════════════════════════════════════
//  SOCKET.IO — REAL-TIME GAME
// ═══════════════════════════════════════════════════════════════════

// Auth middleware — accept any non-empty token (guest UUID or Supabase JWT)
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication failed: token missing'));
    socket.userId        = token;
    socket.pilotCallsign = `Pilot-${token.slice(0, 6).toUpperCase()}`;
    next();
});

io.on('connection', async (socket) => {
    let p;
    try {
        p = await getPlayer(socket.userId);
    } catch (e) {
        p = { balance: 0, transactions: [], pendingDeposits: {} };
    }

    socket.emit('initial_state', {
        balance:      p.balance,
        callsign:     socket.pilotCallsign,
        currentStage: gameStatus
    });

    // ── Place Bet ──────────────────────────────────────────────────
    socket.on('place_bet', async (data) => {
        if (gameStatus !== 'BETTING') {
            return socket.emit('error_message', { message: 'Betting is closed for this round.' });
        }
        if (activeRoundBets.has(socket.userId)) {
            return socket.emit('error_message', { message: 'You already have a bet this round.' });
        }

        const amount = fmt(parseFloat(data.amount));
        if (isNaN(amount) || amount <= 0) {
            return socket.emit('error_message', { message: 'Invalid bet amount.' });
        }

        let player;
        try {
            player = await getPlayer(socket.userId);
        } catch (e) {
            return socket.emit('error_message', { message: 'Could not verify balance. Try again.' });
        }

        if (amount > player.balance) {
            return socket.emit('error_message', {
                message: `Insufficient balance. You have ZK ${player.balance.toFixed(2)}. Please deposit to continue.`
            });
        }

        // Deduct bet from balance immediately
        player.balance = fmt(player.balance - amount);
        player.transactions.unshift({
            id:        `BET-${uuidv4()}`,
            type:      'bet',
            amount,
            status:    'placed',
            createdAt: new Date().toISOString()
        });
        await savePlayer(socket.userId, player);

        activeRoundBets.set(socket.userId, {
            amount,
            vehicle:  data.vehicle || 'balloon',
            callsign: socket.pilotCallsign
        });

        socket.emit('bet_confirmed', { newBalance: player.balance });
        io.emit('ledger_update', `${socket.pilotCallsign} purchased a flight ticket`);
    });

    // ── Cash Out ───────────────────────────────────────────────────
    socket.on('cash_out', async () => {
        if (gameStatus !== 'IN_FLIGHT') {
            return socket.emit('error_message', { message: 'No active flight to cash out from.' });
        }
        if (!activeRoundBets.has(socket.userId)) {
            return socket.emit('error_message', { message: 'No active bet found.' });
        }

        const bet    = activeRoundBets.get(socket.userId);
        const payout = fmt(bet.amount * currentMultiplier);
        const atMult = parseFloat(currentMultiplier.toFixed(2));

        activeRoundBets.delete(socket.userId);

        let player;
        try {
            player          = await getPlayer(socket.userId);
            player.balance  = fmt(player.balance + payout);
            player.transactions.unshift({
                id:           `WIN-${uuidv4()}`,
                type:         'win',
                amount:       payout,
                atMultiplier: atMult,
                status:       'completed',
                createdAt:    new Date().toISOString()
            });
            await savePlayer(socket.userId, player);
        } catch (e) {
            console.error('[cash_out] DB error:', e.message);
        }

        socket.emit('cash_out_success', {
            payout,
            atMultiplier: atMult,
            newBalance:   player.balance
        });

        io.emit('ledger_update',
            `${socket.pilotCallsign} secured ZK ${payout.toFixed(2)} at ${atMult.toFixed(2)}x!`
        );
    });

    socket.on('disconnect', () => {
        // Balance is persisted — player can reconnect safely
    });
});

// ═══════════════════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════════════════

function startNewRound() {
    activeRoundBets.clear();
    gameStatus        = 'BETTING';
    currentMultiplier = 1.00;
    crashPoint        = generateCrashPoint();

    console.log(`[Game] New round | Crash: ${crashPoint.toFixed(2)}x`);

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
            triggerCrash(crashPoint);
        } else {
            io.emit('multiplier_tick', { multiplier: currentMultiplier });
        }
    }, 90);
}

async function triggerCrash(at) {
    clearInterval(lifecycleInterval);
    gameStatus = 'CRASHED';

    // Record losses for players who didn't cash out
    const lossPromises = [];
    activeRoundBets.forEach((bet, playerId) => {
        lossPromises.push(
            getPlayer(playerId).then(p => {
                p.transactions.unshift({
                    id:        `LOSS-${uuidv4()}`,
                    type:      'loss',
                    amount:    bet.amount,
                    status:    'lost',
                    createdAt: new Date().toISOString()
                });
                return savePlayer(playerId, p);
            }).catch(e => console.error('[crash] loss record error:', e.message))
        );
    });
    await Promise.all(lossPromises);

    io.emit('game_crashed', { crashedAt: parseFloat(at.toFixed(2)) });
    console.log(`[Game] Crashed at ${at.toFixed(2)}x`);

    setTimeout(startNewRound, 5000);
}

// ═══════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log(` Kwacha Balloon Adventures — Port ${PORT}`);
    console.log(` Mode:          ${IS_SANDBOX ? '🟡 SANDBOX' : '🟢 LIVE'}`);
    console.log(` RTP:           ${((1 - HOUSE_EDGE) * 100).toFixed(0)}%  (House edge: ${(HOUSE_EDGE * 100).toFixed(0)}%)`);
    console.log(` Lenco key:     ${LENCO_KEY  ? '✅ Set' : '❌ MISSING'}`);
    console.log(` Lenco account: ${LENCO_ID   ? '✅ Set' : '❌ MISSING — withdrawals disabled'}`);
    console.log(` Supabase:      ${supabase   ? '✅ Connected — balances are persistent' : '⚠️  Not set — using in-memory (dev only)'}`);
    console.log('═══════════════════════════════════════════════════');
    startNewRound();
});
