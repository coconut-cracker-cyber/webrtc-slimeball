// --- KONFIGURATION ---
const peerConfig = {
    debug: 2
};

// URL Parameter prüfen um Modus zu bestimmen
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode'); // 'controller' oder null (desktop)
const hostId = urlParams.get('id'); // ID des Desktops, mit dem wir uns verbinden

// --- LOGIK WEICHE ---
if (mode === 'controller' && hostId) {
    initController(hostId);
} else {
    initGame();
}

// ==========================================
// TEIL 1: DESKTOP / GAME LOGIC
// ==========================================
function initGame() {
    document.getElementById('game-screen').style.display = 'block';

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let score = 0;
    let width, height;

    // PeerJS Setup
    const peer = new Peer(null, peerConfig);
    let conn = null;

    peer.on('open', (id) => {
        console.log('Meine Peer ID ist: ' + id);

        // QR Code generieren
        const joinUrl = `${window.location.href.split('?')[0]}?mode=controller&id=${id}`;
        new QRCode(document.getElementById("qrcode"), {
            text: joinUrl,
            width: 128,
            height: 128
        });
    });

    peer.on('connection', (c) => {
        conn = c;
        document.getElementById('desktop-status').innerText = "Controller verbunden!";
        document.getElementById('desktop-status').style.color = "#0f0";

        // Daten vom Handy empfangen
        conn.on('data', (data) => {
            if (data.type === 'throw') {
                spawnBall(data);
            }
        });
    });

    // Spiel-Objekte
    const balls = [];
    const hoop = { x: 0, y: 0, width: 120, height: 10, z: 500 }; // Z ist die Tiefe

    // Resize Handler
    function resize() {
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;
        // Korb positionieren (Mitte, etwas oben, "hinten" im Raum)
        hoop.x = width / 2;
        hoop.y = height * 0.3;
    }
    window.addEventListener('resize', resize);
    resize();

    function spawnBall(data) {
        // data enthält: uplift (acc.y), flick (rot.alpha), forward (acc.z), side (acc.x), tilt (gamma)

        // Tuning der Physik-Werte
        // Wir wollen, dass der Wurf nicht "zu hart" ist.
        // Flick (Rotation) ist der Haupttreiber für die Vorwärtsbewegung (Z).
        // Uplift (Y-Acc) ist für die Höhe.

        const forceFlick = data.flick || 0;
        const forceUplift = data.uplift || 0;
        const forceForward = data.forward || 0;
        const sideMove = data.side || 0;
        const tilt = data.tilt || 0;

        // Berechnung der Geschwindigkeiten
        // Z-Geschwindigkeit (nach vorne)
        // Rotation (deg/s) kann 300-800 sein. Teilen wir durch ~15-20.
        // Acc (m/s^2) kann 10-30 sein.
        let velocityZ = (forceFlick / 12) + (forceForward * 0.5);
        velocityZ = Math.min(Math.max(velocityZ, 15), 55); // Clamp

        // Y-Geschwindigkeit (nach oben, negativ in Canvas)
        // Uplift ist meist 10-30.
        let velocityY = -(forceUplift * 1.5);
        // Mindesthöhe garantieren, wenn Wurf erkannt wurde
        if (velocityY > -15) velocityY = -15;
        if (velocityY < -45) velocityY = -45;

        // X-Geschwindigkeit (seitlich)
        // Tilt (Gamma) ist -90 bis 90.
        // Side (Acc.x) ist +/- m/s^2.
        // Wir mischen beides.
        let velocityX = (tilt * 0.3) + (sideMove * 2.0);

        balls.push({
            x: width / 2,       // Startet unten mittig
            y: height,
            z: 0,               // Startet "vorne" am Bildschirm
            prevX: width / 2,
            prevY: height,
            prevZ: 0,
            vx: velocityX,
            vy: velocityY,
            vz: velocityZ,
            radius: 40,         // Startradius
            color: 'orange',
            scored: false
        });
    }

    function update() {
        ctx.clearRect(0, 0, width, height);

        // 1. Korb zeichnen (2.5D)
        const depthScale = 1000 / (1000 + hoop.z);
        const hW = hoop.width * depthScale;
        const hX = hoop.x - hW / 2;
        const hY = hoop.y;

        // Backboard
        ctx.fillStyle = "white";
        ctx.fillRect(hX - 20 * depthScale, hY - 80 * depthScale, hW + 40 * depthScale, 80 * depthScale);
        ctx.strokeStyle = "red";
        ctx.strokeRect(hX + hW * 0.3, hY - 60 * depthScale, hW * 0.4, 40 * depthScale);

        // Ring (Ellipse)
        ctx.beginPath();
        ctx.ellipse(hoop.x, hY, hW / 2, 10 * depthScale, 0, 0, Math.PI * 2);
        ctx.lineWidth = 5;
        ctx.strokeStyle = "orange";
        ctx.stroke();


        // 2. Bälle updaten und zeichnen
        for (let i = balls.length - 1; i >= 0; i--) {
            let b = balls[i];

            b.prevX = b.x;
            b.prevY = b.y;
            b.prevZ = b.z;

            // Physik
            b.x += b.vx;
            b.y += b.vy;
            b.z += b.vz;

            b.vy += 0.6; // Schwerkraft
            b.vz *= 0.99; // Luftwiderstand

            // Perspektive
            const focalLength = 1000;
            const scale = focalLength / (focalLength + b.z);
            const drawRadius = b.radius * scale;

            // Bodenkollision
            if (b.y > height + 200) {
                balls.splice(i, 1);
                continue;
            }

            // Zeichnen
            ctx.beginPath();
            ctx.arc(b.x, b.y, Math.max(drawRadius, 1), 0, Math.PI * 2);
            ctx.fillStyle = b.color;
            ctx.fill();
            ctx.strokeStyle = "#333";
            ctx.lineWidth = 2;
            ctx.stroke();

            // Pseudo-Schatten
            ctx.beginPath();
            ctx.arc(b.x + 5 * scale, b.y + 5 * scale, Math.max(drawRadius, 1) * 0.8, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.1)";
            ctx.fill();

            // Kollisionserkennung
            if (!b.scored && b.prevZ < hoop.z && b.z >= hoop.z) {
                // Interpolation
                const t = (hoop.z - b.prevZ) / (b.z - b.prevZ);
                const intersectX = b.prevX + (b.x - b.prevX) * t;
                const intersectY = b.prevY + (b.y - b.prevY) * t;

                // Prüfe ob Ball durch Ring fällt (vy > 0)
                if (b.vy > 0) {
                    const dist = Math.sqrt((intersectX - hoop.x) ** 2 + (intersectY - hoop.y) ** 2);
                    if (dist < (hoop.width * depthScale / 2) * 0.85) {
                        score++;
                        b.scored = true;
                        b.color = "#0f0";
                        document.getElementById('score').innerText = score;
                    }
                }
            }
        }

        requestAnimationFrame(update);
    }

    update();
}

