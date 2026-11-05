/**
 * The stage: scene graph, theatre environment, the house jester, two cameras
 * and the post stack. Deliberately data-driven — every visual parameter comes
 * from the project file, nothing is hard-coded into a scene asset.
 */
import * as THREE from './vendor/three.module.js';
import { PostStack } from './post.js';
import { TransformControls, OrbitControls } from './vendor/addons.module.js';
import { autoRigHumanoid } from './autorig.js';
import { noise1, mulberry32, clamp } from '../core/prng.js';

export const STAGE_PRESETS = {
  courtyard: {
    bg: '#241733', fog: '#2f1d42', fogDensity: 0.05,
    floor: '#6d5a63', curtain: '#45275a', ambience: 0.34, dust: 0.55, rim: '#c9a227',
  },
  void: {
    bg: '#120c1a', fog: '#120c1a', fogDensity: 0.014,
    floor: '#241b2d', curtain: '#221a2c', ambience: 0.2, dust: 0.22, rim: '#8f6bd6',
  },
  tavern: {
    bg: '#2a1a12', fog: '#3b2417', fogDensity: 0.07,
    floor: '#59402e', curtain: '#66392a', ambience: 0.28, dust: 0.4, rim: '#e0a15a',
  },
};

// Physical light units (candela): the UI works in "artistic" 0..6 values and
// the host calibrates them, so a project file never depends on a renderer.
const LIGHT_SCALE = 46;

const COAT = '#5a3b7d';
const COAT_DARK = '#3f2a5c';
const CREAM = '#f2e4c8';
const GOLD = '#c9a227';
const WAX = '#8e2f3c';
const HAT = '#6b3f96';

function mat(color, { roughness = 0.82, metalness = 0.06, emissive = null, emissiveIntensity = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness,
    flatShading: true,
  });
  if (emissive) {
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = emissiveIntensity;
  }
  return m;
}

function canvasTexture(size, draw, repeat = [1, 1]) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Soft round sprite so dust motes never read as hard squares. */
function softDotTexture() {
  return canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

function stoneTexture(base = '#6d5a63') {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    const rnd = mulberry32(1337);
    const rows = 8;
    const cell = s / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < rows; x++) {
        const off = (y % 2) * cell * 0.5;
        const shade = 0.86 + rnd() * 0.3;
        ctx.fillStyle = `rgba(${Math.floor(58 * shade)},${Math.floor(44 * shade)},${Math.floor(52 * shade)},0.5)`;
        ctx.fillRect(x * cell + off + 1.5, y * cell + 1.5, cell - 3, cell - 3);
        ctx.strokeStyle = 'rgba(30,20,36,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x * cell + off + 1.5, y * cell + 1.5, cell - 3, cell - 3);
      }
    }
    for (let i = 0; i < 2400; i++) {
      const a = rnd() * 0.09;
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,240,220,${a})` : `rgba(20,12,26,${a})`;
      ctx.fillRect(rnd() * s, rnd() * s, 2, 2);
    }
  }, [5, 5]);
}

function curtainTexture(color = '#45275a') {
  return canvasTexture(512, (ctx, s) => {
    const base = new THREE.Color(color);
    for (let x = 0; x < s; x++) {
      const fold = 0.55 + 0.45 * Math.sin((x / s) * Math.PI * 14) + 0.12 * Math.sin((x / s) * Math.PI * 47);
      const c = base.clone().multiplyScalar(0.35 + 0.65 * clamp(fold, 0, 1));
      ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      ctx.fillRect(x, 0, 1, s);
    }
    const rnd = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`;
      ctx.fillRect(rnd() * s, rnd() * s, 3, 1);
    }
  }, [3, 1]);
}

/* --------------------------------- avatar -------------------------------- */

