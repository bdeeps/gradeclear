// Chapter 1: log to display. A camera films a sunny street. It records either a flat LOG file (LogC3-style,
// wide gamut) or a finished Rec.709 picture that clips. A real 3D LUT, baked on the CPU from the log maths,
// turns the log file into a display picture on the GPU. A slider blends the flat file and the graded picture.
//
// Numbers:
//  - Log keeps 7.8 stops above 18% grey (ARRI, ALEXA at EI 800; LogC3 curve from ARRI's white paper).
//    A Rec.709 video curve (ITU-R BT.709 OETF) reaches 100% at linear 1.0, only log2(1/0.18) = 2.5 stops up.
//  - "Codes per stop" on the board are computed from the two curves for a 10-bit file (1,024 code values).
//  - The LUT error is measured live: 1,500 random log colours looked up with trilinear interpolation, as
//    the GPU does, compared with the exact maths.
import { THREE } from '../kit.js';
import { makeSet, Grader, Scopes, Monitor, Lattice, cameraRig, board, bakeLUT, lutError, logToDisplay, logc, oetf709, autoCal, frameClear, pill, fmt, compact, luma, SENSOR_CLIP } from '../grade.js';

const codes = (curve, s) => Math.max(0, 1023 * (curve(0.18 * Math.pow(2, s + 0.5)) - curve(0.18 * Math.pow(2, s - 0.5))));
const LOGCURVE = (x) => logc(Math.min(x, SENSOR_CLIP));
const V709 = (x) => oetf709(Math.min(x, 1));
export const STOPS_LOG = Math.log2(SENSOR_CLIP / 0.18), STOPS_709 = Math.log2(1 / 0.18);

