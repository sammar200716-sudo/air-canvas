import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// --- Global Variables ---
let handLandmarker;
let video;
let webcamRunning = false;
let lastVideoTime = -1;

let scene, camera, renderer, composer;
let currentLine = null;
let lines = [];
let fingerGlow; // For fingertip glow
let isPinching = false;
let currentColor = new THREE.Color(0x00ffff);
let isRainbow = true;
let hue = 0;

let currentTool = 'brush'; // 'brush' or 'stamp'
let activeStickerSVG = null;
let lastStampTime = 0;

// Tracking debouncing & smoothing
let framesWithoutHand = 0;
let framesNotPointing = 0;
const MAX_TOLERANCE_FRAMES = 15; // Increased tolerance

const stickerLibrary = [
    { name: "Ribbon", svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 50 L10 20 L10 80 Z" fill="#ff9a9e"/><path d="M50 50 L90 20 L90 80 Z" fill="#fecfef"/><circle cx="50" cy="50" r="15" fill="#ff758c"/></svg>` },
    { name: "Flower", svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="25" r="20" fill="#ffb7c5"/><circle cx="75" cy="50" r="20" fill="#ffb7c5"/><circle cx="50" cy="75" r="20" fill="#ffb7c5"/><circle cx="25" cy="50" r="20" fill="#ffb7c5"/><circle cx="50" cy="50" r="15" fill="#feca57"/></svg>` },
    { name: "Star", svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,10 60,40 90,40 65,60 75,90 50,75 25,90 35,60 10,40 40,40" fill="#feca57"/></svg>` },
    { name: "Heart", svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 90 L15 55 A25 25 0 0 1 50 25 A25 25 0 0 1 85 55 Z" fill="#ff6b81"/></svg>` },
    { name: "Crown", svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M10 40 L30 80 L70 80 L90 40 L70 50 L50 10 L30 50 Z" fill="#feca57"/><circle cx="10" cy="30" r="8" fill="#ff6b81"/><circle cx="50" cy="10" r="8" fill="#ff6b81"/><circle cx="90" cy="30" r="8" fill="#ff6b81"/></svg>` }
];

// --- UI Elements ---
const statusDot = document.getElementById('tracking-status-dot');
const statusText = document.getElementById('tracking-status-text');
const colorBtns = document.querySelectorAll('.color-btn');
const canvasContainer = document.querySelector('.canvas-container');

// --- Initialization ---
async function init() {
    initThreeJS();
    await initMediaPipe();
    setupUI();
    animate();
}

function initThreeJS() {
    const canvas = document.getElementById('three-canvas');
    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;

    scene = new THREE.Scene();
    
    // Camera
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = 10; // Back up camera to see drawing

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Post-processing for Neon Glow
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0;
    bloomPass.strength = 2.0; // Intensity of glow
    bloomPass.radius = 0.5;

    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    // Fingertip Glow Sphere
    const glowGeo = new THREE.SphereGeometry(0.1, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
    fingerGlow = new THREE.Mesh(glowGeo, glowMat);
    fingerGlow.visible = false; // Hide until hand detected
    scene.add(fingerGlow);

    // Add floating 3D elements (Blender style)
    addFloatingElements();

    // Handle Resize
    window.addEventListener('resize', () => {
        const newWidth = canvasContainer.clientWidth;
        const newHeight = canvasContainer.clientHeight;
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
        composer.setSize(newWidth, newHeight);
    });
}

function addFloatingElements() {
    const geometries = [
        new THREE.TorusGeometry(0.5, 0.2, 16, 32),
        new THREE.IcosahedronGeometry(0.5, 0),
        new THREE.OctahedronGeometry(0.5, 0)
    ];

    const colors = [0xffb7c5, 0x48dbfb, 0xfeca57, 0x1dd1a1];

    for(let i = 0; i < 15; i++) {
        const geo = geometries[Math.floor(Math.random() * geometries.length)];
        const mat = new THREE.MeshStandardMaterial({
            color: colors[Math.floor(Math.random() * colors.length)],
            roughness: 0.1,
            metalness: 0.8,
            emissive: colors[Math.floor(Math.random() * colors.length)],
            emissiveIntensity: 0.2
        });
        const mesh = new THREE.Mesh(geo, mat);
        
        mesh.position.set(
            (Math.random() - 0.5) * 20,
            (Math.random() - 0.5) * 15,
            (Math.random() - 0.5) * 10 - 5
        );
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        
        // Custom animation data
        mesh.userData = {
            rotSpeedX: (Math.random() - 0.5) * 0.02,
            rotSpeedY: (Math.random() - 0.5) * 0.02,
            floatSpeed: (Math.random() * 0.02) + 0.01,
            originY: mesh.position.y
        };

        scene.add(mesh);
    }

    // Lights for 3D elements
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);
}

async function initMediaPipe() {
    statusText.innerText = "Loading AI...";
    statusDot.className = "dot";
    statusDot.style.background = "#feca57"; // Yellow loading
    
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1,
            minHandDetectionConfidence: 0.4,
            minHandPresenceConfidence: 0.4,
            minTrackingConfidence: 0.3 // Lower confidence to keep tracking during fast motion blur
        });
        
        startWebcam();
    } catch (error) {
        console.error(error);
        statusText.innerText = "Error Loading AI";
        statusDot.className = "dot red";
    }
}

