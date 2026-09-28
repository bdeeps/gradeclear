// Shared parts for GradeClear: a real, tiny colour-grading pipeline running on your graphics card.
//
// How the pipeline works (the same order a colourist's node tree uses, just small):
//  1. A "shot" camera films a 3D set (a street, three faces, or a sunset) into a half-float render
//     target. Those pixels are scene-linear light: 0.18 is a mid-grey card, 40 is where the sensor fills.
//  2. The camera records it: either as LOG (ARRI LogC3-style curve, wide gamut), or as a finished
//     Rec.709 picture that clips at display white, like a video camera or a phone.
//  3. The grade shader then does, in order: exposure and white balance (in linear light), the display
//     LUT (a real 3D lookup table baked on the CPU from the log maths), lift/gamma/gain, contrast,
//     saturation, an HSL qualifier, a power window, a vignette, a creative look LUT and grain.
//  4. A small copy of the result is read back every frame and turned into real scopes: a waveform,
//     an RGB parade and a vectorscope with the skin-tone line.
// Everything filmed here is generic and built for this box. Real films, colourists and software are
// only named as examples in the text; no real film frame is recreated.
//
// Sources for the constants:
//  - LogC3 (EI 800) curve and the ARRI Wide Gamut 3 → Rec.709 matrix: ARRI, "ALEXA Log C Curve: Usage
//    in VFX" (2017). ALEXA dynamic range at EI 800: 7.8 stops above and 6.2 below 18% grey (ARRI).
//  - Rec.709 OETF and luma weights (0.2126, 0.7152, 0.0722): ITU-R BT.709-6.
//  - Vectorscope: Cb = (B − Y)/1.8556, Cr = (R − Y)/1.5748 (BT.709). The skin-tone ("I") line sits at
//    about 123° on a standard vectorscope.
//  - Chart patches: the widely published sRGB values of the 24-patch colour checker chart.
import { THREE, M, box, sphere, beam, clamp, lerp, approach } from './kit.js';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const SET = 1;                        // layer the shot cameras film
export const PW = 640, PH = 360;             // picture size (16:9)
export const inReel = () => document.body.classList.contains('gb-reel');
export const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };

// ---------------------------------------------------------------- colour maths (CPU)
export const LOGC = { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
export const logc = (x) => (x > LOGC.cut ? LOGC.c * Math.log10(LOGC.a * x + LOGC.b) + LOGC.d : LOGC.e * x + LOGC.f);
export const delogc = (t) => (t > LOGC.e * LOGC.cut + LOGC.f ? (Math.pow(10, (t - LOGC.d) / LOGC.c) - LOGC.b) / LOGC.a : (t - LOGC.f) / LOGC.e);
export const oetf709 = (x) => (x <= 0 ? 0 : x < 0.018 ? 4.5 * x : 1.099 * Math.pow(x, 0.45) - 0.099);
export const inv709 = (v) => (v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45));
export const SENSOR_CLIP = 0.18 * Math.pow(2, 7.8);         // ≈ 40: ALEXA-class sensor fills 7.8 stops over grey
// A gentle filmic tone curve: straight in the middle, a soft shoulder that reaches white at scene value W.
const W_TONE = 16;
export const tone = (x) => { x = Math.max(0, x); return (x * (1 + x / (W_TONE * W_TONE))) / (1 + x); };
export const display = (x) => oetf709(clamp(1.08 * tone(x), 0, 1));   // grey card (0.18) → about 39%
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const toCbCr = (r, g, b) => { const y = luma(r, g, b); return [(b - y) / 1.8556, (r - y) / 1.5748, y]; };
export const fromYCbCr = (y, cb, cr) => { const r = y + 1.5748 * cr, b = y + 1.8556 * cb; return [r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b]; };
// A zero-brightness colour push in the direction (cb, cr), as RGB offsets.
export const pushRGB = (cb, cr) => [1.5748 * cr, -0.187324 * cb - 0.468124 * cr, 1.8556 * cb];
export const SKIN_ANGLE = 123;               // degrees on the vectorscope

// ARRI Wide Gamut 3 → Rec.709 (ARRI white paper), and its inverse, computed here.
export const AWG_TO_709 = new THREE.Matrix3().set(1.617523, -0.537287, -0.080237, -0.070573, 1.334613, -0.26404, -0.021102, -0.226954, 1.248056);
export const R709_TO_AWG = AWG_TO_709.clone().invert();
const mul3 = (m, r, g, b) => { const e = m.elements; return [e[0] * r + e[3] * g + e[6] * b, e[1] * r + e[4] * g + e[7] * b, e[2] * r + e[5] * g + e[8] * b]; };
export { mul3 };

// White balance as channel gains in linear light. temp > 0 warmer (more red, less blue); tint > 0 more magenta.
export const wbGains = (temp, tint) => [Math.pow(2, 0.5 * temp + tint / 3), Math.pow(2, (-2 * tint) / 3), Math.pow(2, -0.5 * temp + tint / 3)];
// Solve temp, tint and exposure (EV) that turn grey `from` into grey `to` (both linear RGB).
export function solveBalance(from, to) {
  const k = [0, 1, 2].map((i) => Math.log2(Math.max(1e-5, to[i]) / Math.max(1e-5, from[i])));
  const ev = (k[0] + k[1] + k[2]) / 3;
  return { ev, temp: k[0] - k[2], tint: (k[0] + k[2] - 2 * k[1]) / 2 };
}

// Log file → display, exactly what the display LUT holds.
export function logToDisplay(r, g, b) {
  const [R, G, B] = mul3(AWG_TO_709, delogc(r), delogc(g), delogc(b));
  return [display(R), display(G), display(B)];
}
// Linear scene light (Rec.709 primaries) → log file, as the camera writes it.
export function linToLog(r, g, b, clip = SENSOR_CLIP) {
  const [R, G, B] = mul3(R709_TO_AWG, Math.min(r, clip), Math.min(g, clip), Math.min(b, clip));
  return [logc(Math.max(0, R)), logc(Math.max(0, G)), logc(Math.max(0, B))];
}

// ---------------------------------------------------------------- creative looks (display in → display out)
const sig = (x, c) => { const s = (v) => 1 / (1 + Math.exp(-c * (v - 0.5))); return (s(x) - s(0)) / (s(1) - s(0)); };
const mix = (a, b, k) => a + (b - a) * k;
export const LOOKS = {
  none: { label: 'None', f: (r, g, b) => [r, g, b] },
  teal: {
    label: 'Teal & orange',
    // Squeeze every colour onto the orange–teal line (the axis runs through skin at ~130°), then tint
    // shadows teal and highlights orange and add a little contrast.
    f: (r, g, b) => {
      let [cb, cr, y] = toCbCr(r, g, b);
      const A = 130 * DEG, ca = Math.cos(A), sa = Math.sin(A);
      let p = cb * ca + cr * sa, q = -cb * sa + cr * ca;
      q *= 0.3; p *= 1.25; p += 0.09 * (y - 0.42);
      y = mix(y, sig(y, 5.5), 0.45);
      cb = p * ca - q * sa; cr = p * sa + q * ca;
      return fromYCbCr(y, cb, cr);
    },
  },
  bleach: {
    label: 'Bleach bypass',
    // Skipping the bleach leaves silver in the print: a black-and-white layer over the colour one.
    f: (r, g, b) => {
      const y = luma(r, g, b);
      const ov = (a) => (y < 0.5 ? 2 * a * y : 1 - 2 * (1 - a) * (1 - y));
      const d = [mix(r, y, 0.5), mix(g, y, 0.5), mix(b, y, 0.5)];
      return d.map((a) => mix(a, ov(a), 0.8));
    },
  },
  film: {
    label: 'Film print',
    // An S-curve per channel like a print stock, black that never quite reaches zero, warm highlights.
    f: (r, g, b) => {
      const y = luma(r, g, b);
      const o = [0.025 + 0.95 * sig(r, 5.4) + 0.01, 0.022 + 0.95 * sig(g, 5.1), 0.035 + 0.93 * sig(b, 4.6)];
      const k = clamp((y - 0.75) / 0.25, 0, 1) * 0.5, yo = luma(...o);
      return o.map((a) => mix(a, yo, k));
    },
  },
  night: {
    label: 'Day for night',
    // Two and a half stops darker, most colour gone, moonlight blue, blacks crushed.
    f: (r, g, b) => {
      const lin = [r, g, b].map((v) => Math.pow(clamp(v, 0, 1), 2.2) * 0.18);
      const y = luma(...lin);
      const t = [0.55, 0.78, 1.3];
      return lin.map((v, i) => Math.max(0, Math.pow(Math.max(0, mix(v, y, 0.75) * t[i]), 1 / 2.2) - 0.02) / 0.98);
    },
  },
  sepia: {
    label: 'Sepia',
    // The classic sepia colour matrix.
    f: (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b].map((v) => v * 0.92),
  },
  noir: {
    label: 'Noir',
    // Black and white through a red filter (skies go dark), with hard contrast.
    f: (r, g, b) => { const m = sig(clamp(0.55 * r + 0.38 * g + 0.07 * b, 0, 1), 8.5); return [m, m, m]; },
  },
};

