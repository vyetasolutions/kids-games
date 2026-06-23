/**
 * Vyeta Kwacha Balloon Adventures - Core Engine Logic Sheet
 * Contains Canvas Renderers, Network Socket managers, and Selection State Hooks.
 */

let socket;
const SERVER_URL = "https://kids-games-o79b.onrender.com";

// --- GLOBAL GAME STATE ---
let currentBalance = 1000.00;
let hasBetInRound = false;
let isInFlight = false;
let globalMultiplier = 1.00;
let gameState = 'waiting'; 
let countdownTimer = null;

// --- AIRCRAFT HANGAR OVERLAY STATE CONTROLLERS ---
let selectedCraft = 'balloon'; // Global state option sets: 'balloon' | 'broomstick' | 'lwango'

// Particle emitter arrays for upgraded vehicle trailing visuals
let craftTrailParticles = []; 

function selectCraft(craftType) {
    selectedCraft = craftType;
    document.querySelectorAll('.craft-grid .craft-card').forEach(card => card.classList.remove('active'));
    const targetCard = document.getElementById(`card-${craftType}`);
    if (targetCard) targetCard.classList.add('active');
    
    // Fire click audio loop feedback context window if initialized
    if (audioCtx) playCashOutSound();
}

function enterFlightDeck() {
    const hangar = document.getElementById('hangarScreen');
    if (hangar) {
        hangar.classList.add('hangar-hidden');
        setTimeout(() => hangar.remove(), 500);
    }
    // Ignite socket network authentication connection safely after user chooses craft
    connectToGame();
}

// Audio System State
let audioCtx = null;
let flightOscillator = null;

// FX Physics Engines
let floatOffset = 0;
let particles = [];
let burstShards = [];
let clouds = [];
let stars = [];
let shockwaveRadius = 0;
let triggerShockwave = false;

const statusText = document.getElementById('status-text');
const balanceDisplay = document.getElementById('balance-display');
const balancePill = document.getElementById('balance-pill');
const multiplierDisplay = document.getElementById('multiplier-display');
const actionBtn = document.getElementById('action-btn');
const betInput = document.getElementById('bet-input');
const ledgerContent = document.getElementById('ledger-content');
const historyStrip = document.getElementById('history-strip');

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    setTimeout(() => {
        if (canvas && canvas.parentElement) {
            canvas.width = canvas.parentElement.clientWidth;
            canvas.height = canvas.parentElement.clientHeight;
            initClouds();
            initStars();
        }
    }, 50);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Smooth wallet animations
let balanceAnimFrame = null;
function animateBalanceTo(newBalance) {
    const startVal = currentBalance;
    const startTime = performance.now();
    const duration = 480;
    if (balanceAnimFrame) cancelAnimationFrame(balanceAnimFrame);
    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const shown = startVal + (newBalance - startVal) * eased;
        if (balanceDisplay) {
            balanceDisplay.innerText = shown.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        if (t < 1) {
            balanceAnimFrame = requestAnimationFrame(step);
        } else {
            currentBalance = newBalance;
        }
    }
    balanceAnimFrame = requestAnimationFrame(step);
}

// Quick stake button handlers
const quickBetChips = document.getElementById('quickBetChips');
if (quickBetChips && betInput) {
    quickBetChips.querySelectorAll('.chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            betInput.value = chip.dataset.amount;
            quickBetChips.querySelectorAll('.chip').forEach(c => c.classList.remove('chip-active'));
            chip.classList.add('chip-active');
        });
    });
    betInput.addEventListener('input', () => {
        quickBetChips.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('chip-active', c.dataset.amount === betInput.value);
        });
    });
}

function addLog(msg, isWin = false) {
    if (!ledgerContent) return;
    const div = document.createElement('div');
    div.className = isWin ? "toast-win" : "toast-normal";
    div.innerText = msg;
    ledgerContent.prepend(div);
    if(ledgerContent.children.length > 12) ledgerContent.removeChild(ledgerContent.lastChild);
}

