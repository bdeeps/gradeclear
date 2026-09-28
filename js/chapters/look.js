// Chapter 5: the look. Creative looks as real 3D LUTs (33 × 33 × 33), baked on the CPU from the look
// functions in grade.js and applied on the GPU after the primary grade, with a strength mix and grain.
// The lattice shows each look moving every colour; the wheel board overlays the live vectorscope on a
// colour wheel with the teal and orange poles, so you can watch teal & orange squeeze colours onto one line.
//
// "Near the teal–orange line" is measured from the read-back pixels: of the pixels with visible colour
// (Cb/Cr distance > 0.03), the share whose hue is within 25° of the 130°/310° axis.
import { makeSet, Grader, Scopes, Monitor, Lattice, cameraRig, board, wheelCanvas, bakeLUT, logToDisplay, autoCal, frameClear, vecAngle, pill, fmt, compact, LOOKS, SKIN_ANGLE, SW, SH, DEG, TAU, toCbCr } from '../grade.js';

const REFS = {
  none: 'The balanced primary grade, no creative look.',
  teal: 'Skin is warm, so everything else is pushed to its opposite. Mad Max: Fury Road (2015) is a famous bold example.',
  bleach: 'Like skipping the bleach bath at the lab: silver stays in the print. Saving Private Ryan (1998) used a silver-keeping process.',
  film: 'A print-film emulation: the soft S-curve, lifted blacks and warm highlights of a film stock.',
  night: 'Shot in daylight, graded to look like moonlight. Film makers have done this since the silent era.',
  sepia: 'The warm brown of old toned photographs.',
  noir: 'Black and white with hard contrast. A red filter darkens blue skies.',
};
const AXIS = 130;

