import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { createNoise3D } from 'simplex-noise';
import GUI from 'lil-gui';

// ============================================================
// Simplex noise — one shared 3D noise field reused everywhere a
// wander/drift motion used to be driven by Math.sin/cos. A single
// noise3D instance is cheap to sample (O(1)/call) and is shared
// rather than per-object so we're not paying setup cost repeatedly.
//
// noiseAt(seed, t, rate) sasmples a smooth, non-repeating scalar in
// [-1, 1] for a given "seed" (decorrelates independent signals so two
// different quantities sampled at the same t don't move in lockstep)
// evolving over time t at the given rate. It walks a genuinely curved
// path through the 3D noise field (two axes advance at different
// rates) rather than a straight 1D slice, which avoids the visible
// axis-aligned bias a straight slice through simplex noise can show.
// ============================================================
const noise3D = createNoise3D();

function noiseAt(seed, t, rate) {
  return noise3D(t * rate, t * rate * 0.37 + seed, seed * 1.7);
}

// Bakes fractal (multi-octave) simplex noise into a grayscale canvas —
// reused for both the nebula wash's cloud wisps and each planet's
// surface mottling, drawn on top of an existing gradient via canvas
// 'overlay' compositing rather than computed per-pixel by hand.
function makeNoiseCanvas(size, seed, { octaves = 4, baseFreq = 0.06, persistence = 0.5, lacunarity = 2.1 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cctx = c.getContext('2d');
  const img = cctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, amp = 1, freq = baseFreq, norm = 0;
      for (let o = 0; o < octaves; o++) {
        n += amp * noise3D(x * freq + seed, y * freq + seed * 1.7, o * 11.3);
        norm += amp;
        amp *= persistence;
        freq *= lacunarity;
      }
      const v = Math.round(THREE.MathUtils.clamp((n / norm) * 0.5 + 0.5, 0, 1) * 255);
      const idx = (y * size + x) * 4;
      img.data[idx] = v; img.data[idx + 1] = v; img.data[idx + 2] = v; img.data[idx + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);
  return c;
}

// ============================================================
// Renderer / scene / camera / bloom
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
// Density recalibrated for the ~110-370 unit object depth range below
// (was tuned for the old, much closer 25-70 unit range and fogged out
// everything at the new distances almost immediately).
scene.fog = new THREE.FogExp2(0x000000, 0.0016);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 900);
scene.add(camera); // so camera-attached children (starfield, headlight) render

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Mirrors the reference's core "smoothness" trick: its canvas is never
// fully cleared, only faded 8% per frame, so bright/moving things leave
// soft trailing residue that builds into a hazy, nebulous quality over
// time. damp ~0.9 approximates that 8%-per-frame retention. Placed
// before bloom so the trailed residue blooms too, not just the crisp
// current frame.
const afterimagePass = new AfterimagePass(0.9);
composer.addPass(afterimagePass);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.3, 0.6, 0.15
);
composer.addPass(bloomPass);

const lineResolution = new THREE.Vector2(window.innerWidth, window.innerHeight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  lineResolution.set(window.innerWidth, window.innerHeight);
  updateWashGeometry();
});

// ---- Debug panel ----
const debugParams = {
  travelSpeedMultiplier: 0.18,
  starDensity: 0.5,
};
const gui = new GUI({ title: 'Debug' });
gui.add(bloomPass, 'strength', 0, 3, 0.01).name('Bloom Strength');
gui.add(afterimagePass.uniforms['damp'], 'value', 0, 0.98, 0.01).name('Trail Amount');
gui.add(debugParams, 'travelSpeedMultiplier', 0, 2, 0.05).name('Travel Speed');
gui.add(debugParams, 'starDensity', 0, 1, 0.01).name('Star Density');

scene.add(new THREE.AmbientLight(0x445566, 0.25));
// Off-axis so it actually casts visible shading across spheres instead of
// flattening them with flash-on-camera lighting.
const headLight = new THREE.PointLight(0xffffff, 1.0, 140, 2);
headLight.position.set(4, 5, 2);
camera.add(headLight);
// World-fixed "sun" so every planet the camera flies past reads its form
// from a consistent light direction rather than only the moving headlight.
const sunLight = new THREE.DirectionalLight(0xfff0dd, 0.7);
sunLight.position.set(30, 50, 10);
scene.add(sunLight);

// ============================================================
// Session-long warmth drift + hue helpers
// ============================================================
const sessionStart = performance.now();
const DRIFT_DURATION = 5 * 60 * 1000;

function warmthProgress() {
  return Math.min((performance.now() - sessionStart) / DRIFT_DURATION, 1);
}

function randomHue() {
  const t = warmthProgress();
  const coolCenter = 230, warmCenter = 20;
  const center = coolCenter + (warmCenter - coolCenter) * t;
  return ((center + (Math.random() - 0.5) * 100) + 360) % 360;
}

function randomHueFull() {
  return Math.random() * 360;
}

// ============================================================
// Note-density-driven tempo
// ============================================================
let noteTimestamps = [];
let tempoFactor = 0;

function updateTempo(now) {
  noteTimestamps.push(now);
  if (noteTimestamps.length > 10) noteTimestamps.shift();
  if (noteTimestamps.length >= 2) {
    let totalInterval = 0;
    for (let i = 1; i < noteTimestamps.length; i++) totalInterval += noteTimestamps[i] - noteTimestamps[i - 1];
    const avg = totalInterval / (noteTimestamps.length - 1);
    const target = Math.max(0, Math.min(1, 1 - (avg - 80) / 1200));
    tempoFactor += (target - tempoFactor) * 0.3;
  }
}

// ============================================================
// Camera forward flight: only the camera moves through a static
// world. Speed is driven by tempoFactor (idle = still, dense
// playing = faster), with a gentle organic wander so the path
// reads as a real flight rather than a rigid rail.
// ============================================================
const camPos = new THREE.Vector3(0, 0, 0);
let camDriftPhase = 0;
let travelSpeed = 0;
let frameTime = 0;
const PASS_MARGIN = 4; // world units behind camera before an object is culled

function updateCameraFlight() {
  frameTime++;
  tempoFactor *= 0.998;
  travelSpeed = tempoFactor > 0.001 ? tempoFactor * debugParams.travelSpeedMultiplier : 0;

  camDriftPhase += 0.004 + travelSpeed * 0.01;
  camPos.z -= travelSpeed;

  const driftX = Math.sin(camDriftPhase * 0.6) * 3;
  const driftY = Math.cos(camDriftPhase * 0.4) * 1.4;
  camera.position.set(camPos.x + driftX, camPos.y + driftY, camPos.z);

  const targetX = camPos.x + Math.sin(camDriftPhase * 0.6 + 0.25) * 3;
  const targetY = camPos.y + Math.cos(camDriftPhase * 0.4 + 0.25) * 1.4;
  camera.lookAt(targetX, targetY, camPos.z - 20);
}

