/**
 * Custom post stack (no three/examples dependency).
 *   scene -> HDR target (+depth) -> bright pass -> gaussian bloom -> composite
 * The composite pass owns: camera transitions, depth-of-field, bloom, grading,
 * vignette, paper grain, PS2 dither/quantisation and CRT scanlines.
 */
import * as THREE from './vendor/three.module.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture2D(tDiffuse, vUv + o1).rgb + texture2D(tDiffuse, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(tDiffuse, vUv + o2).rgb + texture2D(tDiffuse, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tScene2;
uniform sampler2D tDepth;
uniform sampler2D tBloom;

uniform float uHasSecond;
uniform float uCamMix;
uniform float uCamMode;      // 0 = fade, 1 = wipe
uniform float uTime;
uniform vec2  uResolution;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uVignette;
uniform float uGrain;
uniform float uDither;
uniform float uScanlines;
uniform float uDof;
uniform float uNear;
uniform float uFar;
uniform float uFocus;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 a = texture2D(tScene, vUv).rgb;
  vec3 b = texture2D(tScene2, vUv).rgb;

  float mixv = uCamMix;
  if (uCamMode > 0.5) {
    float ang = 0.55;
    float d = vUv.x * cos(ang) + vUv.y * sin(ang);
    float edge = mix(-0.25, 1.25, uCamMix);
    mixv = 1.0 - smoothstep(edge - 0.10, edge + 0.10, d);
  }
  vec3 col = (uHasSecond > 0.5) ? mix(a, b, clamp(mixv, 0.0, 1.0)) : a;

  if (uDof > 0.001) {
    float depth = texture2D(tDepth, vUv).x;
    float lin = linearDepth(depth);
    float coc = clamp(abs(lin - uFocus) / max(uFocus * 0.85, 0.2), 0.0, 1.0);
    float radius = coc * uDof * 6.0;
    if (radius > 0.25) {
      vec3 acc = col;
      float wsum = 1.0;
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float ang2 = fi * 0.7853981634 + 0.6;
        vec2 off = vec2(cos(ang2), sin(ang2)) * radius / uResolution;
        acc += texture2D(tScene, vUv + off).rgb;
        wsum += 1.0;
      }
      col = mix(col, acc / wsum, clamp(coc * 1.2, 0.0, 0.85));
    }
  }

  vec3 bloom = texture2D(tBloom, vUv).rgb;
  col += bloom * uBloomStrength;

  col *= uExposure;
  col = aces(col);
  col = (col - 0.5) * uContrast + 0.5;

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  // violet shadow lift: the house look, subtly, so it survives grading
  col += vec3(0.020, 0.006, 0.038) * (1.0 - smoothstep(0.0, 0.42, luma)) * 0.9;

  vec2 q = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(q, q) * 1.7;
  col *= clamp(vig, 0.0, 1.0);

  float grain = hash12(gl_FragCoord.xy + floor(uTime * 60.0)) - 0.5;
  col += grain * uGrain * 0.10;

  if (uDither > 0.001) {
    float bayer = hash12(floor(gl_FragCoord.xy * 0.5) + 0.5);
    vec3 quant = floor(col * 31.0 + bayer * 0.98) / 31.0;
    col = mix(col, quant, uDither);
  }

  if (uScanlines > 0.001) {
    float line = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159265);
    col *= 1.0 - uScanlines * 0.22 * line;
  }

  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeTarget(w, h, withDepth) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  if (withDepth) {
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    rt.depthTexture = depth;
  }
  return rt;
}