function buildJester() {
  const bones = {};
  const face = {};

  const root = new THREE.Group();
  root.name = 'jester';

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  bones.hips = hips;

  const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.22, 9), mat(COAT_DARK));
  pelvis.position.y = 0.02;
  hips.add(pelvis);

  const spine = new THREE.Group();
  spine.position.y = 0.1;
  hips.add(spine);
  bones.spine = spine;

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.19, 0.44, 10), mat(COAT));
  torso.position.y = 0.2;
  spine.add(torso);

  // gold placket: reads as a medieval coat at any distance
  const placket = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.34, 0.02), mat(GOLD, { metalness: 0.45, roughness: 0.42 }));
  placket.position.set(0, 0.21, 0.195);
  spine.add(placket);

  // skirt flare under the belt
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.2, 10, 1, true), mat(COAT_DARK));
  skirt.position.y = -0.08;
  hips.add(skirt);

  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.026, 6, 14), mat(GOLD, { metalness: 0.5, roughness: 0.4 }));
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.04;
  spine.add(belt);

  const ruff = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.048, 6, 18), mat(CREAM, { roughness: 0.95 }));
  ruff.rotation.x = Math.PI / 2;
  ruff.position.y = 0.44;
  spine.add(ruff);

  const chest = new THREE.Group();
  chest.position.y = 0.38;
  spine.add(chest);
  bones.chest = chest;

  // arms
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 0.2, 0.05, 0);
    chest.add(shoulder);
    bones[`shoulder${side}`] = shoulder;

    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), mat(COAT));
    shoulder.add(puff);

    const upper = new THREE.Group();
    shoulder.add(upper);
    bones[`upperArm${side}`] = upper;

    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.044, 0.24, 8), mat(COAT_DARK));
    arm.position.y = -0.12;
    upper.add(arm);

    const fore = new THREE.Group();
    fore.position.y = -0.24;
    upper.add(fore);
    bones[`foreArm${side}`] = fore;

    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.036, 0.22, 8), mat(COAT));
    forearm.position.y = -0.11;
    fore.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 6), mat(CREAM));
    hand.position.y = -0.24;
    fore.add(hand);
    bones[`hand${side}`] = hand;
  }

  // legs (static stand pose, knees slightly soft)
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.062, 0.42, 7), mat(COAT_DARK));
    thigh.position.set(sx * 0.1, -0.32, 0);
    hips.add(thigh);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.05, 0.4, 7), mat('#2f2140'));
    shin.position.set(sx * 0.1, -0.72, 0.01);
    hips.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.2), mat('#231733'));
    boot.position.set(sx * 0.1, -0.905, 0.04);
    hips.add(boot);
  }

  // neck + head
  const neck = new THREE.Group();
  neck.position.y = 0.17;
  chest.add(neck);
  bones.neck = neck;

  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.08, 7), mat(CREAM));
  neck.add(neckMesh);

  const head = new THREE.Group();
  head.position.y = 0.12;
  neck.add(head);
  bones.head = head;

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.132, 14, 12), mat(CREAM, { roughness: 0.9 }));
  skull.scale.set(1, 1.06, 0.96);
  head.add(skull);

  // face features on +Z
  const eyeGroup = new THREE.Group();
  eyeGroup.position.z = 0.119;
  head.add(eyeGroup);

  face.eyes = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.031, 9, 8), mat('#fdfaf2', { roughness: 0.5 }));
    white.position.set(sx * 0.052, 0.018, 0);
    white.scale.z = 0.62;
    eyeGroup.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.013, 7, 6), mat('#241528', { roughness: 0.35 }));
    pupil.position.set(sx * 0.052, 0.018, 0.021);
    eyeGroup.add(pupil);
    face.eyes[side] = { white, pupil };
  }

  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.011, 0.012), mat('#3a2a2a'));
  browL.position.set(-0.052, 0.074, 0.113);
  browL.rotation.z = -0.16;
  head.add(browL);
  const browR = browL.clone();
  browR.position.x = 0.052;
  browR.rotation.z = 0.16;
  head.add(browR);
  face.brows = [browL, browR];

  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat(WAX, { roughness: 0.6 }));
  mouth.position.set(0, -0.062, 0.117);
  mouth.scale.set(0.92, 0.22, 0.5);
  head.add(mouth);
  face.mouth = mouth;

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.019, 0.055, 7), mat('#c05a4a'));
  nose.rotation.x = Math.PI / 2 - 0.32;
  nose.position.set(0, 0.012, 0.148);
  head.add(nose);

  // hat: brim + three floppy points with bells
  const hat = new THREE.Group();
  hat.position.y = 0.1;
  head.add(hat);

  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.122, 0.024, 6, 16), mat(HAT));
  brim.rotation.x = Math.PI / 2;
  hat.add(brim);

  const points = [
    { rot: 0.2, tilt: 0.42, len: 0.26 },
    { rot: 2.2, tilt: 0.46, len: 0.28 },
    { rot: 4.2, tilt: 0.4, len: 0.24 },
  ];
  for (const p of points) {
    const pivot = new THREE.Group();
    pivot.rotation.y = p.rot;
    hat.add(pivot);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.062, p.len, 7), mat(HAT));
    cone.position.set(0, p.len / 2, 0);
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.z = p.tilt;
    tiltGroup.add(cone);
    pivot.add(tiltGroup);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.023, 7, 6), mat(GOLD, { metalness: 0.65, roughness: 0.3 }));
    const dir = new THREE.Vector3(Math.sin(-p.tilt) * 0.5, Math.cos(p.tilt), 0).multiplyScalar(p.len);
    bell.position.copy(dir);
    tiltGroup.add(bell);
  }

  return { root, bones, face };
}