export default {
  id: 'log',
  short: 'Log to display',
  title: 'Flat log footage and the LUT',
  subtitle: 'Why cinema cameras record a grey, washed-out picture, and how a LUT brings it to life.',
  view: { pos: [-7, 10, 35], target: [-3.5, 3, 0] },
  learn: `<p>Straight out of a cinema camera, footage looks <b>flat</b>: grey blacks, dull colours, no punch. That is on purpose. The camera records in <b>log</b>, a curve that gives every stop of light (every doubling of brightness) about the same number of code values. A sunny street has a sky many times brighter than a face in shade, and log keeps both.</p>
    <p>A normal video picture, <b>Rec.709</b>, is made for screens. It spends its codes where our eyes look, and runs out just <b>2.5 stops</b> above a grey card. Anything brighter, like the sky, is <b>clipped</b> to flat white forever. A log file from a cinema camera keeps about <b>7.8 stops</b> above grey. That extra room is why cameras shoot log (see <b>CineCameraClear</b> for dynamic range).</p>
    <p>To watch log you need a <b>LUT</b>, a lookup table. A <b>1D LUT</b> is a list: for each input level, an output level, one curve per channel. A <b>3D LUT</b> is a cube of colours: for a grid of input colours (say 33 × 33 × 33) it stores the output colour, and the graphics card blends between the nearest points. A 3D LUT can do things a 1D one cannot, like changing saturation or turning the camera's wide colours into screen colours. The cube of dots on the stage is that LUT, moving every colour to its new place.</p>
    <p class="tip"><b>Try it:</b> slide from flat log to graded and watch the cube stretch. Pull exposure down two stops: the log sky comes back with its blue. Now switch the camera to Rec.709 and try again: the white sky only turns grey. Then drop the LUT to 2 points and see what a coarse table gets wrong.</p>`,
  terms: [
    { t: 'Log', d: 'A recording curve that gives every stop of light a similar share of code values, so it keeps very bright and very dark detail.' },
    { t: 'Rec.709', d: 'The international standard for HD video colour and brightness, the normal target for TV and the web.' },
    { t: 'Stop', d: 'A doubling (or halving) of light.' },
    { t: 'Clipping', d: 'When brightness goes past the top of the scale, every pixel there becomes the same flat white.' },
    { t: 'LUT', d: 'Lookup table: a stored list (1D) or cube (3D) of input colours and the output colours they should become.' },
    { t: 'Dynamic range', d: 'How many stops, from the darkest detail to the brightest, a camera can record.' },
  ],
  defaults: { blend: 1, rec: 'log', exp: 0, lutN: 33, scopes: true },
  controls: [
    { key: 'blend', type: 'range', label: 'Flat log ↔ graded', min: 0, max: 1, step: 0.01, ends: ['log file', 'Rec.709 picture'], fmt: (v) => Math.round(v * 100) + '% graded' },
    { key: 'rec', type: 'seg', label: 'Camera records', options: [{ v: 'log', label: 'Log' }, { v: '709', label: 'Rec.709' }], fmt: (v) => (v === 'log' ? `${STOPS_LOG.toFixed(1)} stops over grey` : `${STOPS_709.toFixed(1)} stops over grey`) },
    { key: 'exp', type: 'range', label: 'Exposure in the grade', min: -3, max: 2, step: 0.05, ends: ['−3 stops', '+2'], fmt: (v) => fmt.ev(v) },
    { key: 'lutN', type: 'seg', label: 'LUT size (points per side)', options: [{ v: 2, label: '2' }, { v: 5, label: '5' }, { v: 17, label: '17' }, { v: 33, label: '33' }], fmt: (v) => `${v}³ = ${(v * v * v).toLocaleString('en')} colours` },
    { key: 'scopes', type: 'toggle', label: 'Show the waveform' },
  ],
  quiz: [
    { q: 'Why does log footage look flat and grey?', options: ['The camera is broken', 'It squeezes a huge range of light into the file, ready to be graded', 'It is black and white', 'It has no colour information'], answer: 1, why: 'Log spreads every stop evenly through the file. It is meant to be converted, not watched as it is.' },
    { q: 'A sky is clipped in a Rec.709 file. What happens when you lower exposure in the grade?', options: ['The blue comes back', 'It turns flat grey', 'It turns black', 'Nothing changes at all'], answer: 1, why: 'Clipped pixels all hold the same value. Darkening them just makes a uniform grey patch: the detail was never recorded.' },
    { q: 'What does a 3D LUT store?', options: ['One curve for brightness', 'A cube of input colours and the output colour for each', 'The camera settings', 'A list of shots'], answer: 1, why: 'Each point in the cube is an input colour with its output colour. The GPU blends between the nearest points.' },
  ],
  reel: [
    { ms: 5200, caption: 'Cinema cameras record log: a flat, grey picture that keeps every stop of light.', set: { rec: 'log', exp: 0, lutN: 33, scopes: true }, anim: { blend: [0, 0.02] }, spin: 0.25 },
    { ms: 5200, caption: 'A 3D LUT moves every colour to its place, and the flat file becomes a Rec.709 picture.', set: { rec: 'log', exp: 0, lutN: 33 }, anim: { blend: [0, 1] }, spin: 0.3 },
  ],

  build({ stage }) {
    stage.setWorldMode(true);
    const set = makeSet('street'); stage.root.add(set.group);
    const rig = cameraRig(1.6 - 0.1); rig.position.copy(set.cam.position).setY(0); rig.lookAt(0, 0, -3); rig.rotateY(Math.PI); stage.root.add(rig);
    const gr = new Grader(stage), scopes = new Scopes(stage);
    const mon = new Monitor(stage, gr.texture, { title: 'GRADE' });
    const lat = new Lattice(9, 4.2); lat.group.position.set(-13.5, 0.4, 14); lat.group.rotation.y = 0.35; stage.root.add(lat.group);
    const latLbl = stage.label('The 3D LUT: every colour moved', [-11.2, 5.4, 15.5]);
    stage.label('Camera', [0, 2.1, set.cam.position.z]);
    stage.label('Colour chart', [-1.9, 1.75, 5.4]);

    // Codes per stop: a 10-bit log file vs a 10-bit Rec.709 file.
    const chart = board(stage.root, 10, 4.86, 840, 408, (g, w, h) => {
      g.font = '600 30px sans-serif'; g.fillStyle = '#eef0f6'; g.fillText('Code values per stop (10-bit file)', 22, 44);
      g.font = '20px sans-serif'; g.fillStyle = '#a8aebf'; g.fillText('stops below and above a grey card', 22, 74);
      const x0 = 50, x1 = w - 24, y0 = h - 46, y1 = 100, S = [-6, 8], n = S[1] - S[0] + 1, bw = (x1 - x0) / n;
      const Y = (c) => y0 - (c / 170) * (y0 - y1);
      for (let s = S[0]; s <= S[1]; s++) {
        const x = x0 + (s - S[0]) * bw, a = codes(LOGCURVE, s), b = codes(V709, s);
        g.fillStyle = '#38bdf8'; g.fillRect(x + 3, Y(a), bw / 2 - 4, y0 - Y(a));
        g.fillStyle = '#ffb547'; g.fillRect(x + bw / 2, Y(Math.min(b, 170)), bw / 2 - 4, y0 - Y(Math.min(b, 170)));
        g.fillStyle = s === 0 ? '#fff' : '#737a8e'; g.font = '17px sans-serif'; g.fillText(s === 0 ? 'grey' : (s > 0 ? '+' : '') + s, x + 4, y0 + 24);
      }
      const xc = x0 + (2.5 - S[0] + 0.5) * bw;
      g.strokeStyle = '#ff6b6b'; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(xc, y1 - 10); g.lineTo(xc, y0); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#ff6b6b'; g.font = '600 17px sans-serif'; g.fillText('Rec.709 clips', xc + 6, y1 + 6);
      g.fillStyle = '#38bdf8'; g.fillRect(w - 250, 30, 16, 16); g.fillStyle = '#eef0f6'; g.font = '19px sans-serif'; g.fillText('log', w - 226, 45);
      g.fillStyle = '#ffb547'; g.fillRect(w - 160, 30, 16, 16); g.fillStyle = '#eef0f6'; g.fillText('Rec.709', w - 136, 45);
    }, [6.5, 12.5, -7], -0.15);
    void chart;

    let lut = null, lutNow = 0, err = null, cal = null, meas = { sky: 0 }, tMeas = -1, latKey = '';
    return {
      update(dt, s, time) {
        dt = Math.max(0, dt);
        if (lutNow !== s.lutN) { lut = bakeLUT(s.lutN, logToDisplay, lut); lutNow = s.lutN; err = lutError(lut); }
        set.pose(time);
        gr.shoot(set.cam);
        if (cal === null) cal = autoCal(gr, set);
        gr.grade({ cal, rec: s.rec, exp: s.exp, lut, blend: s.blend });
        mon.showScopes = s.scopes;
        if (s.scopes) { scopes.read(gr.texture); mon.drawScopes(scopes, ['wave']); }
        if (time - tMeas > 0.4 || time < tMeas) {
          tMeas = time;
          const uv = set.project(set.poi.sky);
          const v = uv && gr.readLinear(uv[0] * gr.w, uv[1] * gr.h, 3);
          if (v) meas.sky = Math.log2(Math.max(1e-4, luma(...v) * cal) / 0.18);
        }
        const key = s.blend.toFixed(2) + s.lutN;
        if (key !== latKey) { latKey = key; lat.set((r, g, b) => { const o = lut ? logToDisplay(r, g, b) : [r, g, b]; return [r + (o[0] - r) * s.blend, g + (o[1] - g) * s.blend, b + (o[2] - b) * s.blend]; }); }
        lat.group.rotation.y = 0.35 + Math.sin(time * 0.3) * 0.15;
        frameClear(stage);
        mon.title = s.blend < 0.05 ? `${s.rec === 'log' ? 'LOG FILE · straight from the camera' : 'REC.709 FILE · straight from the camera'}` : s.rec === 'log' ? `LOG → REC.709 · through a ${s.lutN}³ LUT` : 'REC.709 FILE · graded';
        mon.draw((g, w, h) => {
          if (s.blend > 0.05 && s.blend < 0.95) pill(g, `${Math.round(s.blend * 100)}% graded`, w - 12, 30, { align: 'right', size: 20 });
          if (s.rec === '709' && s.exp < -0.4) pill(g, 'clipped sky → flat grey', 12, h - 26, { col: '#ff9a9a', size: 20 });
          else if (s.rec === 'log' && s.exp < -0.4) pill(g, 'log kept the sky', 12, h - 26, { col: '#9ff0b8', size: 20 });
        });
        mon.place();
        latLbl.visible = stage.host.clientWidth >= 560;
      },
      readout: (s) => compact(stage, `<div class="big">${s.rec === 'log' ? 'Log file' : 'Rec.709 file'}${s.blend > 0.5 ? ', graded' : ', ungraded'}</div>
        <div class="row"><span>Kept above a grey card</span><b>${(s.rec === 'log' ? STOPS_LOG : STOPS_709).toFixed(1)} stops</b></div>
        <div class="row"><span>Sky, measured</span><b class="${s.rec === '709' && meas.sky > STOPS_709 ? 'no' : 'ok'}">${fmt.ev(meas.sky)} over grey, ${s.rec === '709' && meas.sky > STOPS_709 ? 'clipped' : 'kept'}</b></div>
        <div class="row"><span>Pixels at 100%</span><b>${fmt.pct(scopes.stats.hi)}</b></div>
        <div class="row"><span>LUT</span><b>${s.lutN}³ = ${(s.lutN ** 3).toLocaleString('en')} points</b></div>
        <div class="row"><span>LUT error (worst / average)</span><b class="${err && err.max > 6 ? 'no' : 'ok'}">${err ? `${err.max.toFixed(1)} / ${err.mean.toFixed(1)} codes` : '…'}</b></div>`, 3),
      dispose() { gr.dispose(); scopes.dispose(); mon.dispose(); lut?.dispose(); stage.setWorldMode(false); stage.setShift(0, 0); },
    };
  },
};
