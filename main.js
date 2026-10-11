/* ============================================================
   INTERACTIVE GRAPHENE ARTWORK · THREE.JS
   ============================================================

   The Blender export (graphene_geometry.json) supplies the mesh
   vertices and edges. If it is missing or invalid, a procedural
   lattice is used instead. The static poster is the final fallback
   if WebGL cannot start.

   The mesh stays still until pointer movement, a click or a touch.
   Its deformation is decorative, not a physics simulation.

   This module is separate from the inline website-interaction script.
   It is loaded through the Three.js import map in index.html.
*/

import * as THREE from 'three';


/* ============================================================
   01. PAGE ELEMENTS AND RENDERING STATE
   ============================================================ */

const art = document.querySelector('#graphene-art');
const canvas = document.querySelector('#graphene-canvas');
const status = document.querySelector('#load-status');
const mode = document.querySelector('#model-mode');
const resetButton = document.querySelector('#reset');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let renderer;
let camera;
let mesh;
let geometry;

// Source geometry, plus the line-segment buffers sent to WebGL.
let vertices = [];
let edges = [];
let positions;
let colours;

// The animation loop only runs while the surface is changing.
let frameId = 0;
let lastFrame = 0;
let lastActivity = 0;
let energy = 0;
let pulse = null;

// Pointer position in mesh coordinates, and its smoothed position.
let pointerX = 0;
let pointerY = 0;
let smoothX = 0;
let smoothY = 0;

// Updated from the dimensions of whichever mesh is loaded.
let fieldWidth = 15.0;
let fieldHeight = 13.0;

// Colour stops used for the red-to-blue gradient.
const blue = new THREE.Color('#0e4972');
const cyan = new THREE.Color('#179ac3');
const indigo = new THREE.Color('#33496e');
const vermilion = new THREE.Color('#bf403a');
const crimson = new THREE.Color('#a52645');
const scratch = new THREE.Color();

const scene = new THREE.Scene();

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}


/* ============================================================
   02. PROCEDURAL GEOMETRY · FALLBACK
   ============================================================ */

// Build a hexagonal wireframe with shared vertices and unique edges.
// This is used only when a valid Blender JSON export is unavailable.

function createProceduralLattice() {
    const radius = 0.245;
    const columns = 47;
    const rows = 45;
    const vertexLookup = new Map();
    const edgeLookup = new Set();
    const raw = [];
    const connections = [];

    function addVertex(x, y) {
        const key = `${Math.round(x * 100000)}:${Math.round(y * 100000)}`;

        if (!vertexLookup.has(key)) {
            vertexLookup.set(key, raw.length);
            raw.push([x, y, 0]);
        }

        return vertexLookup.get(key);
    }

    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const cx = Math.sqrt(3) * radius * (column + row / 2);
            const cy = 1.5 * radius * row;
            const corners = [];

            for (let corner = 0; corner < 6; corner++) {
                const angle = (Math.PI / 180) * (60 * corner + 30);

                corners.push(addVertex(
                    cx + Math.cos(angle) * radius,
                    cy + Math.sin(angle) * radius
                ));
            }

            for (let corner = 0; corner < 6; corner++) {
                const a = corners[corner];
                const b = corners[(corner + 1) % 6];
                const key = Math.min(a, b) + ':' + Math.max(a, b);

                if (!edgeLookup.has(key)) {
                    edgeLookup.add(key);
                    connections.push([a, b]);
                }
            }
        }
    }

    return { vertices: raw, edges: connections, procedural: true };
}

// Synthetic curvature for the procedural fallback only.
function baseElevation(x, y) {
    return 0.80 * Math.sin(0.66 * x + 0.28 * y)
         + 0.70 * Math.cos(0.48 * y - 0.24 * x)
         + 0.37 * Math.sin(0.52 * x - 0.72 * y)
         + 0.21 * Math.cos(1.15 * x + 0.35 * y);
}


/* ============================================================
   03. LOAD AND VALIDATE BLENDER GEOMETRY
   ============================================================ */

// Confirm the export contains reasonable vertex arrays and valid edges.

