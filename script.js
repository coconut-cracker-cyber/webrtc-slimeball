

// DOM Elements
const hostView = document.getElementById('host-view');
const controllerView = document.getElementById('controller-view');
const connectionScreen = document.getElementById('connection-screen');
const connectionStatus = document.getElementById('connection-status');
const qrcodeDiv = document.getElementById('qrcode');

// Game State (Host)
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx = bgCanvas.getContext('2d');
const scoreValue = document.getElementById('score-value');

// Controller State
const arrow = document.getElementById('arrow');
const jumpBtn = document.getElementById('jump-btn');
const startOverlay = document.getElementById('start-overlay');
const enableSensorsBtn = document.getElementById('enable-sensors-btn');

// Constants & Config
const ZOOM = 0.6; // Zoom out
const GRAVITY = 0.5;
const FRICTION = 0.99;
const JUMP_FORCE_MULTIPLIER = 0.45;
const MAX_JUMP_FORCE = 35;
const TILT_SENSITIVITY = 1.5;
const SUBSTEPS = 8; // Physics accuracy

// Variables
let peer;
let conn;
let isHost = false;
let gameState = 'start';
let score = 0;
let cameraY = 0;
let lastTime = 0;
let worldWidth = 0;
let worldHeight = 0;
let frameCount = 0;

// Player & World
const player = {
    x: 0,
    y: 0,
    radius: 12, // Slightly smaller relative to world
    vx: 0,
    vy: 0,
    state: 'stuck',
    color: '#00ff88'
};

let walls = [];
let highestGenY = 0;
let tiltVector = { x: 0, y: 0, magnitude: 0, angle: 0 };

// --- INITIALIZATION ---
function init() {
    const urlParams = new URLSearchParams(window.location.search);
    const hostId = urlParams.get('host');

    if (hostId) {
        initController(hostId);
    } else {
        initHost();
    }
}

// --- HOST LOGIC ---
function initHost() {
    isHost = true;
    hostView.classList.remove('hidden');

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug')) {
        console.log('Debug mode: visuals only');
        connectionStatus.textContent = "Debug Mode";
        setTimeout(() => {
            connectionScreen.classList.add('hidden');
            startGame();
        }, 500);

        resize();
        window.addEventListener('resize', resize);
        requestAnimationFrame(gameLoop);
        return;
    }

    peer = new Peer();

    peer.on('open', (id) => {
        console.log('My peer ID is: ' + id);
        const url = `${window.location.href.split('?')[0]}?host=${id}`;
        new QRCode(qrcodeDiv, { text: url, width: 180, height: 180 });
        connectionStatus.textContent = "Scan with phone to start";
    });

    peer.on('connection', (c) => {
        conn = c;
        connectionStatus.textContent = "Controller Connected!";
        setTimeout(() => {
            connectionScreen.style.opacity = 0;
            setTimeout(() => connectionScreen.classList.add('hidden'), 500);
            startGame();
        }, 1000);
        setupHostDataListener();
    });

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(gameLoop);
}

function setupHostDataListener() {
    conn.on('data', (data) => {
        if (data.type === 'tilt') {
            tiltVector = data.vector;
        } else if (data.type === 'jump') {
            jump();
        }
    });
}

function resize() {
    // Optimize: Low-res background for blur effect (Fixes lag)
    // We maintain aspect ratio of window to prevent distortion, 
    // but scale down significantly.
    const bgScale = 1.0;
    bgCanvas.width = window.innerWidth * bgScale;
    bgCanvas.height = window.innerHeight * bgScale;

    // Target Aspect Ratio 9:16 (0.5625)
    // Mobile default typically 9:16 or thinner
    const targetAspect = 9 / 16;
    const windowAspect = window.innerWidth / window.innerHeight;

    let targetW, targetH;

    if (windowAspect > targetAspect) {
        // Window is wider (Desktop/Horizontal) -> Constrain Width by Height
        targetH = window.innerHeight;
        targetW = targetH * targetAspect;
    } else {
        // Window is taller (Some Phones/Vertical) -> Constrain Height by Width
        // Or just fill width if we want standard mobile behavior?
        // User asked to "fix the aspect ratio for narrower screens as well"
        // so we constrain height too (pillarbox).
        targetW = window.innerWidth;
        targetH = targetW / targetAspect;
    }

    canvas.width = targetW;
    canvas.height = targetH;

    // Calculate World Dimensions based on Zoom
    worldWidth = canvas.width / ZOOM;
    worldHeight = canvas.height / ZOOM;

    // Apply scaling/filter to background context once (persists until resize)
    bgCtx.filter = 'brightness(2.0) saturate(150%)';

    if (gameState === 'start') {
        player.x = worldWidth / 2;
        player.y = worldHeight - 150;
        cameraY = 0;
        generateInitialWalls();
    }
}