async function startWebcam() {
    video = document.getElementById('webcam');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
        video.srcObject = stream;
        video.addEventListener('loadeddata', () => {
            video.play();
            webcamRunning = true;
            statusText.innerText = "Hand Tracking ON";
            statusDot.className = "dot green";
            console.log("Webcam started successfully.");
        });
    } catch (err) {
        console.error("Webcam access denied:", err);
        statusText.innerText = "Webcam Denied";
        statusDot.className = "dot red";
    }
}

function setupUI() {
    // Colors
    const colors = [
        'rainbow',
        0xff6b6b,
        0xfeca57,
        0x48dbfb,
        0x1dd1a1
    ];

    colorBtns.forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            colorBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            if(colors[idx] === 'rainbow') {
                isRainbow = true;
            } else {
                isRainbow = false;
                currentColor.setHex(colors[idx]);
            }
        });
    });

    // Photobooth Sticker setup
    const stickerContainer = document.getElementById('sticker-library');
    const brushBtn = document.getElementById('brush-mode-btn');

    stickerLibrary.forEach(lib => {
        const div = document.createElement('div');
        div.className = 'sticker';
        div.innerHTML = lib.svg;
        div.title = lib.name;
        
        div.addEventListener('click', () => {
            currentTool = 'stamp';
            activeStickerSVG = lib.svg;
            
            // UI updates
            document.querySelectorAll('.sticker').forEach(s => s.style.border = 'none');
            div.style.border = '2px solid #ff6b81';
            brushBtn.classList.remove('active');
        });
        
        stickerContainer.appendChild(div);
    });

    brushBtn.addEventListener('click', () => {
        currentTool = 'brush';
        brushBtn.classList.add('active');
        document.querySelectorAll('.sticker').forEach(s => s.style.border = 'none');
    });
}

function stampSticker(svgString, normX, normY) {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    // The video is horizontally mirrored, so we map left-to-right correctly
    const visualX = 1.0 - normX;
    
    wrapper.style.left = (visualX * 100) + '%';
    wrapper.style.top = (normY * 100) + '%';
    wrapper.style.transform = 'translate(-50%, -50%)';
    wrapper.style.zIndex = '10';
    wrapper.style.pointerEvents = 'none';

    wrapper.innerHTML = `<div class="floating-sticker" style="width:80px; height:80px;">${svgString}</div>`;
    
    document.querySelector('.canvas-container').appendChild(wrapper);

    // Pop animation
    wrapper.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    wrapper.style.transform = 'translate(-50%, -50%) scale(0.1)';
    setTimeout(() => wrapper.style.transform = 'translate(-50%, -50%) scale(1.2)', 10);
    setTimeout(() => wrapper.style.transform = 'translate(-50%, -50%) scale(1)', 200);

    // Remove after 8 seconds
    setTimeout(() => {
        wrapper.style.opacity = '0';
        wrapper.style.transition = 'opacity 1s ease-out';
        setTimeout(() => wrapper.remove(), 1000);
    }, 8000);
}

// --- Drawing Logic ---