// Spawn distance/spread calibrated so radius/distance ratios roughly
// match the reference's small, mostly-distant scattered look — the old
// 25-70 range put objects so close (with a 60deg FOV) that they loomed
// huge and flew past in 2-5s instead of the reference's calm ~7-18s.
// Spread scales with distance so notes scatter across the wide FOV like
// the reference's full-canvas placement, instead of clustering near center.
function spawnAnchor() {
  const dist = 110 + Math.random() * 260;
  const spread = dist * (0.4 + Math.random() * 0.35);
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * spread;
  return new THREE.Vector3(
    camPos.x + Math.cos(angle) * r,
    camPos.y + Math.sin(angle) * r * 0.6,
    camPos.z - dist
  );
}

function updateFog() {
  const t = warmthProgress();
  const hue = (250 + (20 - 250) * t + Math.sin(frameTime * 0.001) * 15 + 360) % 360;
  scene.fog.color.setHSL(hue / 360, 0.5, 0.05 + tempoFactor * 0.02);
  scene.fog.density = 0.0016 + tempoFactor * 0.0008;
}

// ============================================================
// Permanent star field — a "map of everything played this
// session". Attached to the camera so it always surrounds the
// viewer like a skybox, unaffected by forward flight.
// ============================================================
const MAX_STARS = 600;
const MAX_CONST_LINES = 90;

const starPositions = new Float32Array(MAX_STARS * 3);
const starColors = new Float32Array(MAX_STARS * 3);
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
starGeo.setDrawRange(0, 0);
const starMat = new THREE.PointsMaterial({
  size: 1.6, vertexColors: true, transparent: true, opacity: 0.85,
  sizeAttenuation: true, depthWrite: false, fog: false,
});
const starPoints = new THREE.Points(starGeo, starMat);
camera.add(starPoints);

const permanentStars = new Array(MAX_STARS).fill(null);
let starWriteIndex = 0;
const constellationLines = [];
let constellationCooldown = 60;

function addPermanentStar(hue) {
  const r = 300 + Math.random() * 400;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(THREE.MathUtils.clamp(2 * Math.random() - 1, -1, 1));
  const x = r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.sin(phi) * Math.sin(theta);
  const z = r * Math.cos(phi);

  const idx = starWriteIndex % MAX_STARS;
  starPositions[idx * 3] = x; starPositions[idx * 3 + 1] = y; starPositions[idx * 3 + 2] = z;
  const c = new THREE.Color().setHSL(hue / 360, 0.55, 0.78);
  starColors[idx * 3] = c.r; starColors[idx * 3 + 1] = c.g; starColors[idx * 3 + 2] = c.b;
  starGeo.attributes.position.needsUpdate = true;
  starGeo.attributes.color.needsUpdate = true;

  permanentStars[idx] = { x, y, z, hue };
  starWriteIndex++;
  starGeo.setDrawRange(0, Math.min(starWriteIndex, MAX_STARS));
}

function tryConnectStars() {
  const populated = permanentStars.filter(Boolean);
  if (populated.length < 6) return;
  const a = populated[Math.floor(Math.random() * populated.length)];
  let best = null, bestDist = 300;
  for (let i = 0; i < 15; i++) {
    const b = populated[Math.floor(Math.random() * populated.length)];
    if (!b || b === a) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  if (!best) return;

  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(best.x, best.y, best.z),
  ]);
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color().setHSL(((a.hue + best.hue) / 2 / 360 + 1) % 1, 0.5, 0.7),
    transparent: true, opacity: 0.12, fog: false,
  });
  const line = new THREE.Line(geo, mat);
  camera.add(line);
  constellationLines.push({ line, mat, geo });
  if (constellationLines.length > MAX_CONST_LINES) {
    const old = constellationLines.shift();
    camera.remove(old.line); old.geo.dispose(); old.mat.dispose();
  }
}

// ============================================================
// Grid-line webs — direct port of the reference's spawnGridLines(): a
// random hub point with a few satellites, connected hub-to-satellite
// and satellite-to-satellite in a loop, additive blend, fading in over
// 50 frames then holding for several seconds before slowly fading out.
// The reference draws these in raw canvas (screen) space, independent
// of its z/depth system, so — like the permanent star field — they're
// camera-attached rather than world-anchored, holding still relative
// to the view instead of being swept away by forward flight.
// ============================================================
const MAX_GRID_LINES = 90;
const gridLines = [];

function randomGridPoint() {
  // Closer than the star field (300-700) so these read as bold
  // foreground structure spanning much of the view, matching the
  // reference's screen-spanning lines rather than tiny distant dots.
  const r = 90 + Math.random() * 160;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(THREE.MathUtils.clamp(2 * Math.random() - 1, -1, 1));
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi)
  );
}

function addGridLine(pA, pB, hue) {
  const geo = new THREE.BufferGeometry().setFromPoints([pA, pB]);
  const targetAlpha = 0.035 + Math.random() * 0.05;
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color().setHSL((((hue + (Math.random() - 0.5) * 30) % 360) + 360) % 360 / 360, 0.55, 0.6),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const line = new THREE.Line(geo, mat);
  camera.add(line);
  const obj = { line, mat, geo, age: 0, targetAlpha, life: 1.0, fadeDecay: 0.0009 + Math.random() * 0.0013 };
  gridLines.push(obj);
  if (gridLines.length > MAX_GRID_LINES) {
    const old = gridLines.shift();
    camera.remove(old.line); old.geo.dispose(); old.mat.dispose();
  }
  return obj;
}

function spawnGridLines() {
  const hue = randomHue();
  const hub = randomGridPoint();
  const pointCount = 2 + Math.floor(Math.random() * 3);
  const satellites = [];
  for (let i = 0; i < pointCount; i++) satellites.push(randomGridPoint());

  const created = [];
  for (const s of satellites) created.push(addGridLine(s, hub, hue));
  for (let i = 0; i < satellites.length; i++) {
    const a = satellites[i], b = satellites[(i + 1) % satellites.length];
    created.push(addGridLine(a, b, hue));
  }

  // one rare, slightly brighter keystone line per structure
  if (created.length > 0 && Math.random() < 0.5) {
    const pick = created[Math.floor(Math.random() * created.length)];
    pick.targetAlpha *= 1.7;
    const hsl = { h: 0, s: 0, l: 0 };
    pick.mat.color.getHSL(hsl);
    pick.mat.color.setHSL(hsl.h, hsl.s, 0.72);
  }
}

