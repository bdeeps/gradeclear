// Chapter 3: balance and match. The same street filmed by two cameras: A at midday, B late in the
// afternoon on a different camera body that sees colour a little differently and was underexposed.
// Both are graded live; the monitor shows them side by side (as colourists do) and the parade shows A on
// the left and B on the right. "Match" measures the chart in both shots and solves the correction:
//  1. white balance: channel gains that make B's grey patch neutral, like A's;
//  2. exposure: the stops between the two grey patches;
//  3. saturation: the ratio of the red patch's colourfulness (Cb/Cr distance) in A and in B.
// All measured from the rendered scene-linear pixels, then pushed through the same maths as the shader.
import { THREE } from '../kit.js';
import { makeSet, Grader, Compositor, Scopes, Monitor, cameraRig, bakeLUT, logToDisplay, autoCal, frameClear, solveBalance, wbGains, mul3, R709_TO_AWG, AWG_TO_709, display, toCbCr, luma, pill, fmt, compact, approach, GREY, RED_P, clamp } from '../grade.js';
import { toast } from '../ui.js';

// Camera B: a slightly different colour response (less saturated, a touch green), rows not summing to 1.
const CAM_B = (() => {
  const L = [0.2126, 0.7152, 0.0722], k = 0.22, rows = [0.96, 1.07, 0.93];
  const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => ((r === c ? 1 - k : 0) + k * L[c]) * rows[r]));
  return new THREE.Matrix3().set(...m[0], ...m[1], ...m[2]);
})();
const CAM_B_EXP = -1.1;
const RESET_B = { bExp: 0, bTemp: 0, bTint: 0, bSat: 1 };