// --- GAME SOUNDS SYNTH (WEB AUDIO API) ---
function initAudioEngine() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function startFlightSound() {
    try {
        initAudioEngine();
        if(flightOscillator) flightOscillator.stop();
        
        flightOscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        flightOscillator.type = 'sine';
        flightOscillator.frequency.setValueAtTime(120, audioCtx.currentTime); 
        gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime); 
        
        flightOscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        flightOscillator.start();
    } catch(e) { console.log(e); }
}

function updateFlightSound(multiplier) {
    if (flightOscillator && audioCtx) {
        let targetFreq = 120 + (multiplier * 45);
        flightOscillator.frequency.setValueAtTime(Math.min(targetFreq, 800), audioCtx.currentTime);
    }
}

function stopFlightSound() {
    try {
        if (flightOscillator) {
            flightOscillator.stop();
            flightOscillator = null;
        }
    } catch(e){}
}

function playCashOutSound() {
    try {
        initAudioEngine();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.3);
    } catch(e){}
}

function playPopSound() {
    try {
        initAudioEngine();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, audioCtx.currentTime);
        osc.frequency.linearRampToValueAtTime(60, audioCtx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.3);
    } catch(e){}
}

// --- ENVIRONMENTAL RUNTIME PHYSICS ---
function initClouds() {
    clouds = [];
    for(let i = 0; i < 6; i++) {
        clouds.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            size: 25 + Math.random() * 40,
            speed: 0.4 + Math.random() * 1.2,
            opacity: 0.08 + Math.random() * 0.15
        });
    }
}

function initStars() {
    stars = [];
    for(let i=0; i<30; i++) {
        stars.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            size: Math.random() * 2,
            twinkleSpeed: 0.02 + Math.random() * 0.05,
            alpha: Math.random()
        });
    }
}

function drawCloud(x, y, size, opacity) {
    ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.arc(x + size * 0.7, y - size * 0.25, size * 0.8, 0, Math.PI * 2);
    ctx.arc(x + size * 1.4, y, size * 0.8, 0, Math.PI * 2);
    ctx.fill();
}

