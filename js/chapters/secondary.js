// Chapter 4: secondaries. Change only part of the picture.
//  - An HSL qualifier (a key on hue, saturation and brightness) picks the sky, the walker's purple shirt or
//    skin, and changes only that. "Show matte" greys out everything not selected, like a highlight view.
//  - A power window (a soft ellipse) brightens the walker and darkens the rest. With tracking on, the
//    window follows his head, projected through the shot camera every frame; with tracking off, it stays put.
//  - A global cool push, with skin protection: a second qualifier on skin hue keeps faces out of it.
// Coverage and hues in the readout are measured from read-back pixels (the matte is rendered on its own).
import { makeSet, Grader, Scopes, Monitor, cameraRig, bakeLUT, logToDisplay, autoCal, frameClear, vecAngle, pill, fmt, compact, SKIN_ANGLE, SW, SH, TAU } from '../grade.js';

export const QUALS = {
  sky: { label: 'Sky', h: 0.585, w: 0.075, soft: 0.05, smin: 0.06, lmin: 0.5, lmax: 1.0 },
  shirt: { label: 'Purple shirt', h: 0.79, w: 0.05, soft: 0.04, smin: 0.2, lmin: 0.04, lmax: 0.95 },
  skin: { label: 'Skin', h: 0.055, w: 0.04, soft: 0.035, smin: 0.12, lmin: 0.1, lmax: 0.92 },
};
const WIN = { rx: 0.09, ry: 0.2, soft: 0.35, inside: 0.8, outside: -1.0 };
const FIXED = [0.5, 0.56];