function generateInitialWalls() {
    walls = [];
    // Floor
    walls.push({ x: 0, y: worldHeight - 50, w: worldWidth, h: 100, type: 'floor' });
    highestGenY = worldHeight - 50;

    for (let i = 0; i < 15; i++) generateNextWall();
}

function generateNextWall() {
    // Determine user progression: calculate a random vertical gap between walls
    // This controls the difficulty and pacing of the climb
    const gapY = 150 + Math.random() * 200;

    // Calculate the new wall's Y position relative to the highest generated wall so far
    // Note: The coordinate system is inverted likely (y decreases as you go up), 
    // so we subtract the gap from the highest generated Y
    const y = highestGenY - gapY;

    // Determine the type of wall using a random roll
    const typeRoll = Math.random();
    let type = 'normal';
    if (typeRoll > 0.7) type = 'bouncy'; // 30% chance for a bouncy wall
    if (typeRoll > 0.9) type = 'vertical'; // 10% chance for a vertical wall (overrides bouncy)

    let w, h, x;

    if (type === 'vertical') {
        // Vertical walls are thin and tall, good for rebounding
        w = worldWidth * 0.08;
        h = worldWidth * 0.25 + Math.random() * worldWidth * 0.5;
        x = Math.random() * (worldWidth - w); // Random horizontal position
    } else {
        // Horizontal walls (normal or bouncy) are wider and serve as platforms
        w = worldWidth * 0.25 + Math.random() * worldWidth * 0.5;
        h = worldWidth * 0.08;
        x = Math.random() * (worldWidth - w);
    }

    // Add the new wall to the walls array to be rendered and simulated
    walls.push({ x, y, w, h, type });

    // Update the tracker for the highest point where we've generated walls
    highestGenY = y;
}

function jump() {
    if (player.state !== 'stuck') return;

    const force = Math.min(tiltVector.magnitude * JUMP_FORCE_MULTIPLIER, MAX_JUMP_FORCE);
    const jumpAngle = tiltVector.angle + Math.PI;

    player.vx = Math.cos(jumpAngle) * force;
    player.vy = Math.sin(jumpAngle) * force;
    player.state = 'air';

    if (conn) conn.send({ type: 'vibrate', duration: Math.floor(force * 5) });
}

function update(dt) {
    if (gameState !== 'playing') return;

    // Physics Sub-stepping
    if (player.state === 'air') {
        const stepDt = 1 / SUBSTEPS; // Normalized step

        // Apply Gravity once per frame
        player.vy += GRAVITY;
        player.vx *= FRICTION;

        for (let i = 0; i < SUBSTEPS; i++) {
            player.x += player.vx * stepDt;
            player.y += player.vy * stepDt;

            // Wall Collisions
            if (checkCollisions()) break; // If stuck, stop stepping

            // World Boundaries
            if (player.x - player.radius < 0) {
                player.x = player.radius;
                player.vx *= -0.8;
            } else if (player.x + player.radius > worldWidth) {
                player.x = worldWidth - player.radius;
                player.vx *= -0.8;
            }
        }

        // Game Over
        if (player.y - player.radius > cameraY + worldHeight + 200) gameOver();
    }

    // Camera
    // --- CAMERA LOGIC ---
    // The camera follows the player as they climb up.
    // We target a position slightly below the player's current Y (worldHeight * 0.6 offset)
    // to keep the player somewhat centered but with more space above to see where to jump next.
    const targetY = player.y - worldHeight * 0.6;

    // Smoothly interpolate the camera's current Y position towards the target Y.
    // The factor 0.1 determines the "smoothness" or lag of the camera (Linear Interpolation / Lerp).
    // We only move the camera if the target is higher (smaller Y value) to prevent moving down.
    if (targetY < cameraY) cameraY += (targetY - cameraY) * 0.1;

    // Score
    const currentHeight = Math.floor(-player.y / 10);
    if (currentHeight > score) {
        score = currentHeight;
        scoreValue.textContent = score + 'm';
    }

    // Gen & Cleanup
    if (cameraY < highestGenY + 1000) generateNextWall();
    walls = walls.filter(w => w.y < cameraY + worldHeight + 200);
}