// ---------------------------------------------------------------- 3D LUTs
// Bake fn(r, g, b) → [r, g, b] (all 0–1) into an N×N×N RGBA8 3D texture the GPU interpolates.
export function bakeLUT(N, fn, tex = null) {
  const data = new Uint8Array(N * N * N * 4);
  let i = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = fn(r / (N - 1), g / (N - 1), b / (N - 1));
    data[i++] = Math.round(clamp(o[0], 0, 1) * 255); data[i++] = Math.round(clamp(o[1], 0, 1) * 255); data[i++] = Math.round(clamp(o[2], 0, 1) * 255); data[i++] = 255;
  }
  if (tex && tex.image.width === N) { tex.image.data.set(data); tex.needsUpdate = true; return tex; }
  tex?.dispose();
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1; t.needsUpdate = true;
  t.userData.N = N; t.userData.data = data;
  return t;
}
// Trilinear lookup on the CPU, for measuring a LUT's error against the exact maths.
export function sampleLUT(tex, r, g, b) {
  const N = tex.image.width, d = tex.image.data;
  const f = (v) => clamp(v, 0, 1) * (N - 1);
  const x = f(r), y = f(g), z = f(b), x0 = Math.min(N - 2, Math.floor(x)), y0 = Math.min(N - 2, Math.floor(y)), z0 = Math.min(N - 2, Math.floor(z));
  const fx = x - x0, fy = y - y0, fz = z - z0, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = (i, j, k) => d[(((z0 + k) * N + (y0 + j)) * N + (x0 + i)) * 4 + c] / 255;
    const a = lerp(lerp(v(0, 0, 0), v(1, 0, 0), fx), lerp(v(0, 1, 0), v(1, 1, 0), fx), fy);
    const bb = lerp(lerp(v(0, 0, 1), v(1, 0, 1), fx), lerp(v(0, 1, 1), v(1, 1, 1), fx), fy);
    out[c] = lerp(a, bb, fz);
  }
  return out;
}
// Largest and average error (in 8-bit code values) of a display LUT against the exact log → display maths.
export function lutError(tex) {
  let max = 0, sum = 0, n = 0, s = 12345;
  const R = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Real-world colours: brightness from 5 stops under to 5 over a grey card, any hue, moderate saturation,
  // encoded to log as the camera would.
  for (let i = 0; i < 1500; i++) {
    const Y = 0.18 * Math.pow(2, -5 + R() * 10), sat = R() * 0.8;
    const [r, g, b] = linToLog(...[R(), R(), R()].map((c) => Y * (1 - sat + sat * 2 * c)));
    const e = logToDisplay(r, g, b), a = sampleLUT(tex, r, g, b);
    for (let c = 0; c < 3; c++) { const d = Math.abs(clamp(e[c], 0, 1) - a[c]) * 255; max = Math.max(max, d); sum += d; n++; }
  }
  return { max, mean: sum / n };
}

