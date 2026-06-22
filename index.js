const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;

// --- SUPABASE DATABASE CONNECTION ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // Use your Service Role Key here
let supabase;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Database link established successfully.");
} else {
    console.log("⚠️ Database keys missing. Running in memory-only mode.");
}

// --- GAME STATE ---
let gameLoopInterval;
let currentMultiplier = 1.00;
let isGameRunning = false;
let crashPoint = 1.00;
let bettingPhase = true;

// Persistent storage keyed by User ID
let playerBalances = {}; 
let activeBets = {}; 
let playerNames = {};

function nameFor(socketId) {
    // Simple, anonymous, human-readable callsign — no login required.
    return `Pilot-${socketId.slice(0, 4).toUpperCase()}`;
}

// In-memory cache of balances so the hot gameplay loop never waits on a
// database round trip. The Supabase table is the source of truth across
// restarts/devices; this cache just makes each tick fast.
let balanceCache = {};

async function loadBalance(userId) {
    if (balanceCache[userId] !== undefined) return balanceCache[userId];

    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('player_balances')
                .select('balance')
                .eq('user_id', userId)
                .maybeSingle();
            if (!error && data) {
                balanceCache[userId] = parseFloat(data.balance);
                return balanceCache[userId];
            }
            // New player — create their row with the starting balance.
            await supabase.from('player_balances').insert({ user_id: userId, balance: 1000.00 });
        } catch (e) {
            console.error("Balance load failed, falling back to in-memory:", e.message);
        }
    }

    balanceCache[userId] = 1000.00;
    return balanceCache[userId];
}

function saveBalance(userId, balance) {
    balanceCache[userId] = balance;
    if (!supabase) return; // memory-only mode, nothing to persist
    // Fire-and-forget: don't make the player wait on a DB write mid-flight.
    supabase
        .from('player_balances')
        .upsert({ user_id: userId, balance, updated_at: new Date().toISOString() })
        .then(({ error }) => { if (error) console.error("Balance save failed:", error.message); });
}

// --- BOUNCER MIDDLEWARE ---
// Every connection — including anonymous ones — must carry a valid Supabase
// session token. signInAnonymously() on the frontend issues one automatically,
// with zero forms, so this stays frictionless for the player while still
// giving us a stable user id to track balance against.
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error: No session found."));
    if (!supabase) return next(new Error("Server not configured for auth."));

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error("Invalid token");
        socket.user = user; // Attach user object to socket
        next();
    } catch (e) {
        next(new Error("Authentication failed: Access denied."));
    }
});

// --- GAME CORE FUNCTIONS ---
function generateCrashPoint() {
    const RNG = Math.random() * 100;
    if (RNG <= 10) return parseFloat((1.00 + (Math.random() * 0.2)).toFixed(2));
    if (RNG <= 60) return parseFloat((1.21 + (Math.random() * 2.29)).toFixed(2));
    if (RNG <= 90) return parseFloat((3.51 + (Math.random() * 6.49)).toFixed(2));
    return parseFloat((10.01 + (Math.random() * 89.99)).toFixed(2));
}

function startBettingPhase() {
    bettingPhase = true;
    isGameRunning = false;
    currentMultiplier = 1.00;
    activeBets = {};
    io.emit('betting_phase_started', { duration: 6000 });
    setTimeout(takeOff, 6000);
}

function takeOff() {
    bettingPhase = false;
    isGameRunning = true;
    crashPoint = generateCrashPoint();
    io.emit('game_started');
    gameLoopInterval = setInterval(() => {
        let increment = 0.01 * Math.pow(currentMultiplier, 0.4);
        currentMultiplier = parseFloat((currentMultiplier + increment).toFixed(2));
        if (currentMultiplier >= crashPoint) handleCrash();
        else io.emit('multiplier_tick', { multiplier: currentMultiplier });
    }, 100);
}

function handleCrash() {
    clearInterval(gameLoopInterval);
    isGameRunning = false;
    io.emit('game_crashed', { crashedAt: crashPoint });

    // Let everyone see how many players went down with the flight.
    const lostCount = Object.keys(activeBets).length;
    if (lostCount > 0) {
        io.emit('ledger_update', {
            message: `Flight crashed at ${crashPoint.toFixed(2)}x — ${lostCount} player${lostCount > 1 ? 's' : ''} lost their stake.`,
            type: 'crash'
        });
    }

    setTimeout(startBettingPhase, 4000);
}

// --- WEBSOCKET EVENT HANDLING ---
io.on('connection', async (socket) => {
    const userId = socket.user.id;
    playerNames[userId] = playerNames[userId] || nameFor(userId);
    console.log(`User connected: ${playerNames[userId]} (${userId}, anonymous: ${!!socket.user.is_anonymous})`);

    if (playerBalances[userId] === undefined) {
        playerBalances[userId] = await loadBalance(userId);
    }

    socket.emit('initial_state', {
        isGameRunning,
        bettingPhase,
        currentMultiplier,
        balance: playerBalances[userId],
        yourName: playerNames[userId]
    });

    socket.on('place_bet', (data) => {
        const betAmount = parseFloat(data.amount);
        if (!bettingPhase) return socket.emit('error_message', { message: "Flight departed!" });
        if (activeBets[userId]) return socket.emit('error_message', { message: "Bet already placed." });
        if (playerBalances[userId] < betAmount || betAmount <= 0) return socket.emit('error_message', { message: "Invalid bet." });

        playerBalances[userId] -= betAmount;
        activeBets[userId] = betAmount;
        saveBalance(userId, playerBalances[userId]);
        socket.emit('bet_confirmed', { balance: playerBalances[userId], betAmount });
        io.emit('ledger_update', {
            message: `${playerNames[userId]} bought a ticket for K${betAmount.toFixed(2)}.`,
            type: 'bet'
        });
    });

    socket.on('cash_out', () => {
        if (!isGameRunning || !activeBets[userId]) return;
        const stake = activeBets[userId];
        const winnings = parseFloat((stake * currentMultiplier).toFixed(2));
        
        playerBalances[userId] += winnings;
        delete activeBets[userId];
        saveBalance(userId, playerBalances[userId]);

        socket.emit('cash_out_success', { balance: playerBalances[userId], winnings });
        io.emit('ledger_update', {
            message: `${playerNames[userId]} cashed out at ${currentMultiplier.toFixed(2)}x and collected K${winnings.toFixed(2)}!`,
            type: 'win'
        });
    });

    socket.on('disconnect', () => {
        delete activeBets[userId];
        // Balance and name stay cached by user id, so a refresh/reconnect
        // (even from a different browser, once they've saved an account)
        // picks up right where they left off.
    });
});

app.get('/', (req, res) => res.send('Secure Game Core Active.'));
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startBettingPhase();
});
