import { describe, it, expect } from 'vitest';
import * as THREE from '../src/renderer/vendor/three.module.js';
import { retargetClip, retargetClips, hasSkeleton } from '../src/renderer/imports.js';

function makeSkeleton() {
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.name = 'Hips'; root.add(hips);
  const spine = new THREE.Group(); spine.name = 'Spine'; hips.add(spine);
  const head = new THREE.Group(); head.name = 'Head'; spine.add(head);
  return root;
}

function makeClip() {
  const tracks = [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 1, 0]),
    new THREE.VectorKeyframeTrack('Spine.position', [0, 1], [0, 0, 0, 0, 0, 0]),
    new THREE.QuaternionKeyframeTrack('mixamorig:Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack('NoSuchBone.position', [0, 1], [0, 0, 0, 1, 1, 1]),
  ];
  return new THREE.AnimationClip('Test', 1, tracks);
}

describe('animation retargeting', () => {
  it('maps tracks by bone name and drops unknown bones', () => {
    const out = retargetClip(makeClip(), makeSkeleton());
    expect(out).not.toBeNull();
    const names = out.tracks.map((t) => t.name);
    expect(names).toContain('Hips.position');
    expect(names).toContain('Spine.position');
    expect(names).toContain('Head.quaternion'); // "mixamorig:" prefix stripped
    expect(names).not.toContain('NoSuchBone.position');
    expect(names.length).toBe(3);
  });

  it('returns null when no track maps', () => {
    const clip = new THREE.AnimationClip('X', 1, [
      new THREE.VectorKeyframeTrack('Ghost.position', [0, 1], [0, 0, 0, 1, 1, 1]),
    ]);
    expect(retargetClip(clip, makeSkeleton())).toBeNull();
  });

  it('retargetClips drops unmappable clips', () => {
    const bad = new THREE.AnimationClip('Bad', 1, [
      new THREE.VectorKeyframeTrack('Ghost.position', [0, 1], [0, 0, 0, 1, 1, 1]),
    ]);
    const out = retargetClips([makeClip(), bad], makeSkeleton());
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('Test');
  });

  it('detects a skinned rig (mesh + bones)', () => {
    const group = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'hips';
    group.add(bone);
    expect(hasSkeleton(group)).toBe(false); // bones without a skinned mesh
    const mesh = new THREE.SkinnedMesh();
    mesh.bind(new THREE.Skeleton([bone]));
    group.add(mesh);
    expect(hasSkeleton(group)).toBe(true);
  });
});