// ---------------------------------------------------------------- the grade shader
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
uniform sampler2D tSrc; uniform sampler3D tLut; uniform float uLutN; uniform sampler3D tLook; uniform float uLookN; uniform float uLookMix;
uniform float uCal, uCamExp, uClip, uExp; uniform vec3 uWB; uniform mat3 uToCam, uCamMat, uFromCam; uniform int uRec;
uniform float uBlend;
uniform vec3 uLift, uGamma, uGain; uniform float uCon, uPivot, uSat;
uniform int uQual; uniform vec4 uQ; uniform vec2 uQLum; uniform vec3 uQAdj; uniform int uShowMatte;
uniform int uWin; uniform vec2 uWinC, uWinR; uniform float uWinSoft, uWinIn, uWinOut, uAspect, uVig;
uniform float uTeal, uProtect, uGrain, uSeed; uniform int uZebra, uOut; uniform float uPeak;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 logc(vec3 x){ vec3 a = 0.24719 * log(5.555556 * x + 0.052272) / log(10.0) + 0.385537; vec3 b = 5.367655 * x + 0.092809; return mix(b, a, step(0.010591, x)); }
vec3 delogc(vec3 t){ vec3 a = (pow(vec3(10.0), (t - 0.385537) / 0.24719) - 0.052272) / 5.555556; vec3 b = (t - 0.092809) / 5.367655; return mix(b, a, step(0.149658, t)); }
vec3 oetf(vec3 x){ x = max(x, 0.0); return mix(4.5 * x, 1.099 * pow(x, vec3(0.45)) - 0.099, step(0.018, x)); }
vec3 ioetf(vec3 v){ return mix(v / 4.5, pow((v + 0.099) / 1.099, vec3(1.0 / 0.45)), step(0.081, v)); }
vec3 dec(vec3 v){ v = clamp(v, 0.0, 1.0); return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(0.04045, v)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
vec3 lut3(sampler3D t, float n, vec3 c){ c = clamp(c, 0.0, 1.0); return texture(t, c * (n - 1.0) / n + 0.5 / n).rgb; }
vec3 hsv(vec3 c){ vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g)); vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-6)), d / (q.x + 1e-6), q.x); }
float hueDist(float a, float b){ return abs(fract(a - b + 0.5) - 0.5); }
vec3 rotHue(vec3 c, float a){ float y = luma(c); float cb = (c.b - y) / 1.8556, cr = (c.r - y) / 1.5748; float cs = cos(a), sn = sin(a); float nb = cb * cs - cr * sn, nr = cb * sn + cr * cs; float r = y + 1.5748 * nr, b = y + 1.8556 * nb; return vec3(r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b); }
float qual(vec3 v, vec4 q, vec2 lum){ vec3 h = hsv(clamp(v, 0.0, 1.0)); float d = hueDist(h.x, q.x); float m = 1.0 - smoothstep(q.y, q.y + q.z, d); m *= smoothstep(q.w, q.w + 0.08, h.y); float l = luma(v); m *= smoothstep(lum.x - 0.06, lum.x, l) * (1.0 - smoothstep(lum.y, lum.y + 0.06, l)); return m; }
void main(){
  vec3 scene = texture2D(tSrc, vUv).rgb * uCal * exp2(uCamExp);
  // The camera: its own colour response, then either a log file or a finished Rec.709 file.
  vec3 cam = max(uCamMat * scene, 0.0);
  vec3 file, lin;
  if (uRec == 0) {
    file = logc(max(uToCam * min(cam, vec3(uClip)), 0.0));
    lin = delogc(file) * exp2(uExp) * uWB;                        // post: exposure and balance in linear light
  } else {
    file = oetf(clamp(cam, 0.0, 1.0));
    lin = ioetf(file) * exp2(uExp) * uWB;
  }
  vec3 v = uRec == 0 ? lut3(tLut, uLutN, logc(max(lin, 0.0))) : oetf(clamp(lin, 0.0, 1.0));
  // Primaries: lift, gamma, gain, then contrast round a pivot and saturation.
  v = v * (uGain - uLift) + uLift;
  v = sign(v) * pow(abs(v), 1.0 / uGamma);
  v = (v - uPivot) * uCon + uPivot;
  v = mix(vec3(luma(v)), v, uSat);
  // Secondaries: an HSL qualifier.
  if (uQual == 1) {
    float m = qual(v, uQ, uQLum);
    vec3 a = rotHue(v, uQAdj.x); a = mix(vec3(luma(a)), a, uQAdj.y) + uQAdj.z;
    vec3 keep = v;
    v = mix(v, a, m);
    if (uShowMatte == 1) v = mix(vec3(0.12 + luma(keep) * 0.18), v, m);
    if (uShowMatte == 2) { gl_FragColor = vec4(dec(vec3(m)), 1.0); return; }
  }
  // A global cool push, with the skin kept out of it.
  if (uTeal > 0.0) {
    float skin = qual(v, vec4(0.055, 0.04, 0.035, 0.12), vec2(0.12, 0.92));
    v += uTeal * vec3(-0.085, 0.02, 0.09) * (1.0 - uProtect * skin);
    v = mix(vec3(luma(v)), v, 1.0 - 0.25 * uTeal * (1.0 - uProtect * skin));
  }
  // The creative look (a 3D LUT).
  if (uLookMix > 0.0) v = mix(v, lut3(tLook, uLookN, v), uLookMix);
  // Power window and vignette: brightness changes shaped by a soft ellipse.
  vec2 d = (vUv - uWinC) * vec2(uAspect, 1.0) / uWinR;
  if (uWin == 1) { float m = 1.0 - smoothstep(1.0 - uWinSoft, 1.0 + uWinSoft, length(d)); v *= mix(exp2(uWinOut * 0.45), exp2(uWinIn * 0.45), m); }
  vec2 dv = (vUv - 0.5) * vec2(uAspect, 1.0);
  v *= 1.0 - uVig * smoothstep(0.3, 1.05, length(dv));
  v += (vec3(hash(vUv * 613.0), hash(vUv * 617.0 + 1.3), hash(vUv * 619.0 + 2.7)) - 0.5) * uGrain;
  // HDR and the nits map.
  if (uOut >= 1) {
    vec3 n = lin * (26.0 / 0.18);                                  // BT.2408: an 18% grey card sits at 26 nits
    float k = 0.6 * uPeak;
    n = mix(n, k + (uPeak - k) * (1.0 - exp(-(n - k) / (uPeak - k))), step(k, n));
    if (uOut == 1) v = oetf(n / uPeak);                              // HDR shrunk to fit an SDR screen
    if (uOut == 2 || uOut == 3) {
      float nits = uOut == 2 ? 100.0 * pow(clamp(luma(v), 0.0, 1.0), 2.4) : luma(n);
      float L = log(max(nits, 0.01)) / log(10.0);                   // −2 … 4
      vec3 c = vec3(0.05, 0.05, 0.2);
      c = mix(c, vec3(0.15, 0.35, 1.0), smoothstep(-1.0, 0.5, L));
      c = mix(c, vec3(0.2, 0.85, 0.4), smoothstep(0.7, 1.6, L));
      c = mix(c, vec3(1.0, 0.85, 0.2), smoothstep(1.7, 2.0, L));
      c = mix(c, vec3(1.0, 0.4, 0.15), smoothstep(2.3, 2.9, L));
      c = mix(c, vec3(1.0, 1.0, 1.0), smoothstep(3.0, 3.5, L));
      v = c;
    }
  }
  if (uZebra == 1) {
    float st = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
    if (max(v.r, max(v.g, v.b)) > 1.0) v = mix(vec3(1.0, 0.15, 0.15), vec3(1.0), st);
    else if (max(v.r, max(v.g, v.b)) < 0.004) v = mix(vec3(0.1, 0.3, 1.0), vec3(0.0), st);
  }
  v = mix(file, v, uBlend);
  gl_FragColor = vec4(dec(v), 1.0);
}`;

let identityLUT = null;
const identity3 = new THREE.Matrix3();

export class Grader {
  constructor(stage, { w = PW, h = PH } = {}) {
    this.stage = stage; this.w = w; this.h = h;
    this.rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtOut = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtOut.texture.colorSpace = THREE.SRGBColorSpace;
    identityLUT ||= bakeLUT(2, (r, g, b) => [r, g, b]);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: this.rtScene.texture }, tLut: { value: identityLUT }, uLutN: { value: 2 }, tLook: { value: identityLUT }, uLookN: { value: 2 }, uLookMix: { value: 0 },
        uCal: { value: 1 }, uCamExp: { value: 0 }, uClip: { value: SENSOR_CLIP }, uExp: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) },
        uToCam: { value: R709_TO_AWG }, uCamMat: { value: identity3 }, uRec: { value: 0 }, uBlend: { value: 1 },
        uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uCon: { value: 1 }, uPivot: { value: 0.42 }, uSat: { value: 1 },
        uQual: { value: 0 }, uQ: { value: new THREE.Vector4(0.58, 0.05, 0.04, 0.15) }, uQLum: { value: new THREE.Vector2(0, 1) }, uQAdj: { value: new THREE.Vector3(0, 1, 0) }, uShowMatte: { value: 0 },
        uWin: { value: 0 }, uWinC: { value: new THREE.Vector2(0.5, 0.5) }, uWinR: { value: new THREE.Vector2(0.3, 0.3) }, uWinSoft: { value: 0.3 }, uWinIn: { value: 0 }, uWinOut: { value: 0 }, uAspect: { value: w / h }, uVig: { value: 0 },
        uTeal: { value: 0 }, uProtect: { value: 0 }, uGrain: { value: 0 }, uSeed: { value: 0 }, uZebra: { value: 0 }, uOut: { value: 0 }, uPeak: { value: 1000 },
      },
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quadScene = new THREE.Scene(); this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this._c = new THREE.Color();
  }
  get texture() { return this.rtOut.texture; }
  // Film the set through `cam` into the scene-linear target.
  shoot(cam) {
    const r = this.stage.renderer, sc = this.stage.scene, prev = r.getRenderTarget(), ac = r.autoClear;
    const cc = r.getClearColor(this._c).clone(), ca = r.getClearAlpha(), env = sc.environment;
    sc.environment = null;
    r.setClearColor(0x000000, 1); r.autoClear = true;
    cam.layers.set(SET);
    r.setRenderTarget(this.rtScene); r.render(sc, cam);
    sc.environment = env; r.setClearColor(cc, ca); r.autoClear = ac; r.setRenderTarget(prev);
  }
  // p: grade settings (see set()), then render the graded picture.
  grade(p = {}) {
    this.set(p);
    const r = this.stage.renderer, prev = r.getRenderTarget(), ac = r.autoClear;
    r.autoClear = true; r.setRenderTarget(this.rtOut); r.render(this.quadScene, this.quadCam);
    r.autoClear = ac; r.setRenderTarget(prev);
  }
  set(p) {
    const u = this.mat.uniforms, V3 = (v, a) => v.set(a[0], a[1], a[2]);
    u.uSeed.value = (u.uSeed.value + 1.618) % 100;
    if (p.cal !== undefined) u.uCal.value = p.cal;
    u.uCamExp.value = p.camExp ?? 0;
    u.uCamMat.value = p.camMat || identity3;
    u.uRec.value = p.rec === '709' ? 1 : 0;
    u.uExp.value = p.exp ?? 0;
    V3(u.uWB.value, wbGains(p.temp ?? 0, p.tint ?? 0));
    if (p.lut) { u.tLut.value = p.lut; u.uLutN.value = p.lut.image.width; }
    u.uBlend.value = p.blend ?? 1;
    const w = wheelsToRGB(p);
    V3(u.uLift.value, w.lift); V3(u.uGamma.value, w.gamma); V3(u.uGain.value, w.gain);
    u.uCon.value = p.con ?? 1; u.uSat.value = p.sat ?? 1;
    const q = p.qual;
    u.uQual.value = q ? 1 : 0;
    if (q) { u.uQ.value.set(q.h, q.w, q.soft, q.smin); u.uQLum.value.set(q.lmin ?? 0, q.lmax ?? 1); u.uQAdj.value.set((q.hue ?? 0) * DEG, q.sat ?? 1, q.lum ?? 0); u.uShowMatte.value = q.show === 'only' ? 2 : q.show ? 1 : 0; }
    const wn = p.win;
    u.uWin.value = wn ? 1 : 0;
    if (wn) { u.uWinC.value.set(wn.cx, wn.cy); u.uWinR.value.set(wn.rx, wn.ry); u.uWinSoft.value = wn.soft ?? 0.3; u.uWinIn.value = wn.inside ?? 0; u.uWinOut.value = wn.outside ?? 0; }
    u.uVig.value = p.vig ?? 0;
    u.uTeal.value = p.teal ?? 0; u.uProtect.value = p.protect ? 1 : 0;
    u.uLookMix.value = p.look ? (p.lookMix ?? 1) : 0;
    if (p.look) { u.tLook.value = p.look; u.uLookN.value = p.look.image.width; }
    u.uGrain.value = p.grain ?? 0;
    u.uZebra.value = p.zebra ? 1 : 0;
    u.uOut.value = { sdr: 0, hdr: 1, nitsSdr: 2, nitsHdr: 3 }[p.out || 'sdr'];
    u.uPeak.value = p.peak ?? 1000;
  }
  // Read scene-linear light (as the camera sees it before recording) around pixel (x, y), y down.
  readLinear(x, y, n = 3) {
    const r = this.stage.renderer, buf = new Uint16Array(n * n * 4), f = THREE.DataUtils.fromHalfFloat;
    const px = clamp(Math.round(x - n / 2), 0, this.w - n), py = clamp(Math.round(this.h - y - n / 2), 0, this.h - n);
    try { r.readRenderTargetPixels(this.rtScene, px, py, n, n, buf); } catch { return null; }
    const o = [0, 0, 0];
    for (let i = 0; i < n * n; i++) for (let c = 0; c < 3; c++) o[c] += f(buf[i * 4 + c]) / (n * n);
    return o;
  }
  dispose() { this.rtScene.dispose(); this.rtOut.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}

// Wheels: each has a master (m) and a colour push (u = Cb, v = Cr, radius ≤ 1).
export function wheelsToRGB(p) {
  const L = p.lift || {}, G = p.gamma || {}, K = p.gain || {};
  const pl = pushRGB(L.u || 0, L.v || 0), pg = pushRGB(G.u || 0, G.v || 0), pk = pushRGB(K.u || 0, K.v || 0);
  return {
    lift: pl.map((o) => (L.m || 0) + 0.12 * o),
    gamma: pg.map((o) => Math.max(0.2, (G.m ?? 1) * (1 + 0.35 * o))),
    gain: pk.map((o) => (K.m ?? 1) * (1 + 0.35 * o)),
  };
}

// A two-picture compositor: A and B side by side (each its centre half), or just one.
const COMP_FRAG = /* glsl */`
varying vec2 vUv; uniform sampler2D tA, tB; uniform int uMode;
void main(){
  vec3 c;
  if (uMode == 0) c = texture2D(tA, vUv).rgb; else if (uMode == 1) c = texture2D(tB, vUv).rgb;
  else { bool left = vUv.x < 0.5; vec2 uv = vec2((left ? vUv.x : vUv.x - 0.5) + 0.25, vUv.y); c = left ? texture2D(tA, uv).rgb : texture2D(tB, uv).rgb; if (abs(vUv.x - 0.5) < 0.0022) c = vec3(1.0); }
  gl_FragColor = vec4(c, 1.0);
}`;
export class Compositor {
  constructor(stage, w = PW, h = PH) {
    this.stage = stage;
    this.rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.ShaderMaterial({ uniforms: { tA: { value: null }, tB: { value: null }, uMode: { value: 2 } }, vertexShader: VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false, toneMapped: false });
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false; this.scene.add(this.quad);
  }
  get texture() { return this.rt.texture; }
  run(a, b, mode) {
    const u = this.mat.uniforms; u.tA.value = a; u.tB.value = b; u.uMode.value = mode;
    const r = this.stage.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.rt); r.render(this.scene, this.cam); r.setRenderTarget(prev);
  }
  dispose() { this.rt.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}

// ---------------------------------------------------------------- scopes (real, from the graded pixels)
export const SW = 192, SH = 108;
const BLIT = 'varying vec2 vUv; uniform sampler2D t; void main(){ gl_FragColor = vec4(texture2D(t, vUv).rgb, 1.0); }';
export class Scopes {
  constructor(stage) {
    this.stage = stage;
    this.rt = new THREE.WebGLRenderTarget(SW, SH, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.buf = new Uint8Array(SW * SH * 4);
    this.mat = new THREE.ShaderMaterial({ uniforms: { t: { value: null } }, vertexShader: VERT, fragmentShader: BLIT, depthTest: false, depthWrite: false, toneMapped: false });
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false; this.scene.add(this.quad);
    this.cv = {}; ['wave', 'r', 'g', 'b'].forEach((k) => { const c = document.createElement('canvas'); c.width = SW; c.height = 100; this.cv[k] = c; });
    const v = document.createElement('canvas'); v.width = v.height = 128; this.cv.vec = v;
    this.stats = { hi: 0, lo: 0 };
    this.ok = false;
  }
  // Read a small copy of `tex` back to the CPU. Bytes are display values (0–255).
  read(tex) {
    const r = this.stage.renderer, prev = r.getRenderTarget();
    this.mat.uniforms.t.value = tex;
    r.setRenderTarget(this.rt); r.render(this.scene, this.cam); r.setRenderTarget(prev);
    try { r.readRenderTargetPixels(this.rt, 0, 0, SW, SH, this.buf); this.ok = true; } catch { this.ok = false; }
    if (this.ok) this.compute();
    return this.buf;
  }
  // Pixel at picture coords (u, v in 0–1, v down): [r, g, b] 0–1.
  px(u, v) {
    const x = clamp(Math.floor(u * SW), 0, SW - 1), y = clamp(Math.floor((1 - v) * SH), 0, SH - 1), i = (y * SW + x) * 4, b = this.buf;
    return [b[i] / 255, b[i + 1] / 255, b[i + 2] / 255];
  }
  // Average over a small box.
  avg(u, v, r = 2) {
    const o = [0, 0, 0]; let n = 0;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const p = this.px(u + i / SW, v + j / SH); o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; n++; }
    return o.map((x) => x / n);
  }
  compute() {
    const b = this.buf, N = SW * SH;
    const wave = new Float32Array(SW * 100), ch = [new Float32Array(SW * 100), new Float32Array(SW * 100), new Float32Array(SW * 100)], vec = new Float32Array(128 * 128);
    let hi = 0, lo = 0;
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4, r = b[i] / 255, g = b[i + 1] / 255, bl = b[i + 2] / 255;
      const Y = luma(r, g, bl);
      wave[Math.round((1 - Y) * 99) * SW + x]++;
      ch[0][Math.round((1 - r) * 99) * SW + x]++; ch[1][Math.round((1 - g) * 99) * SW + x]++; ch[2][Math.round((1 - bl) * 99) * SW + x]++;
      if (b[i] >= 254 || b[i + 1] >= 254 || b[i + 2] >= 254) hi++;
      if (b[i] <= 1 && b[i + 1] <= 1 && b[i + 2] <= 1) lo++;
      const cb = (bl - Y) / 1.8556, cr = (r - Y) / 1.5748;
      const vx = Math.round(64 + cb * 112), vy = Math.round(64 - cr * 112);
      if (vx >= 0 && vx < 128 && vy >= 0 && vy < 128) vec[vy * 128 + vx]++;
    }
    this.stats = { hi: hi / N, lo: lo / N };
    const paint = (cv, arr, w, h, col, gain) => {
      const g = cv.getContext('2d'), img = g.createImageData(w, h), d = img.data;
      for (let k = 0; k < w * h; k++) { const a = Math.min(1, arr[k] * gain); d[k * 4] = col[0]; d[k * 4 + 1] = col[1]; d[k * 4 + 2] = col[2]; d[k * 4 + 3] = Math.round(Math.pow(a, 0.6) * 255); }
      g.putImageData(img, 0, 0);
    };
    paint(this.cv.wave, wave, SW, 100, [150, 255, 170], 0.5);
    paint(this.cv.r, ch[0], SW, 100, [255, 90, 90], 0.5);
    paint(this.cv.g, ch[1], SW, 100, [90, 255, 120], 0.5);
    paint(this.cv.b, ch[2], SW, 100, [110, 150, 255], 0.5);
    paint(this.cv.vec, vec, 128, 128, [235, 245, 255], 0.25);
  }
  // Draw the chosen scopes side by side into a 2D context region.
  draw(g, x0, y0, w, h, which = ['wave', 'parade', 'vector']) {
    g.save();
    g.fillStyle = '#07090d'; g.fillRect(x0, y0, w, h);
    if (!this.ok || !which.length) { g.restore(); return; }
    const gap = 8, n = which.length, vecW = h - 30;
    const rest = which.includes('vector') ? w - vecW - gap * n : w - gap * (n - 1);
    const each = which.includes('vector') ? (n > 1 ? rest / (n - 1) : 0) : rest / n;
    let x = x0;
    g.font = '600 17px ui-monospace, monospace'; g.textBaseline = 'top';
    for (const k of which) {
      const sw = k === 'vector' ? vecW : each, top = y0 + 26, sh = h - 32;
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.fillText({ wave: 'WAVEFORM', parade: 'RGB PARADE', vector: 'VECTORSCOPE' }[k], x + 2, y0 + 5);
      if (k === 'vector') this._vector(g, x, top, sw, sh);
      else {
        g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1;
        for (const l of [0, 25, 50, 75, 100]) { const yy = top + sh * (1 - l / 100); g.beginPath(); g.moveTo(x, yy); g.lineTo(x + sw, yy); g.stroke(); }
        g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '13px ui-monospace, monospace'; g.fillText('100', x + sw - 26, top + 2); g.fillText('0', x + sw - 12, top + sh - 15); g.font = '600 17px ui-monospace, monospace';
        g.globalCompositeOperation = 'lighter';
        if (k === 'wave') g.drawImage(this.cv.wave, x, top, sw, sh);
        else { const t = (sw - 8) / 3; ['r', 'g', 'b'].forEach((c, i) => g.drawImage(this.cv[c], x + i * (t + 4), top, t, sh)); }
        g.globalCompositeOperation = 'source-over';
        // Clipping: a red bar along the top when many pixels sit at 100.
        if (this.stats.hi > 0.01) { g.fillStyle = '#ff4a4a'; g.fillRect(x, top - 2, sw, 3); }
        if (this.stats.lo > 0.01) { g.fillStyle = '#4a7bff'; g.fillRect(x, top + sh - 1, sw, 3); }
      }
      x += sw + gap;
    }
    g.restore();
  }
  _vector(g, x, y, w, h) {
    const s = Math.min(w, h), cx = x + w / 2, cy = y + h / 2, R = s / 2;
    g.strokeStyle = 'rgba(255,255,255,.2)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    // Skin-tone line at 123°.
    const a = SKIN_ANGLE * DEG;
    g.strokeStyle = 'rgba(255,190,140,.85)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); g.stroke();
    g.fillStyle = 'rgba(255,190,140,.95)'; g.font = '600 13px ui-monospace, monospace'; g.fillText('skin', cx + Math.cos(a) * R * 0.62 - 38, cy - Math.sin(a) * R * 0.62 - 6);
    // 75% colour-bar targets.
    [['R', [0.75, 0, 0]], ['Yl', [0.75, 0.75, 0]], ['G', [0, 0.75, 0]], ['Cy', [0, 0.75, 0.75]], ['B', [0, 0, 0.75]], ['Mg', [0.75, 0, 0.75]]].forEach(([n, c]) => {
      const [cb, cr] = toCbCr(...c), px = cx + cb * 112 * (R / 64), py = cy - cr * 112 * (R / 64);
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1.2; g.strokeRect(px - 5, py - 5, 10, 10);
      g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '12px ui-monospace, monospace'; g.fillText(n, px + 7, py - 7);
    });
    g.globalCompositeOperation = 'lighter';
    g.drawImage(this.cv.vec, cx - R, cy - R, 2 * R, 2 * R);
    g.globalCompositeOperation = 'source-over';
  }
  dispose() { this.rt.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
// Mean hue angle (degrees on the vectorscope) and saturation of a list of [r,g,b] samples.
export function vecAngle([r, g, b]) { const [cb, cr] = toCbCr(r, g, b); return { ang: ((Math.atan2(cr, cb) / DEG) + 360) % 360, sat: Math.hypot(cb, cr) }; }

// ---------------------------------------------------------------- the grading monitor (pinned to the view)
// A picture with a title bar, and an optional scope strip under it, bottom right of the stage
// (along the bottom on phones and in portrait reels).
export class Monitor {
  constructor(stage, tex, { title = 'GRADE', aspect = PW / PH, scopes = true, frac = 0.5 } = {}) {
    this.stage = stage; this.aspect = aspect; this.title = title; this.frac = frac; this.showScopes = scopes;
    this.hud = new THREE.Group();
    const mk = (o) => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...o });
    this.frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mk({ color: 0x0a0c11, opacity: 0.95 }));
    this.pic = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mk({ map: tex }));
    this.ov = document.createElement('canvas'); this.ov.width = 1024; this.ov.height = Math.round(1024 / aspect) + 44;
    this.ovTex = new THREE.CanvasTexture(this.ov); this.ovTex.colorSpace = THREE.SRGBColorSpace;
    this.over = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mk({ map: this.ovTex }));
    this.sc = document.createElement('canvas'); this.sc.width = 1024; this.sc.height = 300;
    this.scTex = new THREE.CanvasTexture(this.sc); this.scTex.colorSpace = THREE.SRGBColorSpace;
    this.scope = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mk({ map: this.scTex }));
    this.frame.renderOrder = 1000; this.pic.renderOrder = 1001; this.over.renderOrder = 1002; this.scope.renderOrder = 1001;
    [this.frame, this.pic, this.over, this.scope].forEach((m) => { m.frustumCulled = false; this.hud.add(m); });
    if (!stage.camera.parent) stage.scene.add(stage.camera);
    stage.camera.add(this.hud);
    this.P = new THREE.Vector3(); this._v = new THREE.Vector3(); this._t = 0;
  }
  setTexture(t) { this.pic.material.map = t; this.pic.material.needsUpdate = true; }
  draw(fn) {
    const g = this.ov.getContext('2d'), w = this.ov.width, bar = 44, h = this.ov.height - bar;
    g.clearRect(0, 0, w, this.ov.height);
    g.fillStyle = 'rgba(10,12,17,.96)'; g.fillRect(0, 0, w, bar);
    g.fillStyle = '#38bdf8'; g.beginPath(); g.arc(20, bar / 2, 7, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '600 22px ui-monospace, monospace'; g.textBaseline = 'middle';
    g.fillText(this.title, 36, bar / 2 + 1);
    g.save(); g.translate(0, bar); g.beginPath(); g.rect(0, 0, w, h); g.clip();
    fn?.(g, w, h);
    g.restore();
    this.ovTex.needsUpdate = true;
  }
  drawScopes(scopes, which) {
    if (!this.showScopes) return;
    const g = this.sc.getContext('2d');
    g.clearRect(0, 0, this.sc.width, this.sc.height);
    scopes.draw(g, 0, 0, this.sc.width, this.sc.height, which);
    this.scTex.needsUpdate = true;
  }
  place() {
    const s = this.stage, W = s.host.clientWidth, H = s.host.clientHeight;
    if (!W || !H) return;
    const reel = inReel(), narrow = W < 560;
    let pw;
    if (reel) pw = W < H ? W * 0.9 : W * 0.42;
    else if (narrow) pw = W - 24;
    else pw = Math.min(W * this.frac, 500);
    const ph = pw / this.aspect, bar = (pw * 44) / 1024, sh = this.showScopes ? (pw * 300) / 1024 : 0;
    const mr = reel ? (W < H ? W * 0.05 : W * 0.03) : narrow ? 12 : 16;
    const mb = reel ? H * 0.04 : narrow ? 12 : 58;
    const x1 = W - mr, x0 = x1 - pw, ys1 = H - mb, ys0 = ys1 - sh, y1 = ys0, y0 = y1 - ph;
    const cam = s.camera, D = 0.3;
    const at = (x, y) => { this.P.set((x / W) * 2 - 1, -((y / H) * 2 - 1), 0.5).applyMatrix4(cam.projectionMatrixInverse); return this.P.multiplyScalar(-D / this.P.z).clone(); };
    const a = at(x0, y0 - bar), b = at(x1, y1), c = at(x0, y0), e = at(x1, ys1);
    const pad = (b.x - a.x) * 0.008;
    this.pic.position.set((a.x + b.x) / 2, (c.y + b.y) / 2, -D); this.pic.scale.set(b.x - a.x, c.y - b.y, 1);
    this.over.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, -D + 1e-4); this.over.scale.set(b.x - a.x, a.y - b.y, 1);
    this.scope.visible = this.showScopes;
    if (this.showScopes) { this.scope.position.set((a.x + b.x) / 2, (b.y + e.y) / 2, -D); this.scope.scale.set(b.x - a.x, b.y - e.y, 1); }
    const bottom = this.showScopes ? e.y : b.y;
    this.frame.position.set((a.x + b.x) / 2, (a.y + bottom) / 2, -D - 1e-4); this.frame.scale.set(b.x - a.x + pad * 2, a.y - bottom + pad * 2, 1);
    this.px = { x0, y0: y0 - bar, x1, y1: this.showScopes ? ys1 : y1, W, H };
    const now = performance.now();
    if (now - this._t > 150) { this._t = now; this.hideLabels(); }
  }
  hideLabels() {
    const p = this.px; if (!p) return;
    const cam = this.stage.camera, all = p.W < 560;
    this.stage.root.traverse((o) => {
      if (!o.isCSS2DObject) return;
      if (all) { o.element.style.opacity = '0'; return; }
      o.getWorldPosition(this._v).project(cam);
      const x = ((this._v.x + 1) / 2) * p.W, y = ((1 - this._v.y) / 2) * p.H;
      const under = (x > p.x0 - 60 && x < p.x1 + 20 && y > p.y0 - 16 && y < p.y1 + 10) || this._v.z > 1;
      o.element.style.opacity = under ? '0' : '';
    });
  }
  dispose() {
    this.stage.camera.remove(this.hud);
    [this.frame, this.pic, this.over, this.scope].forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
    this.ovTex.dispose(); this.scTex.dispose();
  }
}

// Keep the 3D model clear of the monitor: shift the picture's centre left and up on wide stages,
// and up on phones and portrait reels, where the monitor runs along the bottom.
export function frameClear(stage, wide = [-0.2, 0.1], tall = [0, 0.24]) {
  const W = stage.host.clientWidth, H = stage.host.clientHeight;
  const t = W < 560 || (inReel() && W < H) ? tall : wide;
  const cur = stage.shift || [0, 0];
  if (cur[0] !== t[0] || cur[1] !== t[1]) stage.setShift(t[0], t[1]);
}

export function pill(g, text, x, y, { col = '#fff', bg = 'rgba(0,0,0,.62)', align = 'left', size = 22 } = {}) {
  g.font = `600 ${size}px ui-monospace, monospace`; g.textBaseline = 'middle';
  const tw = g.measureText(text).width, px = align === 'right' ? x - tw - 16 : align === 'center' ? x - tw / 2 - 8 : x;
  g.fillStyle = bg; g.fillRect(px, y - size * 0.75, tw + 16, size * 1.5);
  g.fillStyle = col; g.fillText(text, px + 8, y + 1);
}

// A canvas board floating in the 3D scene (always on layer 0 only).
export function board(parent, w, h, pxW, pxH, draw, pos, rotY = 0) {
  const c = document.createElement('canvas'); c.width = pxW; c.height = pxH;
  const g = c.getContext('2d'), tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const redraw = (...a) => { g.clearRect(0, 0, pxW, pxH); g.fillStyle = 'rgba(10,12,18,.92)'; g.fillRect(0, 0, pxW, pxH); draw(g, pxW, pxH, ...a); tex.needsUpdate = true; };
  redraw();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
  m.position.set(...pos); m.rotation.y = rotY; parent.add(m);
  return { tex, redraw, mesh: m };
}

// ---------------------------------------------------------------- set pieces
const srgb = (r, g, b) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
const mat = (hex, o = {}) => new THREE.MeshStandardMaterial({ color: typeof hex === 'number' ? hex : hex, roughness: 0.8, metalness: 0, ...o });
export function onLayers(obj, keep0 = true) { obj.traverse((o) => { o.layers.disableAll(); if (keep0) o.layers.enable(0); o.layers.enable(SET); }); return obj; }

// The 24-patch colour chart (published sRGB values), 6 × 4, on a black card. Patch 21 is mid grey.
export const CHART = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];
export const GREY = 21, WHITE_P = 18, RED_P = 14, SKIN_P = 1;
export function colourChart(size = 0.6) {
  const g = new THREE.Group(), p = size / 6.6;
  const card = box(size, p * 4.6, 0.02, mat(0x121212));
  g.add(card);
  g.patches = [];
  CHART.forEach((c, i) => {
    const col = i % 6, row = Math.floor(i / 6);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p * 0.86, p * 0.86), new THREE.MeshStandardMaterial({ color: srgb(...c), roughness: 0.95 }));
    m.position.set((col - 2.5) * p * 1.05, (1.5 - row) * p * 1.05, 0.0115);
    m.receiveShadow = true;
    g.add(m); g.patches.push(m);
  });
  return g;
}

// A stylised mannequin: capsules and spheres, jointed at the shoulders and hips. Facing +z, feet at 0.
export function mannequin({ skin = 0xa87458, shirt = 0xb83a3a, pants = 0x2a3346, hair = 0x1a1410, kurta = false } = {}) {
  const g = new THREE.Group();
  const cap = (r, len, m) => { const o = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), m); o.castShadow = o.receiveShadow = true; return o; };
  const mS = mat(shirt, { roughness: 0.85 }), mP = mat(pants), mK = mat(skin, { roughness: 0.6 }), mH = mat(hair, { roughness: 0.9 });
  const torso = cap(0.17, kurta ? 0.5 : 0.36, mS); torso.scale.set(1, 1, 0.7); torso.position.y = kurta ? 1.2 : 1.24; g.add(torso);
  const head = sphere(0.115, mK, 24); head.scale.set(0.92, 1.08, 0.98); head.position.y = 1.62; g.add(head);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.122, 20, 10, 0, TAU, 0, Math.PI * 0.55), mH); hairCap.position.y = 1.635; hairCap.rotation.x = -0.25; hairCap.castShadow = true; g.add(hairCap);
  const neck = cap(0.05, 0.06, mK); neck.position.y = 1.49; g.add(neck);
  const limb = (x, y, r, len, m, m2) => {
    const j = new THREE.Group(); j.position.set(x, y, 0); g.add(j);
    const up = cap(r, len * 0.5, m); up.position.y = -len * 0.3; j.add(up);
    const lo = cap(r * 0.85, len * 0.5, m2); lo.position.y = -len * 0.78; j.add(lo);
    return j;
  };
  const armL = limb(-0.22, 1.43, 0.055, 0.62, mS, mK), armR = limb(0.22, 1.43, 0.055, 0.62, mS, mK);
  const legL = limb(-0.09, 0.93, 0.075, 0.86, mP, mP), legR = limb(0.09, 0.93, 0.075, 0.86, mP, mP);
  [armL, armR].forEach((a, i) => { a.rotation.z = i ? 0.12 : -0.12; });
  g.head = head;
  g.walk = (ph, amp = 0.45) => {
    legL.rotation.x = Math.sin(ph) * amp; legR.rotation.x = -Math.sin(ph) * amp;
    armL.rotation.x = -Math.sin(ph) * amp * 0.8; armR.rotation.x = Math.sin(ph) * amp * 0.8;
    torso.position.y = (kurta ? 1.2 : 1.24) + Math.abs(Math.cos(ph)) * 0.02;
  };
  return g;
}

// A head-and-shoulders bust with simple eyes and nose, for close-ups.
export function bust({ skin = 0xa87458, shirt = 0x3a5a8a, hair = 0x16110d, long = false } = {}) {
  const g = new THREE.Group();
  const mK = mat(skin, { roughness: 0.55 }), mS = mat(shirt, { roughness: 0.85 }), mH = mat(hair, { roughness: 0.9 });
  const head = sphere(0.115, mK, 32); head.scale.set(0.9, 1.1, 1); head.position.y = 0.36; g.add(head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 12), mK); nose.rotation.x = Math.PI / 2 + 0.3; nose.position.set(0, 0.35, 0.115); g.add(nose);
  [-0.04, 0.04].forEach((x) => { const e = sphere(0.012, mat(0x120d0b), 10); e.position.set(x, 0.385, 0.1); g.add(e); });
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.125, 24, 12, 0, TAU, 0, Math.PI * 0.55), mH); hairCap.position.y = 0.375; hairCap.rotation.x = -0.3; hairCap.castShadow = true; g.add(hairCap);
  if (long) { const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.18, 6, 14), mH); back.position.set(0, 0.26, -0.05); back.scale.set(1.05, 1, 0.6); g.add(back); }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 16), mK); neck.position.y = 0.22; g.add(neck);
  const sh = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.28, 6, 16), mS); sh.rotation.z = Math.PI / 2; sh.scale.set(1, 1, 0.6); sh.position.y = 0.1; g.add(sh);
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.3, 20), mS); chest.scale.z = 0.6; chest.position.y = -0.08; g.add(chest);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.head = head;
  return g;
}

// The sky: a big dome with a gradient and a sun disc, in scene-linear light (bright enough to clip).
function skyDome() {
  const m = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new THREE.Vector3(0, 0.5, -1).normalize() }, uZen: { value: new THREE.Color(0.25, 0.42, 0.95) }, uHor: { value: new THREE.Color(1.1, 1.2, 1.35) }, uGround: { value: new THREE.Color(0.1, 0.09, 0.08) }, uSunI: { value: 400 }, uGlow: { value: new THREE.Color(1, 0.9, 0.7) }, uGlowI: { value: 1.5 }, uSize: { value: 0.9995 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 uSun, uZen, uHor, uGround, uGlow; uniform float uSunI, uGlowI, uSize;
      void main(){ vec3 d = normalize(vDir); float e = d.y;
        vec3 c = e > 0.0 ? mix(uHor, uZen, pow(clamp(e, 0.0, 1.0), 0.55)) : mix(uHor * 0.6, uGround, clamp(-e * 8.0, 0.0, 1.0));
        float k = max(dot(d, uSun), 0.0);
        c += uGlow * uGlowI * (pow(k, 8.0) * 0.6 + pow(k, 60.0) * 2.5);
        c += uGlow * uSunI * smoothstep(uSize - 0.0004, uSize, k);
        gl_FragColor = vec4(c, 1.0); }`,
    side: THREE.BackSide, depthWrite: false,
  });
  const s = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), m);
  s.frustumCulled = false; s.renderOrder = -10;
  s.layers.set(SET);
  return s;
}