function updateGridLines() {
  for (let i = gridLines.length - 1; i >= 0; i--) {
    const l = gridLines[i];
    if (l.age < 50) l.age++; else l.life -= l.fadeDecay;
    if (l.life <= 0) {
      camera.remove(l.line); l.geo.dispose(); l.mat.dispose();
      gridLines.splice(i, 1);
      continue;
    }
    l.mat.opacity = (l.age / 50) * l.targetAlpha * Math.max(l.life, 0);
  }
}

// ============================================================
// Background wash — direct port of the reference's drawBackgroundWash():
// a single soft radial glow whose hue oscillates around 280 (purple) and
// whose center drifts in a slow lissajous path, same frequencies/ratios
// as the source. It's a camera-attached billboard rather than a
// world-anchored object because the reference's wash was itself a
// screen-space overlay, not a scene object.
//
// One necessary deviation: the reference relies on the 2D canvas NOT
// being cleared between frames (it fades the previous frame by 8% and
// repaints on top, and now the AfterimagePass above approximates that
// same trailing-residue accumulation), so its very low 0.06 peak alpha
// builds into a visible wash over many frames. Even with that, a
// literal 0.06 alpha reads as basically invisible on a single fresh
// render, so WASH_ALPHA_BOOST compensates — kept low so the background
// stays almost-dark/very subtle rather than a visible glow.
// ============================================================
const WASH_ALPHA_BOOST = 0.7;

// Smooth radial falloff, reused (unchanged) for planet halos/blotches —
// those want a clean soft glow, not the cloud texture below.
function makeWashTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
const washTexture = makeWashTexture();

// Fractal-noise cloud texture for the background wash specifically — an
// opaque noise pattern (so 'overlay' blending has real light/dark
// contrast to work with) clipped down to a soft circular falloff via
// 'destination-in', giving wispy internal detail instead of one flat
// gradient blob.
function makeNebulaTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  const noiseCanvas = makeNoiseCanvas(size, 777.7, { octaves: 5, baseFreq: 0.022, persistence: 0.55 });
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.7;
  ctx.drawImage(noiseCanvas, 0, 0);
  ctx.globalAlpha = 1;

  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.55, 'rgba(255,255,255,0.7)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return new THREE.CanvasTexture(canvas);
}
const nebulaTexture = makeNebulaTexture();

const washMat = new THREE.SpriteMaterial({
  map: nebulaTexture, color: 0x000000, transparent: true, opacity: 0.06 * WASH_ALPHA_BOOST,
  depthWrite: false, depthTest: false, fog: false,
});
const washSprite = new THREE.Sprite(washMat);
washSprite.renderOrder = -10;
camera.add(washSprite);

const WASH_Z_DIST = 100;
let washAmpX = 60, washAmpY = 40;

function updateWashGeometry() {
  const halfHeight = WASH_Z_DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const halfWidth = halfHeight * camera.aspect;
  // Small drift range — a wide sweep read as distracting/annoying motion.
  washAmpX = 0.3 * halfWidth;
  washAmpY = 0.3 * halfHeight;
  const waveRadius = 0.65 * Math.max(halfWidth, halfHeight) * 2;
  washSprite.scale.set(waveRadius * 2, waveRadius * 2, 1);
}
updateWashGeometry();

function updateNebula() {
  const speedMult = 1 + tempoFactor * 1.3;
  const t = frameTime * speedMult;
  // Same frequencies/amplitudes as the original sine-driven version —
  // only the waveform generator changed, from a perfectly periodic
  // Lissajous path to a smooth, non-repeating noise-driven one. Distinct
  // seeds keep hue, X and Y from moving in lockstep with each other.
  const hue = 280 + noiseAt(11.3, t, 0.00015) * 40;
  washMat.color.setHSL(((hue % 360) + 360) % 360 / 360, 0.55, 0.14);
  const localX = washAmpX * noiseAt(47.9, t, 0.00021);
  const localY = washAmpY * noiseAt(83.6, t, 0.00016);
  washSprite.position.set(localX, localY, -WASH_Z_DIST);
}

// ============================================================
// Planets — gradient-shaded spheres, some ringed, some with
// recursive moon systems (a moon can have its own smaller moon).
// ============================================================
const MAX_PLANETS = 40;
const planets = [];

