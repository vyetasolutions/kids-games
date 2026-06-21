const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;

// --- GAME STATE & USER LEDGER ---
let gameLoopInterval;
let currentMultiplier = 1.00;
let isGameRunning = false;
let crashPoint = 1.00;
let bettingPhase = true; // Tracks if players can bet before takeoff

// Virtual database for testing (resets if server sleeps)
let playerBalances = {}; 
let activeBets = {}; // Stores { socketId: betAmount }

function generateCrashPoint() {
  const rand = Math.random();
  if (rand < 0.03) return 1.00; // 3% House Edge
  return parseFloat((1.01 + (0.01 / (1 - Math.random()))).toFixed(2));
}

function startBettingPhase() {
  bettingPhase = true;
  isGameRunning = false;
  currentMultiplier = 1.00;
  activeBets = {}; // Clear old bets
  
  io.emit('betting_phase_started', { duration: 6000 });
  
  setTimeout(() => {
    takeOff();
  }, 6000);
}

function takeOff() {
  bettingPhase = false;
  isGameRunning = true;
  crashPoint = generateCrashPoint();
  
  io.emit('game_started', { message: "The plane has departed!" });

  gameLoopInterval = setInterval(() => {
    let increment = 0.01 * Math.pow(currentMultiplier, 0.4);
    currentMultiplier = parseFloat((currentMultiplier + increment).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      handleCrash();
    } else {
      io.emit('multiplier_tick', { multiplier: currentMultiplier });
    }
  }, 100);
}

function handleCrash() {
  clearInterval(gameLoopInterval);
  isGameRunning = false;
  
  io.emit('game_crashed', { crashedAt: crashPoint });

  // Start the next betting phase automatically
  setTimeout(() => {
    startBettingPhase();
  }, 4000);
}

// --- WEBSOCKET EVENT HANDLING ---
io.on('connection', (socket) => {
  // Give every new connection a starting balance of $1,000 play money
  playerBalances[socket.id] = 1000.00;
  
  socket.emit('initial_state', {
    isGameRunning,
    bettingPhase,
    currentMultiplier,
    balance: playerBalances[socket.id]
  });

  // Handle a player placing a bet
  socket.on('place_bet', (data) => {
    const betAmount = parseFloat(data.amount);
    
    if (!bettingPhase) {
      return socket.emit('error_message', { message: "Flight already departed! Wait for next round." });
    }
    if (activeBets[socket.id]) {
      return socket.emit('error_message', { message: "Bet already placed for this round." });
    }
    if (playerBalances[socket.id] < betAmount || betAmount <= 0) {
      return socket.emit('error_message', { message: "Insufficient balance or invalid bet." });
    }

    // Deduct stake and register bet securely on the server
    playerBalances[socket.id] -= betAmount;
    activeBets[socket.id] = betAmount;

    socket.emit('bet_confirmed', { balance: playerBalances[socket.id], betAmount });
    io.emit('ledger_update', { message: `Player placed a $${betAmount} bet.` });
  });

  // Handle a player cashing out mid-flight
  socket.on('cash_out', () => {
    if (!isGameRunning || !activeBets[socket.id]) return;

    const stake = activeBets[socket.id];
    const winnings = parseFloat((stake * currentMultiplier).toFixed(2));
    
    // Credit player balance and remove active bet
    playerBalances[socket.id] += winnings;
    delete activeBets[socket.id];

    socket.emit('cash_out_success', { 
      balance: playerBalances[socket.id], 
      winnings, 
      multiplier: currentMultiplier 
    });
    
    io.emit('ledger_update', { message: `Player cashed out $${winnings} at ${currentMultiplier}x!` });
  });

  socket.on('disconnect', () => {
    delete playerBalances[socket.id];
    delete activeBets[socket.id];
  });
});

app.get('/', (req, res) => { res.send('Game core with ledger running.'); });
server.listen(PORT, () => { startBettingPhase(); });
