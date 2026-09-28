// Chapter 2: primary correction. Three people at a table, filmed in log and put through the display LUT,
// then graded with lift, gamma and gain (as three draggable colour wheels on a panel), exposure, white
// balance, contrast and saturation. Live scopes are computed from the graded pixels every frame.
//
// Maths (the same families of controls as DaVinci Resolve's primaries or the ASC CDL):
//  - lift/gain: out = in × (gain − lift) + lift, per channel; gamma: out = out^(1/gamma).
//  - contrast pivots round 0.42 (about where a grey card sits); saturation mixes with BT.709 luma.
//  - exposure and white balance act on linear light before the LUT, as channel gains (see grade.js).
//  - skin angles are measured on each face from the read-back pixels, as Cb/Cr angles; the skin line is
//    at about 123° on a standard vectorscope.
import { THREE } from '../kit.js';
import { makeSet, Grader, Scopes, Monitor, cameraRig, wheelPanel, dragWheels, bakeLUT, logToDisplay, autoCal, frameClear, vecAngle, pill, fmt, compact, GREY, SKIN_ANGLE, beam, box, M } from '../grade.js';

const WHEELS = ['lift', 'gamma', 'gain'];
const wheelVals = (s) => ({
  lift: { u: s.liftU, v: s.liftV, turn: s.lift * 8 },
  gamma: { u: s.gammaU, v: s.gammaV, turn: Math.log2(s.gamma) * 2.2 },
  gain: { u: s.gainU, v: s.gainV, turn: Math.log2(s.gain) * 2.2 },
});
const RESET = { liftU: 0, liftV: 0, gammaU: 0, gammaV: 0, gainU: 0, gainV: 0 };