function sunLight(col, I, box = 12) {
  const l = new THREE.DirectionalLight(col, I);
  l.castShadow = true; l.shadow.mapSize.set(1024, 1024);
  Object.assign(l.shadow.camera, { left: -box, right: box, top: box, bottom: -box, near: 0.5, far: 80 });
  l.shadow.bias = -0.0005; l.shadow.normalBias = 0.02;
  return l;
}

// Three sets. Each: { group, cam (the shot camera), light(preset), pose(t), chart, poi }.
// Light is in physical units of three.js: a Lambert surface of albedo a facing a directional light of
// intensity I reflects a·I/π, so I ≈ 3 gives a white card ≈ 1 and a grey card ≈ 0.18.
export function makeSet(kind, { keep0 = true } = {}) {
  const g = new THREE.Group();
  const sky = skyDome(); g.add(sky);
  const hemi = new THREE.HemisphereLight(0x9fbfff, 0x4a4036, 1);
  const sun = sunLight(0xffffff, 3);
  g.add(hemi, sun, sun.target);
  const set = { group: g, sky, sun, hemi, kind, poi: {}, people: [] };
  const U = sky.material.uniforms;
  const lightFrom = (az, el) => { const v = new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)); return v; };
  const setSun = (az, el, col, I) => { const d = lightFrom(az, el); sun.position.copy(d).multiplyScalar(30); sun.target.position.set(0, 0, 0); sun.color.copy(col); sun.intensity = I; U.uSun.value.copy(d); };
  set.cam = new THREE.PerspectiveCamera(36, PW / PH, 0.1, 200);

  if (kind === 'street') {
    // Asphalt road, a raised pavement, a row of painted shopfronts, a tree, a car and people.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), mat(0x3b3b3d, { roughness: 0.95 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; g.add(ground);
    const pave = box(40, 0.15, 3.2, mat(0x8a857c)); pave.position.set(0, 0.075, -3.6); g.add(pave);
    const kerb = box(40, 0.16, 0.2, mat(0xb9b3a6)); kerb.position.set(0, 0.08, -1.95); g.add(kerb);
    for (let i = -6; i <= 6; i++) { const d = box(1.2, 0.01, 0.14, mat(0xe8e4d8)); d.position.set(i * 3, 0.006, 0.8); g.add(d); }
    const walls = [0xd9a441, 0x2f8f93, 0xd88a9a, 0xece6d8, 0xc0603a, 0x6f9f5a, 0xe0c060];
    let x = -16;
    walls.forEach((c, i) => {
      const w = 4 + (i % 3) * 0.8, h = 4.6 + ((i * 37) % 4);
      const b = box(w, h, 3, mat(c, { roughness: 0.9 })); b.position.set(x + w / 2, h / 2, -6.7); g.add(b);
      for (let fy = 1; fy < h / 2.6; fy++) for (let fx = 0; fx < Math.floor(w / 1.4); fx++) {
        const win = box(0.8, 1.1, 0.06, mat(0x1b2530, { roughness: 0.2, metalness: 0.3 })); win.position.set(x + 0.9 + fx * 1.4, fy * 2.6 + 0.7, -5.18); g.add(win);
      }
      const shop = box(w - 0.6, 2.2, 0.06, mat(0x2a2522)); shop.position.set(x + w / 2, 1.25, -5.18); g.add(shop);
      const awn = box(w - 0.4, 0.08, 1.1, mat([0xc23b2b, 0x2b6cb0, 0xe8a33a, 0x3a8a4a][i % 4])); awn.position.set(x + w / 2, 2.55, -4.6); awn.rotation.x = 0.2; g.add(awn);
      x += w + 0.1;
    });
    // Tree.
    const trunk = beam([-6.5, 0, -3.2], [-6.5, 3.2, -3.2], 0.16, mat(0x5a3f2a)); g.add(trunk);
    [[-6.5, 4.0, -3.2, 1.5], [-5.6, 3.6, -3.0, 1.1], [-7.3, 3.5, -3.4, 1.1]].forEach(([a, b, c, r]) => g.add(at(sphere(r, mat(0x3f7a35, { roughness: 0.95 }), 20), a, b, c)));
    // Car.
    const car = new THREE.Group(); car.position.set(4.2, 0, -0.6); g.add(car);
    car.add(at(box(3.8, 0.7, 1.7, mat(0x2a58a8, { roughness: 0.35, metalness: 0.4 })), 0, 0.65, 0));
    car.add(at(box(2.0, 0.6, 1.5, mat(0x223344, { roughness: 0.15, metalness: 0.5 })), -0.2, 1.25, 0));
    [[-1.2, 0.8], [1.2, 0.8], [-1.2, -0.8], [1.2, -0.8]].forEach(([a, b]) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 20), mat(0x151515)); w.rotation.x = Math.PI / 2; w.position.set(a, 0.34, b); w.castShadow = true; car.add(w); });
    // People on the pavement, and one who walks across the road (tracked in chapter 4).
    const people = [
      [mannequin({ skin: 0x8d5a3c, shirt: 0xc0392b }), -2.4, -3.3, 0.3],
      [mannequin({ skin: 0xd6a283, shirt: 0x2f5fa8, hair: 0x5a3b22 }), -0.6, -3.6, -0.2],
      [mannequin({ skin: 0x6b4430, shirt: 0xf2eee4, kurta: true }), 1.3, -3.2, 0.1],
    ];
    people.forEach(([m, px, pz, ry]) => { m.position.set(px, 0.15, pz); m.rotation.y = ry; g.add(m); set.people.push(m); });
    const walker = mannequin({ skin: 0xa8704f, shirt: 0x8e3fb0, pants: 0x3a3a4a }); walker.rotation.y = Math.PI / 2; g.add(walker); set.walker = walker;
    // The chart on a stand.
    const chart = colourChart(0.7); const stand = beam([0, 0, 0], [0, 1.0, 0], 0.02, mat(0x222222));
    const cg = new THREE.Group(); cg.add(stand); chart.position.y = 1.15; chart.rotation.x = -0.12; cg.add(chart); cg.position.set(-1.9, 0, 5.4); cg.rotation.y = 0.12; g.add(cg);
    set.chart = chart; set.chartStand = cg;
    set.cam.position.set(0, 1.6, 10); set.cam.lookAt(0, 3.3, -3);
    set.presets = {
      noon: () => { setSun(35, 52, new THREE.Color(1, 0.97, 0.92), 3.1); hemi.color.setRGB(0.5, 0.65, 1.0); hemi.groundColor.setRGB(0.32, 0.29, 0.25); hemi.intensity = 1.0; U.uZen.value.setRGB(0.55, 0.95, 2.1); U.uHor.value.setRGB(2.4, 2.6, 2.9); U.uGlow.value.setRGB(1, 0.95, 0.85); U.uGlowI.value = 2.0; },
      late: () => { setSun(-60, 16, new THREE.Color(1, 0.72, 0.45), 2.1); hemi.color.setRGB(0.45, 0.52, 0.8); hemi.groundColor.setRGB(0.3, 0.24, 0.18); hemi.intensity = 0.7; U.uZen.value.setRGB(0.5, 0.72, 1.5); U.uHor.value.setRGB(3.0, 2.2, 1.6); U.uGlow.value.setRGB(1, 0.7, 0.4); U.uGlowI.value = 3.0; },
    };
    set.presets.noon();
    set.pose = (t) => {
      const T = 9, k = (t % T) / T, xw = -5 + 10 * k;
      walker.position.set(xw, 0, 0.4); walker.walk(t * 7.5);
      set.people.forEach((m, i) => m.walk(0.4 * Math.sin(t * 0.8 + i), 0.06));
    };
    set.poi = { sky: [-2, 19, -30] };
  } else if (kind === 'faces') {
    // Three people in a room, a bright window behind and a warm practical lamp.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), mat(0x5a4636, { roughness: 0.8 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);
    const wall = box(10, 4, 0.2, mat(0xb9ab94)); wall.position.set(0, 2, -2.6); g.add(wall);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 5.0, 5.8) })); win.position.set(1.9, 2.0, -2.48); g.add(win);
    const frame = box(1.6, 0.08, 0.1, mat(0xe8e2d6)); frame.position.set(1.9, 2.0, -2.45); g.add(frame);
    const frame2 = box(0.08, 1.7, 0.1, mat(0xe8e2d6)); frame2.position.set(1.9, 2.0, -2.45); g.add(frame2);
    const lampBase = beam([-2.2, 0, -2.0], [-2.2, 1.5, -2.0], 0.025, mat(0x222222)); g.add(lampBase);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 0.35, 24, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.0, 0.9), side: THREE.DoubleSide })); shade.position.set(-2.2, 1.65, -2.0); g.add(shade);
    const plant = sphere(0.35, mat(0x3f6e32), 16); plant.position.set(-1.6, 0.45, -2.2); g.add(plant);
    const table = box(2.8, 0.06, 0.8, mat(0x6b4a33)); table.position.set(0, 0.75, 0.55); g.add(table);
    const people = [
      [bust({ skin: 0xe0b196, shirt: 0x3a6fa8, hair: 0x6a4424, long: true }), -0.75],
      [bust({ skin: 0xa36b4b, shirt: 0xc8553d, hair: 0x120c09 }), 0],
      [bust({ skin: 0x5e3b2a, shirt: 0x3d8a5a, hair: 0x0e0a08, long: true }), 0.75],
    ];
    people.forEach(([b, px]) => { b.position.set(px, 1.05, 0); g.add(b); set.people.push(b); });
    const chart = colourChart(0.36); chart.position.set(1.12, 0.93, 0.62); chart.rotation.x = -0.5; g.add(chart); set.chart = chart;
    set.cam.fov = 30; set.cam.position.set(0, 1.45, 3.4); set.cam.lookAt(0, 1.22, 0);
    set.presets = {
      day: () => { setSun(-40, 30, new THREE.Color(1, 0.95, 0.88), 2.6); hemi.color.setRGB(0.6, 0.62, 0.7); hemi.groundColor.setRGB(0.35, 0.28, 0.22); hemi.intensity = 0.8; },
    };
    set.presets.day();
    set.pose = (t) => { set.people.forEach((b, i) => { b.rotation.y = 0.12 * Math.sin(t * 0.5 + i * 2); b.head.rotation.x = 0.05 * Math.sin(t * 0.7 + i); }); };
  } else {
    // A seaside promenade at sunset: the sun low and straight ahead, people turned towards it.
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), mat(0xa88b68, { roughness: 1 })); sand.rotation.x = -Math.PI / 2; sand.position.z = 10; sand.receiveShadow = true; g.add(sand);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(240, 120), mat(0x1d3a52, { roughness: 0.25, metalness: 0.2 })); sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.02, -70); g.add(sea);
    const prom = box(30, 0.3, 2.2, mat(0x7c756c)); prom.position.set(0, 0.15, 1); g.add(prom);
    const rail = box(30, 0.05, 0.05, mat(0x2a2a2a)); rail.position.set(0, 1.05, -0.05); g.add(rail);
    for (let i = -7; i <= 7; i++) g.add(beam([i * 2, 0.3, -0.05], [i * 2, 1.05, -0.05], 0.025, mat(0x2a2a2a)));
    const post = beam([3.5, 0.3, 0.3], [3.5, 4.2, 0.3], 0.06, mat(0x2a2a2a)); g.add(post);
    const lampHead = box(0.5, 0.12, 0.25, mat(0x2a2a2a)); lampHead.position.set(3.3, 4.2, 0.3); g.add(lampHead);
    const people = [
      [mannequin({ skin: 0x9a6246, shirt: 0xd8d0c0 }), -1.1, 0.7, Math.PI + 0.3],
      [mannequin({ skin: 0x7a4c34, shirt: 0xb8324a, hair: 0x100b08 }), -0.45, 0.8, Math.PI - 0.2],
      [mannequin({ skin: 0xc79272, shirt: 0x3a5f9a }), 1.4, 1.2, Math.PI * 0.6],
    ];
    people.forEach(([m, px, pz, ry]) => { m.position.set(px, 0.3, pz); m.rotation.y = ry; g.add(m); set.people.push(m); });
    set.people[2].scale.setScalar(0.72);
    const chart = colourChart(0.5); chart.position.set(-3.2, 1.1, 2.4); chart.rotation.y = 0.2; chart.rotation.x = -0.2; g.add(chart); set.chart = chart;
    set.cam.position.set(0.4, 1.5, 7.5); set.cam.lookAt(0, 1.9, -4);
    set.presets = {
      sunset: () => { setSun(172, 5, new THREE.Color(1, 0.55, 0.25), 2.4); hemi.color.setRGB(0.35, 0.42, 0.7); hemi.groundColor.setRGB(0.3, 0.2, 0.14); hemi.intensity = 0.65; U.uZen.value.setRGB(0.18, 0.2, 0.48); U.uHor.value.setRGB(3.2, 1.5, 0.7); U.uGlow.value.setRGB(1, 0.5, 0.18); U.uGlowI.value = 9; U.uSunI.value = 900; U.uSize.value = 0.99985; },
    };
    set.presets.sunset();
    set.pose = (t) => { set.people.forEach((m, i) => m.walk(0.5 * Math.sin(t * 0.6 + i * 2), 0.05)); };
  }
  set.cam.updateMatrixWorld(true);
  onLayers(g, keep0);
  sky.layers.set(SET);
  set.light = (name) => set.presets[name]?.();
  // Where a world point lands in the shot (u, v in 0–1, v down), or null.
  const _v = new THREE.Vector3();
  set.project = (obj, off = [0, 0, 0]) => {
    if (obj.isObject3D) obj.getWorldPosition(_v); else _v.set(...obj);
    _v.add(new THREE.Vector3(...off));
    const p = _v.project(set.cam);
    if (p.z > 1) return null;
    return [(p.x + 1) / 2, (1 - p.y) / 2];
  };
  set.patchUV = (i) => set.project(set.chart.patches[i]);
  set.bias = kind === 'sunset' ? -1.6 : kind === 'faces' ? -0.2 : 0;
  return set;
}