/* ---------------------------------- stage -------------------------------- */

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#241733');
    this.scene.fog = new THREE.FogExp2('#2f1d42', 0.05);

    this.cameras = { A: new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 60), B: new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 60) };
    this.post = new PostStack(this.renderer, { width: 1280, height: 720, scale: 1 });

    this.stagePreset = 'courtyard';
    this.renderScale = 1;
    this.cameraCfg = {
      A: { framing: 'wide', focal: 28, height: 1.35, distance: 5.4, lookY: 1.15, shake: 0.15 },
      B: { framing: 'medium', focal: 42, height: 1.5, distance: 3.1, lookY: 1.32, shake: 0.35 },
    };

    this._buildEnvironment();
    const jester = buildJester();
    this.avatar = jester.root;
    this.bones = jester.bones;
    this.face = jester.face;
    this.avatar.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.scene.add(this.avatar);

    this._buildLights();
    this._buildDust();
    this._applyCameras();

    // imported scene objects + selection + transform gizmo + free camera
    this.objects = [];
    this._nextObjectId = 1;
    this.selectedId = null;
    this.transformMode = 'translate';
    this.transformDragging = false;
    this.freecam = false;

    this.freeCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 60);
    this.freeCamera.position.set(4.2, 2.4, 4.2);
    this.orbit = new OrbitControls(this.freeCamera, this.renderer.domElement);
    this.orbit.target.set(0, 1.1, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.enabled = false;

    this.transformControls = new TransformControls(this.cameras.A, this.renderer.domElement);
    this.transformControls.enabled = false;
    this.transformControls.setMode(this.transformMode);
    this.transformControls.addEventListener('dragging-changed', (e) => {
      this.transformDragging = e.value;
    });
    this.scene.add(this.transformControls);

    // the house jester joins the registry so it can be selected and moved too
    this.addImported('jester', this.avatar, [], { builtin: true, normalize: false });
  }

  _buildEnvironment() {
    const preset = STAGE_PRESETS[this.stagePreset];

    this.preset = preset;
    this.scene.background = new THREE.Color(preset.bg);
    this.scene.fog = new THREE.FogExp2(preset.fog, preset.fogDensity);

    // platform
    this.floorTex = stoneTexture(preset.floor);
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(2.9, 3.05, 0.14, 48),
      mat('#8b7f86', { roughness: 0.95 }),
    );
    platform.position.y = -0.07;
    platform.receiveShadow = true;
    this.scene.add(platform);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.88, 48),
      new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 0.92, metalness: 0.02 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.001;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floor = floor;

    // curtain wall
    this.curtainTex = curtainTexture(preset.curtain);
    const curtain = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 6.4, 7, 40, 1, true),
      new THREE.MeshStandardMaterial({ map: this.curtainTex, side: THREE.BackSide, roughness: 0.95 }),
    );
    curtain.position.y = 3.2;
    this.scene.add(curtain);
    this.curtain = curtain;

    // pillars
    const pillarMat = mat('#4a3552', { roughness: 0.9 });
    for (const [x, z] of [[-3.5, -2.2], [3.5, -2.2], [-4.2, 1.6], [4.2, 1.6]]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 3.6, 10), pillarMat);
      pillar.position.set(x, 1.8, z);
      pillar.castShadow = true;
      this.scene.add(pillar);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.42), pillMatSafe(GOLD));
      cap.position.set(x, 3.62, z);
      this.scene.add(cap);
    }

    // footlights
    this.footlights = [];
    for (let i = 0; i < 7; i++) {
      const a = -0.9 + (i / 6) * 1.8;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        mat(GOLD, { emissive: '#ffcf6b', emissiveIntensity: 2.6, roughness: 0.3 }),
      );
      bulb.position.set(Math.sin(a) * 2.55, 0.1, Math.cos(a) * 2.55);
      this.scene.add(bulb);
      this.footlights.push(bulb);
    }
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(new THREE.Color('#6b4a8f'), new THREE.Color('#1a1020'), 1.0);
    this.scene.add(this.hemi);

    this.key = new THREE.SpotLight(new THREE.Color('#ffd9a8'), 2.1, 0, 0.72, 0.55, 1.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0012;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    this.fill = new THREE.PointLight(new THREE.Color('#8f6bd6'), 0.9, 14, 1.6);
    this.scene.add(this.fill);

    this.rim = new THREE.SpotLight(new THREE.Color('#c9a227'), 1.6, 0, 0.9, 0.7, 1.4);
    this.scene.add(this.rim);
    this.scene.add(this.rim.target);
  }

  _buildDust() {
    const count = 500;
    const rnd = mulberry32(4242);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rnd() - 0.5) * 9;
      positions[i * 3 + 1] = rnd() * 4.2 + 0.2;
      positions[i * 3 + 2] = (rnd() - 0.5) * 9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: new THREE.Color('#f0d7a8'),
        map: softDotTexture(),
        size: 0.05,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.scene.add(this.dust);
  }

  applyStage(stage = {}) {
    const preset = STAGE_PRESETS[stage.preset] ?? STAGE_PRESETS.courtyard;
    this.stagePreset = stage.preset ?? 'courtyard';
    this.preset = preset;
    this.scene.background = new THREE.Color(preset.bg);
    this.scene.fog = new THREE.FogExp2(preset.fog, preset.fogDensity * (0.4 + (stage.fog ?? 0.5) * 2.4));
    this.hemi.intensity = (stage.ambient ?? 0.34) * 3.0;
    if (this.floor && stage.floorTone !== undefined) {
      this.floor.material.color = new THREE.Color().setHSL(0.78, 0.05, 0.28 + stage.floorTone * 0.4);
    }
    if (this.curtain) this.curtain.material.color = new THREE.Color(preset.curtain).lerp(new THREE.Color('#ffffff'), 0.05);
    if (this.dust) this.dust.material.opacity = preset.dust * 0.9;
  }

  applyLighting(lighting = {}) {
    const place = (light, cfg, radius = 4.2) => {
      const az = THREE.MathUtils.degToRad(cfg.azimuth ?? 30);
      const el = THREE.MathUtils.degToRad(cfg.elevation ?? 40);
      light.position.set(
        Math.sin(az) * Math.cos(el) * radius,
        1.1 + Math.sin(el) * radius,
        Math.cos(az) * Math.cos(el) * radius,
      );
      light.target.position.set(0, 1.15, 0);
      light.target.updateMatrixWorld();
      light.intensity = (cfg.intensity ?? 1) * LIGHT_SCALE;
      light.color = new THREE.Color(cfg.color ?? '#ffffff');
    };
    if (lighting.key) place(this.key, lighting.key, 4.6);
    if (lighting.rim) place(this.rim, lighting.rim, 4.9);
    if (lighting.fill) {
      const cfg = lighting.fill;
      const az = THREE.MathUtils.degToRad(cfg.azimuth ?? -50);
      this.fill.position.set(Math.sin(az) * 3, (cfg.elevation ?? 20) / 30, Math.cos(az) * 3);
      this.fill.intensity = (cfg.intensity ?? 1) * LIGHT_SCALE * 0.8;
      this.fill.color = new THREE.Color(cfg.color ?? '#8f6bd6');
    }
  }

  _applyCameras() {
    for (const id of ['A', 'B']) {
      const cfg = this.cameraCfg[id];
      const cam = this.cameras[id];
      const fov = (2 * Math.atan(12 / Math.max(8, cfg.focal)) * 180) / Math.PI;
      cam.fov = clamp(fov, 8, 75);
      cam.updateProjectionMatrix();
    }
  }

  setCameras(cameras = {}) {
    this.cameraCfg = { ...this.cameraCfg, ...cameras };
    this._applyCameras();
  }

  setPostParams(post) {
    this.post.setParams(post);
  }

  setSize(cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
    this.dpr = Math.min(dpr, 3);
    const w = Math.max(2, Math.floor(cssWidth * this.dpr));
    const h = Math.max(2, Math.floor(cssHeight * this.dpr));
    this.ctxW = w;
    this.ctxH = h;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.renderScale);
    for (const id of ['A', 'B']) {
      this.cameras[id].aspect = w / h;
      this.cameras[id].updateProjectionMatrix();
    }
    if (this.freeCamera) {
      this.freeCamera.aspect = w / h;
      this.freeCamera.updateProjectionMatrix();
    }
  }

  setQuality(scale = 1) {
    this.renderScale = clamp(scale, 0.5, 1.6);
    if (this.ctxW) this.post.setSize(this.ctxW, this.ctxH, this.renderScale);
  }

  _positionCamera(id, t) {
    const cfg = this.cameraCfg[id];
    const cam = this.cameras[id];
    const azimuth = id === 'A' ? -0.2 : 0.26;
    const dist = cfg.distance ?? 4;
    const shake = (cfg.shake ?? 0.2) * 0.02;
    const sx = noise1(`cam${id}`, t * 1.7, 2) * shake;
    const sy = noise1(`cam${id}y`, t * 1.5 + 5, 2) * shake * 0.7;
    cam.position.set(Math.sin(azimuth) * dist + sx, (cfg.height ?? 1.4) + sy, Math.cos(azimuth) * dist);
    cam.lookAt(Math.sin(azimuth) * 0.2, cfg.lookY ?? 1.3, 0);
    cam.updateMatrixWorld();
    return cam;
  }

  /** Apply a sampled performance (from PerformancePipeline.sample). */
  applyPerformance(sample, { liveMic = 0, mirrorTime = 0 } = {}) {
    const { pose, face } = sample;
    const b = this.bones;

    b.hips.position.y = 0.92 + pose.hipsY * 1.5;
    b.hips.rotation.set(0, 0, pose.hipsRoll);

    b.spine.rotation.set(pose.chestPitch * 0.45, pose.chestYaw * 0.4, pose.spineRoll);
    b.chest.rotation.set(pose.chestPitch * 0.6, pose.chestYaw * 0.6, pose.chestRoll);

    b.neck.rotation.set(pose.neckPitch, pose.neckYaw, 0);
    b.head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll);

    // arms: negative z lifts the left arm outward, positive the right
    b.upperArmL.rotation.z = -0.14 - pose.armLiftL;
    b.upperArmR.rotation.z = 0.14 + pose.armLiftR;
    b.upperArmL.rotation.x = -0.04 + noise1('armL', mirrorTime * 0.3, 1) * 0.02;
    b.upperArmR.rotation.x = -0.04 + noise1('armR', mirrorTime * 0.3 + 2, 1) * 0.02;

    b.foreArmL.rotation.x = clamp(-pose.elbowL, -0.2, 1.3);
    b.foreArmR.rotation.x = clamp(-pose.elbowR, -0.2, 1.3);
    b.handL.rotation.x = pose.wristL;
    b.handR.rotation.x = pose.wristR;

    b.shoulderL.position.y = 0.05 + pose.shoulderL * 0.5;
    b.shoulderR.position.y = 0.05 + pose.shoulderR * 0.5;

    // face
    const jaw = clamp(Math.max(face.jaw, liveMic * 0.55), 0, 0.95);
    const m = this.face.mouth;
    m.scale.set(0.72 + face.wide * 0.6, 0.16 + jaw * 3.4, 0.4 + face.round * 0.5);
    m.position.y = -0.058 - jaw * 0.012;

    for (const side of ['L', 'R']) {
      const eye = this.face.eyes[side];
      const open = 1 - face.blink * 0.94;
      eye.white.scale.y = open;
      const px = face.eyeX * 0.011;
      const py = face.eyeY * 0.009;
      eye.pupil.position.x = (side === 'L' ? -1 : 1) * 0.052 + px;
      eye.pupil.position.y = 0.018 + py;
    }

    this.face.brows[0].position.y = 0.072 + face.brow * 0.014;
    this.face.brows[1].position.y = 0.072 + face.brow * 0.014;
    this.face.brows[0].rotation.z = -0.16 - face.brow * 0.16;
    this.face.brows[1].rotation.z = 0.16 + face.brow * 0.16;
  }

  /* ------------------------- imported scene objects ------------------------ */

  _normalizeImported(object, opts = {}) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const height = box.getSize(new THREE.Vector3()).y || 1;
    const scale = clamp((opts.height ?? 1.7) / height, 0.005, 400);
    object.scale.multiplyScalar(scale);
    object.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(object);
    object.position.x -= (b.min.x + b.max.x) / 2;
    object.position.z -= (b.min.z + b.max.z) / 2;
    object.position.y -= b.min.y;
  }

  addImported(name, object, animations = [], opts = {}) {
    if (opts.normalize !== false) this._normalizeImported(object, opts);
    object.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    const entry = {
      id: `obj_${this._nextObjectId++}`,
      name: name || object.name || 'object',
      object,
      animations: animations ?? [],
      extraClips: [],
      mixer: null,
      action: null,
      clipName: null,
      loop: true,
      speed: 1,
      playing: false,
      timelineAction: null,
      timelineClipName: null,
      timelineActive: false,
      builtin: Boolean(opts.builtin),
      source: opts.source ?? null,
    };
    this.objects.push(entry);
    this.scene.add(object);
    return entry;
  }

  getImported(id) {
    return this.objects.find((e) => e.id === id) ?? null;
  }

  getSelected() {
    return this.objects.find((e) => e.id === this.selectedId) ?? null;
  }

  addClips(id, clips) {
    const entry = this.getImported(id);
    if (!entry) return 0;
    const seen = new Set([...entry.animations, ...entry.extraClips].map((c) => c.name));
    let added = 0;
    for (const clip of clips) {
      if (!clip || seen.has(clip.name)) continue;
      seen.add(clip.name);
      entry.extraClips.push(clip);
      added += 1;
    }
    if (!entry.mixer) entry.mixer = new THREE.AnimationMixer(entry.object);
    return added;
  }

  selectObject(id) {
    const entry = this.getImported(id);
    if (!entry) return null;
    this.selectedId = id;
    this.transformControls.attach(entry.object);
    this.transformControls.enabled = true;
    this.transformControls.setMode(this.transformMode);
    return entry;
  }

  deselect() {
    this.selectedId = null;
    this.transformControls.detach();
    this.transformControls.enabled = false;
  }

  removeImported(id) {
    const i = this.objects.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const entry = this.objects[i];
    if (entry.builtin) return false;
    if (this.selectedId === id) this.deselect();
    entry.mixer?.stopAllAction();
    this.scene.remove(entry.object);
    entry.object.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
    this.objects.splice(i, 1);
    return true;
  }

  /**
   * Auto-rig an unrigged imported object: place a humanoid skeleton and skin
   * the mesh, so animation clips (e.g. the Quaternius library) can drive it.
   * Replaces the object's meshes with a single SkinnedMesh. Returns bone count.
   */
  autorigObject(entryId) {
    const entry = this.getImported(entryId);
    if (!entry || entry.builtin) throw new Error('cannot rig this object');

    entry.object.updateMatrixWorld(true);
    const inv = entry.object.matrixWorld.clone().invert();
    const positions = [];
    let material = null;
    const meshes = [];
    entry.object.traverse((o) => {
      if (!o.isMesh) return;
      meshes.push(o);
      const geo = o.geometry;
      const posAttr = geo?.getAttribute?.('position');
      if (!posAttr) return;
      const m = new THREE.Matrix4().copy(o.matrixWorld).multiply(inv);
      const index = geo.index;
      const count = index ? index.count : posAttr.count;
      const tmp = new THREE.Vector3();
      for (let i = 0; i + 2 < count; i += 3) {
        const a = index ? index.getX(i) : i;
        const b = index ? index.getX(i + 1) : i + 1;
        const c = index ? index.getX(i + 2) : i + 2;
        for (const vi of [a, b, c]) {
          tmp.fromBufferAttribute(posAttr, vi).applyMatrix4(m);
          positions.push(tmp.x, tmp.y, tmp.z);
        }
      }
      if (!material && o.material) {
        material = Array.isArray(o.material) ? o.material[0] : o.material;
      }
    });

    if (positions.length < 9) throw new Error('no mesh to rig');

    const rig = autoRigHumanoid(new Float32Array(positions));

    // remove + dispose the original meshes
    for (const mesh of meshes) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose?.();
    }

    const skinnedMaterial = material
      ? material.clone()
      : new THREE.MeshStandardMaterial({ color: 0x9a8b9c, roughness: 0.8, metalness: 0.04 });
    // the welded geometry has no UVs; drop any map so the material renders fine
    if (skinnedMaterial.map) skinnedMaterial.map = null;

    const skinned = new THREE.SkinnedMesh(rig.geometry, skinnedMaterial);
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    skinned.add(rig.rootBone); // only the top bone — descendants chain through it
    entry.object.add(skinned);
    skinned.bind(rig.skeleton);
    entry.object.updateMatrixWorld(true);
    return rig.boneArray.length;
  }

  setTransformMode(mode) {
    this.transformMode = mode;
    this.transformControls.setMode(mode);
  }

  setFreecam(on) {
    this.freecam = Boolean(on);
    this.orbit.enabled = this.freecam;
    if (this.freecam) {
      this.freeCamera.aspect = this.cameras.A.aspect;
      this.freeCamera.updateProjectionMatrix();
    }
  }

  /** Raycast the imported objects (+ jester) under a viewport pixel. */
  pickImported(clientX, clientY) {
    const cam = this.activeCamera ?? this.cameras.A;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    const meshes = [];
    for (const entry of this.objects) {
      entry.object.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
    }
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0].object;
    for (const entry of this.objects) {
      let owned = false;
      entry.object.traverse((o) => { if (o === hit) owned = true; });
      if (owned) return entry;
    }
    return null;
  }

  /* ------------------------------ animations ------------------------------ */

  clipsOf(entryId) {
    const entry = this.getImported(entryId);
    if (!entry) return [];
    return [...entry.animations, ...entry.extraClips];
  }

  playClip(entryId, clipName, opts = {}) {
    const entry = this.getImported(entryId);
    const clip = this.clipsOf(entryId).find((c) => c.name === clipName);
    if (!entry || !clip) return;
    if (!entry.mixer) entry.mixer = new THREE.AnimationMixer(entry.object);
    this.stopTimeline(entryId);
    entry.action?.stop();
    entry.loop = opts.loop ?? entry.loop;
    entry.speed = opts.speed ?? entry.speed;
    entry.action = entry.mixer.clipAction(clip);
    entry.action.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, entry.loop ? Infinity : 1);
    entry.action.clampWhenFinished = !entry.loop;
    entry.action.reset().play();
    entry.action.setEffectiveTimeScale(entry.speed);
    entry.clipName = clipName;
    entry.playing = true;
  }

  stopClip(entryId) {
    const entry = this.getImported(entryId);
    if (!entry) return;
    entry.action?.stop();
    entry.action = null;
    entry.playing = false;
    entry.clipName = null;
  }

  /* ------------------------- timeline-driven clips ------------------------ */

  stopTimeline(entryId) {
    const entry = this.getImported(entryId);
    if (!entry) return;
    entry.timelineAction?.stop();
    entry.timelineAction = null;
    entry.timelineClipName = null;
    entry.timelineActive = false;
  }

  /**
   * Drive an imported rig deterministically from the timeline clock: the pose
   * is a pure function of `time`, so scrubbing is reversible and re-rendering
   * tomorrow reproduces the same frame (the house determinism promise).
   */
  playTimeline(entryId, clipName, { time = 0, loop = true, speed = 1 } = {}) {
    const entry = this.getImported(entryId);
    const clip = this.clipsOf(entryId).find((c) => c.name === clipName);
    if (!entry || !clip) return;
    if (!entry.mixer) entry.mixer = new THREE.AnimationMixer(entry.object);
    // timeline playback takes over wall-clock preview
    entry.action?.stop(); entry.action = null; entry.playing = false; entry.clipName = null;
    if (entry.timelineClipName !== clipName || !entry.timelineAction) {
      entry.timelineAction?.stop();
      entry.timelineAction = entry.mixer.clipAction(clip);
      entry.timelineClipName = clipName;
      entry.timelineAction.play(); // activate (clipAction alone leaves it inactive)
    }
    const action = entry.timelineAction;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.enabled = true;
    action.paused = false;
    action.setEffectiveTimeScale(speed);
    entry.timelineActive = true;
    entry.mixer.setTime(time);
    entry.mixer.update(0);
  }

  /**
   * @param {{entryId:string, clipName:string, time:number, loop:boolean, speed:number}[]} schedule
   */
  syncTimelineAnimations(schedule) {
    const active = new Set();
    for (const s of schedule) {
      this.playTimeline(s.entryId, s.clipName, s);
      active.add(s.entryId);
    }
    for (const entry of this.objects) {
      if (entry.timelineActive && !active.has(entry.id)) this.stopTimeline(entry.id);
    }
  }

  setClipSpeed(entryId, speed) {
    const entry = this.getImported(entryId);
    if (!entry) return;
    entry.speed = speed;
    entry.action?.setEffectiveTimeScale(speed);
  }

  setClipLoop(entryId, loop) {
    const entry = this.getImported(entryId);
    if (!entry) return;
    entry.loop = Boolean(loop);
    if (entry.action) {
      entry.action.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, entry.loop ? Infinity : 1);
      entry.action.clampWhenFinished = !entry.loop;
    }
  }

  update(dt) {
    for (const entry of this.objects) {
      if (!entry.mixer) continue;
      if (entry.timelineActive) continue; // timeline drives via setTime each frame
      if (entry.action) {
        entry.mixer.update(dt);
        if (entry.playing && !entry.loop && !entry.action.isRunning()) {
          entry.playing = false;
          entry.action = null;
          entry.clipName = null;
        }
      }
    }
    if (this.freecam) this.orbit.update();
  }

  render(t, transition) {
    let camA;
    let camB = null;
    let trans = transition;
    if (this.freecam) {
      camA = this.freeCamera;
      trans = null;
    } else {
      camA = this._positionCamera(transition?.from ?? 'A', t);
      const needsB = transition && transition.progress < 0.999 && transition.to !== transition.from;
      camB = needsB ? this._positionCamera(transition.to, t) : null;
    }
    this.activeCamera = camA;
    this.transformControls.camera = camA;
    const focus = this.freecam
      ? this.freeCamera.position.distanceTo(this.orbit.target)
      : (this.cameraCfg[transition?.to ?? 'A']?.distance ?? 4);
    this.post.render({
      scene: this.scene,
      camA,
      camB,
      transition: trans,
      near: 0.05,
      far: 60,
      focus,
      time: t,
    });
  }

  updateDust(t) {
    if (!this.dust) return;
    this.dust.rotation.y = t * 0.01;
    this.dust.position.y = Math.sin(t * 0.2) * 0.05;
  }

  grabFrame() {
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    this.post.dispose();
    this.renderer.dispose();
  }
}

// tiny helper so the pillar cap uses the same material recipe
function pillMatSafe(color) {
  return mat(color, { metalness: 0.45, roughness: 0.45 });
}
