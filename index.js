/**
 * KWACHA BALLOON ADVENTURES — Game + Manual Payment Server
 * Vyeta Digital Solutions
 * ═══════════════════════════════════════════════════════════════════
 *
 *  SETUP: npm install express socket.io cors axios uuid @supabase/supabase-js express-rate-limit
 *
 *  ENV VARS (set in Render → Environment):
 *
 *    SUPABASE_URL        your Supabase project URL
 *    SUPABASE_KEY        your Supabase service_role key (not anon key)
 *    ADMIN_KEY           secret password for /admin panel (choose any strong string)
 *    PORT                3000 (Render sets this automatically)
 *
 *  SUPABASE TABLE (run once in Supabase SQL editor):
 *
 *    create table if not exists players (
 *      id               text primary key,
 *      balance          numeric(12,2) not null default 0,
 *      transactions     jsonb not null default '[]',
 *      pending_deposits jsonb not null default '{}',
 *      created_at       timestamptz default now(),
 *      updated_at       timestamptz default now()
 *    );
 *
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

const express          = require('express');
const http             = require('http');
const { Server }       = require('socket.io');
const cors             = require('cors');
const { v4: uuidv4 }  = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const rateLimit        = require('express-rate-limit');
const crypto           = require('crypto');

// ═══════════════════════════════════════════════════════════════════
//  INITIALISATION
// ═══════════════════════════════════════════════════════════════════

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
    'https://vyetasolutions.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true }
});

const PORT = process.env.PORT || 3000;

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true }));
app.use(express.json());

// ── Rate Limiting ─────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, max: 120,
    message: { error: 'Too many requests. Please wait a moment.' }
});
const depositLimiter = rateLimit({
    windowMs: 60 * 1000, max: 10,
    message: { error: 'Too many deposit attempts. Please wait.' }
});
const withdrawLimiter = rateLimit({
    windowMs: 60 * 1000, max: 10,
    message: { error: 'Too many withdrawal attempts. Please wait.' }
});
const adminLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    message: { error: 'Too many admin requests.' }
});
app.use('/api/', apiLimiter);
app.use('/api/admin', adminLimiter);

// ═══════════════════════════════════════════════════════════════════
//  MANUAL PAYMENT CONFIG
//  Players send money here directly — admin credits via /admin panel
// ═══════════════════════════════════════════════════════════════════

const PAYMENT_CONFIG = {
    mtn: {
        number:  process.env.MTN_NUMBER || '0760829950',
        name:    process.env.PAY_NAME   || 'Suwilanji Puta',
        network: 'MTN MoMo'
    }
};
// Optional: set AIRTEL_NUMBER in Render to also accept Airtel Money deposits
if (process.env.AIRTEL_NUMBER) {
    PAYMENT_CONFIG.airtel = {
        number:  process.env.AIRTEL_NUMBER,
        name:    process.env.PAY_NAME || 'Suwilanji Puta',
        network: 'Airtel Money'
    };
}
const MIN_DEPOSIT    = 20;
const MIN_WITHDRAWAL = 20;
const WITHDRAWAL_FEE = 3;
const DEMO_BALANCE   = 5000;

// ═══════════════════════════════════════════════════════════════════
//  ADMIN AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

const ADMIN_KEY = process.env.ADMIN_KEY || '';

function adminAuth(req, res, next) {
    if (!ADMIN_KEY) {
        return res.status(503).json({ error: 'Admin disabled: set ADMIN_KEY in Render environment' });
    }
    const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
    const real  = Buffer.from(ADMIN_KEY);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
        return res.status(401).json({ error: 'Unauthorised' });
    }
    next();
}

// ═══════════════════════════════════════════════════════════════════
//  SUPABASE — Persistent Player Storage
// ═══════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase     = SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

const memPlayers = new Map();

async function getPlayer(id) {
    if (supabase) {
        const { data, error } = await supabase
            .from('players').select('*').eq('id', id).single();
        if (error && error.code === 'PGRST116') {
            const fresh = { id, balance: 0, transactions: [], pending_deposits: {} };
            await supabase.from('players').insert(fresh);
            return { balance: 0, transactions: [], pendingDeposits: {} };
        }
        if (error) throw error;
        return {
            balance:         parseFloat(data.balance),
            transactions:    data.transactions     || [],
            pendingDeposits: data.pending_deposits || {}
        };
    }
    if (!memPlayers.has(id)) {
        memPlayers.set(id, { balance: 0, transactions: [], pendingDeposits: {} });
    }
    return memPlayers.get(id);
}

async function savePlayer(id, player) {
    // Keep transaction history capped at 200 entries
    player.transactions = player.transactions.slice(0, 200);
    if (supabase) {
        const { error } = await supabase.from('players').upsert({
            id,
            balance:          player.balance,
            transactions:     player.transactions,
            pending_deposits: player.pendingDeposits,
            updated_at:       new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) console.error('[Supabase] savePlayer error:', error.message);
        return;
    }
    memPlayers.set(id, player);
}

function fmt(n) { return Math.round(parseFloat(n) * 100) / 100; }

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
function validId(id)  { return typeof id === 'string' && ID_RE.test(id); }
function isDemoId(id) { return id.startsWith('demo_'); }
function cleanPhone(p) { return String(p || '').replace(/[\s\+\-]/g, ''); }
function validPhone(p) { return /^(260\d{9}|0\d{9})$/.test(p); }

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
const activeRoundBets = new Map();

const HOUSE_EDGE = 0.04;

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
        status:        'online',
        game_stage:    gameStatus,
        current_mult:  currentMultiplier,
        active_bets:   activeRoundBets.size,
        supabase:      !!supabase,
        rtp:           `${((1 - HOUSE_EDGE) * 100).toFixed(0)}%`,
        house_edge:    `${(HOUSE_EDGE * 100).toFixed(0)}%`,
        payment_mode:  'manual'
    });
});

// ── GET /api/balance ──────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
    const { player_id } = req.query;
    if (!validId(player_id)) return res.status(400).json({ error: 'valid player_id required' });
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
    if (!validId(player_id)) return res.status(400).json({ error: 'valid player_id required' });
    try {
        const p = await getPlayer(player_id);
        res.json({ transactions: p.transactions.slice(0, Math.min(parseInt(limit) || 25, 100)) });
    } catch (e) {
        res.status(500).json({ error: 'Could not fetch transactions' });
    }
});

// ── GET /api/payment-info ─────────────────────────────────────────
// Returns the manual payment details players need to send money
app.get('/api/payment-info', (req, res) => {
    res.json({
        airtel: PAYMENT_CONFIG.airtel,
        mtn:    PAYMENT_CONFIG.mtn,
        min_deposit:    MIN_DEPOSIT,
        min_withdrawal: MIN_WITHDRAWAL,
        withdrawal_fee: WITHDRAWAL_FEE
    });
});

// ── POST /api/deposit-request ─────────────────────────────────────
// Player has already sent money manually and is submitting their
// transaction reference for admin verification and crediting.
app.post('/api/deposit-request', depositLimiter, async (req, res) => {
    const { player_id, amount, phone, operator, player_tx_ref } = req.body;

    if (!validId(player_id) || isDemoId(player_id)) {
        return res.status(400).json({ error: 'Deposits are only available in real-money mode.' });
    }

    if (!player_id || !amount || !phone || !operator || !player_tx_ref) {
        return res.status(400).json({
            error: 'player_id, amount, phone, operator, and player_tx_ref are all required'
        });
    }

    const amt = fmt(parseFloat(amount));
    if (isNaN(amt) || amt < MIN_DEPOSIT) {
        return res.status(400).json({ error: `Minimum deposit is ZK ${MIN_DEPOSIT}` });
    }
    if (!PAYMENT_CONFIG[String(operator).toLowerCase()]) {
        return res.status(400).json({ error: 'That network is not available for deposits.' });
    }
    const txRefClean = String(player_tx_ref).trim();
    if (txRefClean.length < 6 || txRefClean.length > 40) {
        return res.status(400).json({ error: 'Please enter the full transaction ID from your confirmation SMS.' });
    }
    if (!validPhone(cleanPhone(phone))) {
        return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0971234567' });
    }
    if (amt > 10000) {
        return res.status(400).json({ error: 'Maximum deposit is ZK 10,000' });
    }

    const ref = `KBA-DEP-${uuidv4()}`;

    try {
        const p = await getPlayer(player_id);

        // Check for duplicate tx ref submission
        const alreadySubmitted = Object.values(p.pendingDeposits || {})
            .some(d => d.player_tx_ref === txRefClean);
        if (alreadySubmitted) {
            return res.status(400).json({
                error: 'This transaction reference has already been submitted.'
            });
        }

        const awaiting = Object.values(p.pendingDeposits || {})
            .filter(d => d.status === 'awaiting_admin').length;
        if (awaiting >= 5) {
            return res.status(400).json({ error: 'You have too many deposits awaiting verification. Please wait for them to be processed.' });
        }

        const nowIso = new Date().toISOString();
        p.pendingDeposits[ref] = {
            amount:         amt,
            phone:          cleanPhone(phone),
            operator:       operator.toLowerCase(),
            player_tx_ref:  txRefClean,
            status:         'awaiting_admin',
            credited:       false,
            createdAt:      nowIso
        };
        // Show it in the player's history as pending
        p.transactions.unshift({
            id: ref, type: 'deposit', amount: amt,
            operator: operator.toLowerCase(), status: 'pending', createdAt: nowIso
        });
        await savePlayer(player_id, p);

        console.log(`[Deposit Request] ${player_id.slice(0,8)} | ZK${amt} | ${operator} | Ref: ${txRefClean}`);

        res.json({
            status:  'submitted',
            ref,
            message: `Your deposit of ZK ${amt.toFixed(2)} has been submitted for verification. It will be credited within 30 minutes.`
        });
    } catch (e) {
        console.error('[deposit-request] error:', e.message);
        res.status(500).json({ error: 'Could not save deposit request. Please try again.' });
    }
});

// ── POST /api/withdraw-request ────────────────────────────────────
// Player requests a withdrawal — admin will send manually via mobile money
app.post('/api/withdraw-request', withdrawLimiter, async (req, res) => {
    const { player_id, amount, phone, operator } = req.body;

    if (!validId(player_id) || isDemoId(player_id)) {
        return res.status(400).json({ error: 'Withdrawals are only available in real-money mode.' });
    }
    if (!amount || !phone || !operator) {
        return res.status(400).json({ error: 'amount, phone, and operator are required' });
    }
    if (!['airtel', 'mtn'].includes(String(operator).toLowerCase())) {
        return res.status(400).json({ error: 'operator must be airtel or mtn' });
    }
    if (!validPhone(cleanPhone(phone))) {
        return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 0971234567' });
    }

    const amt   = fmt(parseFloat(amount));
    const total = fmt(amt + WITHDRAWAL_FEE);

    if (isNaN(amt) || amt < MIN_WITHDRAWAL) {
        return res.status(400).json({ error: `Minimum withdrawal is ZK ${MIN_WITHDRAWAL}` });
    }

    let p;
    try {
        p = await getPlayer(player_id);
    } catch (e) {
        return res.status(500).json({ error: 'Could not retrieve balance' });
    }

    if (total > p.balance) {
        return res.status(400).json({
            error: `Insufficient balance. Need ZK ${total.toFixed(2)} (ZK ${amt} + ZK ${WITHDRAWAL_FEE} fee). Available: ZK ${p.balance.toFixed(2)}`
        });
    }

    // Reserve the funds immediately to prevent double-spend
    p.balance = fmt(p.balance - total);
    const ref = `KBA-WD-${uuidv4()}`;
    p.transactions.unshift({
        id:        ref,
        type:      'withdraw_request',
        amount:    amt,
        fee:       WITHDRAWAL_FEE,
        phone:     cleanPhone(phone),
        operator:  operator.toLowerCase(),
        status:    'pending',
        createdAt: new Date().toISOString()
    });
    await savePlayer(player_id, p);

    console.log(`[Withdraw Request] ${player_id.slice(0,8)} | ZK${amt} → ${phone} via ${operator} | ${ref}`);

    res.json({
        status:     'submitted',
        ref,
        newBalance: p.balance,
        message:    `Withdrawal of ZK ${amt.toFixed(2)} submitted. Will arrive within 2 hours during business hours.`
    });
});

// ═══════════════════════════════════════════════════════════════════
//  ADMIN ROUTES — Protected by ADMIN_KEY
// ═══════════════════════════════════════════════════════════════════

// ── GET /api/admin/requests ───────────────────────────────────────
app.get('/api/admin/requests', adminAuth, async (req, res) => {
    try {
        let deposits = [], withdrawals = [];

        if (supabase) {
            const { data: rows } = await supabase
                .from('players')
                .select('id, balance, transactions, pending_deposits');

            if (rows) {
                rows.forEach(row => {
                    // Pending deposit requests
                    Object.entries(row.pending_deposits || {}).forEach(([ref, d]) => {
                        if (!d.credited && d.status === 'awaiting_admin') {
                            deposits.push({
                                ref,
                                player_id:     row.id,
                                player_short:  row.id.slice(0, 8).toUpperCase(),
                                amount:        d.amount,
                                phone:         d.phone,
                                operator:      d.operator,
                                player_tx_ref: d.player_tx_ref,
                                createdAt:     d.createdAt
                            });
                        }
                    });

                    // Pending withdrawal requests
                    (row.transactions || []).forEach(tx => {
                        if (tx.type === 'withdraw_request' && tx.status === 'pending') {
                            withdrawals.push({
                                ref:          tx.id,
                                player_id:    row.id,
                                player_short: row.id.slice(0, 8).toUpperCase(),
                                amount:       tx.amount,
                                fee:          tx.fee,
                                phone:        tx.phone,
                                operator:     tx.operator,
                                createdAt:    tx.createdAt
                            });
                        }
                    });
                });
            }
        } else {
            // In-memory fallback
            memPlayers.forEach((p, pid) => {
                Object.entries(p.pendingDeposits || {}).forEach(([ref, d]) => {
                    if (!d.credited && d.status === 'awaiting_admin') {
                        deposits.push({ ref, player_id: pid, player_short: pid.slice(0,8).toUpperCase(), ...d });
                    }
                });
                (p.transactions || []).forEach(tx => {
                    if (tx.type === 'withdraw_request' && tx.status === 'pending') {
                        withdrawals.push({ ref: tx.id, player_id: pid, player_short: pid.slice(0,8).toUpperCase(), ...tx });
                    }
                });
            });
        }

        // Sort newest first
        deposits.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            deposits,
            withdrawals,
            game: { status: gameStatus, multiplier: currentMultiplier, active_bets: activeRoundBets.size }
        });
    } catch (e) {
        console.error('[admin/requests]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/admin/approve-deposit ──────────────────────────────
app.post('/api/admin/approve-deposit', adminAuth, async (req, res) => {
    const { player_id, ref } = req.body;
    if (!player_id || !ref) return res.status(400).json({ error: 'player_id and ref required' });

    try {
        const p = await getPlayer(player_id);
        const d = p.pendingDeposits[ref];

        if (!d) return res.status(404).json({ error: 'Deposit request not found' });
        if (d.credited) return res.status(400).json({ error: 'Already credited' });
        if (d.status === 'rejected') return res.status(400).json({ error: 'This request was rejected' });

        d.credited = true;
        d.status   = 'completed';
        p.balance  = fmt(p.balance + d.amount);
        const existing = p.transactions.find(t => t.id === ref);
        if (existing) {
            existing.status      = 'completed';
            existing.completedAt = new Date().toISOString();
        } else {
            p.transactions.unshift({
                id: ref, type: 'deposit', amount: d.amount, operator: d.operator,
                status: 'completed', createdAt: d.createdAt, completedAt: new Date().toISOString()
            });
        }
        await savePlayer(player_id, p);
        pushBalance(player_id, p.balance);
        io.sockets.sockets.forEach(s => {
            if (s.userId === player_id) s.emit('deposit_approved', { ref, amount: d.amount });
        });

        console.log(`[Admin ✅ Deposit] ${player_id.slice(0,8)} credited ZK${d.amount}`);
        res.json({ status: 'credited', newBalance: p.balance, amount: d.amount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/admin/reject-deposit ───────────────────────────────
app.post('/api/admin/reject-deposit', adminAuth, async (req, res) => {
    const { player_id, ref, reason } = req.body;
    if (!player_id || !ref) return res.status(400).json({ error: 'player_id and ref required' });

    try {
        const p = await getPlayer(player_id);
        if (!p.pendingDeposits[ref]) return res.status(404).json({ error: 'Not found' });
        if (p.pendingDeposits[ref].credited) return res.status(400).json({ error: 'Already credited — cannot reject' });

        p.pendingDeposits[ref].status = 'rejected';
        const row = p.transactions.find(t => t.id === ref);
        if (row) { row.status = 'rejected'; row.reason = String(reason || 'Could not verify transaction').slice(0, 200); }
        await savePlayer(player_id, p);

        // Notify player via socket if connected
        io.sockets.sockets.forEach(s => {
            if (s.userId === player_id) {
                s.emit('deposit_rejected', {
                    ref,
                    reason: reason || 'We could not verify your transaction. Please contact support.'
                });
            }
        });

        console.log(`[Admin ❌ Deposit] ${player_id.slice(0,8)} rejected ${ref}`);
        res.json({ status: 'rejected' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/admin/complete-withdrawal ───────────────────────────
app.post('/api/admin/complete-withdrawal', adminAuth, async (req, res) => {
    const { player_id, ref } = req.body;
    if (!player_id || !ref) return res.status(400).json({ error: 'player_id and ref required' });

    try {
        const p = await getPlayer(player_id);
        const tx = p.transactions.find(t => t.id === ref && t.type === 'withdraw_request');
        if (!tx) return res.status(404).json({ error: 'Withdrawal request not found' });
        if (tx.status === 'completed') return res.status(400).json({ error: 'Already completed' });

        tx.status      = 'completed';
        tx.type        = 'withdraw';
        tx.completedAt = new Date().toISOString();
        await savePlayer(player_id, p);

        io.sockets.sockets.forEach(s => {
            if (s.userId === player_id) {
                s.emit('withdrawal_sent', { ref, amount: tx.amount, phone: tx.phone });
            }
        });

        console.log(`[Admin ✅ Withdraw] ${player_id.slice(0,8)} ZK${tx.amount} → ${tx.phone}`);
        res.json({ status: 'completed', amount: tx.amount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/admin/cancel-withdrawal ────────────────────────────
// Refunds the player if withdrawal can't be processed
app.post('/api/admin/cancel-withdrawal', adminAuth, async (req, res) => {
    const { player_id, ref, reason } = req.body;
    if (!player_id || !ref) return res.status(400).json({ error: 'player_id and ref required' });

    try {
        const p = await getPlayer(player_id);
        const tx = p.transactions.find(t => t.id === ref && t.type === 'withdraw_request');
        if (!tx) return res.status(404).json({ error: 'Not found' });

        // Refund the reserved amount including fee
        p.balance  = fmt(p.balance + tx.amount + (tx.fee || 0));
        tx.status  = 'cancelled';
        tx.reason  = reason || 'Cancelled by admin';
        await savePlayer(player_id, p);
        pushBalance(player_id, p.balance);

        io.sockets.sockets.forEach(s => {
            if (s.userId === player_id) {
                s.emit('withdrawal_cancelled', { ref, reason: tx.reason });
            }
        });

        console.log(`[Admin ↩ Withdraw] Refunded ${player_id.slice(0,8)} ZK${tx.amount}`);
        res.json({ status: 'cancelled', refunded: tx.amount, newBalance: p.balance });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /admin ────────────────────────────────────────────────────
// Static page. It contains no secrets: the key is typed in and sent as a header.
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>KBA Admin</title>
<style>
:root{--bg:#060912;--surface:#0d1525;--border:rgba(255,255,255,0.08);--green:#10b981;--red:#ef4444;--amber:#f59e0b;--cyan:#00e5ff;--text:#f8fafc;--muted:#64748b;}
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,sans-serif;}
body{background:var(--bg);color:var(--text);min-height:100vh;padding:20px;}
h1{font-size:1.3rem;font-weight:800;margin-bottom:4px;}
.sub{font-size:0.78rem;color:var(--muted);margin-bottom:24px;}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;flex:1;min-width:120px;}
.stat-val{font-size:1.6rem;font-weight:800;}
.stat-lbl{font-size:0.68rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-top:2px;}
h2{font-size:0.85rem;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:var(--muted);margin-bottom:12px;}
.section{margin-bottom:32px;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
.badge{padding:3px 10px;border-radius:99px;font-size:0.68rem;font-weight:700;text-transform:uppercase;}
.badge-dep{background:rgba(16,185,129,0.15);color:var(--green);}
.badge-wd{background:rgba(59,130,246,0.15);color:#60a5fa;}
.info{flex:1;min-width:180px;}
.info-main{font-size:0.9rem;font-weight:700;}
.info-sub{font-size:0.74rem;color:var(--muted);margin-top:3px;line-height:1.6;}
.amount{font-size:1.1rem;font-weight:800;color:var(--green);white-space:nowrap;}
.actions{display:flex;gap:8px;flex-wrap:wrap;}
.btn{border:none;border-radius:9px;padding:10px 16px;font-weight:700;font-size:0.8rem;cursor:pointer;color:#fff;}
.b-ok{background:linear-gradient(135deg,#10b981,#047857);}
.b-sent{background:linear-gradient(135deg,#3b82f6,#1d4ed8);}
.b-no{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:var(--red);}
.b-ref{background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);color:var(--amber);}
.empty{text-align:center;padding:28px;color:var(--muted);font-size:0.82rem;}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--green);color:#fff;padding:12px 24px;border-radius:12px;font-weight:700;font-size:0.85rem;opacity:0;transition:opacity 0.3s;pointer-events:none;}
.toast.show{opacity:1;}
.ref-box{background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:7px;padding:3px 9px;font-size:0.74rem;color:var(--cyan);font-family:monospace;word-break:break-all;}
</style></head><body>
<h1>KBA Admin Panel</h1>
<p class="sub">Kwacha Balloon Adventures - Vyeta Digital Solutions</p>
<div class="stats">
  <div class="stat"><div class="stat-val" id="s-dep">-</div><div class="stat-lbl">Pending deposits</div></div>
  <div class="stat"><div class="stat-val" id="s-wd">-</div><div class="stat-lbl">Pending withdrawals</div></div>
  <div class="stat"><div class="stat-val" id="s-bets">-</div><div class="stat-lbl">Active bets</div></div>
  <div class="stat"><div class="stat-val" id="s-stage">-</div><div class="stat-lbl">Game stage</div></div>
</div>
<div class="section"><h2>Pending deposits</h2><div id="dl"></div></div>
<div class="section"><h2>Pending withdrawals</h2><div id="wl"></div></div>
<div class="toast" id="toast"></div>
<script>
var KEY = sessionStorage.getItem('kba_admin_key') || '';
function el(t, c, x){ var e = document.createElement(t); if (c) e.className = c; if (x !== undefined && x !== null) e.textContent = x; return e; }
function toast(m, ok){ var t = document.getElementById('toast'); t.textContent = m; t.style.background = ok === false ? '#ef4444' : '#10b981'; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 3000); }
function ago(iso){ var d = Math.round((Date.now() - new Date(iso)) / 60000); if (d < 1) return 'just now'; if (d < 60) return d + 'm ago'; var h = Math.round(d / 60); if (h < 24) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
function askKey(){ var k = prompt('Admin key:'); if (k){ KEY = k; sessionStorage.setItem('kba_admin_key', k); } return !!k; }
function api(method, path, body){
  return fetch(path, { method: method, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY }, body: body ? JSON.stringify(body) : undefined })
    .then(function(r){
      if (r.status === 401 || r.status === 503){ return r.json().then(function(j){ sessionStorage.removeItem('kba_admin_key'); KEY = ''; throw new Error(j.error || 'Unauthorised'); }); }
      return r.json();
    });
}
function card(kind, x){
  var c = el('div', 'card');
  c.appendChild(el('span', 'badge ' + (kind === 'dep' ? 'badge-dep' : 'badge-wd'), kind === 'dep' ? 'Deposit' : 'Withdrawal'));
  var info = el('div', 'info');
  info.appendChild(el('div', 'info-main', 'Pilot ' + x.player_short + ' - ' + String(x.operator).toUpperCase()));
  var sub = el('div', 'info-sub');
  if (kind === 'dep'){
    sub.appendChild(document.createTextNode('Their phone: ' + x.phone)); sub.appendChild(el('br'));
    sub.appendChild(document.createTextNode('Their ref: ')); sub.appendChild(el('span', 'ref-box', x.player_tx_ref));
  } else {
    sub.appendChild(document.createTextNode('Send to: ')); sub.appendChild(el('strong', null, x.phone));
  }
  sub.appendChild(el('br')); sub.appendChild(document.createTextNode(ago(x.createdAt)));
  info.appendChild(sub); c.appendChild(info);
  c.appendChild(el('div', 'amount', 'ZK ' + Number(x.amount).toFixed(2)));
  var a = el('div', 'actions');
  if (kind === 'dep'){
    var ok = el('button', 'btn b-ok', 'Approve');
    ok.onclick = function(){
      if (!confirm('Approve ZK ' + x.amount + '?\nOnly do this after the money (ref ' + x.player_tx_ref + ') is in your mobile money account.')) return;
      api('POST', '/api/admin/approve-deposit', { player_id: x.player_id, ref: x.ref }).then(function(r){ if (r.status === 'credited') toast('Credited ZK ' + r.amount); else toast(r.error || 'Failed', false); load(); });
    };
    var no = el('button', 'btn b-no', 'Reject');
    no.onclick = function(){
      var why = prompt('Reason (the player will see this):', 'Transaction reference not found');
      if (why === null) return;
      api('POST', '/api/admin/reject-deposit', { player_id: x.player_id, ref: x.ref, reason: why }).then(function(r){ toast(r.status === 'rejected' ? 'Rejected' : (r.error || 'Failed'), r.status === 'rejected'); load(); });
    };
    a.appendChild(ok); a.appendChild(no);
  } else {
    var sent = el('button', 'btn b-sent', 'I sent it');
    sent.onclick = function(){
      if (!confirm('Confirm you have sent ZK ' + x.amount + ' to ' + x.phone + '?')) return;
      api('POST', '/api/admin/complete-withdrawal', { player_id: x.player_id, ref: x.ref }).then(function(r){ toast(r.status === 'completed' ? 'Marked as sent' : (r.error || 'Failed'), r.status === 'completed'); load(); });
    };
    var rf = el('button', 'btn b-ref', 'Refund');
    rf.onclick = function(){
      var why = prompt('Reason (player is refunded in full):', 'Unable to process withdrawal');
      if (why === null) return;
      api('POST', '/api/admin/cancel-withdrawal', { player_id: x.player_id, ref: x.ref, reason: why }).then(function(r){ toast(r.status === 'cancelled' ? 'Refunded' : (r.error || 'Failed'), r.status === 'cancelled'); load(); });
    };
    a.appendChild(sent); a.appendChild(rf);
  }
  c.appendChild(a);
  return c;
}
function fill(id, kind, items, emptyMsg){
  var box = document.getElementById(id); box.textContent = '';
  if (!items.length){ box.appendChild(el('div', 'empty', emptyMsg)); return; }
  items.forEach(function(x){ box.appendChild(card(kind, x)); });
}
function load(){
  if (!KEY && !askKey()) return;
  api('GET', '/api/admin/requests').then(function(d){
    document.getElementById('s-dep').textContent = d.deposits.length;
    document.getElementById('s-wd').textContent = d.withdrawals.length;
    document.getElementById('s-bets').textContent = d.game.active_bets;
    document.getElementById('s-stage').textContent = d.game.status;
    fill('dl', 'dep', d.deposits, 'No pending deposits');
    fill('wl', 'wd', d.withdrawals, 'No pending withdrawals');
  }).catch(function(e){ toast(e.message, false); });
}
load();
setInterval(function(){ if (KEY) load(); }, 20000);
</script></body></html>`;

app.get('/admin', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.type('html').send(ADMIN_HTML);
});

// ═══════════════════════════════════════════════════════════════════
//  SOCKET.IO — REAL-TIME GAME
// ═══════════════════════════════════════════════════════════════════

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!validId(token)) return next(new Error('Authentication failed: invalid token'));
    socket.userId        = token;
    socket.pilotCallsign = `Pilot-${token.slice(0, 6).toUpperCase()}`;
    socket.isDemo        = token.startsWith('demo_');
    next();
});

io.on('connection', async (socket) => {
    let p;
    try {
        p = await getPlayer(socket.userId);
        // Give new players their starting balance
        if (p.balance === 0 && p.transactions.length === 0) {
            p.balance = socket.isDemo ? DEMO_BALANCE : 0;
            if (socket.isDemo) {
                p.transactions.unshift({
                    id:        `DEMO-${uuidv4()}`,
                    type:      'demo_credit',
                    amount:    DEMO_BALANCE,
                    status:    'completed',
                    createdAt: new Date().toISOString()
                });
                await savePlayer(socket.userId, p);
            }
        }
    } catch (e) {
        p = { balance: socket.isDemo ? DEMO_BALANCE : 0, transactions: [], pendingDeposits: {} };
    }

    socket.emit('initial_state', {
        balance:      p.balance,
        callsign:     socket.pilotCallsign,
        currentStage: gameStatus,
        isDemo:       socket.isDemo
    });

    // ── Place Bet ──────────────────────────────────────────────────
    socket.on('place_bet', async (data) => {
        if (gameStatus !== 'BETTING') {
            return socket.emit('error_message', { message: 'Betting is closed for this round.' });
        }
        if (activeRoundBets.has(socket.userId)) {
            return socket.emit('error_message', { message: 'You already have a bet this round.' });
        }

        const amount = fmt(parseFloat(data && data.amount));
        if (isNaN(amount) || amount < 1) {
            return socket.emit('error_message', { message: 'Minimum bet is ZK 1.' });
        }
        if (amount > 10000) {
            return socket.emit('error_message', { message: 'Maximum bet is ZK 10,000.' });
        }

        const craft = ['balloon', 'lwango', 'broom'].includes(data.vehicle) ? data.vehicle : 'balloon';
        // Reserve the slot immediately so a double-tap cannot place two bets
        activeRoundBets.set(socket.userId, {
            amount, vehicle: craft, callsign: socket.pilotCallsign, isDemo: socket.isDemo
        });

        let player;
        try {
            player = await getPlayer(socket.userId);
        } catch (e) {
            activeRoundBets.delete(socket.userId);
            return socket.emit('error_message', { message: 'Could not verify balance. Try again.' });
        }

        if (amount > player.balance) {
            activeRoundBets.delete(socket.userId);
            return socket.emit('error_message', {
                message: `Insufficient balance. You have ZK ${player.balance.toFixed(2)}.`
            });
        }

        player.balance = fmt(player.balance - amount);
        player.transactions.unshift({
            id:        `BET-${uuidv4()}`,
            type:      'bet',
            amount,
            status:    'placed',
            createdAt: new Date().toISOString()
        });
        await savePlayer(socket.userId, player);

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
            player         = await getPlayer(socket.userId);
            player.balance = fmt(player.balance + payout);
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
            activeRoundBets.set(socket.userId, bet);
            return socket.emit('error_message', { message: 'Could not process cash out. Tap again.' });
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

    // ── Demo refill: free-play players can top their play money back up ──
    let lastRefill = 0;
    socket.on('demo_refill', async () => {
        if (!socket.isDemo) return;
        if (Date.now() - lastRefill < 5000) return;
        lastRefill = Date.now();
        if (activeRoundBets.has(socket.userId)) return;
        try {
            const dp = await getPlayer(socket.userId);
            if (dp.balance >= 10) return;
            dp.balance = DEMO_BALANCE;
            dp.transactions.unshift({
                id: `DEMO-${uuidv4()}`, type: 'demo_credit', amount: DEMO_BALANCE,
                status: 'completed', createdAt: new Date().toISOString()
            });
            await savePlayer(socket.userId, dp);
            socket.emit('balance_update', { balance: dp.balance });
        } catch (e) {
            console.error('[demo_refill]', e.message);
        }
    });

    socket.on('disconnect', () => {});
});

// ═══════════════════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════════════════

function startNewRound() {
    activeRoundBets.clear();
    gameStatus        = 'BETTING';
    currentMultiplier = 1.00;
    crashPoint        = generateCrashPoint();

    // SECURITY: Never log the crash point — it's visible in Render logs
    console.log(`[Game] New round started`);

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
    // Log crash point AFTER it has already happened — safe to log now
    console.log(`[Game] Crashed at ${at.toFixed(2)}x`);

    setTimeout(startNewRound, 5000);
}

// ═══════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log(` Kwacha Balloon Adventures — Port ${PORT}`);
    console.log(` RTP:           ${((1 - HOUSE_EDGE) * 100).toFixed(0)}%  (House edge: ${(HOUSE_EDGE * 100).toFixed(0)}%)`);
    console.log(` Supabase:      ${supabase ? '✅ Connected' : '⚠️  Not set — using in-memory (dev only)'}`);
    console.log(` Admin panel:   ${ADMIN_KEY ? '/admin  (key set)' : 'DISABLED - set ADMIN_KEY in Render env'}`);
    console.log(` Payment mode:  Manual (${Object.keys(PAYMENT_CONFIG).join(', ')})`);
    console.log('═══════════════════════════════════════════════════');
    startNewRound();
});