function getWorldPosition(x, y, z) {
    // MediaPipe x and y are 0 to 1 (from top left).
    // The video is mirrored via CSS (`transform: scaleX(-1)`), but the hand tracking 
    // landmarks coordinates match the un-mirrored frame. So we must invert X.
    const normX = -((x - 0.5) * 2); 
    const normY = -((y - 0.5) * 2);
    
    // Scale to Three.js camera bounds. Z roughly gives depth
    const vector = new THREE.Vector3(normX, normY, 0.5);
    vector.unproject(camera);
    
    const dir = vector.sub(camera.position).normalize();
    // Use Z to add depth, pushing it away
    const distance = -camera.position.z / dir.z + (z * 10); 
    const pos = camera.position.clone().add(dir.multiplyScalar(distance));
    return pos;
}

function getDist2D(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function isFingerExtended(landmarks, tipIndex, mcpIndex) {
    const wrist = landmarks[0];
    const tip = landmarks[tipIndex];
    const mcp = landmarks[mcpIndex];
    // If distance from wrist to tip is greater than wrist to mcp * 1.2, it's extended
    return getDist2D(wrist, tip) > getDist2D(wrist, mcp) * 1.2;
}

function updateDrawing(landmarks) {
    const indexTip = landmarks[8];
    const thumbTip = landmarks[4];

    const pos = getWorldPosition(indexTip.x, indexTip.y, indexTip.z);
    
    // Show and update fingertip glow
    fingerGlow.visible = true;
    fingerGlow.position.copy(pos);

    const dist = Math.sqrt(
        Math.pow(indexTip.x - thumbTip.x, 2) +
        Math.pow(indexTip.y - thumbTip.y, 2) +
        Math.pow(indexTip.z - thumbTip.z, 2)
    );

    const pinchThreshold = 0.05;
    
    // Rotation invariant pointing check (Index extended, Middle folded)
    const indexUp = isFingerExtended(landmarks, 8, 5);
    const middleUp = isFingerExtended(landmarks, 12, 9);

    if (dist < pinchThreshold) {
        // Pinching (Clear Canvas)
        framesNotPointing = 0;
        if (!isPinching) {
            isPinching = true;
            clearCanvas();
        }
        currentLine = null;
        fingerGlow.material.color.setHex(0xff0000); // Red when pinching
    } else if (indexUp && !middleUp) {
        // Pointing
        framesNotPointing = 0;
        isPinching = false;
        
        if (currentTool === 'brush') {
            fingerGlow.material.color.setHex(isRainbow ? 0xffffff : currentColor.getHex());
            
            if (!currentLine) {
                // Start new line
                const material = new THREE.LineBasicMaterial({
                    color: isRainbow ? 0xffffff : currentColor.clone(),
                    linewidth: 5,
                    linecap: 'round',
                    linejoin: 'round',
                    transparent: true,
                    opacity: 0.9
                });
                const geometry = new THREE.BufferGeometry();
                const points = [pos];
                geometry.setFromPoints(points);
                currentLine = new THREE.Line(geometry, material);
                currentLine.userData = { points: points, isRainbow: isRainbow, birthTime: performance.now(), fading: false };
                scene.add(currentLine);
                lines.push(currentLine);
            } else {
                // Append points instantly for zero lag
                currentLine.userData.points.push(pos);
                currentLine.geometry.setFromPoints(currentLine.userData.points);
            }

            // Add tiny spark particles at contact point occasionally
            if (Math.random() > 0.5) {
                createTinySpark(pos);
            }
        } else if (currentTool === 'stamp') {
            currentLine = null; // Break line
            fingerGlow.material.color.setHex(0xffffff);
            
            // Only stamp every 500ms to prevent spamming
            if (performance.now() - lastStampTime > 500) {
                stampSticker(activeStickerSVG, indexTip.x, indexTip.y);
                lastStampTime = performance.now();
                createTinySpark(pos);
            }
        }
    } else {
        // "Flock finger" / open hand / other gestures -> Lift brush slowly
        framesNotPointing++;
        if (framesNotPointing > MAX_TOLERANCE_FRAMES) {
            isPinching = false;
            currentLine = null;
            fingerGlow.material.color.setHex(0xaaaaaa); // Gray when not drawing
        }
    }
}

function createTinySpark(pos) {
    const geo = new THREE.BoxGeometry(0.04, 0.04, 0.04);
    const mat = new THREE.MeshBasicMaterial({ color: isRainbow ? 0xffffff : currentColor.getHex() });
    const spark = new THREE.Mesh(geo, mat);
    spark.position.copy(pos);
    spark.userData = {
        vel: new THREE.Vector3((Math.random()-0.5)*0.05, Math.random()*0.05, (Math.random()-0.5)*0.05),
        life: 1.0
    };
    spark.isSpark = true;
    scene.add(spark);
}

function clearCanvas() {
    // Soft fade out animation for all lines
    lines.forEach(line => {
        // We'll animate opacity in the render loop by setting a fading flag
        line.userData.fading = true;
    });
    
    // Particle burst effect
    createParticleBurst();
}

function createParticleBurst() {
    // Simple particle burst using raw ThreeJS
    const geom = new THREE.BufferGeometry();
    const count = 100;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();

    for(let i=0; i<count; i++) {
        positions[i*3] = (Math.random() - 0.5) * 5;
        positions[i*3+1] = (Math.random() - 0.5) * 5;
        positions[i*3+2] = (Math.random() - 0.5) * 5;
        
        color.setHSL(Math.random(), 1.0, 0.5);
        colors[i*3] = color.r;
        colors[i*3+1] = color.g;
        colors[i*3+2] = color.b;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
        size: 0.2,
        vertexColors: true,
        transparent: true,
        opacity: 1.0
    });

    const points = new THREE.Points(geom, mat);
    points.userData = { isBurst: true, velocity: [] };
    
    for(let i=0; i<count; i++) {
        points.userData.velocity.push(new THREE.Vector3(
            (Math.random() - 0.5) * 0.1,
            (Math.random() - 0.5) * 0.1,
            (Math.random() - 0.5) * 0.1
        ));
    }
    
    scene.add(points);
    
    // Remove after animation
    setTimeout(() => {
        scene.remove(points);
    }, 2000);
}

