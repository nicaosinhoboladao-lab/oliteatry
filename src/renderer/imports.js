/**
 * Model & animation import for the reference host.
 *
 * The renderer never touches the filesystem: the main process reads a file
 * (resolving glTF buffers/images and OBJ mtl textures into data URIs) and
 * hands back bytes/text. This module turns those into THREE objects plus the
 * animation clips they carry, and provides best-effort same-name retargeting
 * so clips from one skeleton (e.g. the Quaternius Universal Animation Library)
 * can drive another that shares its bone names.
 *
 * Formats: glb / gltf / fbx / obj(+mtl) / stl / ply / dae / vrm.
 */
import * as THREE from './vendor/three.module.js';
import {
  GLTFLoader, FBXLoader, OBJLoader, MTLLoader, STLLoader, PLYLoader, ColladaLoader,
} from './vendor/addons.module.js';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js';

/** Promise-wrapping form of `loader.parse(data, path, onLoad, onError)`. */
function parse(loader, data, path = '') {
  return new Promise((resolve, reject) => loader.parse(data, path, resolve, reject));
}

function asArrayBuffer(u8) {
  if (u8 == null) return new ArrayBuffer(0);
  if (u8 instanceof ArrayBuffer) return u8;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function asUint8(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

const DECODER = new TextDecoder();
const decodeText = (data) => DECODER.decode(asUint8(data));

/* ------------------------------ GLTF / GLB ------------------------------- */

function loadGltf(asset) {
  const loader = new GLTFLoader();
  const data = asset.kind === 'text' ? asset.data : asArrayBuffer(asUint8(asset.data));
  return parse(loader, data).then((gltf) => ({
    object: gltf.scene,
    animations: gltf.animations ?? [],
    meta: { loader: 'gltf' },
  }));
}

/* --------------------------------- FBX ----------------------------------- */

function loadFbx(asset) {
  const loader = new FBXLoader();
  const object = loader.parse(asArrayBuffer(asUint8(asset.data)), '');
  return { object, animations: object.animations ?? [], meta: { loader: 'fbx' } };
}

/* ------------------------------ OBJ (+MTL) ------------------------------- */

async function loadObj(asset) {
  const objText = asset.kind === 'text' ? asset.data : decodeText(asset.data);
  let materials = null;
  if (asset.mtl) {
    try {
      const mtlLoader = new MTLLoader();
      materials = mtlLoader.parse(asset.mtl, '');
      if (materials?.preload) await materials.preload();
    } catch { materials = null; }
  }
  const loader = new OBJLoader();
  if (materials) loader.setMaterials(materials);
  const object = loader.parse(objText);
  return { object, animations: [], meta: { loader: 'obj' } };
}

/* ---------------------------------- STL ---------------------------------- */

function loadStl(asset) {
  const loader = new STLLoader();
  const geometry = loader.parse(asArrayBuffer(asUint8(asset.data)));
  const material = new THREE.MeshStandardMaterial({ color: 0x9a8b9c, roughness: 0.7, metalness: 0.05 });
  const object = new THREE.Mesh(geometry, material);
  return { object, animations: [], meta: { loader: 'stl' } };
}

/* ---------------------------------- PLY ---------------------------------- */

function loadPly(asset) {
  const bytes = asUint8(asset.data);
  const header = decodeText(bytes.slice(0, 4096));
  const isBinary = /format\s+binary/i.test(header);
  const loader = new PLYLoader();
  const geometry = loader.parse(isBinary ? asArrayBuffer(bytes) : decodeText(bytes));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x9a8b9c, roughness: 0.7, metalness: 0.05, vertexColors: true });
  const object = new THREE.Mesh(geometry, material);
  return { object, animations: [], meta: { loader: 'ply' } };
}

/* ---------------------------------- DAE ---------------------------------- */

function loadDae(asset) {
  const loader = new ColladaLoader();
  const text = asset.kind === 'text' ? asset.data : decodeText(asset.data);
  const collada = loader.parse(text, '');
  return { object: collada.scene, animations: collada.animations ?? [], meta: { loader: 'dae' } };
}