export default {
  id: 'match',
  short: 'Balance and match',
  title: 'Making two shots match',
  subtitle: 'Two cameras, two times of day, one scene that has to look continuous.',
  view: { pos: [-6, 9, 30], target: [-2.5, 2.5, 2] },
  learn: `<p>A scene is cut from many shots, filmed hours apart, sometimes on different cameras. The sun moves, clouds pass, and every camera sees colour a little differently. If the shots are not matched, the audience feels a jump at every cut, even if they cannot say why. Matching is a huge part of a colourist's day. How the cuts themselves work is in <b>EditClear</b>.</p>
    <p>Colourists match with the <b>scopes</b>, not by eye. They put the two shots side by side and compare the <b>RGB parade</b>: something that should be neutral grey must have red, green and blue at the same height in both. That fixes the <b>balance</b>. Then the <b>exposure</b>: the same grey card should sit at the same level on the waveform. Last, <b>saturation and contrast</b>: the same coloured object should sit the same distance out on the vectorscope.</p>
    <p>A <b>colour chart</b> filmed at the start of each setup makes this much easier, because everyone knows exactly what colour each patch should be. Grading can match colour and brightness, but not everything: it cannot move a shadow that falls the wrong way.</p>
    <p class="tip"><b>Try it:</b> press <b>Match B to A</b> and watch the three steps in the parade. Then reset B and try to match it yourself with the four sliders, watching the grey card numbers in the readout.</p>`,
  terms: [
    { t: 'Shot matching', d: 'Grading shots in a scene so they look as if they were filmed together.' },
    { t: 'Balance', d: 'Making neutral things neutral: equal red, green and blue on a grey or white object.' },
    { t: 'Colour chart', d: 'A card of known colour patches filmed on set as a reference for the grade.' },
    { t: 'Side by side', d: 'Showing two shots together (a split screen) to compare them directly.' },
    { t: 'Continuity', d: 'The feeling that shots in a scene belong to one moment in one place.' },
  ],
  defaults: { mode: 'side', ...RESET_B, scope: 'parade' },
  controls: [
    { key: 'mode', type: 'seg', label: 'Monitor', options: [{ v: 'a', label: 'Shot A' }, { v: 'side', label: 'Side by side' }, { v: 'b', label: 'Shot B' }] },
    { key: 'match', type: 'buttons', label: 'Match', items: [
      { label: 'Match B to A (show the steps)', act: (s, inst) => inst.match?.(s) },
      { label: 'Reset B', act: (s, inst) => { inst.stop?.(); Object.assign(s, RESET_B); } },
    ] },
    { key: 'bTemp', type: 'range', label: 'Shot B temperature', min: -1.5, max: 1.5, step: 0.01, ends: ['cooler', 'warmer'], fmt: (v) => fmt.sgn(v) },
    { key: 'bTint', type: 'range', label: 'Shot B tint', min: -1, max: 1, step: 0.01, ends: ['green', 'magenta'], fmt: (v) => fmt.sgn(v) },
    { key: 'bExp', type: 'range', label: 'Shot B exposure', min: -1, max: 2.5, step: 0.02, ends: ['−1 stop', '+2.5'], fmt: (v) => fmt.ev(v) },
    { key: 'bSat', type: 'range', label: 'Shot B saturation', min: 0.5, max: 1.8, step: 0.01, ends: ['grey', 'vivid'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'scope', type: 'seg', label: 'Scopes', options: [{ v: 'parade', label: 'Parade' }, { v: 'wave', label: 'Waveform' }, { v: 'vector', label: 'Vector' }] },
  ],
  quiz: [
    { q: 'On an RGB parade, how do you know a grey card is neutral?', options: ['The red trace is highest', 'Red, green and blue sit at the same height', 'All three are at 100', 'The green trace is missing'], answer: 1, why: 'Grey has equal amounts of red, green and blue, so all three traces line up.' },
    { q: 'What is usually matched first?', options: ['Saturation', 'Balance and exposure', 'Grain', 'The vignette'], answer: 1, why: 'Get neutral things neutral and the brightness level right first; saturation and style come after.' },
    { q: 'Which difference between two shots can grading NOT fix?', options: ['A blue tint', 'One shot a stop darker', 'Shadows falling in a different direction', 'Lower saturation'], answer: 2, why: 'Grading changes colours and brightness, not where the light came from.' },
  ],
  reel: [
    { ms: 6000, caption: 'Two cameras, two times of day: balance the grey chart, match exposure, and the cut disappears.', set: { mode: 'side', ...RESET_B, scope: 'parade' }, act: (s, inst) => inst.match?.(s), spin: 0.15 },
  ],

  build({ stage }) {
    stage.setWorldMode(true);
    const set = makeSet('street'); stage.root.add(set.group);
    // Put the chart in the middle of the frame so it shows in both halves of the side-by-side.
    set.chartStand.position.set(0.1, 0, 5.4); set.chartStand.rotation.y = 0;
    const rigA = cameraRig(1.5); rigA.position.set(-0.45, 0, 10); stage.root.add(rigA);
    const rigB = cameraRig(1.5); rigB.position.set(0.45, 0, 10); stage.root.add(rigB);
    const gA = new Grader(stage), gB = new Grader(stage), comp = new Compositor(stage), scopes = new Scopes(stage);
    const mon = new Monitor(stage, comp.texture, { title: 'A | B' });
    const lut = bakeLUT(33, logToDisplay);
    stage.label('Camera A · midday', [-1.2, 2.2, 10]);
    stage.label('Camera B · late afternoon', [1.3, 1.8, 10], stage.root, 'hot');
    stage.label('Chart in both shots', [0.1, 1.75, 5.4]);

    let cal = null, meas = null, tMeas = -1, job = null;
    const measure = () => {
      set.group.updateMatrixWorld(true);
      const read = (gr, i, camMat, camExp) => {
        const uv = set.patchUV(i); if (!uv) return null;
        const v = gr.readLinear(uv[0] * gr.w, uv[1] * gr.h, 3); if (!v) return null;
        const c = mul3(camMat, ...v.map((x) => x * cal * Math.pow(2, camExp)));
        return mul3(R709_TO_AWG, ...c);                                 // what the log file holds (linear)
      };
      const I = new THREE.Matrix3();
      const a = { grey: read(gA, GREY, I, 0), red: read(gA, RED_P, I, 0) }, b = { grey: read(gB, GREY, CAM_B, CAM_B_EXP), red: read(gB, RED_P, CAM_B, CAM_B_EXP) };
      if (!a.grey || !b.grey || !a.red || !b.red) return null;
      return { a, b };
    };
    // Display value of a file-linear colour after a post correction (exp, temp, tint, sat).
    const show = (awg, c = RESET_B) => {
      const g = wbGains(c.bTemp, c.bTint), e = Math.pow(2, c.bExp);
      let d = mul3(AWG_TO_709, ...awg.map((x, i) => x * e * g[i])).map(display);
      const y = luma(...d); d = d.map((v) => y + (v - y) * c.bSat);
      return d;
    };
    const chroma = (d) => { const [cb, cr] = toCbCr(...d); return Math.hypot(cb, cr); };

    const inst = {
      match(s) {
        const m = meas || measure(); if (!m) return;
        const sol = solveBalance(m.b.grey, m.a.grey);
        const after = { bExp: sol.ev, bTemp: sol.temp, bTint: sol.tint, bSat: 1 };
        const sat = clamp(chroma(show(m.a.red)) / Math.max(1e-4, chroma(show(m.b.red, after))), 0.5, 1.8);
        Object.assign(s, RESET_B);
        job = { t: 0, step: -1, steps: [
          { msg: '<b>1. Balance.</b> Make B’s grey patch neutral: equal red, green and blue.', to: { bTemp: sol.temp, bTint: sol.tint } },
          { msg: `<b>2. Exposure.</b> Lift B by ${sol.ev.toFixed(1)} stops so both grey cards sit at the same level.`, to: { bExp: sol.ev } },
          { msg: `<b>3. Saturation.</b> Match the red patch: ${Math.round(sat * 100)}%.`, to: { bSat: sat } },
        ] };
      },
      stop() { job = null; },
      update(dt, s, time) {
        dt = Math.max(0, dt);
        set.pose(time);
        set.light('late'); gB.shoot(set.cam);
        set.light('noon'); gA.shoot(set.cam);
        if (cal === null) cal = autoCal(gA, set);
        if (job) {
          const k = Math.floor(job.t / 1.5);
          if (k !== job.step && k < job.steps.length) { job.step = k; toast(job.steps[k].msg); }
          const st = job.steps[Math.min(job.step, job.steps.length - 1)];
          if (st) for (const [key, v] of Object.entries(st.to)) s[key] = approach(s[key], v, 5, dt);
          job.t += dt;
          if (job.t > job.steps.length * 1.5 + 0.6) { job.steps.forEach((x) => Object.assign(s, x.to)); job = null; toast('<b>Matched.</b> The cut from A to B now feels continuous.'); }
        }
        gA.grade({ cal, lut });
        gB.grade({ cal, lut, camMat: CAM_B, camExp: CAM_B_EXP, exp: s.bExp, temp: s.bTemp, tint: s.bTint, sat: s.bSat });
        comp.run(gA.texture, gB.texture, { a: 0, b: 1, side: 2 }[s.mode]);
        scopes.read(comp.texture);
        mon.drawScopes(scopes, [s.scope]);
        if (time - tMeas > 0.3 || time < tMeas) { tMeas = time; meas = measure() || meas; }
        mon.title = s.mode === 'side' ? 'A (midday) | B (late afternoon)' : s.mode === 'a' ? 'SHOT A · midday' : 'SHOT B · late afternoon, camera B';
        mon.draw((g, w, h) => {
          if (s.mode === 'side') { pill(g, 'A', 12, 26, { size: 20 }); pill(g, 'B', w / 2 + 12, 26, { size: 20 }); }
        });
        frameClear(stage);
        mon.place();
      },
      readout: (s) => {
        if (!meas) return '';
        const A = show(meas.a.grey), B = show(meas.b.grey, s), Ar = show(meas.a.red), Br = show(meas.b.red, s);
        const d = Math.max(...A.map((v, i) => Math.abs(v - B[i]))) * 100, dr = Math.abs(chroma(Ar) - chroma(Br)) * 100;
        const ok = d < 2.5 && dr < 2.5;
        return compact(stage, `<div class="big">${ok ? 'Shots match' : job ? `Matching: step ${job.step + 1} of 3` : 'Shots don’t match yet'}</div>
          <div class="row"><span>Grey card A (R · G · B)</span><b>${A.map(fmt.ire).join(' · ')}</b></div>
          <div class="row"><span>Grey card B (R · G · B)</span><b class="${d < 2.5 ? 'ok' : 'no'}">${B.map(fmt.ire).join(' · ')}</b></div>
          <div class="row"><span>Biggest grey difference</span><b class="${d < 2.5 ? 'ok' : 'no'}">${d.toFixed(1)} points</b></div>
          <div class="row"><span>Red patch colourfulness, A / B</span><b class="${dr < 2.5 ? 'ok' : 'no'}">${(chroma(Ar) * 100).toFixed(0)} / ${(chroma(Br) * 100).toFixed(0)}</b></div>`, 3);
      },
      dispose() { gA.dispose(); gB.dispose(); comp.dispose(); scopes.dispose(); mon.dispose(); lut.dispose(); stage.setWorldMode(false); stage.setShift(0, 0); },
    };
    return inst;
  },
};
