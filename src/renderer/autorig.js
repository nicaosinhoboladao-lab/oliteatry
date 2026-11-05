/**
 * Deterministic humanoid auto-rigging for the reference host.
 *
 * Turns an unrigged mesh into a skinned mesh: it places a humanoid skeleton by
 * analysing the mesh's silhouette, then computes skin weights from geodesic
 * distance (bounded Dijkstra on the welded vertex graph) with a Gaussian
 * falloff — a cheap, robust stand-in for full bone-heat diffusion.
 *
 * The generated skeleton deliberately reuses the Unreal/Quaternius bone names
 * (`pelvis`, `spine_01`, `upperarm_l`, …) so the CC0 Universal Animation
 * Library retargets onto it by name via `retargetClips` in imports.js.
 *
 * Assumes an upright humanoid facing +Z, in T-pose or A-pose (the common case
 * for imported characters). Everything is a pure function of the geometry.
 */
import * as THREE from './vendor/three.module.js';

/** [name, parent] — generation order is the skinIndex order. */
const BONE_DEFS = [
  ['root', ''],
  ['pelvis', 'root'],
  ['spine_01', 'pelvis'],
  ['spine_02', 'spine_01'],
  ['spine_03', 'spine_02'],
  ['neck_01', 'spine_03'],
  ['Head', 'neck_01'],
  ['clavicle_l', 'spine_03'],
  ['upperarm_l', 'clavicle_l'],
  ['lowerarm_l', 'upperarm_l'],
  ['hand_l', 'lowerarm_l'],
  ['clavicle_r', 'spine_03'],
  ['upperarm_r', 'clavicle_r'],
  ['lowerarm_r', 'upperarm_r'],
  ['hand_r', 'lowerarm_r'],
  ['thigh_l', 'pelvis'],
  ['calf_l', 'thigh_l'],
  ['foot_l', 'calf_l'],
  ['ball_l', 'foot_l'],
  ['thigh_r', 'pelvis'],
  ['calf_r', 'thigh_r'],
  ['foot_r', 'calf_r'],
  ['ball_r', 'foot_r'],
];

/* ------------------------------ graph helpers ----------------------------- */