/* ---------------------------------- VRM ---------------------------------- */

function loadVrm(asset) {
  const bytes = asArrayBuffer(asUint8(asset.data));

  const withPlugin = () => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    return parse(loader, bytes).then((gltf) => {
      const vrm = gltf.userData.vrm;
      if (vrm?.scene) {
        // VRM0 models are authored facing away from the camera; rotate them.
        if (vrm.meta?.metaVersion === '0') {
          try { VRMUtils.rotateVRM0(vrm); } catch { /* ignore */ }
        }
        return {
          object: vrm.scene,
          animations: gltf.animations ?? [],
          meta: { loader: 'vrm', vrm: vrm.meta?.metaVersion },
        };
      }
      return { object: gltf.scene, animations: gltf.animations ?? [], meta: { loader: 'vrm' } };
    });
  };

  // A VRM whose license URL / metadata is not recognised makes the plugin
  // throw — fall back to a plain GLB load so the avatar still imports.
  return withPlugin().catch(() => {
    const loader = new GLTFLoader();
    return parse(loader, bytes).then((gltf) => ({
      object: gltf.scene,
      animations: gltf.animations ?? [],
      meta: { loader: 'vrm', fallback: true },
    }));
  });
}

/* -------------------------------- dispatch ------------------------------- */

export async function loadModelAsset(asset) {
  if (asset.error) throw new Error(asset.error);
  switch (asset.ext) {
    case 'glb': case 'gltf': return loadGltf(asset);
    case 'fbx': return loadFbx(asset);
    case 'obj': return loadObj(asset);
    case 'stl': return loadStl(asset);
    case 'ply': return loadPly(asset);
    case 'dae': return loadDae(asset);
    case 'vrm': return loadVrm(asset);
    default: throw new Error(`unsupported format: .${asset.ext}`);
  }
}

/* ------------------------------ retargeting ------------------------------ */

const TRACK_SUFFIX = /\.(position|quaternion|scale|weights)$/;

function stripBonePrefix(name) {
  return name.replace(/^(mixamorig:|mixamo:|Mannequin:|Armature\|)/, '');
}

function collectBones(root) {
  const map = new Map();
  root.traverse((o) => {
    if (o.isBone || o.isObject3D) {
      const key = o.name.toLowerCase();
      if (key && !map.has(key)) map.set(key, o);
    }
  });
  return map;
}

/**
 * Rebuild `clip` so its tracks drive the skeleton of `targetRoot` by bone name.
 * Returns null when no track could be matched (nothing to retarget onto).
 */
export function retargetClip(clip, targetRoot) {
  const bones = collectBones(targetRoot);
  if (!bones.size) return null;

  const tracks = [];
  for (const track of clip.tracks) {
    const m = track.name.match(TRACK_SUFFIX);
    if (!m) continue; // morph targets / root motion carry no bone we can map
    const prop = m[1];
    const boneName = track.name.slice(0, m.index);
    const target = bones.get(boneName.toLowerCase())
      ?? bones.get(stripBonePrefix(boneName).toLowerCase());
    if (!target) continue;
    const t = track.clone();
    t.name = `${target.name}.${prop}`;
    tracks.push(t);
  }
  if (!tracks.length) return null;
  return new THREE.AnimationClip(`${clip.name}`, clip.duration, tracks);
}

/** Retarget every clip, dropping the ones that cannot map. */
export function retargetClips(clips, targetRoot) {
  return clips.map((c) => retargetClip(c, targetRoot)).filter(Boolean);
}

/** Does the asset carry a rigged character (a skinned mesh + bones)? */
export function hasSkeleton(object) {
  let skinned = false;
  let bone = false;
  object.traverse((o) => {
    if (o.isSkinnedMesh) skinned = true;
    if (o.isBone) bone = true;
  });
  return skinned && bone;
}