// ==========================================
// TEIL 2: MOBILE CONTROLLER LOGIC
// ==========================================
function initController(hostId) {
    document.getElementById('controller-screen').style.display = 'flex';
    const statusEl = document.getElementById('status');
    const btn = document.getElementById('btn-connect');
    const debugEl = document.getElementById('debug');
    const canvas = document.getElementById('feedback-canvas');
    const ctx = canvas.getContext('2d');

    const peer = new Peer(null, peerConfig);
    let conn = null;

    peer.on('open', (id) => {
        statusEl.innerText = "Verbinde mit Desktop...";
        conn = peer.connect(hostId);

        conn.on('open', () => {
            statusEl.innerText = "Verbunden! Bereit.";
            statusEl.style.color = "#0f0";
            btn.innerText = "Sensoren neu kalibrieren";
        });

        conn.on('error', (err) => {
            statusEl.innerText = "Fehler: " + err;
        });
    });

    // Sensor Variablen
    let acc = { x: 0, y: 0, z: 0 };
    let rot = { alpha: 0, beta: 0, gamma: 0 };
    let tilt = { alpha: 0, beta: 0, gamma: 0 }; // Orientation

    let canThrow = true;
    const THROW_THRESHOLD = 25; // Kombinierter Wert aus Rotation und Uplift

    // Visualisierung Loop
    function drawLoop() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h / 2;

        // Hintergrund-Gitter
        ctx.strokeStyle = "#ddd";
        ctx.beginPath();
        ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
        ctx.moveTo(0, cy); ctx.lineTo(w, cy);
        ctx.stroke();

        // 1. Optimale Wurflinie (Referenz)
        ctx.strokeStyle = "rgba(0, 200, 0, 0.3)";
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy - 100); // Gerade nach oben
        ctx.stroke();

        // Text: "Optimal"
        ctx.fillStyle = "green";
        ctx.font = "12px Arial";
        ctx.fillText("Optimal: Gerade hoch & Flick", cx + 10, cy - 80);


        // 2. Aktueller Vektor (Live Feedback)
        // Wir visualisieren Uplift (Y) und Side (X)
        // Und Flick als Länge oder Farbe?
        // Nehmen wir: Y-Achse = Uplift + Flick, X-Achse = Tilt + Side

        const flick = Math.abs(rot.alpha || 0);
        const uplift = acc.y || 0;
        const side = (acc.x || 0) * 5 + (tilt.gamma || 0); // Mix aus Bewegung und Neigung

        // Vektor berechnen
        const vecY = (uplift * 5) + (flick * 0.2); // Skalierung für Anzeige
        const vecX = side * 2;

        ctx.strokeStyle = "orange";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + vecX, cy - vecY);
        ctx.stroke();

        // Pfeilspitze
        ctx.beginPath();
        ctx.arc(cx + vecX, cy - vecY, 5, 0, Math.PI * 2);
        ctx.fill();

        // Debug Text
        ctx.fillStyle = "#333";
        ctx.fillText(`Flick (Rot): ${flick.toFixed(0)}`, 10, 20);
        ctx.fillText(`Uplift (Y): ${uplift.toFixed(1)}`, 10, 40);
        ctx.fillText(`Side (X/Tilt): ${side.toFixed(1)}`, 10, 60);

        requestAnimationFrame(drawLoop);
    }
    drawLoop();


    btn.addEventListener('click', () => {
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            DeviceMotionEvent.requestPermission()
                .then(response => {
                    if (response == 'granted') {
                        startSensors();
                    } else {
                        alert("Sensoren müssen erlaubt sein!");
                    }
                })
                .catch(console.error);
        } else {
            startSensors();
        }
    });

    function startSensors() {
        window.addEventListener('devicemotion', (event) => {
            if (event.acceleration) acc = event.acceleration;
            if (event.rotationRate) rot = event.rotationRate;
            handleThrowLogic();
        });
        window.addEventListener('deviceorientation', (event) => {
            if (event.gamma) tilt.gamma = event.gamma;
            if (event.beta) tilt.beta = event.beta;
            if (event.alpha) tilt.alpha = event.alpha;
        });
        statusEl.innerText = "Sensoren aktiv!";
    }

    function handleThrowLogic() {
        if (!conn || !canThrow) return;

        // Wurf-Erkennung:
        // Wir suchen nach starkem Uplift (Y) UND starker Rotation (Alpha - Flick nach vorne)

        const flick = Math.abs(rot.alpha || 0);
        const uplift = acc.y || 0;

        // Score berechnen (wie stark ist der Wurf)
        // Flick ist meist 100-500 deg/s bei schnellem Wurf
        // Uplift ist 10-30 m/s^2
        const intensity = (uplift * 1.0) + (flick / 10.0);

        if (intensity > THROW_THRESHOLD) {
            // Wurf erkannt!
            canThrow = false;

            // Daten senden
            conn.send({
                type: 'throw',
                uplift: uplift,
                flick: flick,
                forward: Math.abs(acc.z || 0),
                side: acc.x || 0,
                tilt: tilt.gamma || 0
            });

            // Feedback
            const screen = document.getElementById('controller-screen');
            screen.style.backgroundColor = "#4caf50"; // Grün aufleuchten
            setTimeout(() => { screen.style.backgroundColor = "#333"; }, 200);

            // Cooldown
            setTimeout(() => { canThrow = true; }, 1000);
        }
    }
}