export default {
  id: 'look',
  short: 'The look',
  title: 'Teal and orange, noir and the creative LUT',
  subtitle: 'Once the shot is balanced, the colourist gives the film its mood.',
  view: { pos: [-3, 5.6, 17.5], target: [-2.2, 3.4, 3.5] },
  learn: `<p>After correction comes the <b>look</b>: the colour that tells you how to feel. Warm and golden, cold and steely, faded and old. Film makers plan it early with a palette (see <b>ConceptArtClear</b>) and the colourist builds it in the grade, often saving it as a <b>creative LUT</b> so every shot gets the same treatment.</p>
    <p>The most famous modern look is <b>teal and orange</b>. It works because of <b>complementary colours</b>: orange and teal sit opposite each other on the colour wheel, and opposites make each other look stronger. Skin, of every shade, sits on the <b>orange</b> side. So if you push shadows, skies and backgrounds towards teal, the faces pop out. Watch the vectorscope squeeze every colour onto one line.</p>
    <p>Other classic looks: <b>bleach bypass</b> (silvery, harsh, low colour), <b>film print emulation</b> (a gentle S-curve and blacks that never quite reach zero), <b>day for night</b> (filmed in daylight, darkened and turned blue), <b>sepia</b> and <b>noir</b>. Amélie (2001) is famous for its warm greens and golds. A look is only a starting point: colourists still fine-tune it shot by shot.</p>
    <p class="tip"><b>Try it:</b> pick Teal &amp; orange and raise the strength slowly: watch the lattice fold and the dots on the wheel line up. Then try Day for night on the street, and Noir on the sunset.</p>`,
  terms: [
    { t: 'Look', d: 'The overall creative colour style of a film or scene.' },
    { t: 'Creative LUT', d: 'A 3D lookup table that stores a look, so it can be applied the same way to many shots.' },
    { t: 'Complementary colours', d: 'Colours opposite each other on the colour wheel, like orange and teal, that make each other look stronger.' },
    { t: 'Bleach bypass', d: 'Skipping the bleach step when processing film, leaving silver in: low colour, high contrast.' },
    { t: 'Day for night', d: 'Filming in daylight and grading it dark and blue so it looks like night.' },
    { t: 'Film grain', d: 'The fine random texture of film, often added to digital pictures for a filmic feel.' },
  ],
  defaults: { look: 'teal', amount: 1, grain: 0.2, scene: 'sunset' },
  controls: [
    { key: 'look', type: 'seg', label: 'Look', options: Object.entries(LOOKS).map(([v, l]) => ({ v, label: l.label })) },
    { key: 'amount', type: 'range', label: 'Strength', min: 0, max: 1, step: 0.01, ends: ['off', 'full'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'grain', type: 'range', label: 'Film grain', min: 0, max: 1, step: 0.01, ends: ['clean', 'coarse'], fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'scene', type: 'seg', label: 'Footage', options: [{ v: 'sunset', label: 'Sunset' }, { v: 'faces', label: 'Faces' }, { v: 'street', label: 'Street' }] },
  ],
  quiz: [
    { q: 'Why does teal and orange flatter faces?', options: ['Teal is a skin colour', 'Skin sits on the orange side, and teal is its opposite, so faces stand out', 'It makes the film brighter', 'Cameras only see teal and orange'], answer: 1, why: 'Complementary colours strengthen each other. With the background pushed to teal, warm skin pops.' },
    { q: 'What is a creative LUT?', options: ['A camera lens', 'A stored look that can be applied to many shots', 'A type of film stock', 'A light on set'], answer: 1, why: 'A LUT stores exactly how every colour should change, so a look can be shared and repeated.' },
    { q: 'Day for night means…', options: ['Filming at night with big lights', 'Filming in daylight and grading it to look like night', 'Grading night scenes brighter', 'Filming at dawn'], answer: 1, why: 'Real night is hard to film. Underexposing, cooling and desaturating daylight footage fakes it.' },
  ],
  reel: [
    { ms: 5200, caption: 'Teal and orange: skin is warm, so everything else is pushed to its opposite colour.', set: { look: 'teal', scene: 'faces', grain: 0.15 }, anim: { amount: [0, 1] }, spin: 0.2 },
    { ms: 4800, caption: 'Swap the lookup table and the same shot becomes night, or a film noir.', set: { look: 'noir', scene: 'sunset', amount: 1, grain: 0.3 }, anim: { look: ['night', 'noir'] }, spin: 0.2 },
  ],

  build({ stage }) {
    stage.setWorldMode(true);
    const sets = {}, getSet = (k) => (sets[k] ||= (() => { const st = makeSet(k); st.group.visible = false; stage.root.add(st.group); return st; })());
    const rig = cameraRig(1.4); stage.root.add(rig);
    const gr = new Grader(stage), scopes = new Scopes(stage);
    const mon = new Monitor(stage, gr.texture, { title: 'LOOK' });
    const lut = bakeLUT(33, logToDisplay);
    const lat = new Lattice(9, 2.8); lat.group.position.set(-7.2, 0.4, 5.5); lat.group.rotation.y = 0.5; stage.root.add(lat.group);
    const latLbl = { visible: true, position: { set() {} } };
    const wheelImg = wheelCanvas(256, 0.5);
    const wb = board(stage.root, 3.2, 3.2, 512, 512, (g, w, h) => {
      const cx = w / 2, cy = h / 2 + 14, R = w * 0.4;
      g.drawImage(wheelImg, cx - R, cy - R, 2 * R, 2 * R);
      g.fillStyle = 'rgba(0,0,0,.45)'; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
      if (scopes.ok) { g.globalCompositeOperation = 'lighter'; g.drawImage(scopes.cv.vec, cx - R, cy - R, 2 * R, 2 * R); g.globalCompositeOperation = 'source-over'; }
      const ray = (a, col, txt, r1 = 1.12) => {
        const x = Math.cos(a * DEG), y = -Math.sin(a * DEG);
        g.strokeStyle = col; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + x * R, cy + y * R); g.stroke();
        g.fillStyle = col; g.font = '600 24px sans-serif'; g.textAlign = 'center'; g.fillText(txt, cx + x * R * r1, cy + y * R * r1 + 8); g.textAlign = 'left';
      };
      ray(AXIS, '#ffa24a', 'orange'); ray(AXIS + 180, '#3fd6d0', 'teal');
      ray(SKIN_ANGLE, 'rgba(255,220,190,.8)', '');
      g.fillStyle = '#eef0f6'; g.font = '600 26px sans-serif'; g.fillText('The picture on a colour wheel', 16, 32);
    }, [-3.8, 3.4, 4.2], 0.35);
    const wbLbl = { visible: true, position: { set() {} } };

    let cal = {}, cur = '', lookTex = null, lookKey = '', latKey = '', tMeas = -1, stat = { onAxis: 0, sat: 0, skin: null };
    const measure = (set) => {
      const b = scopes.buf; let n = 0, on = 0, sum = 0;
      for (let i = 0; i < SW * SH; i++) {
        const [cb, cr] = toCbCr(b[i * 4] / 255, b[i * 4 + 1] / 255, b[i * 4 + 2] / 255), c = Math.hypot(cb, cr);
        sum += c;
        if (c > 0.03) { n++; const d = ((((Math.atan2(cr, cb) / DEG) - AXIS) % 180) + 180) % 180; if (d < 25 || d > 155) on++; }
      }
      const faces = set.people.map((m) => set.project(m.head, [0, -0.01, 0.1])).filter(Boolean)
        .map((uv) => vecAngle(scopes.avg(uv[0], uv[1], 0))).filter((f) => f.sat > 0.02);
      stat = { onAxis: n ? on / n : 0, sat: sum / (SW * SH), skin: faces.length ? faces.reduce((a, f) => a + f.ang, 0) / faces.length : null };
    };
    return {
      update(dt, s, time) {
        dt = Math.max(0, dt);
        const set = getSet(s.scene);
        if (cur !== s.scene) {
          Object.values(sets).forEach((x) => { x.group.visible = x === set; });
          cur = s.scene;
          const c = set.cam.position;
          rig.position.set(c.x, 0, c.z);
          lat.group.position.set(c.x - 4.0, 0.3, c.z - 2.6);
          wb.mesh.position.set(c.x - 5.6, 1.35, c.z - 1.6); wb.mesh.rotation.y = 0.3; wb.mesh.scale.setScalar(0.85);
          latLbl.position.set(c.x - 3.8, 3.5, c.z - 1.2); wbLbl.position.set(c.x - 2.6, 1.45, c.z - 3.5);
          if (!stage.moved) stage.setView([c.x - 3.4, 5.6, c.z + 10], [c.x - 2.6, 3.4, c.z - 4], 0.9);
        }
        set.pose(time);
        gr.shoot(set.cam);
        if (cal[s.scene] === undefined) cal[s.scene] = autoCal(gr, set);
        if (lookKey !== s.look) { lookKey = s.look; lookTex = bakeLUT(33, LOOKS[s.look].f, lookTex); }
        gr.grade({ cal: cal[s.scene], lut, look: s.look === 'none' ? null : lookTex, lookMix: s.amount, grain: s.grain * 0.07 });
        scopes.read(gr.texture);
        mon.drawScopes(scopes, ['wave', 'vector']);
        const k = s.look + s.amount.toFixed(2);
        if (k !== latKey) { latKey = k; const f = LOOKS[s.look].f; lat.set((r, g, b) => { const o = f(r, g, b); return [r + (o[0] - r) * s.amount, g + (o[1] - g) * s.amount, b + (o[2] - b) * s.amount]; }); }
        if (time - tMeas > 0.3 || time < tMeas) { tMeas = time; measure(set); wb.redraw(); }
        lat.group.rotation.y = 0.5 + Math.sin(time * 0.3) * 0.15;
        mon.title = `LOOK · ${LOOKS[s.look].label.toLowerCase()} · 33³ creative LUT at ${Math.round(s.amount * 100)}%`;
        mon.draw((g, w, h) => { if (s.look === 'night') pill(g, 'shot at midday, graded to night', 12, h - 26, { size: 20 }); });
        const narrow = stage.host.clientWidth < 560;
        latLbl.visible = wbLbl.visible = !narrow;
        frameClear(stage);
        mon.place();
      },
      readout: (s) => compact(stage, `<div class="big">${LOOKS[s.look].label}</div>
        <p style="margin:4px 0 8px;color:var(--muted);max-width:340px">${REFS[s.look]}</p>
        <div class="row"><span>Colours near the teal–orange line</span><b>${fmt.pct(stat.onAxis)}</b></div>
        <div class="row"><span>Average colourfulness</span><b>${(stat.sat * 100).toFixed(1)}</b></div>
        ${stat.skin !== null && s.look !== 'noir' && s.scene !== 'sunset' ? `<div class="row"><span>Faces, average hue</span><b>${Math.round(stat.skin)}° (skin line ${SKIN_ANGLE}°)</b></div>` : ''}
        <div class="row"><span>Creative LUT</span><b>33³ = 35,937 colours</b></div>`, 2),
      dispose() { gr.dispose(); scopes.dispose(); mon.dispose(); lut.dispose(); lookTex?.dispose(); stage.setWorldMode(false); stage.setShift(0, 0); },
    };
  },
};