export class PostStack {
  constructor(renderer, { width = 1280, height = 720, scale = 1 } = {}) {
    this.renderer = renderer;
    this.scale = scale;
    this.width = width;
    this.height = height;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.72 } },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: null },
        tScene2: { value: null },
        tDepth: { value: null },
        tBloom: { value: null },
        uHasSecond: { value: 0 },
        uCamMix: { value: 1 },
        uCamMode: { value: 0 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) },
        uBloomStrength: { value: 0.38 },
        uExposure: { value: 1 },
        uContrast: { value: 1.06 },
        uSaturation: { value: 1.04 },
        uVignette: { value: 0.42 },
        uGrain: { value: 0.16 },
        uDither: { value: 0 },
        uScanlines: { value: 0 },
        uDof: { value: 0.35 },
        uNear: { value: 0.1 },
        uFar: { value: 120 },
        uFocus: { value: 4 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.rtScene = null;
    this.rtScene2 = null;
    this.rtBlurA = null;
    this.rtBlurB = null;
    this.setSize(width, height, scale);
  }

  setSize(cssWidth, cssHeight, scale = this.scale) {
    this.scale = scale;
    this.width = Math.max(2, Math.floor(cssWidth));
    this.height = Math.max(2, Math.floor(cssHeight));
    const w = Math.max(2, Math.floor(this.width * scale));
    const h = Math.max(2, Math.floor(this.height * scale));

    for (const rt of [this.rtScene, this.rtScene2, this.rtBlurA, this.rtBlurB]) rt?.dispose();

    this.rtScene = makeTarget(w, h, true);
    this.rtScene2 = makeTarget(w, h, false);
    this.rtBlurA = makeTarget(Math.max(2, w >> 1), Math.max(2, h >> 1), false);
    this.rtBlurB = makeTarget(Math.max(2, w >> 1), Math.max(2, h >> 1), false);

    this.compMat.uniforms.tDepth.value = this.rtScene.depthTexture;
    this.compMat.uniforms.uResolution.value.set(w, h);
    this.internalWidth = w;
    this.internalHeight = h;
  }

  setParams(post = {}) {
    const u = this.compMat.uniforms;
    if (post.bloom !== undefined) u.uBloomStrength.value = post.bloom;
    if (post.bloomThreshold !== undefined) this.brightMat.uniforms.uThreshold.value = post.bloomThreshold;
    if (post.exposure !== undefined) u.uExposure.value = post.exposure;
    if (post.contrast !== undefined) u.uContrast.value = post.contrast;
    if (post.saturation !== undefined) u.uSaturation.value = post.saturation;
    if (post.vignette !== undefined) u.uVignette.value = post.vignette;
    if (post.grain !== undefined) u.uGrain.value = post.grain;
    if (post.dof !== undefined) u.uDof.value = post.dof;
    const ps2 = Boolean(post.ps2);
    u.uDither.value = ps2 ? Math.max(0.85, post.dither ?? 0) : (post.dither ?? 0);
    u.uScanlines.value = ps2 ? Math.max(0.5, post.scanlines ?? 0) : (post.scanlines ?? 0);
  }

  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Camera} opts.camA
   * @param {THREE.Camera} [opts.camB]
   * @param {{from:string,to:string,progress:number,type:string}} [opts.transition]
   */
  render({ scene, camA, camB, transition, near = 0.1, far = 120, focus = 4, time = 0 }) {
    const r = this.renderer;
    const u = this.compMat.uniforms;

    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camA);

    let hasSecond = 0;
    if (camB && transition && transition.progress < 0.999) {
      r.setRenderTarget(this.rtScene2);
      r.clear();
      r.render(scene, camB);
      hasSecond = 1;
    }

    // bright pass -> half-res
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tDiffuse.value = this.rtScene.texture;
    r.setRenderTarget(this.rtBlurA);
    r.render(this.scene, this.camera);

    // gaussian: horizontal then vertical (both half-res)
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.rtBlurA.texture;
    this.blurMat.uniforms.uDir.value.set(1.2 / this.rtBlurA.width, 0);
    r.setRenderTarget(this.rtBlurB);
    r.render(this.scene, this.camera);

    this.blurMat.uniforms.tDiffuse.value = this.rtBlurB.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1.6 / this.rtBlurB.height);
    r.setRenderTarget(this.rtBlurA);
    r.render(this.scene, this.camera);

    // composite to screen
    this.quad.material = this.compMat;
    u.tScene.value = this.rtScene.texture;
    u.tScene2.value = this.rtScene2.texture;
    u.tBloom.value = this.rtBlurA.texture;
    u.tDepth.value = this.rtScene.depthTexture;
    u.uHasSecond.value = hasSecond;
    u.uCamMix.value = transition ? transition.progress : 1;
    u.uCamMode.value = transition && transition.type === 'wipe' ? 1 : 0;
    u.uTime.value = time;
    u.uNear.value = near;
    u.uFar.value = far;
    u.uFocus.value = focus;

    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }

  dispose() {
    for (const rt of [this.rtScene, this.rtScene2, this.rtBlurA, this.rtBlurB]) rt?.dispose();
    this.compMat.dispose();
    this.blurMat.dispose();
    this.brightMat.dispose();
    this.quad.geometry.dispose();
  }
}