function validateExport(data) {
    if (!data || !Array.isArray(data.vertices) || !Array.isArray(data.edges)) {
        return false;
    }

    if (data.vertices.length < 10 || data.vertices.length > 100000) {
        return false;
    }

    if (data.edges.length < 10 || data.edges.length > 240000) {
        return false;
    }

    for (const v of data.vertices) {
        if (
            !Array.isArray(v) ||
            v.length < 3 ||
            !v.slice(0, 3).every(Number.isFinite)
        ) {
            return false;
        }
    }

    const n = data.vertices.length;

    for (const e of data.edges) {
        if (
            !Array.isArray(e) ||
            e.length < 2 ||
            !e.every(i => Number.isInteger(i) && i >= 0 && i < n)
        ) {
            return false;
        }
    }

    return true;
}

async function sourceGeometry() {
    try {
        const response = await fetch(
            './graphene_geometry.json',
            { cache: 'no-store' }
        );

        if (response.ok) {
            const content = await response.json();

            if (validateExport(content)) {
                return { ...content, procedural: false };
            }

            console.warn(
                'The Blender export has an unexpected geometry format; using the procedural mesh.'
            );
        }

    } catch (_error) {
        // The JSON is optional. Use the procedural mesh if unavailable.
    }

    return createProceduralLattice();
}


/* ============================================================
   04. NORMALISE GEOMETRY AND BUILD THE THREE.JS MESH
   ============================================================ */

function prepareGeometry(data) {
    const raw = data.vertices;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    // Find the exported geometry's bounds.
    for (const p of raw) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
        }
    }

    const extentX = max[0] - min[0];
    const extentY = max[1] - min[1];
    const scale = 15.0 / Math.max(extentX, extentY, 0.00001);

    const centerX = (max[0] + min[0]) / 2;
    const centerY = (max[1] + min[1]) / 2;
    const centerZ = (max[2] + min[2]) / 2;

    // Centre and scale the mesh.
    //
    // Blender Z is preserved. Only the procedural lattice
    // receives the synthetic elevation defined earlier.

    vertices = raw.map(p => {
        const x = (p[0] - centerX) * scale;
        const y = (p[1] - centerY) * scale;

        const z = data.procedural
            ? baseElevation(x, y)
            : (p[2] - centerZ) * scale;

        return [x, y, z];
    });

    edges = data.edges;
    fieldWidth = extentX * scale;
    fieldHeight = extentY * scale;

    // Each edge contributes two 3D positions and two RGB colours.
    positions = new Float32Array(edges.length * 6);
    colours = new Float32Array(edges.length * 6);

    geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
            positions, 3
        ).setUsage(THREE.DynamicDrawUsage)
    );

    geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(
            colours, 3
        ).setUsage(THREE.DynamicDrawUsage)
    );

    mesh = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.89
        })
    );

    mesh.frustumCulled = false;

    return mesh;
}


/* ============================================================
   05. GRADIENT COLOURS AND LATTICE DEFORMATION
   ============================================================ */

// Blend red, indigo, cyan and blue along the mesh's Y direction.
// Pointer movement and ripple effects subtly shift the gradient.

function gradColour(y, influence, result) {
    let t = clamp(
        (y / Math.max(fieldHeight, 0.001)) + .5 + influence * .055,
        0,
        1
    );

    if (t < .28) {
        result.copy(crimson).lerp(vermilion, t / .28);

    } else if (t < .53) {
        result.copy(vermilion).lerp(indigo, (t - .28) / .25);

    } else if (t < .72) {
        result.copy(indigo).lerp(cyan, (t - .53) / .19);

    } else {
        result.copy(cyan).lerp(blue, (t - .72) / .28);
    }

    return result;
}

const displaced = [];
const tinted = [];

