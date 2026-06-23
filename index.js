/**
 * Vyeta Kwacha Balloon Adventures - Real-Time Game Logic Engine
 * Architecture Framework: Express / Native Node HTTP / Socket.io Engine Cache Wrapper
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Server operational system tracking boundaries
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// High Performance Local Micro-Cache Storage (Eliminates database round-trip performance bottlenecks)
let playerBalances = new Map();
let activeRoundBets = new Map();

// Game Lifecycle Loop State Flags Configuration Elements
let gameStatus = "BETTING"; // BETTING, IN_FLIGHT, CRASHED
let currentMultiplier = 1.00;
let lifecycleIntervalLoop = null;
let targetCrashSecretPoint = 1.00;

// Universal Status Check Entry Endpoint Route
app.get('/health', (req, res) => {
    res.json({ status: "online", activePlayers: playerBalances.size, stage: gameStatus });
});

// Authentication Validation Layer Handshake Protocol Implementation Hook
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication handshake sequence denied: missing identity payload."));
    }
    // Attach clean callsign attributes parsing context maps tracking records safely
    socket.userId = token;
    socket.pilotCallsign = token.startsWith("anon_") 
        ? `Pilot-${token.substring(5, 9).toUpperCase()}` 
        : `Captain-${token.substring(0, 4).toUpperCase()}`;
    next();
});

// Core Socket Event Communication Handling Mesh Grid Configuration Layer
io.on('connection', (socket) => {
    // Synchronize balance registration tracking loops
    if (!playerBalances.has(socket.userId)) {
        playerBalances.set(socket.userId, 5000.00); // Starter credits deployment bankrolls: ZK 5,000
    }

    // Immediately push down complete initial state metrics packet arrays
    socket.emit('initial_state', {
        balance: playerBalances.get(socket.userId),
        callsign: socket.pilotCallsign,
        currentStage: gameStatus
    });

    // Handle ticket purchase commitments
    socket.on('place_bet', (data) => {
        if (gameStatus !== "BETTING") {
            return socket.emit('error', 'Flight ticket sales closed for this running round segment.');
        }
        if (activeRoundBets.has(socket.userId)) {
            return socket.emit('error', 'You have already secured a cabin room location allocation row.');
        }

        const amount = parseFloat(data.amount);
        const currentBalance = playerBalances.get(socket.userId);

        if (isNaN(amount) || amount <= 0 || amount > currentBalance) {
            return socket.emit('error', 'Invalid currency financial structure requested.');
        }

        // Fast In-Memory Upsert Mutation Loop (Instantaneous execution processing map)
        const updatedBalance = currentBalance - amount;
        playerBalances.set(socket.userId, updatedBalance);
        activeRoundBets.set(socket.userId, {
            amount: amount,
            vehicle: data.vehicle || 'balloon',
            callsign: socket.pilotCallsign
        });

        socket.emit('bet_confirmed', { newBalance: updatedBalance });
        socket.broadcast.emit('ledger_update', `${socket.pilotCallsign} purchased a flight ticket using a ${data.vehicle || 'craft'}`);
    });

    // Handle Cash out processing triggers safely
    socket.on('cash_out', () => {
        if (gameStatus !== "IN_FLIGHT") {
            return socket.emit('error', 'Cannot process flight settlement mechanics outside dynamic navigation operations.');
        }
        if (!activeRoundBets.has(socket.userId)) {
            return socket.emit('error', 'No active flight record identified matching this session parameter.');
        }

        const betData = activeRoundBets.get(socket.userId);
        const payout = betData.amount * currentMultiplier;
        const finalBalance = playerBalances.get(socket.userId) + payout;

        playerBalances.set(socket.userId, finalBalance);
        activeRoundBets.delete(socket.userId); // Erase reference to prevent race conditions mutations

        socket.emit('cash_out_success', {
            payout: payout,
            atMultiplier: currentMultiplier,
            newBalance: finalBalance
        });

        socket.broadcast.emit('ledger_update', `${socket.pilotCallsign} safely touched down, securing ZK ${payout.toFixed(2)}!`);
    });

    socket.on('disconnect', () => {
        // Retain allocations on disconnection to protect user balances if they drop signal briefly mid-flight
    });
});

// Run Central Multiplier Game Progression State Machine Core Loops
function initializeNewRoundSequence() {
    activeRoundBets.clear();
    gameStatus = "BETTING";
    currentMultiplier = 1.00;
    
    // Generate randomized crash limit using heavily tested, clean crash game distributions
    targetCrashSecretPoint = generateWeightedCrashThreshold();
    console.log(`[Vyeta Engine] Next flight destination target calculated secret parameter: ${targetCrashSecretPoint.toFixed(2)}x`);

    io.emit('betting_phase_started', { duration: 7000 });

    // Transition from sales to operational active lift-off flight path window after 7 seconds delay bounds
    setTimeout(() => {
        executeFlightLiftOffLoop();
    }, 7000);
}

function executeFlightLiftOffLoop() {
    gameStatus = "IN_FLIGHT";
    io.emit('game_started');

    let processingTickTimestamp = Date.now();

    lifecycleIntervalLoop = setInterval(() => {
        const delta = (Date.now() - processingTickTimestamp) / 1000;
        processingTickTimestamp = Date.now();

        // Advanced fluid acceleration curve formula structure map
        // Scales progress exponentially while keeping the early flight phases comfortable
        const accelerationFactor = 0.065 * Math.pow(currentMultiplier, 0.35);
        currentMultiplier += accelerationFactor * delta * 10;

        if (currentMultiplier >= targetCrashSecretPoint) {
            terminateActiveFlightTrack(targetCrashSecretPoint);
        } else {
            io.emit('multiplier_tick', { multiplier: currentMultiplier });
        }
    }, 90); // 90ms rapid stream updates minimize client coordinate synchronization drift
}

function terminateActiveFlightTrack(finalCrashPoint) {
    clearInterval(lifecycleIntervalLoop);
    gameStatus = "CRASHED";
    
    io.emit('game_crashed', { crashedAt: finalCrashPoint });
    console.log(`[Vyeta Engine] Flight loop concluded at target ${finalCrashPoint.toFixed(2)}x. Resetting layouts.`);

    // Leave terminal status layout on screen for a moment before clearing next stage preparations loop
    setTimeout(() => {
        initializeNewRoundSequence();
    }, 5000);
}

function generateWeightedCrashThreshold() {
    const rand = Math.random();
    // 3% instant-house edge crash right out of the box (1.00x)
    if (rand < 0.03) return 1.00;
    // 55% standard flight operational ceiling boundaries
    if (rand < 0.58) return 1.01 + (Math.random() * 1.8);
    // 32% mid-altitude exploration achievements scaling up to 7x multiplier
    if (rand < 0.90) return 2.8 + (Math.random() * 4.2);
    // 10% elite lunar hyper-speed milestones running up bounds to astronomical ranges
    return 7.0 + (Math.random() * 45.0);
}

// Start Main Cluster Engine Thread operations
server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Vyeta Kwacha Balloon Game Engine Live On Port ${PORT}`);
    console.log(` Target Socket Handshake Pipeline: ${SERVER_URL}`);
    console.log(`===================================================`);
    initializeNewRoundSequence();
});