export default {
  id: 'secondary',
  short: 'Secondaries',
  title: 'Qualifiers, power windows and skin',
  subtitle: 'Change only the sky, only a shirt, only one face, and keep skin looking like skin.',
  view: { pos: [-8, 8.5, 30], target: [-3, 2.4, 1] },
  learn: `<p>Primaries change the whole picture. <b>Secondaries</b> change only part of it. There are two main tools.</p>
    <p>A <b>qualifier</b> picks pixels by their colour: a range of <b>hue</b>, <b>saturation</b> and <b>brightness</b> (HSL). Choose the blue of the sky and only the sky turns deeper; choose the purple of a shirt and you can make it red for a continuity fix. Colourists check the selection as a <b>matte</b>, a black-and-white mask, to make sure nothing else sneaks in.</p>
    <p>A <b>power window</b> is a shape, like a soft circle, drawn on the picture. Brighten inside it to lead the eye to a face, darken outside it to make a <b>vignette</b>. People move, so windows are <b>tracked</b>: the software follows a point from frame to frame and moves the window with it. VFX artists track in the same way (see <b>VFXClear</b>).</p>
    <p>Every strong look must protect <b>skin</b>. Push a whole shot towards blue-green and faces go grey and ill. So colourists key the skin tones and hold them out of the push. The eye forgives a strange sky, but never a strange face.</p>
    <p class="tip"><b>Try it:</b> pick Shirt and spin the hue, with Show matte on to see the selection. Turn on the window and switch tracking off: the walker leaves his light behind. Then push the cool look all the way and toggle Protect skin.</p>`,
  terms: [
    { t: 'Secondary correction', d: 'A change applied to only part of the picture.' },
    { t: 'Qualifier (HSL key)', d: 'A selection made from a range of hue, saturation and brightness.' },
    { t: 'Matte', d: 'A black-and-white mask showing what is selected.' },
    { t: 'Power window', d: 'A soft shape drawn on the picture that limits where a correction applies.' },
    { t: 'Tracking', d: 'Following a point through the frames so a window moves with the subject.' },
    { t: 'Vignette', d: 'Darkening towards the edges of the frame to pull the eye to the middle.' },
    { t: 'Skin protection', d: 'Keeping skin tones out of a strong colour change so faces stay natural.' },
  ],
  defaults: { target: 'sky', qHue: -14, qSat: 1.6, show: false, win: 'off', track: true, teal: 0, protect: true },
  controls: [
    { key: 'target', type: 'seg', label: 'Qualifier picks', options: Object.entries(QUALS).map(([v, q]) => ({ v, label: q.label })) },
    { key: 'qHue', type: 'range', label: 'Hue of the selection', min: -180, max: 180, step: 1, ends: ['−180°', '+180°'], fmt: (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)) + '°' },
    { key: 'qSat', type: 'range', label: 'Saturation of the selection', min: 0, max: 2, step: 0.01, ends: ['grey', 'vivid'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'show', type: 'toggle', label: 'Show matte (grey out the rest)' },
    { key: 'win', type: 'seg', label: 'Power window', options: [{ v: 'off', label: 'Off' }, { v: 'window', label: 'On the walker' }, { v: 'vig', label: 'Vignette' }] },
    { key: 'track', type: 'toggle', label: 'Track the window' },
    { key: 'teal', type: 'range', label: 'Cool push on the whole shot', min: 0, max: 1, step: 0.01, ends: ['none', 'strong'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'protect', type: 'toggle', label: 'Protect skin from the push' },
  ],
  quiz: [
    { q: 'A qualifier selects pixels by…', options: ['Their position in the frame', 'Their hue, saturation and brightness', 'How far away they are', 'Which camera shot them'], answer: 1, why: 'An HSL qualifier keys a range of colour and brightness, wherever it is in the frame.' },
    { q: 'An actor walks across the frame. How does the window brightening his face stay on him?', options: ['It is redrawn by hand every frame', 'It is tracked: software follows a point and moves the window', 'It is made very big', 'It cannot'], answer: 1, why: 'A tracker follows features frame by frame and moves the window with them.' },
    { q: 'Why protect skin when pushing a shot towards blue-green?', options: ['Skin cannot be changed', 'Faces turned grey or green look ill, and viewers notice at once', 'It saves render time', 'Blue-green is illegal'], answer: 1, why: 'We are very sensitive to skin colour. Holding faces out keeps them natural inside a strong look.' },
  ],
  reel: [
    { ms: 5000, caption: 'A qualifier selects one colour, like a purple shirt, and changes only that.', set: { target: 'shirt', qSat: 1.2, show: false, win: 'off', teal: 0 }, anim: { qHue: [0, 150] }, spin: 0.2 },
    { ms: 5000, caption: 'A tracked power window follows the walker and lights his way; the rest of the street falls darker.', set: { target: 'sky', qHue: -14, qSat: 1.6, win: 'window', track: true, teal: 0.35, protect: true }, anim: {}, spin: 0.2 },
  ],

  build({ stage }) {
    stage.setWorldMode(true);
    const set = makeSet('street'); stage.root.add(set.group);
    const rig = cameraRig(1.5); rig.position.set(0, 0, 10); stage.root.add(rig);
    const gr = new Grader(stage), scopes = new Scopes(stage);
    const mon = new Monitor(stage, gr.texture, { title: 'SECONDARIES' });
    const lut = bakeLUT(33, logToDisplay);
    stage.label('Walker', [0, 2.1, 0], set.walker, 'hot');
    stage.label('Camera', [0, 2.1, 10]);

    let cal = null, cover = 0, tMeas = -1, head = null, winC = FIXED.slice(), skin = null;
    return {
      update(dt, s, time) {
        dt = Math.max(0, dt);
        set.pose(time);
        gr.shoot(set.cam);
        if (cal === null) cal = autoCal(gr, set);
        set.group.updateMatrixWorld(true);
        head = set.project(set.walker.head, [0, -0.2, 0]);
        if (s.track && head) winC = head.slice(); else if (!s.track) winC = FIXED.slice();
        const q = { ...QUALS[s.target], hue: s.qHue, sat: s.qSat, lum: 0, show: s.show };
        const P = { cal, lut, qual: q, teal: s.teal, protect: s.protect,
          win: s.win === 'window' ? { cx: winC[0], cy: 1 - winC[1], ...WIN } : null, vig: s.win === 'vig' ? 0.55 : s.win === 'window' ? 0.2 : 0 };
        if (time - tMeas > 0.3 || time < tMeas) {
          tMeas = time;
          gr.grade({ ...P, qual: { ...q, show: 'only' } }); scopes.read(gr.texture);
          let sum = 0; for (let i = 0; i < SW * SH; i++) sum += scopes.buf[i * 4]; cover = sum / (SW * SH * 255);
          gr.grade(P); scopes.read(gr.texture);
          const faces = [set.walker, ...set.people].map((m) => set.project(m.head, [0, -0.01, 0.1])).filter(Boolean).map((uv) => vecAngle(scopes.avg(uv[0], uv[1], 0)));
          skin = faces.length ? faces.reduce((a, f) => a + f.ang, 0) / faces.length : null;
        } else { gr.grade(P); scopes.read(gr.texture); }
        mon.drawScopes(scopes, ['wave', 'vector']);
        mon.title = `SECONDARIES · qualifier: ${QUALS[s.target].label.toLowerCase()}${s.win === 'window' ? ' · window' : ''}`;
        mon.draw((g, w, h) => {
          if (s.win === 'window') {
            g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2.5; g.setLineDash([10, 7]);
            g.beginPath(); g.ellipse(winC[0] * w, winC[1] * h, WIN.rx * h, WIN.ry * h, 0, 0, TAU); g.stroke(); g.setLineDash([]);
            g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(winC[0] * w, winC[1] * h, WIN.rx * h * (1 + WIN.soft), WIN.ry * h * (1 + WIN.soft), 0, 0, TAU); g.stroke();
            if (s.track && head) { g.strokeStyle = '#ffb547'; g.lineWidth = 3; const x = head[0] * w, y = head[1] * h; g.strokeRect(x - 14, y - 14, 28, 28); g.beginPath(); g.moveTo(x - 22, y); g.lineTo(x + 22, y); g.moveTo(x, y - 22); g.lineTo(x, y + 22); g.stroke(); }
          }
          if (s.show) pill(g, `matte: ${fmt.pct(cover)} of the frame`, 12, h - 26, { size: 20 });
        });
        frameClear(stage);
        mon.place();
      },
      readout: (s) => {
        const err = head ? Math.hypot((winC[0] - head[0]) * 1920, (winC[1] - head[1]) * 1080) : 0;
        return compact(stage, `<div class="big">${QUALS[s.target].label} selected</div>
          <div class="row"><span>Selection covers</span><b>${fmt.pct(cover)} of the frame</b></div>
          <div class="row"><span>Hue shift · saturation</span><b>${Math.round(s.qHue)}° · ${Math.round(s.qSat * 100)}%</b></div>
          ${s.win === 'window' ? `<div class="row"><span>Window off the walker</span><b class="${err > 60 ? 'no' : 'ok'}">${Math.round(err)} px (in 1920 × 1080)</b></div>` : ''}
          ${skin !== null ? `<div class="row"><span>Faces, average hue</span><b class="${Math.abs(skin - SKIN_ANGLE) < 15 ? 'ok' : 'no'}">${Math.round(skin)}° (skin line ${SKIN_ANGLE}°)</b></div>` : ''}`, 3);
      },
      dispose() { gr.dispose(); scopes.dispose(); mon.dispose(); lut.dispose(); stage.setWorldMode(false); stage.setShift(0, 0); },
    };
  },
};
