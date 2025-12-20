

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
let GRAVITY = 0.5;
const FRICTION = 0.96;
let JUMP_FORCE_MULTIPLIER = 0.28;
let MAX_JUMP_FORCE = 35;
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

// Ominous Tide (Chaser)
const tide = {
    y: 0,
    speed: 0.1, // Base speed
    waveOffset: 0,
    color: '#ff0055'
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

    // Adjust player size relative to world width
    player.radius = worldWidth * 0.025;

    // Adjust Physics based on World Width (scaling from original reference values)
    GRAVITY = worldWidth * 0.00060;
    MAX_JUMP_FORCE = worldWidth * 0.15;
    JUMP_FORCE_MULTIPLIER = worldWidth * 0.0007;

    // Adjust Tide Speed relative to world
    tide.speed = worldWidth * 0.001;

    // Optimize: Apply filters via CSS instead of Canvas Context. blur(${worldWidth * 0.03}px)
    // Context filters force re-rasterization every frame (slow). CSS filters run on the compositor (fast/GPU).
    bgCtx.filter = 'none';
    bgCanvas.style.filter = ` brightness(2.0) saturate(150%)`;

    if (gameState === 'start') {
        player.x = worldWidth / 2;
        player.y = worldHeight - 150;

        // Reset Tide
        tide.y = worldHeight + 400; // Start comfortably below

        cameraY = 0;
        generateInitialWalls();
    }
}

function generateInitialWalls() {
    walls = [];
    // Floor
    // Scale floor dimensions relative to worldWidth
    const floorHeight = worldWidth * 0.15;
    const floorY = worldHeight - worldWidth * 0.1;

    walls.push({ x: 0, y: floorY, w: worldWidth, h: floorHeight, type: 'floor' });
    highestGenY = floorY;

    for (let i = 0; i < 15; i++) generateNextWall();
}