// Expose like a DIT with a grey card: find the scale that puts the chart's mid grey at 0.18 (plus the
// set's deliberate bias: a sunset is exposed darker so the sky keeps its colour).
export function autoCal(gr, set) {
  set.group.updateMatrixWorld(true);
  const uv = set.patchUV(GREY); if (!uv) return 1;
  const v = gr.readLinear(uv[0] * gr.w, uv[1] * gr.h, 3); if (!v) return 1;
  const y = luma(...v);
  return y > 1e-5 ? (0.18 / y) * Math.pow(2, set.bias) : 1;
}

// A small cinema camera on a tripod (for the 3D view). Looks down −z.
export function cameraRig(h = 1.5) {
  const g = new THREE.Group(), dark = M.matte(0x22252b), metal = M.metal(0x3b3f47, { roughness: 0.5 });
  for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU + 0.3; g.add(beam([0, h - 0.12, 0], [Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5], 0.02, metal)); }
  const head = box(0.16, 0.1, 0.16, dark); head.position.y = h - 0.05; g.add(head);
  const body = box(0.2, 0.2, 0.34, M.matte(0x2b2f38)); body.position.y = h + 0.1; g.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.2, 24), M.matte(0x111111)); lens.rotation.x = Math.PI / 2; lens.position.set(0, h + 0.1, -0.27); g.add(lens);
  const top = box(0.06, 0.06, 0.24, M.matte(0x3a3f4a)); top.position.y = h + 0.23; g.add(top);
  const tally = sphere(0.014, M.glow(0xff2a2a)); tally.position.set(0.06, h + 0.18, -0.16); g.add(tally);
  return g;
}