let lastLogTime = 0;

// --- Main Loop ---
function animate() {
    requestAnimationFrame(animate);

    // MediaPipe Detection
    if (webcamRunning && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        let startTimeMs = performance.now();
        const results = handLandmarker.detectForVideo(video, startTimeMs);
        
        if (results.landmarks && results.landmarks.length > 0) {
            framesWithoutHand = 0;
            updateDrawing(results.landmarks[0]);
        } else {
            framesWithoutHand++;
            if (framesWithoutHand > MAX_TOLERANCE_FRAMES) {
                currentLine = null;
                fingerGlow.visible = false;
            }
        }
    }

    // Rainbow Color Shift
    hue += 0.01;
    if (hue > 1) hue = 0;
    
    const now = performance.now();

    // Update lines (fading and rainbow)
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        
        // Rainbow effect
        if (line.userData.isRainbow) {
            line.material.color.setHSL(hue, 1.0, 0.5);
        }

        // Time-based glow fading (auto fade after 5 seconds)
        if (now - line.userData.birthTime > 5000 && !line.userData.fading) {
            line.userData.fading = true;
        }

        // Fading effect
        if (line.userData.fading) {
            line.material.opacity -= 0.02;
            if (line.material.opacity <= 0) {
                scene.remove(line);
                line.geometry.dispose();
                line.material.dispose();
                lines.splice(i, 1);
            }
        }
    }

    // Animate 3D background elements and sparks
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const child = scene.children[i];
        if (child.isSpark) {
            child.position.add(child.userData.vel);
            child.userData.vel.y -= 0.002; // slight gravity
            child.userData.life -= 0.05;
            child.scale.setScalar(child.userData.life);
            if (child.userData.life <= 0) {
                scene.remove(child);
                child.geometry.dispose();
                child.material.dispose();
            }
        } else if (child.isMesh && !child.isSpark && child !== fingerGlow) {
            child.rotation.x += child.userData.rotSpeedX || 0;
            child.rotation.y += child.userData.rotSpeedY || 0;
            if (child.userData.originY !== undefined) {
                child.position.y = child.userData.originY + Math.sin(now * 0.002) * 0.5;
            }
        } else if (child.isPoints && child.userData.isBurst) {
            // Animate particles
            const positions = child.geometry.attributes.position.array;
            for(let j=0; j<positions.length/3; j++) {
                positions[j*3] += child.userData.velocity[j].x;
                positions[j*3+1] += child.userData.velocity[j].y;
                positions[j*3+2] += child.userData.velocity[j].z;
            }
            child.geometry.attributes.position.needsUpdate = true;
            child.material.opacity -= 0.01;
        }
    }

    composer.render();
}

// Start
init();