function generateNextWall() {
    // Determine user progression: calculate a random vertical gap between walls
    // This controls the difficulty and pacing of the climb
    const gapY = worldWidth * 0.2 + Math.random() * worldWidth * 0.4;

    // Calculate the new wall's Y position relative to the highest generated wall so far
    // Note: The coordinate system is inverted likely (y decreases as you go up), 
    // so we subtract the gap from the highest generated Y
    const y = highestGenY - gapY;

    // Determine the type of wall using a random roll
    const typeRoll = Math.random();
    let type = 'normal';
    if (typeRoll > 0.75) type = 'bouncy'; // % chance for a bouncy wall
    if (typeRoll > 0.83) type = 'vertical'; // % chance for a vertical wall (overrides bouncy)

    let w, h, x;

    if (type === 'vertical') {
        // Vertical walls are thin and tall, good for rebounding
        w = worldWidth * 0.05;
        h = worldWidth * 0.10 + Math.random() * worldWidth * 0.5;
        x = Math.random() * (worldWidth - w); // Random horizontal position
    } else {
        // Horizontal walls (normal or bouncy) are wider and serve as platforms
        w = worldWidth * 0.10 + Math.random() * worldWidth * 0.5;
        h = worldWidth * 0.05;
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

    // Update Tide
    // Catch Up Mechanic: If player is far ahead, speed up the tide
    let currentSpeed = tide.speed;
    const distToTide = tide.y - player.y;
    // If player is more than 1.5 screens ahead
    const catchUpThreshold = worldHeight * 1.5;

    if (distToTide > catchUpThreshold) {
        // Boost speed proportional to distance
        // e.g. add 0.05% of the excess distance per frame
        currentSpeed += (distToTide - catchUpThreshold) * 0.002;
    }

    tide.y -= currentSpeed;
    tide.waveOffset += 0.1;

    // Visual Danger Indicator: Border Color
    // Canvas Border reacts to tide proximity
    // Distance from bottom of camera (screen bottom) to tide
    const screenBottomY = cameraY + worldHeight;
    const proximity = tide.y - screenBottomY; // Negative if tide is on screen, positive if below

    // Warning starts when tide is within 300px of the screen bottom or ON screen
    const dangerZone = 300;

    // We want a value from 0 (safe) to 1 (danger/dead)
    // If proximity > 300 (safe) -> 0
    // If proximity < -worldHeight (dead/player covered) -> 1
    // Actually simpler: just based on visual presence.
    // If tide is ON SCREEN (proximity < 0), it gets redder.

    if (proximity < dangerZone) {
        // Map [300, -200] to [0, 1] opacity of red
        // 300 -> 0 (White/Norm)
        // 0 -> 0.6 (Red)
        // -200 -> 1.0 (Deep Red)

        let intensity = 1 - ((proximity + 200) / (dangerZone + 200));
        intensity = Math.max(0, Math.min(1, intensity));

        // Base border is rgba(255, 255, 255, 0.3)
        // Danger is rgba(255, 0, 0, 0.8)

        const r = Math.floor(255);
        const g = Math.floor(255 * (1 - intensity));
        const b = Math.floor(255 * (1 - intensity));
        const a = 0.3 + (intensity * 0.5);

        canvas.style.borderColor = `rgba(${r}, ${g}, ${b}, ${a})`;
        canvas.style.boxShadow = `0 0 ${50 + intensity * 50}px rgba(${r}, 0, 0, ${0.9 * intensity})`;
    } else {
        canvas.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        canvas.style.boxShadow = '0 0 50px rgba(0, 0, 0, 0.9)';
    }

    // Tide Collision
    // If player touches the tide (plus a bit of leeway for the wave peaks)
    if (player.y + player.radius > tide.y + 20) {
        gameOver();
    }

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

        // Game Over - as soon as the top of the ball leaves the visual area
        if (player.y - player.radius > cameraY + worldHeight) gameOver();
    }

    // Camera
    // --- CAMERA LOGIC ---
    // The camera follows the player as they climb up.
    // We target a position slightly below the player's current Y (worldHeight * 0.6 offset)
    const targetY = player.y - worldHeight * 0.6;

    // Smoothly interpolate the camera's current Y position towards the target Y.
    const smoothness = 0.1;
    cameraY += (targetY - cameraY) * smoothness;

    // Clamp the camera so it doesn't go indefinitely down into the void
    // The "buffer" here ensures we don't look too far past the tide
    // tide.y is the top of the tide. We want the camera bottom (cameraY + worldHeight) to be near tide.y
    const maxCameraY = tide.y - worldHeight + 100; // Allow seeing 100px into the tide
    if (cameraY > maxCameraY) cameraY = maxCameraY;

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

function renderWorld(targetCtx) {
    targetCtx.save();
    targetCtx.scale(ZOOM, ZOOM); // Apply Zoom
    targetCtx.translate(0, -cameraY);

    // Draw Walls
    for (let w of walls) {
        targetCtx.beginPath();
        targetCtx.roundRect(w.x, w.y, w.w, w.h, 5);

        if (w.type === 'bouncy') {
            targetCtx.fillStyle = 'rgba(255, 0, 255, 0.2)';
            targetCtx.strokeStyle = '#ff00ff';
            targetCtx.shadowColor = '#ff00ff';
        } else if (w.type === 'vertical') {
            targetCtx.fillStyle = 'rgba(255, 255, 0, 0.1)';
            targetCtx.strokeStyle = '#ffff00';
            targetCtx.shadowColor = '#ffff00';
        } else {
            targetCtx.fillStyle = 'rgba(0, 255, 255, 0.1)';
            targetCtx.strokeStyle = '#00ccff';
            targetCtx.shadowColor = '#00ccff';
        }

        targetCtx.shadowBlur = 10;
        targetCtx.lineWidth = 2;
        targetCtx.fill();
        targetCtx.stroke();
    }

    // Draw Player
    targetCtx.shadowBlur = 20;
    targetCtx.shadowColor = player.color;
    targetCtx.fillStyle = player.color;
    targetCtx.beginPath();
    targetCtx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
    targetCtx.fill();

    // Aim Line
    if (player.state === 'stuck') {
        const jumpAngle = tiltVector.angle + Math.PI;
        const lineLen = tiltVector.magnitude * 3;

        targetCtx.beginPath();
        targetCtx.moveTo(player.x, player.y);
        targetCtx.lineTo(player.x + Math.cos(jumpAngle) * lineLen, player.y + Math.sin(jumpAngle) * lineLen);
        targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        targetCtx.lineWidth = 2;
        targetCtx.setLineDash([10, 10]);
        targetCtx.stroke();
        targetCtx.setLineDash([]);
    }

    // Draw Tide (The Neon Void)
    targetCtx.fillStyle = tide.color;
    // Create a glitchy/wavy top
    targetCtx.beginPath();
    targetCtx.moveTo(0, tide.y + 1000); // Start bottom left
    targetCtx.lineTo(0, tide.y); // Top left

    // Draw wavy top
    const waveRes = 10;
    for (let x = 0; x <= worldWidth; x += waveRes) {
        // Sine wave + random glitch
        let yOffset = Math.sin(x * 0.05 + tide.waveOffset) * 15;
        // Occasional vertical glitch spikes
        if (Math.random() > 0.98) yOffset -= Math.random() * 30; // Spike up
        targetCtx.lineTo(x, tide.y + yOffset);
    }

    targetCtx.lineTo(worldWidth, tide.y + 1000); // Bottom right
    targetCtx.closePath();

    // Gradient fill for the void
    const tideGrad = targetCtx.createLinearGradient(0, tide.y, 0, tide.y + 500);
    tideGrad.addColorStop(0, 'rgba(255, 0, 85, 0.6)'); // Top transparency
    tideGrad.addColorStop(0.2, 'rgba(50, 0, 20, 0.9)');
    tideGrad.addColorStop(1, 'rgba(0, 0, 0, 1)');
    targetCtx.fillStyle = tideGrad;
    targetCtx.fill();

    // Top edge glow line
    targetCtx.shadowBlur = 15;
    targetCtx.shadowColor = '#ff3366';
    targetCtx.strokeStyle = '#ff99aa';
    targetCtx.lineWidth = 3;
    targetCtx.stroke();

    targetCtx.restore();
}

function draw() {
    // 1. Draw Game
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderWorld(ctx);

    // 2. Draw Background (High Quality Vector Stretch)
    if (bgCanvas.width > 0 && bgCanvas.height > 0) {
        // Clear background
        bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

        bgCtx.save();
        // Scale to fill the background
        const scaleX = bgCanvas.width / canvas.width;
        const scaleY = bgCanvas.height / canvas.height;
        bgCtx.scale(scaleX, scaleY);

        renderWorld(bgCtx);
        bgCtx.restore();
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