function updateLattice(timestamp) {
    const pulseAge = pulse
        ? (timestamp - pulse.time) / 1000
        : Infinity;

    if (pulse && pulseAge > 1.8) {
        pulse = null;
    }

    const strength = reducedMotion.matches ? 0 : energy;

    // Apply local pointer deformation and an outward click ripple.
    for (let i = 0; i < vertices.length; i++) {
        const [x, y, z] = vertices[i];

        const dx = x - smoothX;
        const dy = y - smoothY;
        const r2 = dx * dx + dy * dy;

        const local = Math.exp(-r2 / 7.5) * strength;

        let ripple = 0;

        if (pulse) {
            const distance = Math.sqrt(
                (x - pulse.x) ** 2 +
                (y - pulse.y) ** 2
            );

            const front = distance - pulseAge * 5.8;

            ripple =
                Math.sin(front * 2.6) *
                Math.exp(-front * front * 0.9) *
                0.36 *
                Math.exp(-pulseAge * 1.5);
        }

        displaced[i] = [
            x + dx * local * .035,
            y + dy * local * .026,
            z + local * .56 + ripple
        ];

        const colourInfluence = local * 0.5 + ripple * 0.6;

        gradColour(y, colourInfluence, scratch);

        tinted[i] = [
            scratch.r,
            scratch.g,
            scratch.b
        ];
    }

    // Write the two endpoints of each edge to the GPU buffers.
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];

        const a = displaced[edge[0]];
        const b = displaced[edge[1]];

        const ca = tinted[edge[0]];
        const cb = tinted[edge[1]];

        const k = i * 6;

        positions[k] = a[0];
        positions[k + 1] = a[1];
        positions[k + 2] = a[2];

        positions[k + 3] = b[0];
        positions[k + 4] = b[1];
        positions[k + 5] = b[2];

        colours[k] = ca[0];
        colours[k + 1] = ca[1];
        colours[k + 2] = ca[2];

        colours[k + 3] = cb[0];
        colours[k + 4] = cb[1];
        colours[k + 5] = cb[2];
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
}


/* ============================================================
   06. CAMERA AND CANVAS RESIZING
   ============================================================ */

function resize() {
    if (!renderer) {
        return;
    }

    const width = Math.max(1, art.clientWidth);
    const height = Math.max(1, art.clientHeight);

    renderer.setSize(width, height, false);

    // Orthographic framing.
    //
    // These settings determine how much graphene is visible.
    // The current zoom and aspect calculations are unchanged.

    const aspect = width / height;
    const halfHeight = 3.7;

    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;

    camera.updateProjectionMatrix();

    if (mesh) {
        renderer.render(scene, camera);
    }
}


/* ============================================================
   07. ON-DEMAND ANIMATION LOOP
   ============================================================ */

// Unlike a continuously animated scene, the renderer requests
// frames only while movement, smoothing or a ripple is active.

function queueFrame() {
    if (frameId || !renderer) {
        return;
    }

    frameId = requestAnimationFrame(drawFrame);
}

function drawFrame(timestamp) {
    frameId = 0;

    const dt = Math.min(
        0.06,
        Math.max(
            0,
            (timestamp - (lastFrame || timestamp)) / 1000
        )
    );

    lastFrame = timestamp;

    // Recent pointer activity adds energy.
    // Otherwise the deformation gradually decays.

    const target =
        !reducedMotion.matches && timestamp - lastActivity < 90
            ? 0.95
            : 0;

    const decay = 1 - Math.exp(
        -dt * (target ? 13 : 4.3)
    );

    energy += (target - energy) * decay;

    // Smooth the pointer so deformation eases towards it.
    smoothX += (pointerX - smoothX) * (1 - Math.exp(-dt * 8));
    smoothY += (pointerY - smoothY) * (1 - Math.exp(-dt * 8));

    updateLattice(timestamp);
    renderer.render(scene, camera);

    // Stop requesting frames once everything is sufficiently still.
    if (
        energy > 0.0008 ||
        pulse ||
        Math.abs(pointerX - smoothX) > .006 ||
        Math.abs(pointerY - smoothY) > .006 ||
        target > 0
    ) {
        queueFrame();
    }
}


/* ============================================================
   08. POINTER COORDINATES AND INTERACTIONS
   ============================================================ */

// Translate browser pointer coordinates into the centred mesh field.

function readPointer(event) {
    const box = art.getBoundingClientRect();

    pointerX =
        ((event.clientX - box.left) / box.width - .5) * fieldWidth;

    pointerY =
        (.5 - (event.clientY - box.top) / box.height) * fieldHeight;
}