export default {
  id: 'primary',
  short: 'Primary correction',
  title: 'Lift, gamma, gain and the scopes',
  subtitle: 'Three wheels for the shadows, the middle and the highlights, checked on real scopes.',
  view: { pos: [-2.2, 3.4, 8.4], target: [-0.4, 1.0, 1.6] },
  learn: `<p>The first job in any grade is the <b>primary correction</b>: make the shot look natural and balanced. Colourists do it with three <b>colour wheels</b>, one for each part of the picture.</p>
    <p><b>Lift</b> moves the blacks and shadows. <b>Gamma</b> moves the middle tones, where faces usually sit. <b>Gain</b> moves the highlights. Turning a wheel's ring makes that part brighter or darker. Dragging its centre towards a colour tints that part: warm shadows, cool highlights, or a green cast taken out of the middle. Next to them sit <b>exposure</b>, <b>white balance</b> (temperature and tint), <b>contrast</b> and <b>saturation</b>.</p>
    <p>Screens and eyes lie, so colourists trust the <b>scopes</b>. The <b>waveform</b> plots brightness from 0 at the bottom to 100 at the top, for every column of the picture. The <b>RGB parade</b> shows red, green and blue side by side: a neutral grey has all three at the same height. The <b>vectorscope</b> is a colour wheel: distance from the centre is saturation, angle is hue. Every human skin tone, light or dark, lands close to one line, the <b>skin-tone line</b>. Push anything past 100 and it <b>clips</b>; push below 0 and the shadows are <b>crushed</b>. Colour temperature on set is explained in <b>LightingClear</b>, and how the eye sees colour in <b>EyeClear</b>.</p>
    <p class="tip"><b>Try it:</b> drag the centre of a wheel on the panel. Push gain up until the waveform hits the red line and the window starts to clip; turn on zebras to see where. Then look at the vectorscope: three quite different skin tones, one line.</p>`,
  terms: [
    { t: 'Primary correction', d: 'Adjustments that change the whole picture at once: balance, exposure, contrast, saturation.' },
    { t: 'Lift, gamma, gain', d: 'Controls for the shadows, the mid-tones and the highlights.' },
    { t: 'Waveform', d: 'A scope that plots the brightness of every column of the picture, 0 to 100.' },
    { t: 'RGB parade', d: 'Three waveforms side by side, one each for red, green and blue.' },
    { t: 'Vectorscope', d: 'A round scope showing hue as angle and saturation as distance from the centre.' },
    { t: 'Skin-tone line', d: 'The line on a vectorscope, about 123°, near which healthy skin of every shade falls.' },
    { t: 'Crushed blacks', d: 'Shadows pushed to 0, where all their detail becomes one flat black.' },
  ],
  defaults: { exp: 0, temp: 0, tint: 0, con: 1, sat: 1, lift: 0, gamma: 1, gain: 1, ...RESET, zebra: false, scope: 'all' },
  controls: [
    { key: 'scope', type: 'seg', label: 'Scopes', options: [{ v: 'all', label: 'All' }, { v: 'wave', label: 'Waveform' }, { v: 'parade', label: 'Parade' }, { v: 'vector', label: 'Vector' }] },
    { key: 'lift', type: 'range', label: 'Lift (shadows)', min: -0.12, max: 0.12, step: 0.005, ends: ['darker', 'lighter'], fmt: (v) => fmt.sgn(v) },
    { key: 'gamma', type: 'range', label: 'Gamma (mid-tones)', min: 0.6, max: 1.6, step: 0.01, ends: ['darker', 'lighter'], fmt: (v) => v.toFixed(2) },
    { key: 'gain', type: 'range', label: 'Gain (highlights)', min: 0.6, max: 1.6, step: 0.01, ends: ['darker', 'lighter'], fmt: (v) => v.toFixed(2) + '×' },
    { key: 'exp', type: 'range', label: 'Exposure', min: -2, max: 2, step: 0.05, ends: ['−2 stops', '+2'], fmt: (v) => fmt.ev(v) },
    { key: 'temp', type: 'range', label: 'Temperature', min: -1.5, max: 1.5, step: 0.02, ends: ['cooler', 'warmer'], fmt: (v) => fmt.sgn(v) },
    { key: 'tint', type: 'range', label: 'Tint', min: -1, max: 1, step: 0.02, ends: ['green', 'magenta'], fmt: (v) => fmt.sgn(v) },
    { key: 'con', type: 'range', label: 'Contrast', min: 0.5, max: 1.8, step: 0.01, ends: ['flat', 'punchy'], fmt: (v) => v.toFixed(2) },
    { key: 'sat', type: 'range', label: 'Saturation', min: 0, max: 2, step: 0.01, ends: ['grey', 'vivid'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'zebra', type: 'toggle', label: 'Zebras: stripe what clips', hint: 'Red stripes: over 100. Blue stripes: crushed to 0.' },
    { key: 'wheels', type: 'buttons', label: 'Colour wheels (or drag them on the panel)', items: [
      { label: 'Warm shadows', act: (s) => { s.liftU = -0.45; s.liftV = 0.35; } },
      { label: 'Cool highlights', act: (s) => { s.gainU = 0.35; s.gainV = -0.3; } },
      { label: 'Green cast', act: (s) => { s.gammaU = -0.25; s.gammaV = -0.45; } },
      { label: 'Reset', act: (s) => Object.assign(s, RESET, { lift: 0, gamma: 1, gain: 1, exp: 0, temp: 0, tint: 0, con: 1, sat: 1 }) },
    ] },
  ],
  quiz: [
    { q: 'You want brighter faces without changing the blacks or the brightest whites. Which wheel?', options: ['Lift', 'Gamma', 'Gain', 'Saturation'], answer: 1, why: 'Gamma bends the middle of the curve, where faces usually sit, and leaves the two ends in place.' },
    { q: 'On a waveform, a flat line squashed against the top means…', options: ['Perfect exposure', 'Clipped highlights', 'Too much saturation', 'Crushed shadows'], answer: 1, why: 'Everything that reached 100 has become the same value, so its detail is gone.' },
    { q: 'Why do colourists watch the skin-tone line on the vectorscope?', options: ['Only pale skin falls on it', 'Skin of every shade sits near the same hue, so it shows if faces have drifted', 'It measures brightness', 'It shows the focus'], answer: 1, why: 'Skin tones differ mostly in brightness, not hue. If faces drift off the line, they look ill or sunburnt.' },
  ],
  reel: [
    { ms: 5000, caption: 'Lift moves the blacks, gamma the middle, gain the whites: the waveform follows every turn.', set: { ...RESET, scope: 'wave', lift: 0, gamma: 1, exp: 0, zebra: false }, anim: { gain: [0.8, 1.55] }, spin: 0.2 },
    { ms: 5000, caption: 'Three very different skin tones, one line on the vectorscope: the skin-tone line.', set: { ...RESET, scope: 'vector', gain: 1, sat: 1 }, anim: { sat: [0.4, 1.6] }, spin: 0.2 },
  ],

  build({ stage, s }) {
    stage.setWorldMode(true);
    const set = makeSet('faces'); stage.root.add(set.group);
    const rig = cameraRig(1.35); rig.position.set(set.cam.position.x, 0, set.cam.position.z); rig.rotation.y = 0; stage.root.add(rig);
    const gr = new Grader(stage), scopes = new Scopes(stage);
    const mon = new Monitor(stage, gr.texture, { title: 'PRIMARIES' });
    const lut = bakeLUT(33, logToDisplay);
    // The grading panel on a desk in front of the set.
    const desk = new THREE.Group(); desk.position.set(-1.35, 0, 5.2); desk.rotation.y = 0.25; stage.root.add(desk);
    const top = box(2.8, 0.06, 1.2, M.matte(0x3a2c22)); top.position.y = 0.82; desk.add(top);
    [[-1.3, -0.5], [1.3, -0.5], [-1.3, 0.5], [1.3, 0.5]].forEach(([x, z]) => desk.add(beam([x, 0, z], [x, 0.8, z], 0.03, M.matte(0x222222))));
    const panel = wheelPanel(); panel.position.y = 0.92; desk.add(panel);
    const lbls = panel.wheels.map((w, i) => stage.label(['Lift', 'Gamma', 'Gain'][i], [(i - 1) * 0.8, 0.5, -0.25], panel));
    stage.label('Drag a wheel', [0, 0.1, 0.6], panel, 'hot');
    stage.label('Camera', [set.cam.position.x, 2.1, set.cam.position.z]);
    const undrag = dragWheels(stage, panel, (name, u, v) => { s[name + 'U'] = u; s[name + 'V'] = v; });

    let cal = null, faces = [], tMeas = -1, grey = [0, 0, 0];
    return {
      update(dt, s, time) {
        dt = Math.max(0, dt);
        set.pose(time);
        gr.shoot(set.cam);
        if (cal === null) cal = autoCal(gr, set);
        const P = { cal, lut, exp: s.exp, temp: s.temp, tint: s.tint, con: s.con, sat: s.sat, zebra: s.zebra,
          lift: { m: s.lift, u: s.liftU, v: s.liftV }, gamma: { m: s.gamma, u: s.gammaU, v: s.gammaV }, gain: { m: s.gain, u: s.gainU, v: s.gainV } };
        // Scopes read the picture without zebra stripes.
        if (s.zebra) { gr.grade({ ...P, zebra: false }); scopes.read(gr.texture); gr.grade(P); } else { gr.grade(P); scopes.read(gr.texture); }
        mon.drawScopes(scopes, s.scope === 'all' ? ['wave', 'parade', 'vector'] : [s.scope]);
        if (time - tMeas > 0.3 || time < tMeas) {
          tMeas = time;
          faces = set.people.map((b) => { const uv = set.project(b.head, [0, -0.02, 0.1]); return uv ? vecAngle(scopes.avg(uv[0], uv[1], 1)) : null; });
          const g = set.patchUV(GREY); if (g) grey = scopes.avg(g[0], g[1], 1);
        }
        panel.set(wheelVals(s));
        lbls.forEach((l, i) => { const w = WHEELS[i]; l.element.textContent = `${['Lift', 'Gamma', 'Gain'][i]} ${w === 'lift' ? fmt.sgn(s.lift) : s[w].toFixed(2)}`; });
        mon.draw((g, w, h) => {
          if (scopes.stats.hi > 0.01) pill(g, `clipped ${fmt.pct(scopes.stats.hi)}`, 12, h - 26, { col: '#ff9a9a', size: 20 });
          if (scopes.stats.lo > 0.01) pill(g, `crushed ${fmt.pct(scopes.stats.lo)}`, w - 12, h - 26, { col: '#9ab8ff', size: 20, align: 'right' });
        });
        frameClear(stage);
        mon.place();
      },
      readout: () => {
        const f = faces.map((a, i) => (a ? `<div class="row"><span>Face ${i + 1} hue</span><b class="${Math.abs(a.ang - SKIN_ANGLE) < 12 ? 'ok' : 'no'}">${Math.round(a.ang)}° (${a.ang - SKIN_ANGLE >= 0 ? '+' : '−'}${Math.abs(Math.round(a.ang - SKIN_ANGLE))}° off the line)</b></div>` : '')).join('');
        const spread = Math.max(...grey) - Math.min(...grey);
        return compact(stage, `<div class="big">${scopes.stats.hi > 0.01 ? 'Highlights clipping' : scopes.stats.lo > 0.01 ? 'Shadows crushed' : 'Nothing clipped'}</div>
          <div class="row"><span>Grey card R · G · B</span><b class="${spread > 0.04 ? 'no' : 'ok'}">${grey.map(fmt.ire).join(' · ')}</b></div>
          <div class="row"><span>Pixels over 100 / at 0</span><b>${fmt.pct(scopes.stats.hi)} / ${fmt.pct(scopes.stats.lo)}</b></div>${f}`, 2);
      },
      dispose() { undrag(); gr.dispose(); scopes.dispose(); mon.dispose(); lut.dispose(); stage.setWorldMode(false); stage.setShift(0, 0); },
    };
  },
};