// Bakes the planet's actual hue blend into a small radial-gradient texture
// (mirrors the reference's per-planet canvas gradient) instead of a single
// shared gray shading mask — so the surface itself carries the color blend.
function makePlanetGradientTexture(hues) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size * 0.34, size * 0.34, size * 0.02, size * 0.5, size * 0.5, size * 0.7);
  const stops = hues.length >= 3
    ? [[0, hues[0], 65, 58], [0.55, hues[1], 60, 40], [1, hues[2], 55, 22]]
    : [[0, hues[0], 65, 58], [1, hues[1], 60, 24]];
  for (const [pos, h, s, l] of stops) grad.addColorStop(pos, `hsl(${h}, ${s}%, ${l}%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Fractal-noise surface mottling (continent/cloud-band-like detail),
  // unique per planet — 'overlay' blend perturbs contrast/lightness
  // around the existing gradient rather than replacing its color.
  const noiseCanvas = makeNoiseCanvas(size, Math.random() * 1000, { octaves: 4, baseFreq: 0.09 });
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.5;
  ctx.drawImage(noiseCanvas, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  return new THREE.CanvasTexture(canvas);
}

// A moon can itself have a smaller moon, a couple of levels deep —
// nested as real Object3D children so three.js handles the compound
// orbital transforms for us.
function makeMoon(depth, sizeFrac, parentMesh, parentRadius, hueColor) {
  if (depth <= 0) return null;
  const size = Math.max(0.04, parentRadius * sizeFrac);
  const geo = new THREE.SphereGeometry(size, 12, 9);
  const mat = new THREE.MeshStandardMaterial({
    color: hueColor, emissive: hueColor, emissiveIntensity: 0.35, roughness: 0.6, transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  parentMesh.add(mesh);
  return {
    mesh, mat,
    angle: Math.random() * Math.PI * 2,
    speed: (0.02 + Math.random() * 0.03) * (1 + (3 - depth) * 0.4),
    dist: parentRadius * (2.0 + Math.random() * 0.8),
    child: Math.random() < 0.7 ? makeMoon(depth - 1, sizeFrac * (0.45 + Math.random() * 0.15), mesh, size, hueColor) : null,
  };
}

function updateMoonRecursive(moon) {
  if (!moon) return;
  moon.angle += moon.speed * (1 + tempoFactor * 0.5);
  moon.mesh.position.set(
    Math.cos(moon.angle) * moon.dist,
    Math.sin(moon.angle) * moon.dist * 0.5,
    Math.sin(moon.angle * 0.8) * moon.dist * 0.5
  );
  updateMoonRecursive(moon.child);
}

function collectMoonMats(moon, out) {
  if (!moon) return out;
  out.push(moon.mat);
  return collectMoonMats(moon.child, out);
}

function spawnPlanet(v, anchor) {
  const isDistant = Math.random() < 0.35;
  const baseRadius = (isDistant ? 0.6 + v * 2.0 : 1.25 + v * 4.0) * (0.85 + tempoFactor * 0.3);
  const hueCount = Math.random() < 0.5 ? 2 : 3;
  const baseHue = randomHueFull();
  const hues = [];
  for (let i = 0; i < hueCount; i++) hues.push((baseHue + i * (35 + Math.random() * 70)) % 360);

  const group = new THREE.Group();
  const basePos = anchor.clone();
  group.position.copy(basePos);
  scene.add(group);

  const coreTexture = makePlanetGradientTexture(hues);
  // emissiveMap carries the same baked gradient as `map`, so the sphere's
  // true colors always read even on the hemisphere facing away from the
  // lights — the reference's flat gradient circles are never physically
  // shaded, and without this every planet's dark side reads as a muddy
  // near-black blob under our comparatively weak scene lighting.
  const coreMat = new THREE.MeshStandardMaterial({
    map: coreTexture,
    emissiveMap: coreTexture,
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.22 + v * 0.3,
    roughness: 0.55, metalness: 0.05, transparent: true, opacity: 1,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(baseRadius, 24, 18), coreMat);
  group.add(core);

  // Soft additive glow halo behind the planet — direct port of the
  // reference's radial-gradient halo pass (r*2.2, 'lighter' blend) drawn
  // before the surface. Entirely absent before; this is most of the
  // "atmospheric" quality the flat three.js version was missing.
  const haloMat = new THREE.SpriteMaterial({
    map: washTexture,
    color: new THREE.Color().setHSL(hues[0] / 360, 0.6, 0.45),
    transparent: true, opacity: 0.2,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(baseRadius * 3.2); // soft glow falloff, not a full second sphere
  group.add(halo);

  // Soft-edged radial-gradient patches (billboard sprites, still depth-
  // tested against the sphere so they're correctly hidden on the far
  // side), matching the reference's borderless gradient blobs — not the
  // small opaque lit spheres this used to be, which read as hard "acne"
  // bumps under real lighting instead of soft surface mottling.
  const blotchMats = [];
  const blotchCount = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < blotchCount; i++) {
    const ang = Math.random() * Math.PI * 2;
    const elevation = (Math.random() - 0.5) * Math.PI * 0.6;
    const bx = Math.cos(ang) * Math.cos(elevation) * baseRadius * 0.95;
    const by = Math.sin(elevation) * baseRadius * 0.95;
    const bz = Math.sin(ang) * Math.cos(elevation) * baseRadius * 0.95;
    const bsize = baseRadius * (0.2 + Math.random() * 0.3);
    const bhue = ((hues[0] + (Math.random() - 0.5) * 50) % 360 + 360) % 360;
    const bmat = new THREE.SpriteMaterial({
      map: washTexture,
      color: new THREE.Color().setHSL(bhue / 360, 0.55, 0.32),
      transparent: true, opacity: 0.4, depthWrite: false, fog: false,
    });
    const bsprite = new THREE.Sprite(bmat);
    bsprite.scale.setScalar(Math.max(0.04, bsize * 2));
    bsprite.position.set(bx, by, bz);
    core.add(bsprite);
    blotchMats.push(bmat);
  }

  let ring = null, ringMat = null;
  if (Math.random() > 0.35) {
    // Unlit + additive, like the reference's thin stroked/lighter-blended
    // ellipse — a real lit MeshStandardMaterial torus just reads as a
    // solid grey/matte donut regardless of hue.
    const ringHue = new THREE.Color().setHSL(hues[0] / 360, 0.55, 0.65);
    ringMat = new THREE.MeshBasicMaterial({
      color: ringHue, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ringRadius = baseRadius * (1.55 + Math.random() * 0.3);
    const tubeRadius = baseRadius * (0.025 + Math.random() * 0.02);
    ring = new THREE.Mesh(new THREE.TorusGeometry(ringRadius, tubeRadius, 8, 48), ringMat);
    ring.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.9;
    ring.rotation.y = Math.random() * Math.PI;
    group.add(ring);
  }

  let moon = null, moonMats = [];
  if (baseRadius > 1.4 && Math.random() < 0.55) {
    const moonColor = new THREE.Color().setHSL(hues[hues.length - 1] / 360, 0.5, 0.6);
    moon = makeMoon(3, 0.4 + Math.random() * 0.15, core, baseRadius, moonColor);
    moonMats = collectMoonMats(moon, []);
  }

  const hasOrbit = Math.random() < 0.55;
  const hasSpin = Math.random() < 0.4;

  planets.push({
    group, core, coreMat, coreTexture, halo, haloMat, blotchMats, ring, ringMat, moon, moonMats,
    basePos, hasOrbit, radius: baseRadius,
    orbitAngle: Math.random() * Math.PI * 2,
    orbitSpeed: (0.004 + Math.random() * 0.01) * (Math.random() < 0.5 ? 1 : -1),
    orbitRadiusX: 1.5 + Math.random() * 4,
    orbitRadiusY: 1 + Math.random() * 2.5,
    vx: hasOrbit ? 0 : (Math.random() - 0.5) * 0.02,
    vy: hasOrbit ? 0 : (Math.random() - 0.5) * 0.02,
    vz: hasOrbit ? 0 : (Math.random() - 0.5) * 0.015,
    // Seeds for the subtle noise wobble layered on top of the orbit/drift
    // math in updatePlanets — decorrelated per axis and per planet so
    // wobbles don't sync up across the scene.
    noiseSeedX: Math.random() * 1000, noiseSeedY: Math.random() * 1000, noiseSeedZ: Math.random() * 1000,
    noiseSpeed: 0.008 + Math.random() * 0.012,
    hasSpin, spinSpeed: hasSpin ? (Math.random() - 0.5) * 0.01 : 0,
    hues, hueSpeed: (Math.random() - 0.5) * 0.15,
    life: 1.0,
    // Roughly halved — planets were fading out ("disappearing") too
    // quickly, some within just a few seconds even at idle tempo.
    decay: ((isDistant ? 0.00011 : 0.0003) + Math.random() * (isDistant ? 0.0008 : 0.002)) * (0.75 + tempoFactor * 0.7),
  });
  if (planets.length > MAX_PLANETS) disposePlanet(planets.shift());
  if (Math.random() < debugParams.starDensity) addPermanentStar(randomHue());
}

function spawnSparkPlanet(pos, dir, hue) {
  const radius = 0.15 + Math.random() * 0.25;
  const color = new THREE.Color().setHSL(hue / 360, 0.7, 0.55);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  planets.push({
    group: mesh, core: mesh, coreMat: mat, halo: null, haloMat: null, blotchMats: [], ring: null, ringMat: null, moon: null, moonMats: [],
    basePos: pos.clone(), hasOrbit: false, radius,
    orbitAngle: 0, orbitSpeed: 0, orbitRadiusX: 0, orbitRadiusY: 0,
    vx: dir.x * (0.03 + Math.random() * 0.03), vy: dir.y * (0.03 + Math.random() * 0.03), vz: dir.z * (0.03 + Math.random() * 0.03),
    noiseSeedX: Math.random() * 1000, noiseSeedY: Math.random() * 1000, noiseSeedZ: Math.random() * 1000,
    noiseSpeed: 0.008 + Math.random() * 0.012,
    hasSpin: false, spinSpeed: 0, hues: [hue], hueSpeed: 0,
    life: 1.0, decay: 0.0006 + Math.random() * 0.001,
  });
  if (planets.length > MAX_PLANETS) disposePlanet(planets.shift());
}

function disposePlanet(p) {
  scene.remove(p.group);
  p.group.traverse(c => {
    // Sprites (halo, blotches) share a single module-level plane geometry
    // across every sprite in the scene — never dispose it per-instance.
    if (c.geometry && !c.isSprite) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
  if (p.coreTexture) p.coreTexture.dispose();
}

function updatePlanets() {
  for (let i = planets.length - 1; i >= 0; i--) {
    const p = planets[i];
    let baseX, baseY, baseZ;
    if (p.hasOrbit) {
      p.orbitAngle += p.orbitSpeed * (1 + tempoFactor * 0.6);
      const ex = Math.cos(p.orbitAngle) * p.orbitRadiusX;
      const ey = Math.sin(p.orbitAngle) * p.orbitRadiusY;
      const ez = Math.sin(p.orbitAngle * 0.7) * p.orbitRadiusY * 0.6;
      baseX = p.basePos.x + ex; baseY = p.basePos.y + ey; baseZ = p.basePos.z + ez;
    } else {
      // basePos doubles as the "clean" drift-only position here (unused
      // otherwise once a non-orbit planet is moving), kept separate from
      // the noise wobble below so the wobble stays a bounded offset
      // rather than compounding into the accumulated drift.
      p.basePos.x += p.vx; p.basePos.y += p.vy; p.basePos.z += p.vz;
      baseX = p.basePos.x; baseY = p.basePos.y; baseZ = p.basePos.z;
    }
    // Subtle noise perturbation on top of the orbit/drift math so motion
    // feels slightly alive rather than perfectly mathematical — bounded
    // to a fraction of the planet's own radius, so it reads as a gentle
    // wobble rather than a competing motion.
    const wobbleAmp = p.radius * 0.22;
    const wx = noiseAt(p.noiseSeedX, frameTime, p.noiseSpeed) * wobbleAmp;
    const wy = noiseAt(p.noiseSeedY, frameTime, p.noiseSpeed) * wobbleAmp;
    const wz = noiseAt(p.noiseSeedZ, frameTime, p.noiseSpeed) * wobbleAmp * 0.7;
    p.group.position.set(baseX + wx, baseY + wy, baseZ + wz);
    if (p.hasSpin) p.core.rotation.y += p.spinSpeed;
    if (p.hueSpeed) {
      // Drift the emissive tint only — the baked gradient texture (now
      // doubling as the emissiveMap) already carries the hue blend, so a
      // mid-lightness tint nudges hue without washing the map back to grey.
      p.hues = p.hues.map(h => (h + p.hueSpeed + 360) % 360);
      p.coreMat.emissive.setHSL(p.hues[p.hues.length - 1] / 360, 0.5, 0.65);
      if (p.haloMat) p.haloMat.color.setHSL(p.hues[0] / 360, 0.6, 0.45);
    }
    if (p.moon) updateMoonRecursive(p.moon);

    p.life -= p.decay;
    const alpha = Math.max(p.life, 0);
    p.coreMat.opacity = alpha;
    if (p.haloMat) p.haloMat.opacity = alpha * 0.2;
    if (p.ringMat) p.ringMat.opacity = alpha * 0.5;
    for (const bm of p.blotchMats) bm.opacity = alpha * 0.4;
    for (const mm of p.moonMats) mm.opacity = alpha;

    if (p.life <= 0 || p.group.position.z > camPos.z + PASS_MARGIN) {
      disposePlanet(p);
      planets.splice(i, 1);
    }
  }
}

function spawnChordCluster(anchor) {
  const hue = randomHue();
  spawnShockwave(anchor, hue);
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const dist = 3.5 + Math.random() * 3;
    const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle) * 0.6, (Math.random() - 0.5) * 0.6).normalize();
    const pos = anchor.clone().add(dir.clone().multiplyScalar(dist));
    spawnSparkPlanet(pos, dir, hue);
  }
}

// ============================================================
// Rhizome web — nodes and jagged fat-line edges in real 3D space,
// growing over time. Lines (not tubes) so a bolt reads as a thin
// glowing wire from every angle — a static-cross-section tube goes
// edge-on to the camera and reads as a flat ribbon blob instead.
// Edges reveal progressively via a growing instanceCount (cheap: no
// full geometry rebuild) and can spawn child branches once fully
// grown, so separate strikes weave into a single connected structure
// over a session.
// ============================================================
// Raised above the reference's own 140/260 — WebGL comfortably handles
// far more simultaneous small meshes than repeatedly redrawing 2D canvas
// paths, and a low cap here was silently capping how much lightning
// density could ever accumulate during a long/intense session.
const MAX_NODES = 180;
const MAX_EDGES = 320;
const nodeGeo = new THREE.SphereGeometry(1, 10, 8);
const rhizomeNodes = [];
const rhizomeEdges = [];

// Straight polyline through jittered kink points (no spline smoothing,
// unlike the old CatmullRomCurve3 — smoothing turned jagged lightning
// into loopy curls). Each kink-to-kink segment is subdivided further
// purely so progressive growth (instanceCount stepping) reads smoothly;
// the path shape itself stays a straight-segment jagged crack.
function buildJaggedPoints(fromPos, toPos, depth) {
  const dir = new THREE.Vector3().subVectors(toPos, fromPos);
  const length = Math.max(0.05, dir.length());
  dir.normalize();
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const perp1 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp2 = new THREE.Vector3().crossVectors(dir, perp1).normalize();

  const kinkCount = Math.max(2, depth + 1);
  const kinks = [fromPos.clone()];
  for (let k = 1; k < kinkCount; k++) {
    const t = k / kinkCount;
    const base = fromPos.clone().lerp(toPos, t);
    const jagMag = length * (Math.random() < 0.18 ? 0.32 : 0.14);
    const off = perp1.clone().multiplyScalar((Math.random() - 0.5) * jagMag)
      .add(perp2.clone().multiplyScalar((Math.random() - 0.5) * jagMag));
    kinks.push(base.add(off));
  }
  kinks.push(toPos.clone());

  const SUB = 3;
  const points = [kinks[0]];
  for (let i = 1; i < kinks.length; i++) {
    for (let s = 1; s <= SUB; s++) points.push(kinks[i - 1].clone().lerp(kinks[i], s / SUB));
  }
  return points;
}

function randomDirection3D() {
  const theta = Math.random() * Math.PI * 2;
  const z = Math.random() * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), z).normalize();
}

function createRhizomeNode(pos, hue, isRoot) {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.75, 0.5), transparent: true, opacity: isRoot ? 0.3 : 0.18,
  });
  const mesh = new THREE.Mesh(nodeGeo, mat);
  mesh.position.copy(pos);
  const baseSize = isRoot ? 0.35 : 0.18 + Math.random() * 0.08;
  mesh.scale.setScalar(baseSize);
  scene.add(mesh);

  const node = {
    mesh, mat, baseSize, hue, isRoot, removed: false,
    // homePos anchors the noise-driven wander (see updateRhizome) — the
    // offset is bounded around this point rather than accumulated, so
    // the node can't random-walk away from where its edge geometry
    // (baked once at spawn, not rebuilt per frame) actually terminates.
    homePos: pos.clone(),
    noiseSeedX: Math.random() * 1000, noiseSeedY: Math.random() * 1000, noiseSeedZ: Math.random() * 1000,
    wanderSpeedX: 0.02 + Math.random() * 0.03, wanderSpeedY: 0.02 + Math.random() * 0.03, wanderSpeedZ: 0.02 + Math.random() * 0.03,
    pulsePhase: Math.random() * Math.PI * 2, pulseSpeed: 0.05 + Math.random() * 0.05,
  };
  rhizomeNodes.push(node);
  if (rhizomeNodes.length > MAX_NODES) {
    const old = rhizomeNodes.shift();
    old.removed = true;
    scene.remove(old.mesh);
    old.mat.dispose();
  }
  return node;
}

function addRhizomeEdge(nodeA, nodeB, depth, hue, isRoot) {
  const points = buildJaggedPoints(nodeA.mesh.position, nodeB.mesh.position, depth);
  const positions = [];
  for (const p of points) positions.push(p.x, p.y, p.z);

  const geo = new LineGeometry();
  geo.setPositions(positions);
  const segCount = points.length - 1;
  geo.instanceCount = 0; // revealed progressively as the bolt grows

  // targetAlpha and lightness both trimmed well below the original
  // reference-matched values — under additive blending + bloom, bright
  // pixels clip all three color channels to white regardless of hue, so
  // "less white" mainly means "dimmer," not just less pale.
  const targetAlpha = (0.08 + Math.random() * 0.06) * (isRoot ? 1.15 : 1);
  const mat = new LineMaterial({
    color: new THREE.Color().setHSL((((hue + (Math.random() - 0.5) * 18) % 360) + 360) % 360 / 360, 0.85, 0.4),
    transparent: true, opacity: targetAlpha, blending: THREE.AdditiveBlending, depthWrite: false,
    linewidth: (0.26 + depth * 0.16) * (isRoot ? 1.15 : 1), worldUnits: true, resolution: lineResolution,
  });
  const mesh = new Line2(geo, mat);
  scene.add(mesh);

  rhizomeEdges.push({
    mesh, mat, geo, a: nodeA, b: nodeB, depth, hue,
    segCount,
    grownSegments: 0,
    growSpeed: segCount / (200 + Math.random() * 150),
    spawnedChildren: false,
    ageAfterGrown: 0,
    lingerFrames: 80 + Math.random() * 130,
    life: 1.0, fadeDecay: 0.0025 + Math.random() * 0.003,
    targetAlpha,
    flickerPhase: Math.random() * Math.PI * 2,
    flickerSpeed: 0.05 + Math.random() * 0.05,
  });
  if (rhizomeEdges.length > MAX_EDGES) {
    const old = rhizomeEdges.shift();
    scene.remove(old.mesh); old.geo.dispose(); old.mat.dispose();
  }
}

function spawnChildBranches(e) {
  const dirAB = new THREE.Vector3().subVectors(e.b.mesh.position, e.a.mesh.position).normalize();
  for (let c = 0; c < 2; c++) {
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const angleOffset = (0.5 + Math.random() * 0.7) * (c === 0 ? 1 : -1);
    const childDir = dirAB.clone().applyAxisAngle(axis, angleOffset).normalize();
    const childLength = 6 + Math.random() * 8;
    const tipPos = e.b.mesh.position.clone().add(childDir.multiplyScalar(childLength));
    const tip = createRhizomeNode(tipPos, e.hue, false);
    addRhizomeEdge(e.b, tip, e.depth - 1, e.hue, false);
  }
}

function spawnLightning(anchor) {
  const hue = randomHue();
  const root = createRhizomeNode(anchor, hue, true);
  const boltCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < boltCount; i++) {
    const dir = randomDirection3D();
    const length = 12 + Math.random() * 14;
    const tipPos = root.mesh.position.clone().add(dir.multiplyScalar(length));
    const tip = createRhizomeNode(tipPos, hue, false);
    addRhizomeEdge(root, tip, 4, hue, true);
  }
  let linked = 0;
  for (let i = 0; i < 20 && linked < 2; i++) {
    const other = rhizomeNodes[Math.floor(Math.random() * rhizomeNodes.length)];
    if (!other || other === root) continue;
    const d = root.mesh.position.distanceTo(other.mesh.position);
    if (d > 15 && d < 140) { addRhizomeEdge(root, other, Math.random() < 0.25 ? 1 : 0, hue, false); linked++; }
  }
}

function tryConnectRhizomeNodes() {
  if (rhizomeNodes.length < 6) return;
  const a = rhizomeNodes[Math.floor(Math.random() * rhizomeNodes.length)];
  let best = null, bestDist = 50;
  for (let i = 0; i < 15; i++) {
    const b = rhizomeNodes[Math.floor(Math.random() * rhizomeNodes.length)];
    if (!b || b === a) continue;
    const d = a.mesh.position.distanceTo(b.mesh.position);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  if (best) addRhizomeEdge(a, best, 0, (a.hue + best.hue) / 2, false);
}

function updateRhizome() {
  for (let i = rhizomeNodes.length - 1; i >= 0; i--) {
    const n = rhizomeNodes[i];
    // Bounded noise offset from the node's fixed home position — organic,
    // non-repeating wander that still stays put rather than a random walk.
    const wx = noiseAt(n.noiseSeedX, frameTime, n.wanderSpeedX) * 0.35;
    const wy = noiseAt(n.noiseSeedY, frameTime, n.wanderSpeedY) * 0.35;
    const wz = noiseAt(n.noiseSeedZ, frameTime, n.wanderSpeedZ) * 0.28;
    n.mesh.position.set(n.homePos.x + wx, n.homePos.y + wy, n.homePos.z + wz);
    n.pulsePhase += n.pulseSpeed;
    const pulse = 0.5 + 0.5 * Math.sin(n.pulsePhase);
    n.mesh.scale.setScalar(n.baseSize * (0.8 + 0.4 * pulse));
    n.mat.opacity = (n.isRoot ? 0.3 : 0.18) * (0.6 + 0.4 * pulse);

    if (n.mesh.position.z > camPos.z + PASS_MARGIN) {
      n.removed = true;
      scene.remove(n.mesh);
      n.mat.dispose();
      rhizomeNodes.splice(i, 1);
    }
  }

  for (let i = rhizomeEdges.length - 1; i >= 0; i--) {
    const e = rhizomeEdges[i];
    if (e.a.removed || e.b.removed) {
      scene.remove(e.mesh); e.geo.dispose(); e.mat.dispose();
      rhizomeEdges.splice(i, 1);
      continue;
    }

    if (e.grownSegments < e.segCount) {
      e.grownSegments = Math.min(e.segCount, e.grownSegments + e.growSpeed);
      e.geo.instanceCount = Math.floor(e.grownSegments);
      if (e.grownSegments >= e.segCount && !e.spawnedChildren) {
        e.spawnedChildren = true;
        if (e.depth > 0) spawnChildBranches(e);
      }
    } else {
      e.ageAfterGrown++;
      if (e.ageAfterGrown > e.lingerFrames) {
        e.life -= e.fadeDecay;
      }
    }

    // Flicker/alpha applies every frame regardless of growth state, same
    // as the reference's render loop.
    e.flickerPhase += e.flickerSpeed * (1 + (Math.random() - 0.5) * 0.9);
    let flicker = 0.5 + 0.5 * Math.sin(e.flickerPhase);
    if (Math.random() < 0.02) flicker += 0.35;
    flicker = Math.max(0, Math.min(1.3, flicker));
    e.mat.opacity = e.targetAlpha * flicker * Math.max(e.life, 0);

    if (e.life <= 0) {
      scene.remove(e.mesh); e.geo.dispose(); e.mat.dispose();
      rhizomeEdges.splice(i, 1);
    }
  }
}

// ============================================================
// Easter-egg cats — rare, low-poly critters with tiny glowing
// eyes that pick up the bloom pass.
// ============================================================
const MAX_CATS = 8;
const cats = [];

function spawnCat(anchor) {
  const group = new THREE.Group();
  group.position.copy(anchor);
  const flip = Math.random() > 0.5 ? -1 : 1;
  // x7: the cat's own geometry is built at the old tight-world scale;
  // the whole scene's object spacing/distance grew ~8x (see spawnAnchor),
  // so without this the cat would be a near-invisible speck.
  const scale = (0.7 + Math.random() * 0.6) * 7;
  group.scale.set(flip * scale, scale, scale);
  scene.add(group);

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, transparent: true, opacity: 1 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), bodyMat);
  group.add(head);

  const earGeo = new THREE.ConeGeometry(0.14, 0.28, 10);
  const earL = new THREE.Mesh(earGeo, bodyMat); earL.position.set(-0.22, 0.32, 0); earL.rotation.z = 0.3;
  const earR = new THREE.Mesh(earGeo, bodyMat); earR.position.set(0.22, 0.32, 0); earR.rotation.z = -0.3;
  group.add(earL, earR);

  const eyeGeo = new THREE.SphereGeometry(0.045, 6, 6);
  const eyeMatL = new THREE.MeshBasicMaterial({ color: 0x66ffee, transparent: true, opacity: 1 });
  const eyeMatR = eyeMatL.clone();
  const eyeL = new THREE.Mesh(eyeGeo, eyeMatL); eyeL.position.set(-0.12, 0.02, 0.3);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMatR); eyeR.position.set(0.12, 0.02, 0.3);
  group.add(eyeL, eyeR);

  cats.push({
    group, bodyMat, eyeMats: [eyeMatL, eyeMatR], ears: [earL, earR],
    vx: (Math.random() - 0.5) * 0.02, vy: (Math.random() - 0.5) * 0.01, vz: (Math.random() - 0.5) * 0.015,
    life: 1.0, decay: 0.0018 + Math.random() * 0.003, earPhase: Math.random() * Math.PI * 2, t: 0,
  });
  if (cats.length > MAX_CATS) disposeCat(cats.shift());
}

function disposeCat(c) {
  scene.remove(c.group);
  c.group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

function updateCats() {
  for (let i = cats.length - 1; i >= 0; i--) {
    const c = cats[i];
    c.group.position.x += c.vx; c.group.position.y += c.vy; c.group.position.z += c.vz;
    c.t++;
    const twitch = Math.sin(c.t * 0.15 + c.earPhase) * 0.25;
    c.ears[0].rotation.z = 0.3 + twitch;
    c.ears[1].rotation.z = -0.3 - twitch;
    c.life -= c.decay;
    const alpha = Math.max(c.life, 0);
    c.bodyMat.opacity = alpha;
    for (const m of c.eyeMats) m.opacity = alpha;
    if (c.life <= 0 || c.group.position.z > camPos.z + PASS_MARGIN) {
      disposeCat(c);
      cats.splice(i, 1);
    }
  }
}

// ============================================================
// Rings / shockwaves — expanding ring bursts, double-layered (a
// wide soft outer glow pass + a crisp inner ring, both additive)
// matching the reference's two-stroke technique. Growth is linear
// (constant radius added per frame), same as the reference's
// `radius += growth`, not the exponential scale-multiply used
// before. Per-note rings grow slower and decay slower than chord
// shockwaves, same ratio as the reference's spawnRing vs
// spawnShockwave. Reference growth is canvas-px/frame — rebased to
// world units with one consistent /30 factor since the domains
// aren't directly comparable; alpha start/decay are unitless and
// used exactly as in the reference.
// ============================================================
// The reference has no cap at all on shockwaves — they're bounded only
// by their own decay. Kept a generous ceiling here (not fully uncapped)
// purely as a memory safety net, well above what natural decay would
// ever let accumulate in practice.
const MAX_RINGS = 200;
const rings = [];

function spawnRingPair(anchor, hue, { startRadius, growth, decay, alpha, thickness }) {
  const color = new THREE.Color().setHSL(hue / 360, 0.75, 0.65);

  const innerMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: alpha, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const inner = new THREE.Mesh(new THREE.RingGeometry(1, 1 + thickness, 32), innerMat);

  const outerMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: alpha * 0.35, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const outer = new THREE.Mesh(new THREE.RingGeometry(1, 1 + thickness * 4, 32), outerMat);

  for (const mesh of [inner, outer]) {
    mesh.position.copy(anchor);
    mesh.quaternion.copy(camera.quaternion);
    mesh.scale.setScalar(startRadius);
    scene.add(mesh);
  }

  rings.push({ inner, outer, innerMat, outerMat, anchor: anchor.clone(), radius: startRadius, growth, decay, alpha });
  if (rings.length > MAX_RINGS) disposeRing(rings.shift());
}

function disposeRing(r) {
  scene.remove(r.inner); r.inner.geometry.dispose(); r.innerMat.dispose();
  scene.remove(r.outer); r.outer.geometry.dispose(); r.outerMat.dispose();
}

function spawnRing(anchor, hue, opts = {}) {
  spawnRingPair(anchor, hue, {
    startRadius: opts.startRadius || 0.1,
    growth: ((1.1 + Math.random() * 1.1) / 30) * (1 + tempoFactor * 0.4),
    decay: 0.0035 + Math.random() * 0.0035,
    alpha: 0.3 + Math.random() * 0.15,
    thickness: 0.05,
  });
}

function spawnShockwave(anchor, hue) {
  spawnRingPair(anchor, hue, {
    startRadius: 0.15,
    growth: ((2.5 + Math.random() * 1.5) / 30) * (1 + tempoFactor * 0.4),
    decay: 0.012 + Math.random() * 0.008,
    alpha: 0.5,
    thickness: 0.1,
  });
}

function updateRings() {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.radius += r.growth;
    r.alpha -= r.decay;
    const alpha = Math.max(0, r.alpha);
    r.inner.scale.setScalar(r.radius);
    r.outer.scale.setScalar(r.radius);
    r.inner.quaternion.copy(camera.quaternion);
    r.outer.quaternion.copy(camera.quaternion);
    r.innerMat.opacity = alpha;
    r.outerMat.opacity = alpha * 0.35;

    if (r.alpha <= 0 || r.radius > 40 || r.anchor.z > camPos.z + PASS_MARGIN) {
      disposeRing(r);
      rings.splice(i, 1);
    }
  }
}

// ============================================================
// Main loop
// ============================================================
function animate() {
  requestAnimationFrame(animate);

  updateCameraFlight();
  updateFog();
  updateNebula();
  updatePlanets();
  updateRhizome();
  updateCats();
  updateRings();
  updateGridLines();

  constellationCooldown--;
  if (constellationCooldown <= 0) {
    tryConnectStars();
    tryConnectRhizomeNodes();
    constellationCooldown = 50 + Math.random() * 70;
  }

  composer.render();
}
animate();

// ============================================================
// Web MIDI
// ============================================================
const startBtn = document.getElementById('startBtn');
const deviceSelect = document.getElementById('deviceSelect');
const statusEl = document.getElementById('status');

let midiAccess = null;
let activeInput = null;
let recentNotes = [];
let chordCooldownUntil = 0;

function noteOn(note, velocity) {
  const v = velocity / 127;
  const anchor = spawnAnchor();
  const now = performance.now();
  updateTempo(now);

  spawnPlanet(v, anchor);
  if (Math.random() < 0.07) spawnCat(anchor);
  if (Math.random() < 0.06) spawnLightning(anchor);
  if (Math.random() < 0.18) spawnGridLines();
  if (Math.random() < 0.12) {
    if (Math.random() < 0.25) {
      const ringCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < ringCount; i++) spawnRing(anchor, randomHue(), { startRadius: 0.1 + i * 0.06 });
    } else {
      spawnRing(anchor, randomHue());
    }
  }

  recentNotes.push({ time: now, anchor });
  recentNotes = recentNotes.filter(n => now - n.time < 130);
  if (recentNotes.length >= 3 && now > chordCooldownUntil) {
    const avg = new THREE.Vector3();
    for (const n of recentNotes) avg.add(n.anchor);
    avg.divideScalar(recentNotes.length);
    spawnChordCluster(avg);
    chordCooldownUntil = now + 600;
  }
}

function noteOff(note) {
  // The scene persists until its own decay/pass-camera cleanup; nothing to do here.
}

function handleMIDIMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status & 0xf0;
  if (command === 0x90 && velocity > 0) {
    noteOn(note, velocity);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    noteOff(note);
  }
}

function selectInput(input) {
  if (activeInput) activeInput.onmidimessage = null;
  activeInput = input;
  if (activeInput) {
    activeInput.onmidimessage = handleMIDIMessage;
    statusEl.textContent = `Listening on: ${activeInput.name}`;
  }
}

function populateDeviceList() {
  const inputs = Array.from(midiAccess.inputs.values());
  deviceSelect.innerHTML = '';

  if (inputs.length === 0) {
    statusEl.textContent = 'No MIDI input devices found.';
    deviceSelect.style.display = 'none';
    return;
  }

  for (const input of inputs) {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = input.name;
    deviceSelect.appendChild(option);
  }
  deviceSelect.style.display = 'inline-block';

  deviceSelect.onchange = () => {
    const input = inputs.find(i => i.id === deviceSelect.value);
    selectInput(input);
  };

  selectInput(inputs[0]);
}

async function enableMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess();
    statusEl.textContent = 'MIDI access granted.';
    populateDeviceList();
    midiAccess.onstatechange = populateDeviceList;
    startBtn.style.display = 'none';
  } catch (err) {
    statusEl.textContent = `MIDI access failed: ${err.message}`;
  }
}

if (!navigator.requestMIDIAccess) {
  statusEl.textContent = 'Web MIDI API is not supported in this browser.';
  startBtn.disabled = true;
} else {
  startBtn.addEventListener('click', enableMIDI);
}