/* ============================================================
   09. INITIALISE THREE.JS AND EVENT LISTENERS
   ============================================================ */

async function start() {
    try {

        // ----------------------------------------------------
        // 09.1. CREATE RENDERER AND CAMERA
        // ----------------------------------------------------

        renderer = new THREE.WebGLRenderer({
            canvas,
            alpha: true,
            antialias: true,
            powerPreference: 'low-power'
        });

        renderer.setPixelRatio(
            Math.min(window.devicePixelRatio || 1, 2)
        );

        renderer.outputColorSpace = THREE.SRGBColorSpace;

        camera = new THREE.OrthographicCamera(
            -10, 10, 10, -10, 0.1, 100
        );

        camera.up.set(0, 0, 1);
        camera.position.set(0, -14.6, 3.9);
        camera.lookAt(0, 0, 0);

        // ----------------------------------------------------
        // 09.2. LOAD AND DISPLAY THE GEOMETRY
        // ----------------------------------------------------

        // Load Blender geometry, or create the procedural fallback.

        const data = await sourceGeometry();

        scene.add(prepareGeometry(data));

        mode.textContent = data.procedural
            ? 'Procedural lattice · awaiting Blender export'
            : 'Geometry from your Blender project';

        status.textContent = data.procedural
            ? '3D ready · sample geometry'
            : '3D ready · Blender geometry';

        // Render one initial still frame.
        resize();
        updateLattice(0);
        renderer.render(scene, camera);

        // Hide the static poster when WebGL is ready.
        art.classList.add('is-live');

        // Enable the existing reset control.
        resetButton.disabled = false;

        // Update the camera when the artwork container changes size.
        const observer = new ResizeObserver(resize);
        observer.observe(art);

        // ----------------------------------------------------
        // 09.3. POINTER MOVEMENT AND CLICK RIPPLE
        // ----------------------------------------------------

        // Respect reduced-motion preferences by not installing
        // the interactive pointer effects.

        if (!reducedMotion.matches) {

            // Move and deform the mesh under the pointer.
            art.addEventListener('pointermove', event => {
                if (event.pointerType === 'touch') {
                    return;
                }

                readPointer(event);
                lastActivity = performance.now();

                queueFrame();
            });

            // Start a ripple when the artwork is clicked or tapped.
            art.addEventListener('pointerdown', event => {
                readPointer(event);

                smoothX = pointerX;
                smoothY = pointerY;

                pulse = {
                    x: pointerX,
                    y: pointerY,
                    time: performance.now()
                };

                lastActivity = 0;

                queueFrame();
            });
        }

        // ----------------------------------------------------
        // 09.4. RESET THE SURFACE
        // ----------------------------------------------------

        // Restore the undeformed wireframe when reset is used.

        resetButton.addEventListener('click', () => {
            energy = 0;
            pulse = null;

            pointerX = 0;
            pointerY = 0;

            smoothX = 0;
            smoothY = 0;

            lastActivity = 0;

            updateLattice(0);
            renderer.render(scene, camera);
        });

        // ----------------------------------------------------
        // 09.5. PAGE VISIBILITY
        // ----------------------------------------------------

        // Avoid unnecessary animation while the tab is hidden.
        // Redraw once when the visitor returns.

        document.addEventListener('visibilitychange', () => {

            if (document.hidden && frameId) {
                cancelAnimationFrame(frameId);
                frameId = 0;

            } else if (!document.hidden && renderer && mesh) {
                renderer.render(scene, camera);
            }
        });

    } catch (error) {

        // ----------------------------------------------------
        // 09.6. WEBGL ERROR FALLBACK
        // ----------------------------------------------------

        // Preserve the static poster if WebGL cannot initialise.

        console.error('Could not initialise Three.js:', error);

        status.textContent =
            'Static image fallback · 3D unavailable';

        mode.textContent =
            'Original graphene artwork';

        canvas.style.display = 'none';
        resetButton.disabled = true;
    }
}

// Start the interactive graphene artwork.
start();