// A lattice of coloured points inside an RGB cube: shows what a LUT does to every colour at once.
export class Lattice {
  constructor(n = 9, size = 2) {
    this.n = n; this.size = size;
    this.group = new THREE.Group();
    const N = n * n * n;
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(size * 0.022, 8, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), N);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size)), new THREE.LineBasicMaterial({ color: 0x8a93a8, transparent: true, opacity: 0.5 }));
    edges.position.setScalar(size / 2); this.group.add(edges);
    const diag = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(size, size, size)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.group.add(diag);
    this.o = new THREE.Object3D(); this.c = new THREE.Color();
  }
  // fn(r, g, b) → [r, g, b]: where each lattice colour goes. Position = output colour; tint = output colour.
  set(fn) {
    const n = this.n, S = this.size; let i = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const o = fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => clamp(v, 0, 1));
      this.o.position.set(o[0] * S, o[2] * S, o[1] * S * -1 + S); // x = red, y = blue, z = green (towards the viewer is less green)
      this.o.updateMatrix(); this.mesh.setMatrixAt(i, this.o.matrix);
      this.c.setRGB(o[0], o[1], o[2], THREE.SRGBColorSpace); this.mesh.setColorAt(i, this.c);
      i++;
    }
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
  }
}

export const fmt = {
  pct: (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%',
  ev: (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' stops',
  sgn: (v, d = 2) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d),
  ire: (v) => Math.round(v * 100),
};
export const compact = (stage, html, n = 2) => (stage.host.clientWidth < 560 ? html.split('<div class="row">').slice(0, n + 1).join('<div class="row">').replace(/<p [^>]*>.*?<\/p>/s, '') : html);

export { THREE, M, box, sphere, beam, clamp, lerp, approach };

// ---------------------------------------------------------------- the colour wheels (a grading panel)
// A colour-wheel picture: each point shows the colour you push towards by dragging the puck there
// (angle = hue on the vectorscope, distance = strength), so the wheel and the vectorscope agree.
export function wheelCanvas(S = 256, k = 0.42) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1, v = 1 - (y + 0.5) / S * 2, r = Math.hypot(u, v), i = (y * S + x) * 4;
    if (r > 1) { d[i + 3] = 0; continue; }
    const p = pushRGB(u, v);
    const col = p.map((o) => clamp(0.5 + o * k, 0, 1));
    d[i] = Math.round(Math.pow(col[0], 1 / 2.2) * 255); d[i + 1] = Math.round(Math.pow(col[1], 1 / 2.2) * 255); d[i + 2] = Math.round(Math.pow(col[2], 1 / 2.2) * 255); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(S / 2, S * 0.1); g.lineTo(S / 2, S * 0.9); g.moveTo(S * 0.1, S / 2); g.lineTo(S * 0.9, S / 2); g.stroke();
  return c;
}