// Core Central Graphics Vector Loop Engine
function drawScene() {
    let skyGlow = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (globalMultiplier < 2) {
        skyGlow.addColorStop(0, '#1e40af');
        skyGlow.addColorStop(1, '#0f172a');
    } else if (globalMultiplier >= 2 && globalMultiplier < 5) {
        let progress = Math.min((globalMultiplier - 2) / 3, 1);
        let topColor = d3Blend('#1e40af', '#7c2d12', progress);
        let btmColor = d3Blend('#0f172a', '#1e1b4b', progress);
        skyGlow.addColorStop(0, topColor);
        skyGlow.addColorStop(1, btmColor);
    } else {
        skyGlow.addColorStop(0, '#4c1d95');
        skyGlow.addColorStop(1, '#030712');
    }
    ctx.fillStyle = skyGlow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (globalMultiplier > 3.5) {
        stars.forEach(s => {
            s.alpha += s.twinkleSpeed;
            if(s.alpha > 1 || s.alpha < 0) s.twinkleSpeed = -s.twinkleSpeed;
            ctx.fillStyle = `rgba(255,255,255,${Math.max(s.alpha, 0)})`;
            ctx.fillRect(s.x, s.y, s.size, s.size);
            if(gameState === 'flying') s.y += (globalMultiplier * 0.2);
            if(s.y > canvas.height) s.y = 0;
        });
    }

    clouds.forEach(c => {
        drawCloud(c.x, c.y, c.size, c.opacity);
        if(gameState === 'flying') {
            c.y += c.speed * (1 + (globalMultiplier * 0.4));
        } else if (gameState === 'waiting') {
            c.y += c.speed * 0.15;
        }
        if(c.y > canvas.height + 80) {
            c.y = -80; c.x = Math.random() * canvas.width;
        }
    });
    
    let centerX = canvas.width / 2;
    let centerY = canvas.height / 2 + 20;
    
    floatOffset += 0.04;
    if (gameState === 'flying' || gameState === 'waiting') {
        centerY += Math.sin(floatOffset) * 8; 
    }
    
    let balloonSize = 45 + Math.min(globalMultiplier * 9, 95);
    
    if (gameState === 'flying' && multiplierDisplay) {
        let textScale = 1 + Math.min((globalMultiplier - 1) * 0.02, 0.18);
        multiplierDisplay.style.transform = `translateX(-50%) scale(${textScale})`;
    } else if (multiplierDisplay) {
        multiplierDisplay.style.transform = `translateX(-50%) scale(1)`;
    }

    if (globalMultiplier > 3.5 && gameState === 'flying') {
        centerX += (Math.random() - 0.5) * (globalMultiplier * 0.6);
        centerY += (Math.random() - 0.5) * (globalMultiplier * 0.6);
    }

    // --- ENHANCED VEHICLE GRAPHICS ROUTER ---
    if (gameState !== 'crashed') {
        
        // Spawn active motion-tracking sparkles during active flight intervals
        if (gameState === 'flying' && Math.random() < 0.4) {
            let trailColor = selectedCraft === 'balloon' ? '#34d399' : selectedCraft === 'broomstick' ? '#a855f7' : '#60a5fa';
            craftTrailParticles.push({
                x: centerX + (Math.random() - 0.5) * 20,
                y: centerY + balloonSize,
                vx: (Math.random() - 0.5) * 2,
                vy: Math.random() * 3 + 2,
                size: Math.random() * 4 + 1,
                alpha: 1.0
            });
        }

        // Render dynamic asset background engine streams
        for (let i = craftTrailParticles.length - 1; i >= 0; i--) {
            let p = craftTrailParticles[i];
            p.x += p.vx; p.y += p.vy; p.alpha -= 0.02;
            ctx.save();
            ctx.globalAlpha = Math.max(p.alpha, 0);
            ctx.fillStyle = selectedCraft === 'balloon' ? '#fbbf24' : selectedCraft === 'broomstick' ? '#c084fc' : '#34d399';
            ctx.shadowBlur = 8;
            ctx.shadowColor = ctx.fillStyle;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            if (p.alpha <= 0) craftTrailParticles.splice(i, 1);
        }

        switch(selectedCraft) {
            
            case 'broomstick':
                // ==========================================
                // THE NIGHT FLYER (BROOMSTICK) GRAPHICS
                // ==========================================
                ctx.save();
                
                // Draw energy fields behind vehicle
                let broomGlow = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 50);
                broomGlow.addColorStop(0, 'rgba(168, 85, 247, 0.25)');
                broomGlow.addColorStop(1, 'rgba(168, 85, 247, 0)');
                ctx.fillStyle = broomGlow;
                ctx.beginPath();
                ctx.arc(centerX, centerY, 50, 0, Math.PI * 2);
                ctx.fill();

                // Vector Handle Shaft drawing
                ctx.strokeStyle = '#7c2d12'; 
                ctx.lineWidth = 6;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(centerX - 40, centerY + 15);
                ctx.lineTo(centerX + 40, centerY - 15);
                ctx.stroke();

                // Inner core energy line
                ctx.strokeStyle = '#c084fc';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(centerX - 35, centerY + 13);
                ctx.lineTo(centerX + 20, centerY - 7);
                ctx.stroke();

                // Bristle Tail structure
                ctx.fillStyle = '#b45309';
                ctx.beginPath();
                ctx.moveTo(centerX - 35, centerY + 13);
                ctx.lineTo(centerX - 65, centerY + 30);
                ctx.lineTo(centerX - 58, centerY + 10);
                ctx.closePath();
                ctx.fill();
                
                // Bristle Highlights
                ctx.fillStyle = '#f59e0b';
                ctx.beginPath();
                ctx.moveTo(centerX - 38, centerY + 14);
                ctx.lineTo(centerX - 62, centerY + 24);
                ctx.lineTo(centerX - 58, centerY + 16);
                ctx.closePath();
                ctx.fill();

                // Pilot Passenger Node Accent Overlay
                ctx.font = "24px sans-serif";
                ctx.fillText("✨", centerX - 5, centerY - 10);
                
                ctx.restore();
                break;

            case 'lwango':
                // ==========================================
                // THE TRADITIONAL LWANGO BASKET GRAPHICS
                // ==========================================
                ctx.save();
                
                let lwangoBase = 32 + Math.min(globalMultiplier * 5, 45);
                
                // Levitational energy vertical vector ring offsets
                let pulseOffset = Math.sin(Date.now() * 0.008) * 6;

                // Draw external mystic vortex rings below basket
                ctx.beginPath();
                ctx.ellipse(centerX, centerY + 18 + pulseOffset, lwangoBase * 0.9, lwangoBase * 0.22, 0, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(52, 211, 153, ${0.4 + Math.sin(Date.now() * 0.01) * 0.25})`;
                ctx.lineWidth = 3;
                ctx.shadowBlur = 10;
                ctx.shadowColor = '#34d399';
                ctx.stroke();

                // Main woven wicker dish hull base structure
                ctx.beginPath();
                ctx.ellipse(centerX, centerY + 4, lwangoBase, lwangoBase * 0.4, 0, 0, Math.PI * 2);
                let basketGrad = ctx.createLinearGradient(centerX - lwangoBase, centerY, centerX + lwangoBase, centerY);
                basketGrad.addColorStop(0, '#7c2d12');
                basketGrad.addColorStop(0.5, '#9a3412');
                basketGrad.addColorStop(1, '#431407');
                ctx.fillStyle = basketGrad;
                ctx.fill();
                ctx.strokeStyle = '#ea580c';
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // Cross-hatched native woven structural alignment maps
                ctx.strokeStyle = 'rgba(251, 191, 36, 0.25)';
                ctx.lineWidth = 1;
                for(let j = -lwangoBase + 10; j < lwangoBase; j += 12) {
                    ctx.beginPath();
                    ctx.moveTo(centerX + j, centerY - 6);
                    ctx.lineTo(centerX + j * 0.6, centerY + 12);
                    ctx.stroke();
                }

                // Core pilot aura glow node indicator
                ctx.fillStyle = '#fff';
                ctx.font = "22px sans-serif";
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("⚡", centerX, centerY - 10);
                
                ctx.restore();
                break;

            case 'balloon':
            default:
                // ==========================================
                // STANDARD CLASSIC BALLOON ENGINE 
                // ==========================================
                let colorGlow = ctx.createLinearGradient(centerX - balloonSize, centerY - balloonSize, centerX + balloonSize, centerY + balloonSize);
                if (globalMultiplier < 2) {
                    colorGlow.addColorStop(0, 'rgba(59,130,246,0.40)'); colorGlow.addColorStop(1, 'rgba(29,78,216,0.40)');
                } else if (globalMultiplier < 5) {
                    colorGlow.addColorStop(0, 'rgba(245,158,11,0.32)'); colorGlow.addColorStop(1, 'rgba(180,83,9,0.32)');
                } else {
                    colorGlow.addColorStop(0, 'rgba(239,68,68,0.40)'); colorGlow.addColorStop(1, 'rgba(185,28,28,0.40)');
                }

                // Ropes
                ctx.beginPath();
                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
                ctx.lineWidth = 1.5;
                ctx.moveTo(centerX - balloonSize * 0.25, centerY + balloonSize * 0.4);
                ctx.lineTo(centerX - 14, centerY + balloonSize + 18);
                ctx.moveTo(centerX + balloonSize * 0.25, centerY + balloonSize * 0.4);
                ctx.lineTo(centerX + 14, centerY + balloonSize + 18);
                ctx.stroke();

                // Basket
                ctx.fillStyle = '#5c4128';
                ctx.beginPath();
                ctx.roundRect(centerX - 16, centerY + balloonSize + 18, 32, 22, 5);
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(centerX - 16, centerY + balloonSize + 26);
                ctx.lineTo(centerX + 16, centerY + balloonSize + 26);
                ctx.stroke();

                // Flame flicker
                const flameFlicker = 0.85 + Math.sin(Date.now() * 0.02) * 0.15;
                let flameGrad = ctx.createRadialGradient(centerX, centerY + balloonSize + 10, 1, centerX, centerY + balloonSize + 14, 12);
                flameGrad.addColorStop(0, '#fff7d6');
                flameGrad.addColorStop(0.55, '#fbbf24');
                flameGrad.addColorStop(1, 'rgba(234,88,12,0)');
                ctx.save();
                ctx.globalAlpha = flameFlicker;
                ctx.beginPath();
                ctx.ellipse(centerX, centerY + balloonSize + 10, 6, 9 * flameFlicker, 0, 0, Math.PI * 2);
                ctx.fillStyle = flameGrad;
                ctx.fill();
                ctx.restore();

                // Canopy: gold/green panels, clipped to circle matrix
                ctx.save();
                ctx.beginPath();
                ctx.arc(centerX, centerY, balloonSize, 0, Math.PI * 2);
                ctx.clip();
                const stripeCount = 10;
                const stripeW = (balloonSize * 2) / stripeCount;
                for (let i = 0; i < stripeCount; i++) {
                    const sx = centerX - balloonSize + i * stripeW;
                    let goreGrad = ctx.createLinearGradient(0, centerY - balloonSize, 0, centerY + balloonSize);
                    if (i % 2 === 0) {
                        goreGrad.addColorStop(0, '#fde68a'); goreGrad.addColorStop(1, '#f59e0b');
                    } else {
                        goreGrad.addColorStop(0, '#6ee7b7'); goreGrad.addColorStop(1, '#10b981');
                    }
                    ctx.fillStyle = goreGrad;
                    ctx.fillRect(sx, centerY - balloonSize, stripeW, balloonSize * 2);
                }
                ctx.fillStyle = colorGlow;
                ctx.fillRect(centerX - balloonSize, centerY - balloonSize, balloonSize * 2, balloonSize * 2);
                ctx.beginPath();
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                ctx.arc(centerX - balloonSize * 0.28, centerY - balloonSize * 0.28, balloonSize * 0.45, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                ctx.beginPath();
                ctx.strokeStyle = 'rgba(0,0,0,0.25)';
                ctx.lineWidth = 1.5;
                ctx.arc(centerX, centerY, balloonSize, 0, Math.PI * 2);
                ctx.stroke();

                // Central 'K' Signet Badge
                ctx.beginPath();
                ctx.fillStyle = 'rgba(11,18,32,0.85)';
                ctx.arc(centerX, centerY - balloonSize * 0.05, balloonSize * 0.32, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fbbf24';
                ctx.font = `900 ${Math.max(balloonSize * 0.42, 16)}px Sora, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('K', centerX, centerY - balloonSize * 0.02);
                break;
        }
    }

    // SHOCKWAVE ACTION
    if (triggerShockwave) {
        shockwaveRadius += 14;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(52, 211, 153, ${Math.max(1 - (shockwaveRadius / 280), 0)})`;
        ctx.lineWidth = 5;
        ctx.arc(centerX, centerY, shockwaveRadius, 0, Math.PI * 2);
        ctx.stroke();
        if (shockwaveRadius > 280) triggerShockwave = false;
    }

    // WALLET FLYING PARTICLES
    let targetX = canvas.width - 40;
    let targetY = -20; 
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i]; p.x += (targetX - p.x) * 0.12; p.y += (targetY - p.y) * 0.12; p.alpha -= 0.006;
        ctx.save(); ctx.globalAlpha = Math.max(p.alpha, 0); ctx.fillStyle = '#34d399'; ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        if (Math.abs(p.x - targetX) < 25 && Math.abs(p.y - targetY) < 25) {
            particles.splice(i, 1);
            if (balancePill) {
                balancePill.style.transform = "scale(1.1)";
                setTimeout(() => balancePill.style.transform = "scale(1)", 120);
            }
        }
    }

    // EXPLOSION SPLINTER SHARDS
    for (let i = burstShards.length - 1; i >= 0; i--) {
        let s = burstShards[i]; s.x += s.vx; s.y += s.vy; s.vy += 0.18; s.alpha -= 0.018;
        ctx.save(); ctx.globalAlpha = Math.max(s.alpha, 0); ctx.fillStyle = s.color; ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        if (s.alpha <= 0) burstShards.splice(i, 1);
    }

    requestAnimationFrame(drawScene);
}
requestAnimationFrame(drawScene);

function d3Blend(c1, c2, p) {
    const f = parseInt(c1.slice(1), 16), t = parseInt(c2.slice(1), 16),
          R1 = f >> 16, G1 = f >> 8 & 0x00FF, B1 = f & 0x0000FF,
          R2 = t >> 16, G2 = t >> 8 & 0x00FF, B2 = t & 0x0000FF;
    return "#" + (0x1000000 + (Math.round((R2 - R1) * p) + R1) * 0x10000 + (Math.round((G2 - G1) * p) + G1) * 0x100 + (Math.round((B2 - B1) * p) + B1)).toString(16).slice(1);
}

function triggerWinAnimation() {
    shockwaveRadius = 0; triggerShockwave = true;
    let startX = canvas.width / 2; let startY = canvas.height / 2 + 20 + Math.sin(floatOffset) * 8;
    for(let i=0; i<25; i++) {
        particles.push({ x: startX + (Math.random() - 0.5) * 35, y: startY + (Math.random() - 0.5) * 35, size: Math.random() * 5 + 3, alpha: 1.4 });
    }
}

function triggerBurstAnimation() {
    let startX = canvas.width / 2; let startY = canvas.height / 2 + 20 + Math.sin(floatOffset) * 8;
    let fragmentColor = globalMultiplier < 2 ? '#3b82f6' : globalMultiplier < 5 ? '#f59e0b' : '#ef4444';
    for (let i = 0; i < 45; i++) {
        let angle = Math.random() * Math.PI * 2; let speed = Math.random() * 9 + 2;
        burstShards.push({ x: startX, y: startY, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: Math.random() * 7 + 2, color: fragmentColor, alpha: 1.0 });
    }
}

function appendHistoryBadge(val) {
    if (!historyStrip) return;
    const badge = document.createElement('div');
    badge.className = "history-badge";
    badge.innerText = val.toFixed(2) + "x";
    
    if(val < 2) { badge.style.color = "#93c5fd"; badge.style.borderColor = "rgba(59,130,246,0.2)"; }
    else if(val < 5) { badge.style.color = "#fcd34d"; badge.style.borderColor = "rgba(245,158,11,0.2)"; }
    else { badge.style.color = "#fca5a5"; badge.style.borderColor = "rgba(239,68,68,0.2)"; badge.style.boxShadow = "0 0 10px rgba(239,68,68,0.1)"; }
    
    historyStrip.prepend(badge);
    if(historyStrip.children.length > 7) historyStrip.removeChild(historyStrip.lastChild);
}

// --- GAME EVENT LISTENERS ARCHITECTURE ---
function initializeGameListeners() {
    socket.on('betting_phase_started', () => {
        stopFlightSound();
        gameState = 'waiting';
        isInFlight = false;
        hasBetInRound = false;
        globalMultiplier = 1.00;
        
        if (multiplierDisplay) {
            multiplierDisplay.style.color = "#cbd5e1";
            multiplierDisplay.innerText = "1.00x";
        }
        
        if (actionBtn) {
            actionBtn.className = "btn-bet";
            actionBtn.innerText = "BUY FLIGHT TICKET";
        }
        if (betInput) betInput.disabled = false;

        let timeLeft = 6;
        if (statusText) {
            statusText.innerText = `Boarding... Flight departs in ${timeLeft}s`;
            statusText.style.color = "#fbbf24";
        }
        
        if(countdownTimer) clearInterval(countdownTimer);
        countdownTimer = setInterval(() => {
            timeLeft--;
            if(timeLeft > 0) {
                if (statusText) statusText.innerText = `Boarding... Flight departs in ${timeLeft}s`;
            } else {
                clearInterval(countdownTimer);
                if (statusText) statusText.innerText = "Releasing safety valves...";
            }
        }, 1000);
    });

    socket.on('game_started', () => {
        if(countdownTimer) clearInterval(countdownTimer);
        initAudioEngine();
        startFlightSound();
        
        gameState = 'flying';
        isInFlight = true;
        if (statusText) {
            statusText.innerText = "We are airborne!";
            statusText.style.color = "#34d399";
        }
        if (multiplierDisplay) multiplierDisplay.style.color = "#34d399";

        if (hasBetInRound) {
            if (actionBtn) {
                actionBtn.className = "btn-cash";
                actionBtn.innerText = "COLLECT KWACHA";
            }
        } else {
            if (actionBtn) {
                actionBtn.className = "btn-disabled";
                actionBtn.innerText = "FLIGHT IN PROGRESS";
            }
        }
    });

    socket.on('multiplier_tick', (data) => {
        globalMultiplier = data.multiplier;
        if (multiplierDisplay) {
            multiplierDisplay.innerText = data.multiplier.toFixed(2) + "x";
            if(globalMultiplier >= 2 && globalMultiplier < 5) {
                multiplierDisplay.style.color = "#fbbf24";
            } else if (globalMultiplier >= 5) {
                multiplierDisplay.style.color = "#f87171";
            }
        }
        updateFlightSound(globalMultiplier);
        
        if (hasBetInRound && actionBtn && betInput) {
            const liveWinnings = (parseFloat(betInput.value) * data.multiplier).toFixed(2);
            actionBtn.innerText = `COLLECT K${liveWinnings}`;
        }
    });

    socket.on('game_crashed', (data) => {
        if(countdownTimer) clearInterval(countdownTimer);
        stopFlightSound();
        playPopSound();
        
        gameState = 'crashed';
        isInFlight = false;
        globalMultiplier = data.crashedAt;
        
        triggerBurstAnimation();
        appendHistoryBadge(data.crashedAt);
        
        if (statusText) {
            statusText.innerText = "Oh no, it popped!";
            statusText.style.color = "#ef4444";
        }
        if (multiplierDisplay) {
            multiplierDisplay.style.color = "#ef4444";
            multiplierDisplay.innerText = data.crashedAt.toFixed(2) + "x";
        }
        
        if (actionBtn) {
            actionBtn.className = "btn-disabled";
            actionBtn.innerText = "FLIGHT ENDED";
        }
        if (betInput) betInput.disabled = false;
    });

    socket.on('bet_confirmed', (data) => {
        hasBetInRound = true;
        animateBalanceTo(data.balance);
        if (actionBtn) {
            actionBtn.className = "btn-disabled";
            actionBtn.innerText = "TICKET SECURED!";
        }
        if (betInput) betInput.disabled = true;
        initAudioEngine(); 
    });

    socket.on('cash_out_success', (data) => {
        if (navigator.vibrate) {
            navigator.vibrate([40, 50, 40]);
        }

        hasBetInRound = false;
        animateBalanceTo(data.balance);
        if (actionBtn) {
            actionBtn.className = "btn-disabled";
            actionBtn.innerText = "CASH SECURED!";
        }
        
        playCashOutSound();
        triggerWinAnimation();
        addLog(`Awesome! You safely collected K${data.winnings.toFixed(2)}`, true);

        const winSplash = document.getElementById('win-splash');
        const winSplashAmount = document.getElementById('win-splash-amount');
        
        if (winSplash && winSplashAmount) {
            winSplashAmount.innerText = `+ K${data.winnings.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            winSplash.classList.add('show');
            setTimeout(() => {
                winSplash.classList.remove('show');
            }, 2500);
        }
    });

    socket.on('ledger_update', (data) => {
        addLog(data.message, data.type === 'win');
    });

    socket.on('error_message', (data) => { alert(data.message); });

    if (actionBtn) {
        actionBtn.addEventListener('click', () => {
            initAudioEngine(); 
            if (!isInFlight && !hasBetInRound && actionBtn.className !== "btn-disabled" && betInput) {
                socket.emit('place_bet', { amount: betInput.value });
            } else if (isInFlight && hasBetInRound) {
                socket.emit('cash_out');
            }
        });
    }
}

