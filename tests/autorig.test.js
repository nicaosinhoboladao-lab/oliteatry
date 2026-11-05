import { describe, it, expect } from 'vitest';
import * as THREE from '../src/renderer/vendor/three.module.js';
import { autoRigHumanoid } from '../src/renderer/autorig.js';

/** A closed box as non-indexed triangles. */
function box(w, h, d, cx, cy, cz) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ];
  const out = [];
  for (const [a, b, cIdx] of f) for (const i of [a, b, cIdx]) out.push(...c[i]);
  return out;
}

/** A rough T-pose: torso + arms + head, upright facing +Z. */
function humanoidTriangles() {
  const parts = [];
  parts.push(...box(0.4, 0.8, 0.3, 0, 0.45, 0));   // torso
  parts.push(...box(1.6, 0.16, 0.2, 0, 0.78, 0));  // arms
  parts.push(...box(0.26, 0.26, 0.26, 0, 0.98, 0)); // head
  parts.push(...box(0.34, 0.5, 0.28, -0.13, 0.25, 0)); // left leg
  parts.push(...box(0.34, 0.5, 0.28, 0.13, 0.25, 0));  // right leg
  return new Float32Array(parts);
}

describe('humanoid auto-rig', () => {
  const rig = autoRigHumanoid(humanoidTriangles());

  it('builds the 23-bone humanoid chain with the Quaternius names', () => {
    const names = rig.boneArray.map((b) => b.name);
    expect(names.length).toBe(23);
    expect(names).toContain('root');
    expect(names).toContain('pelvis');
    expect(names).toContain('Head');
    expect(names).toContain('upperarm_l');
    expect(names).toContain('hand_r');
    expect(names).toContain('thigh_l');
    expect(rig.rootBone.name).toBe('root');
  });

  it('parents the bones in a chain (root is the top)', () => {
    const pelvis = rig.boneArray.find((b) => b.name === 'pelvis');
    expect(pelvis.parent).toBe(rig.rootBone);
    const head = rig.boneArray.find((b) => b.name === 'Head');
    expect(head.parent.name).toBe('neck_01');
  });

  it('produces matching, valid skin attributes', () => {
    const pos = rig.geometry.getAttribute('position');
    const si = rig.geometry.getAttribute('skinIndex');
    const sw = rig.geometry.getAttribute('skinWeight');
    expect(si.count).toBe(pos.count);
    expect(sw.count).toBe(pos.count);
    expect(si.itemSize).toBe(4);
    for (let v = 0; v < sw.count; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        expect(si.getComponent(v, k)).toBeGreaterThanOrEqual(0);
        expect(si.getComponent(v, k)).toBeLessThan(23);
        sum += sw.getComponent(v, k);
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
    }
  });

  it('rejects an empty mesh', () => {
    expect(() => autoRigHumanoid(new Float32Array(0))).toThrow(/too small/);
  });
});