export function wheelPanel() {
  const g = new THREE.Group();
  const base = box(2.5, 0.14, 1.0, M.matte(0x1b1e24)); g.add(base);
  const tex = new THREE.CanvasTexture(wheelCanvas()); tex.colorSpace = THREE.SRGBColorSpace;
  const R = 0.3;
  g.wheels = ['lift', 'gamma', 'gain'].map((name, i) => {
    const w = new THREE.Group(); w.position.set((i - 1) * 0.8, 0.09, 0.02); w.rotation.x = -Math.PI / 2 + 0.55; g.add(w);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    w.add(disc);
    const ring = new THREE.Group(); w.add(ring);
    const tor = new THREE.Mesh(new THREE.TorusGeometry(R + 0.045, 0.035, 12, 64), M.metal(0x6a707c, { roughness: 0.35 })); ring.add(tor);
    const notch = box(0.03, 0.06, 0.05, M.glow(0xffffff)); notch.position.set(0, R + 0.045, 0.02); ring.add(notch);
    const puck = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 10), M.glow(0xffffff)); puck.position.z = 0.02; w.add(puck);
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.038, 0.05, 24), M.glow(0x111111)); halo.position.z = 0.021; puck.add(halo);
    return { name, group: w, disc, ring, puck, R };
  });
  // Place the pucks and turn the rings: u, v in −1…1; master turns the ring (0 = centre).
  g.set = (vals) => g.wheels.forEach((w) => {
    const v = vals[w.name];
    w.puck.position.set(v.u * w.R, v.v * w.R, 0.02);
    w.ring.rotation.z = -v.turn;
  });
  return g;
}