function weldVertices(positions) {
  const n = positions.length / 3;
  const map = new Map();
  const unique = [];
  const indexMap = new Int32Array(n);
  const SCALE = 1000;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(positions[i * 3] * SCALE)},${Math.round(positions[i * 3 + 1] * SCALE)},${Math.round(positions[i * 3 + 2] * SCALE)}`;
    let idx = map.get(k);
    if (idx === undefined) {
      idx = unique.length / 3;
      map.set(k, idx);
      unique.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    indexMap[i] = idx;
  }
  return { uniquePos: new Float32Array(unique), indexMap };
}

/** Build the welded vertex graph with Euclidean edge weights. */
function buildGraph(uniquePos, indexMap) {
  const V = uniquePos.length / 3;
  const adj = Array.from({ length: V }, () => []);
  const add = (a, b) => {
    if (a === b) return;
    const dx = uniquePos[a * 3] - uniquePos[b * 3];
    const dy = uniquePos[a * 3 + 1] - uniquePos[b * 3 + 1];
    const dz = uniquePos[a * 3 + 2] - uniquePos[b * 3 + 2];
    const w = Math.sqrt(dx * dx + dy * dy + dz * dz);
    adj[a].push([b, w]);
  };
  for (let i = 0; i + 2 < indexMap.length; i += 3) {
    const a = indexMap[i], b = indexMap[i + 1], c = indexMap[i + 2];
    add(a, b); add(b, a);
    add(b, c); add(c, b);
    add(c, a); add(a, c);
  }
  // dedupe is not necessary — Dijkstra tolerates parallel edges
  return adj;
}

class MinHeap {
  constructor() { this.d = []; this.i = []; }
  get size() { return this.d.length; }
  push(dist, idx) {
    const d = this.d, i = this.i;
    let k = d.length;
    d.push(dist); i.push(idx);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (d[p] <= d[k]) break;
      [d[p], d[k]] = [d[k], d[p]]; [i[p], i[k]] = [i[k], i[p]];
      k = p;
    }
  }
  pop() {
    const d = this.d, i = this.i;
    const topD = d[0], topI = i[0];
    const lastD = d.pop(), lastI = i.pop();
    if (d.length) {
      d[0] = lastD; i[0] = lastI;
      let k = 0;
      for (;;) {
        let m = k, l = k * 2 + 1, r = k * 2 + 2;
        if (l < d.length && d[l] < d[m]) m = l;
        if (r < d.length && d[r] < d[m]) m = r;
        if (m === k) break;
        [d[m], d[k]] = [d[k], d[m]]; [i[m], i[k]] = [i[k], i[m]];
        k = m;
      }
    }
    return [topD, topI];
  }
}

function dijkstraBounded(adj, sources, maxDist) {
  const V = adj.length;
  const dist = new Float64Array(V).fill(Infinity);
  const settled = new Uint8Array(V);
  const heap = new MinHeap();
  for (const s of sources) { dist[s] = 0; heap.push(0, s); }
  while (heap.size) {
    const [d, u] = heap.pop();
    if (settled[u]) continue;
    settled[u] = 1;
    if (d > maxDist) break;
    const nb = adj[u];
    for (let i = 0; i < nb.length; i++) {
      const v = nb[i][0], w = nb[i][1];
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
    }
  }
  return dist;
}

/* ------------------------------ mesh analysis ----------------------------- */

function analyze(uniquePos) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < uniquePos.length; i += 3) {
    const x = uniquePos[i], y = uniquePos[i + 1], z = uniquePos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    H: Math.max(1e-4, maxY - minY),
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    minY, maxY,
  };
}

/** Contiguous occupied histogram run around cx — separates torso from limbs. */
function centralHalfWidth(uniquePos, yLo, yHi, cx, nBins = 60) {
  const xs = [];
  for (let i = 0; i < uniquePos.length; i += 3) {
    const y = uniquePos[i + 1];
    if (y >= yLo && y < yHi) xs.push(uniquePos[i]);
  }
  if (xs.length < 4) return 0.08;
  let lo = Infinity, hi = -Infinity;
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (hi - lo < 1e-6) return 0.08;
  const binW = (hi - lo) / nBins;
  const occ = new Uint8Array(nBins);
  for (const x of xs) {
    let b = Math.floor((x - lo) / binW);
    if (b >= nBins) b = nBins - 1; if (b < 0) b = 0;
    occ[b] = 1;
  }
  let cb = Math.floor((cx - lo) / binW);
  cb = Math.max(0, Math.min(nBins - 1, cb));
  let left = cb, right = cb;
  while (right + 1 < nBins && occ[right + 1]) right++;
  while (left - 1 >= 0 && occ[left - 1]) left--;
  return ((right - left + 1) * binW) / 2;
}

function centroidX(uniquePos, yLo, yHi, cx, side) {
  // side: -1 = left, +1 = right, 0 = all
  let sx = 0, n = 0;
  for (let i = 0; i < uniquePos.length; i += 3) {
    const y = uniquePos[i + 1];
    if (y < yLo || y >= yHi) continue;
    const x = uniquePos[i];
    if (side < 0 && x >= cx) continue;
    if (side > 0 && x <= cx) continue;
    sx += x; n++;
  }
  return n ? sx / n : cx;
}

/* ------------------------------ bone placement ---------------------------- */

function placeBones(uniquePos) {
  const s = analyze(uniquePos);
  const H = s.H, cx = s.cx, cz = s.cz;

  const torsoHW = centralHalfWidth(uniquePos, 0.55 * H, 0.75 * H, cx);

  // legs: split by x at the pelvis, centroid of each side
  let legL = centroidX(uniquePos, 0.02 * H, 0.46 * H, cx, -1);
  let legR = centroidX(uniquePos, 0.02 * H, 0.46 * H, cx, +1);
  if (Math.abs(legL - cx) < torsoHW * 0.2) legL = cx - torsoHW * 0.62;
  if (Math.abs(legR - cx) < torsoHW * 0.2) legR = cx + torsoHW * 0.62;

  // arms: vertices far from the centre line in the upper band
  let armL = centroidX(uniquePos, 0.44 * H, 0.86 * H, cx, -1);
  let armR = centroidX(uniquePos, 0.44 * H, 0.86 * H, cx, +1);
  const armReach = Math.max(Math.abs(armL - cx), Math.abs(armR - cx));
  const armsOut = armReach > torsoHW * 1.25;

  // T-pose vs A-pose: y of the leftmost vertex in the arm band
  let wristY = 0.46 * H;
  if (armsOut) {
    let minX = Infinity, minXy = 0;
    for (let i = 0; i < uniquePos.length; i += 3) {
      const y = uniquePos[i + 1];
      if (y < 0.44 * H || y >= 0.86 * H) continue;
      if (uniquePos[i] < minX) { minX = uniquePos[i]; minXy = y; }
    }
    wristY = minXy > 0.62 * H ? 0.76 * H : 0.46 * H; // T-pose keeps arms level
  }
  const elbowY = armsOut ? (wristY > 0.62 * H ? 0.76 * H : 0.62 * H) : 0.62 * H;
  const shoulderX = torsoHW * 0.95;
  const handLX = armsOut ? Math.min(armL, cx - torsoHW) : cx - torsoHW * 1.12;
  const handRX = armsOut ? Math.max(armR, cx + torsoHW) : cx + torsoHW * 1.12;

  const p = (name, x, y, z) => ({ name, pos: new THREE.Vector3(x, y, z) });

  return [
    p('root', cx, s.minY + 0.50 * H, cz),
    p('pelvis', cx, s.minY + 0.50 * H, cz),
    p('spine_01', cx, s.minY + 0.59 * H, cz),
    p('spine_02', cx, s.minY + 0.67 * H, cz),
    p('spine_03', cx, s.minY + 0.74 * H, cz),
    p('neck_01', cx, s.minY + 0.81 * H, cz),
    p('Head', cx, s.minY + 0.90 * H, cz + 0.03 * H),
    p('clavicle_l', cx - shoulderX, s.minY + 0.78 * H, cz),
    p('upperarm_l', cx - shoulderX, s.minY + 0.72 * H, cz),
    p('lowerarm_l', (cx - shoulderX + handLX) / 2, s.minY + elbowY, cz),
    p('hand_l', handLX, s.minY + wristY, cz),
    p('clavicle_r', cx + shoulderX, s.minY + 0.78 * H, cz),
    p('upperarm_r', cx + shoulderX, s.minY + 0.72 * H, cz),
    p('lowerarm_r', (cx + shoulderX + handRX) / 2, s.minY + elbowY, cz),
    p('hand_r', handRX, s.minY + wristY, cz),
    p('thigh_l', legL, s.minY + 0.40 * H, cz),
    p('calf_l', legL, s.minY + 0.22 * H, cz),
    p('foot_l', legL, s.minY + 0.05 * H, cz),
    p('ball_l', legL, s.minY, cz),
    p('thigh_r', legR, s.minY + 0.40 * H, cz),
    p('calf_r', legR, s.minY + 0.22 * H, cz),
    p('foot_r', legR, s.minY + 0.05 * H, cz),
    p('ball_r', legR, s.minY, cz),
  ];
}

/* ------------------------------- skin weights ----------------------------- */

function seedsNear(uniquePos, p, radius) {
  const out = [];
  const r2 = radius * radius;
  for (let i = 0; i < uniquePos.length; i += 3) {
    const dx = uniquePos[i] - p.x, dy = uniquePos[i + 1] - p.y, dz = uniquePos[i + 2] - p.z;
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(i / 3);
  }
  return out;
}

function nearestVertex(uniquePos, p) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < uniquePos.length; i += 3) {
    const dx = uniquePos[i] - p.x, dy = uniquePos[i + 1] - p.y, dz = uniquePos[i + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = i / 3; }
  }
  return best;
}

function skinWeights(uniquePos, adj, bones, H) {
  const V = uniquePos.length / 3;
  const B = bones.length;
  const sigma = 0.09 * H;
  const maxDist = 0.55 * H;
  const seedR = 0.05 * H;
  const acc = new Array(V);
  for (let i = 0; i < V; i++) acc[i] = [];

  for (let b = 0; b < B; b++) {
    const pos = bones[b].pos;
    let seeds = seedsNear(uniquePos, pos, seedR);
    if (!seeds.length) seeds = [nearestVertex(uniquePos, pos)];
    const dist = dijkstraBounded(adj, seeds, maxDist);
    for (let v = 0; v < V; v++) {
      const d = dist[v];
      if (d === Infinity) continue;
      acc[v].push([b, Math.exp(-(d * d) / (sigma * sigma))]);
    }
  }

  const skinIndex = new Uint16Array(V * 4);
  const skinWeight = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    let list = acc[v];
    if (!list.length) list = [[nearestBone(uniquePos, v, bones), 1]];
    list.sort((a, b) => b[1] - a[1]);
    const top = list.slice(0, 4);
    let sum = 0;
    for (const [, w] of top) sum += w;
    for (let k = 0; k < 4; k++) {
      const [b, w] = top[k] ?? [0, 0];
      skinIndex[v * 4 + k] = b;
      skinWeight[v * 4 + k] = sum ? w / sum : (k === 0 ? 1 : 0);
    }
  }
  return { skinIndex, skinWeight };
}

function nearestBone(uniquePos, v, bones) {
  const x = uniquePos[v * 3], y = uniquePos[v * 3 + 1], z = uniquePos[v * 3 + 2];
  let best = 0, bd = Infinity;
  for (let b = 0; b < bones.length; b++) {
    const p = bones[b].pos;
    const dx = p.x - x, dy = p.y - y, dz = p.z - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/* -------------------------------- normals --------------------------------- */

function smoothNormals(uniquePos, indexMap) {
  const V = uniquePos.length / 3;
  const acc = new Float32Array(V * 3);
  for (let i = 0; i + 2 < indexMap.length; i += 3) {
    const a = indexMap[i], b = indexMap[i + 1], c = indexMap[i + 2];
    const ax = uniquePos[a * 3], ay = uniquePos[a * 3 + 1], az = uniquePos[a * 3 + 2];
    const bx = uniquePos[b * 3], by = uniquePos[b * 3 + 1], bz = uniquePos[b * 3 + 2];
    const cx = uniquePos[c * 3], cy = uniquePos[c * 3 + 1], cz = uniquePos[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [a, b, c]) {
      acc[v * 3] += nx; acc[v * 3 + 1] += ny; acc[v * 3 + 2] += nz;
    }
  }
  const normals = new Float32Array(indexMap.length * 3);
  for (let i = 0; i < indexMap.length; i++) {
    const u = indexMap[i];
    let x = acc[u * 3], y = acc[u * 3 + 1], z = acc[u * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / len; normals[i * 3 + 1] = y / len; normals[i * 3 + 2] = z / len;
  }
  return normals;
}

/* ---------------------------------- entry --------------------------------- */

/**
 * @param {Float32Array} triangles  non-indexed triangle positions (local space)
 * @returns {{geometry:THREE.BufferGeometry, skeleton:THREE.Skeleton, boneArray:THREE.Bone[]}}
 */
export function autoRigHumanoid(triangles) {
  if (triangles.length < 9) throw new Error('mesh too small to rig');
  const { uniquePos, indexMap } = weldVertices(triangles);
  const adj = buildGraph(uniquePos, indexMap);
  const bones = placeBones(uniquePos);
  const H = analyze(uniquePos).H;

  const { skinIndex, skinWeight } = skinWeights(uniquePos, adj, bones, H);
  const normals = smoothNormals(uniquePos, indexMap);

  // weights are computed per unique (welded) vertex — remap to the output
  // (non-indexed) vertices so the attributes line up with `position`.
  const N = indexMap.length;
  const outSkinIndex = new Uint16Array(N * 4);
  const outSkinWeight = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const u = indexMap[i];
    outSkinIndex[i * 4] = skinIndex[u * 4];
    outSkinIndex[i * 4 + 1] = skinIndex[u * 4 + 1];
    outSkinIndex[i * 4 + 2] = skinIndex[u * 4 + 2];
    outSkinIndex[i * 4 + 3] = skinIndex[u * 4 + 3];
    outSkinWeight[i * 4] = skinWeight[u * 4];
    outSkinWeight[i * 4 + 1] = skinWeight[u * 4 + 1];
    outSkinWeight[i * 4 + 2] = skinWeight[u * 4 + 2];
    outSkinWeight[i * 4 + 3] = skinWeight[u * 4 + 3];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triangles), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(outSkinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(outSkinWeight, 4));

  // build the bone hierarchy (local transforms = offset from parent)
  const byName = new Map();
  const boneArray = [];
  for (const [name] of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    byName.set(name, bone);
    boneArray.push(bone);
  }
  for (const [name, parent] of BONE_DEFS) {
    if (!parent) continue;
    const b = byName.get(name), p = byName.get(parent);
    b.position.copy(positionOf(bones, name)).sub(positionOf(bones, parent));
    p.add(b);
  }
  // root bone at its absolute position
  byName.get('root').position.copy(positionOf(bones, 'root'));

  const skeleton = new THREE.Skeleton(boneArray);
  return { geometry, skeleton, boneArray, rootBone: byName.get('root') };
}

function positionOf(bones, name) {
  return bones.find((b) => b.name === name).pos;
}