function checkCollisions() {
    for (let w of walls) {
        // AABB vs Circle
        let closestX = Math.max(w.x, Math.min(player.x, w.x + w.w));
        let closestY = Math.max(w.y, Math.min(player.y, w.y + w.h));

        let dx = player.x - closestX;
        let dy = player.y - closestY;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < player.radius) {
            // Collision!

            // 1. Depenetrate (Push out)
            const overlap = player.radius - dist;
            let nx, ny;

            if (dist === 0) {
                // Center inside wall, push up
                nx = 0; ny = -1;
            } else {
                nx = dx / dist;
                ny = dy / dist;
            }

            player.x += nx * overlap;
            player.y += ny * overlap;

            // 2. Handle Reaction
            if (w.type === 'bouncy') {
                // Reflect velocity: V_new = V_old - 2(V_old . N) * N
                const dot = player.vx * nx + player.vy * ny;
                player.vx = player.vx - 2 * dot * nx;
                player.vy = player.vy - 2 * dot * ny;

                // Add some energy loss or gain?
                player.vx *= 1.1; // Super bounce!
                player.vy *= 1.1;

                // Play sound or effect?
                return false; // Keep moving in this frame (don't stop)
            } else {
                // Stick
                player.state = 'stuck';
                player.vx = 0;
                player.vy = 0;
                return true; // Stop physics steps
            }
        }
    }
    return false;
}

function gameOver() {
    gameState = 'gameover';
    alert(`Game Over! Height: ${score}m`);
    resetGame();
}

function resetGame() {
    gameState = 'start';
    score = 0;
    scoreValue.textContent = '0m';
    resize();
    gameState = 'playing';
}

function draw() {
    // Clear with Zoom
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(ZOOM, ZOOM); // Apply Zoom
    ctx.translate(0, -cameraY);

    // Draw Walls
    for (let w of walls) {
        ctx.beginPath();
        ctx.roundRect(w.x, w.y, w.w, w.h, 5);

        if (w.type === 'bouncy') {
            ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
            ctx.strokeStyle = '#ff00ff';
            ctx.shadowColor = '#ff00ff';
        } else if (w.type === 'vertical') {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.1)';
            ctx.strokeStyle = '#ffff00';
            ctx.shadowColor = '#ffff00';
        } else {
            ctx.fillStyle = 'rgba(0, 255, 255, 0.1)';
            ctx.strokeStyle = '#00ccff';
            ctx.shadowColor = '#00ccff';
        }

        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
    }

    // Draw Player
    ctx.shadowBlur = 20;
    ctx.shadowColor = player.color;
    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
    ctx.fill();

    // Aim Line
    if (player.state === 'stuck') {
        const jumpAngle = tiltVector.angle + Math.PI;
        const lineLen = tiltVector.magnitude * 3;

        ctx.beginPath();
        ctx.moveTo(player.x, player.y);
        ctx.lineTo(player.x + Math.cos(jumpAngle) * lineLen, player.y + Math.sin(jumpAngle) * lineLen);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    ctx.restore();
    // Use the main canvas as the source for the background
    // Optimize: Update background less frequently and apply filter on the small canvas
    if (bgCanvas.width > 0 && bgCanvas.height > 0) {
        // Filter is already set in resize(), just draw
        bgCtx.drawImage(canvas, 0, 0, bgCanvas.width, bgCanvas.height);
    }
}

function gameLoop(timestamp) {
    const dt = timestamp - lastTime;
    lastTime = timestamp;
    frameCount++;
    update(dt);
    draw();
    requestAnimationFrame(gameLoop);
}

function startGame() {
    gameState = 'playing';
}

// --- CONTROLLER LOGIC ---
function initController(hostId) {
    controllerView.classList.remove('hidden');
    peer = new Peer();
    peer.on('open', (id) => {
        conn = peer.connect(hostId);
        conn.on('open', () => {
            console.log('Connected to host');
            startOverlay.style.display = 'flex';
        });
        conn.on('data', (data) => {
            if (data.type === 'vibrate' && navigator.vibrate) {
                navigator.vibrate(data.duration);
            }
        });
    });

    enableSensorsBtn.addEventListener('click', () => {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(response => {
                    if (response === 'granted') startController();
                    else alert('Permission denied');
                })
                .catch(console.error);
        } else {
            startController();
        }
    });
}

function startController() {
    startOverlay.style.display = 'none';
    window.addEventListener('deviceorientation', handleOrientation);
    jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sendJump(); });
    jumpBtn.addEventListener('mousedown', (e) => { e.preventDefault(); sendJump(); });
}

function handleOrientation(event) {
    let gamma = event.gamma || 0;
    let beta = event.beta || 0;

    const x = gamma * TILT_SENSITIVITY;
    const y = beta * TILT_SENSITIVITY;

    const magnitude = Math.min(Math.sqrt(x * x + y * y), 100);
    const angle = Math.atan2(y, x);

    tiltVector = { x, y, magnitude, angle };
    updateArrowUI();
    if (conn && conn.open) conn.send({ type: 'tilt', vector: tiltVector });
}

function updateArrowUI() {
    const rotationDeg = (tiltVector.angle * 180 / Math.PI) + 270;
    const scale = tiltVector.magnitude / 50;
    arrow.style.transform = `rotate(${rotationDeg}deg) scaleY(${0.5 + scale * 0.5})`;
}

function sendJump() {
    if (conn && conn.open) conn.send({ type: 'jump' });
}

// Start
init();
