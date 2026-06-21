const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow our GitHub Pages frontend to connect safely
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// --- GAME STATE VARIABLES ---
let gameLoopInterval;
let currentMultiplier = 1.00;
let isGameRunning = false;
let crashPoint = 1.00;

// --- CORE GAME ENGINE LOGIC ---

function generateCrashPoint() {
  const rand = Math.random();
  // 3% house edge: Instant crash at 1.00x
  if (rand < 0.03) return 1.00; 
  
  // Mathematical curve for classic crash games
  return parseFloat((1.01 + (0.01 / (1 - Math.random()))).toFixed(2));
}

function startRound() {
  isGameRunning = true;
  currentMultiplier = 1.00;
  crashPoint = generateCrashPoint();
  
  console.log(`\n--- New Round Started! Target Crash Point: ${crashPoint}x ---`);
  
  // Broadcast to all connected players that a new flight has taken off
  io.emit('game_started', { message: "The plane has taken off!" });

  // Update the multiplier every 100 milliseconds (10 times a second)
  gameLoopInterval = setInterval(() => {
    // Scale speed upward slightly as the multiplier grows higher
    let increment = 0.01 * Math.pow(currentMultiplier, 0.4);
    currentMultiplier = parseFloat((currentMultiplier + increment).toFixed(2));

    if (currentMultiplier >= crashPoint) {
      handleCrash();
    } else {
      // Stream the live, running tick to every open browser tab instantly
      io.emit('multiplier_tick', { multiplier: currentMultiplier });
    }
  }, 100);
}

function handleCrash() {
  clearInterval(gameLoopInterval);
  isGameRunning = false;
  
  console.log(`💥 Game Crashed at ${crashPoint}x!`);
  io.emit('game_crashed', { crashedAt: crashPoint });

  // 6-second cooling period/betting phase before the next plane takes off
  setTimeout(() => {
    startRound();
  }, 6000);
}

// --- WEBSOCKET CONNECTION HANDLING ---
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Immediately hand the newly connected player the current live state
  socket.emit('initial_state', {
    isGameRunning,
    currentMultiplier
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

app.get('/', (req, res) => {
  res.send('The Aviator Real-Time WebSocket Core is running perfectly.');
});

// Start our unified HTTP & WebSocket Server
server.listen(PORT, () => {
  console.log(`Game engine active and broadcasting on port ${PORT}`);
});

// Kickstart the very first game round instantly when the server boots
startRound();