// Drag a wheel's puck with the pointer (orbiting pauses while you drag).
export function dragWheels(stage, panel, onMove) {
  const el = stage.renderer.domElement, ray = new THREE.Raycaster(), v2 = new THREE.Vector2(), discs = panel.wheels.map((w) => w.disc);
  let active = null;
  const hit = (e, list) => {
    const b = el.getBoundingClientRect();
    v2.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(v2, stage.camera);
    return ray.intersectObjects(list, false)[0];
  };
  const move = (e, w) => {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(w.group.getWorldQuaternion(new THREE.Quaternion())), w.group.getWorldPosition(new THREE.Vector3()));
    const b = el.getBoundingClientRect();
    v2.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(v2, stage.camera);
    const p = ray.ray.intersectPlane(plane, new THREE.Vector3()); if (!p) return;
    w.group.worldToLocal(p);
    let u = p.x / w.R, v = p.y / w.R; const r = Math.hypot(u, v); if (r > 1) { u /= r; v /= r; }
    onMove(w.name, u, v);
  };
  const down = (e) => {
    const h = hit(e, discs); if (!h) return;
    active = panel.wheels.find((w) => w.disc === h.object);
    stage.controls.enabled = false; el.setPointerCapture?.(e.pointerId);
    move(e, active);
  };
  const mv = (e) => { if (active) move(e, active); else if (!e.buttons) el.style.cursor = hit(e, discs) ? 'grab' : ''; };
  const up = () => { if (active) { active = null; stage.controls.enabled = true; } };
  el.addEventListener('pointerdown', down, true); el.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  return () => { el.removeEventListener('pointerdown', down, true); el.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); stage.controls.enabled = true; el.style.cursor = ''; };
}