// --- AUTOMATED SUPABASE PERSISTENCE ENGINE ---
const supabaseUrl = 'https://uccdevvfexfpxnnwtpxa.supabase.co';
const supabaseKey = 'sb_publishable_cy9uVdq593I0sq2Q0x53Wg_k3Liixp_';
const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);

async function connectToGame() {
    if (statusText) statusText.innerText = "Boarding...";

    let { data: { session } } = await supabaseClient.auth.getSession();

    if (!session) {
        const { data, error } = await supabaseClient.auth.signInAnonymously();
        if (error) {
            console.error("Anonymous sign-in failed:", error.message);
            if (statusText) {
                statusText.innerText = "Sign-in failed: " + error.message;
                statusText.style.color = "#ef4444";
            }
            return;
        }
        session = data.session;
    }

    socket = io(SERVER_URL, {
        auth: { token: session.access_token }
    });

    socket.on('connect_error', (err) => {
        console.error("Socket connect_error:", err.message);
        if (statusText) {
            statusText.innerText = "Connection failed: " + err.message;
            statusText.style.color = "#ef4444";
        }
        if (actionBtn) {
            actionBtn.className = "btn-disabled";
            actionBtn.innerText = "RECONNECTING...";
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn("Socket disconnected:", reason);
        if (statusText) {
            statusText.innerText = "Disconnected: " + reason;
            statusText.style.color = "#ef4444";
        }
        if (actionBtn) {
            actionBtn.className = "btn-disabled";
            actionBtn.innerText = "RECONNECTING...";
        }
    });

    socket.on('initial_state', (data) => {
        currentBalance = data.balance;
        if (balanceDisplay) {
            balanceDisplay.innerText = currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    });

    initializeGameListeners();
}

// --- OPTIONAL ACCOUNT MANAGEMENT ACCOUNT PORTAL ---
const savePill = document.getElementById('saveProgressPill');
const saveOverlay = document.getElementById('saveProgressOverlay');
const saveEmail = document.getElementById('saveEmail');
const savePassword = document.getElementById('savePassword');
const saveStatus = document.getElementById('saveProgressStatus');
const saveConfirm = document.getElementById('saveProgressConfirm');
const saveCancel = document.getElementById('saveProgressCancel');

if (savePill && saveOverlay && saveCancel && saveConfirm) {
    savePill.addEventListener('click', () => {
        if (saveStatus) saveStatus.innerText = '';
        saveOverlay.classList.add('show');
    });
    saveCancel.addEventListener('click', () => saveOverlay.classList.remove('show'));
    saveOverlay.addEventListener('click', (e) => {
        if (e.target === saveOverlay) saveOverlay.classList.remove('show');
    });
    saveConfirm.addEventListener('click', async () => {
        const email = saveEmail ? saveEmail.value.trim() : '';
        const password = savePassword ? savePassword.value : '';
        if (!email || !password) {
            if (saveStatus) saveStatus.innerText = "Please enter both an email and a password.";
            return;
        }
        saveConfirm.disabled = true;
        saveConfirm.innerText = "Saving...";
        const { error } = await supabaseClient.auth.updateUser({ email, password });
        if (error) {
            if (saveStatus) saveStatus.innerText = error.message;
            saveConfirm.disabled = false;
            saveConfirm.innerText = "Save account";
        } else {
            if (saveStatus) {
                saveStatus.style.color = "#34d399";
                saveStatus.innerText = "Check your email to confirm — your progress is safe either way.";
            }
            saveConfirm.innerText = "Saved!";
            setTimeout(() => saveOverlay.classList.remove('show'), 1800);
        }
    });
}
