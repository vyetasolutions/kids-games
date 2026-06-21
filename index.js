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

// --- BOUNCER MIDDLEWARE ---
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error: No session found."));

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
    setTimeout(startBettingPhase, 4000);
}

// --- WEBSOCKET EVENT HANDLING ---
io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`User connected: ${socket.user.email}`);

    // Set default balance if player is new
    if (playerBalances[userId] === undefined) playerBalances[userId] = 1000.00;
  
    socket.emit('initial_state', {
        isGameRunning,
        bettingPhase,
        currentMultiplier,
        balance: playerBalances[userId]
    });

    socket.on('place_bet', (data) => {
        const betAmount = parseFloat(data.amount);
        if (!bettingPhase) return socket.emit('error_message', { message: "Flight departed!" });
        if (activeBets[userId]) return socket.emit('error_message', { message: "Bet already placed." });
        if (playerBalances[userId] < betAmount || betAmount <= 0) return socket.emit('error_message', { message: "Invalid bet." });

        playerBalances[userId] -= betAmount;
        activeBets[userId] = betAmount;
        socket.emit('bet_confirmed', { balance: playerBalances[userId], betAmount });
        io.emit('ledger_update', { message: `A player placed a K${betAmount} bet.` });
    });

    socket.on('cash_out', () => {
        if (!isGameRunning || !activeBets[userId]) return;
        const stake = activeBets[userId];
        const winnings = parseFloat((stake * currentMultiplier).toFixed(2));
        
        playerBalances[userId] += winnings;
        delete activeBets[userId];

        socket.emit('cash_out_success', { balance: playerBalances[userId], winnings });
    });

    socket.on('disconnect', () => {
        delete activeBets[userId];
    });
});

app.get('/', (req, res) => res.send('Secure Game Core Active.'));
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startBettingPhase();
});
