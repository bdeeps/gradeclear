// Chapter 6: delivery. The grading suite, SDR vs HDR, and colour gamuts.
//  - Two reference monitors show the same log shot: graded for SDR (BT.1886, 100 nits white) and mapped
//    for HDR (BT.2408 puts an 18% grey card at 26 nits and diffuse white at 203 nits; highlights roll
//    off to the display's peak: 1,000 or 4,000 nits). The HDR picture is shrunk to fit an ordinary screen.
//  - The nits map colours each pixel by how bright it would be on the real display.
//  - The CIE 1931 board draws the spectral locus (CIE tables, 2° observer), the Rec.709, DCI-P3 and
//    Rec.2020 triangles (ITU-R BT.709, SMPTE RP 431-2, ITU-R BT.2020) and the picture's own colours.
//    Coverage is computed here as each triangle's share of the area inside the locus on the xy diagram.
//  - Reference numbers: SDR 100 nits (ITU-R BT.1886/BT.2035 practice), DCI cinema 48 nits (14 fL),
//    Dolby Cinema 108 nits, PQ (SMPTE ST 2084) encodes up to 10,000 nits.
import { THREE, M } from '../kit.js';
import { makeSet, Grader, Scopes, board, wheelPanel, bakeLUT, logToDisplay, autoCal, inv709, luma, fmt, compact, box, beam, clamp, GREY } from '../grade.js';

// CIE 1931 2° spectral locus, xy, 380–700 nm.
const LOCUS = [[0.1741, 0.005], [0.1738, 0.0049], [0.1733, 0.0048], [0.1726, 0.0048], [0.1714, 0.0051], [0.1689, 0.0069], [0.1644, 0.0109], [0.1566, 0.0177], [0.144, 0.0297], [0.1241, 0.0578], [0.0913, 0.1327], [0.0687, 0.2007], [0.0454, 0.295], [0.0235, 0.4127], [0.0082, 0.5384], [0.0039, 0.6548], [0.0139, 0.7502], [0.0389, 0.812], [0.0743, 0.8338], [0.1142, 0.8262], [0.1547, 0.8059], [0.1929, 0.7816], [0.2296, 0.7543], [0.2658, 0.7243], [0.3016, 0.6923], [0.3373, 0.6589], [0.3731, 0.6245], [0.4087, 0.5896], [0.4441, 0.5547], [0.4788, 0.5202], [0.5125, 0.4866], [0.5448, 0.4544], [0.5752, 0.4242], [0.6029, 0.3965], [0.627, 0.3725], [0.6482, 0.3514], [0.6658, 0.334], [0.6801, 0.3197], [0.6915, 0.3083], [0.7006, 0.2993], [0.714, 0.2859], [0.7219, 0.2780], [0.73, 0.27], [0.7347, 0.2653]];
export const GAMUTS = {
  rec709: { label: 'Rec.709', pts: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], col: '#ffffff', use: 'HD TV, the web, most phones' },
  p3: { label: 'DCI-P3', pts: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], col: '#ffb547', use: 'digital cinema, newer phones and TVs' },
  rec2020: { label: 'Rec.2020', pts: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], col: '#38bdf8', use: 'UHD and HDR delivery (a container few screens fill)' },
};
const area = (p) => Math.abs(p.reduce((a, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + x * y2 - x2 * y; }, 0)) / 2;
const LOCUS_AREA = area(LOCUS);
export const coverage = (k) => area(GAMUTS[k].pts) / LOCUS_AREA;
// HDR mapping (as in the shader): 18% grey → 26 nits, soft roll-off to the peak.
export const hdrNits = (lin, peak) => { let n = lin * (26 / 0.18); const k = 0.6 * peak; if (n > k) n = k + (peak - k) * (1 - Math.exp(-(n - k) / (peak - k))); return n; };
const sdrNits = (v) => 100 * Math.pow(clamp(v, 0, 1), 2.4);

export default {
  id: 'delivery',
  short: 'Delivery: HDR and gamuts',
  title: 'The grading suite, HDR and colour gamuts',
  subtitle: 'Why a colourist grades in a dim grey room, and why every film is graded more than once.',
  view: { pos: [0.9, 2.0, 4.3], target: [0.5, 1.45, -0.8] },
  learn: `<p>Colourists work in a <b>grading suite</b>: a dim room with neutral grey walls and a <b>calibrated reference monitor</b>. Our eyes adjust to whatever is around them, so a bright or coloured room would fool them. The HDR standard even says how bright the wall behind the screen should be: a dim, neutral grey of about <b>5 nits</b>. The monitor is measured with a probe so that its grey really is grey. Projection in cinemas is its own story (see <b>ProjectorClear</b>, coming soon).</p>
    <p>Brightness on a screen is measured in <b>nits</b> (candelas per square metre). Normal <b>SDR</b> video is graded for a white of <b>100 nits</b>, and a cinema screen is only about <b>48</b>. <b>HDR</b> TVs reach <b>1,000 nits</b> or more, and HDR masters are often made on 1,000 to 4,000 nit monitors. In HDR a white shirt stays around 200 nits but the sun, lamps and sparkles get ten times more room, so they keep their detail and colour. That is why films are delivered in several versions: an HDR grade, an SDR trim and a cinema version.</p>
    <p>Screens also differ in how saturated their colours can go: their <b>gamut</b>. On the <b>CIE diagram</b>, the horseshoe is every colour a human can see (how the eye does it is in <b>EyeClear</b>). <b>Rec.709</b> covers about a third of it, <b>DCI-P3</b> (cinema) more, and <b>Rec.2020</b> about two thirds of the diagram's area (other ways of measuring put it nearer three quarters). India's <b>digital intermediate</b> industry took off in the early 2000s: Prime Focus says its 2003 grade of <i>Qayamat</i> was the first fully colour-graded Indian film, and today studios such as Prime Focus and Red Chillies grade films in-house.</p>
    <p class="tip"><b>Try it:</b> switch to the nits map and compare the SDR and HDR monitors: the sun and sky stay yellow-orange in SDR but go white-hot in HDR. Then switch gamuts and watch the picture's colours sit inside the small Rec.709 triangle.</p>`,
  terms: [
    { t: 'Nit', d: 'A unit of brightness: one candela per square metre.' },
    { t: 'SDR', d: 'Standard dynamic range: video graded for a white of about 100 nits.' },
    { t: 'HDR', d: 'High dynamic range: video for displays of 1,000 nits and more, with far brighter highlights.' },
    { t: 'Gamut', d: 'The range of colours a screen or standard can show.' },
    { t: 'CIE diagram', d: 'A map of every colour humans can see, used to compare gamuts.' },
    { t: 'Reference monitor', d: 'A calibrated display that shows the picture exactly as the standard says.' },
    { t: 'Digital intermediate (DI)', d: 'Scanning or recording a film digitally so the whole thing can be graded on a computer.' },
  ],
  defaults: { peak: 1000, map: false, gamut: 'p3', scene: 'sunset' },
  controls: [
    { key: 'peak', type: 'seg', label: 'HDR monitor peak', options: [{ v: 1000, label: '1,000 nits' }, { v: 4000, label: '4,000 nits' }] },
    { key: 'map', type: 'toggle', label: 'Show the nits map', hint: 'Blue under 10 nits, green 10–100, yellow about 100, orange hundreds, white over 1,000.' },
    { key: 'gamut', type: 'seg', label: 'Gamut on the CIE board', options: Object.entries(GAMUTS).map(([v, g]) => ({ v, label: g.label })), fmt: (v) => fmt.pct(coverage(v)) + ' of visible colours' },
    { key: 'scene', type: 'seg', label: 'Footage', options: [{ v: 'sunset', label: 'Sunset' }, { v: 'street', label: 'Street' }, { v: 'faces', label: 'Faces' }] },
  ],
  quiz: [
    { q: 'Roughly how bright is white in a normal SDR grade?', options: ['10 nits', '100 nits', '1,000 nits', '10,000 nits'], answer: 1, why: 'SDR video is graded for a reference white of about 100 nits.' },
    { q: 'What does HDR mostly add?', options: ['Brighter everything', 'Far more room for highlights, like the sun and lamps', 'More frames per second', 'Bigger pictures'], answer: 1, why: 'Faces and white walls stay at similar levels; the extra brightness goes to highlights, which keep detail and colour.' },
    { q: 'Why are grading suites dim with neutral grey walls?', options: ['To save electricity', 'So the colourist’s eyes aren’t fooled by bright or coloured surroundings', 'Because monitors overheat', 'For the clients to sleep'], answer: 1, why: 'Eyes adapt to their surroundings. A controlled, neutral room keeps judgement honest.' },
  ],
  reel: [
    { ms: 5400, caption: 'SDR is graded for 100 nits; HDR screens reach 1,000 and more, so the sun keeps its detail.', set: { peak: 1000, gamut: 'p3', scene: 'sunset' }, anim: { map: [false, true] }, spin: 0.2 },
  ],

  build({ stage }) {
    const sets = {}, getSet = (k) => (sets[k] ||= (() => { const st = makeSet(k, { keep0: false }); st.group.visible = false; stage.root.add(st.group); return st; })());
    const gS = new Grader(stage), gH = new Grader(stage), scopes = new Scopes(stage);
    gH.mat.uniforms.tSrc.value = gS.rtScene.texture;
    const lut = bakeLUT(33, logToDisplay);

    // The suite: grey walls, a desk, two reference monitors, a grading panel and a bias light.
    const room = new THREE.Group(); stage.root.add(room);
    const wallMat = M.matte(0x5c5c5c);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), M.matte(0x1c1d21)); floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.003, 0.5); floor.receiveShadow = true; room.add(floor);
    const back = box(9, 3.4, 0.1, wallMat); back.position.set(0, 1.7, -2.2); room.add(back);
    const side = box(0.1, 3.4, 7, M.matte(0x2a2b30)); side.position.set(-4.5, 1.7, 1); room.add(side);
    const bias = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 1.2), new THREE.MeshBasicMaterial({ color: 0x8a8f96, transparent: true, opacity: 0.55 })); bias.position.set(0, 1.55, -2.14); room.add(bias);
    const desk = box(3.6, 0.06, 1.1, M.matte(0x2e2620)); desk.position.set(0, 0.78, 0.2); room.add(desk);
    [[-1.7, -0.3], [1.7, -0.3], [-1.7, 0.7], [1.7, 0.7]].forEach(([x, z]) => room.add(beam([x, 0, z], [x, 0.76, z], 0.03, M.matte(0x222222))));
    const panel = wheelPanel(); panel.scale.setScalar(0.62); panel.position.set(0, 0.87, 0.35); room.add(panel);
    panel.set({ lift: { u: -0.2, v: 0.1, turn: 0 }, gamma: { u: 0, v: 0, turn: 0 }, gain: { u: 0.15, v: -0.1, turn: 0 } });
    const mkMon = (x, ry, tex, wid) => {
      const g = new THREE.Group(); g.position.set(x, 1.45, -0.55); g.rotation.y = ry; room.add(g);
      const h = wid * 9 / 16;
      g.add(box(wid + 0.06, h + 0.06, 0.05, M.matte(0x0d0e11)));
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(wid, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })); scr.position.z = 0.027; g.add(scr);
      g.add(beam([0, -h / 2, -0.05], [0, -0.66, -0.05], 0.03, M.matte(0x222222)));
      const foot = box(0.4, 0.02, 0.25, M.matte(0x222222)); foot.position.set(0, -0.66, -0.05); g.add(foot);
      return g;
    };
    mkMon(-0.8, 0.12, gS.texture, 1.45); mkMon(0.8, -0.12, gH.texture, 1.45);
    const lblS = stage.label('SDR · 100 nits white', [-0.8, 2.08, -0.55]);
    const lblH = stage.label('HDR · 1,000 nits peak', [0.8, 2.08, -0.55], stage.root, 'hot');
    stage.label('Neutral grey surround, about 5 nits', [1.9, 2.9, -2.1]);
    stage.label('Grading panel', [0, 1.05, 0.75]);

    // CIE 1931 board.
    const X = (x, w) => 60 + (x / 0.8) * (w - 90), Y = (y, h) => h - 60 - (y / 0.9) * (h - 110);
    let pts = [];
    const cie = board(stage.root, 1.5, 1.5, 560, 560, (g, w, h, gam) => {
      g.fillStyle = '#eef0f6'; g.font = '600 26px sans-serif'; g.fillText('CIE 1931: every colour we can see', 18, 34);
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.font = '15px sans-serif'; g.fillStyle = '#737a8e';
      for (let v = 0; v <= 0.8; v += 0.1) { g.beginPath(); g.moveTo(X(v, w), Y(0, h)); g.lineTo(X(v, w), Y(0.9, h)); g.stroke(); g.fillText(v.toFixed(1), X(v, w) - 10, h - 36); }
      for (let v = 0; v <= 0.9; v += 0.1) { g.beginPath(); g.moveTo(X(0, w), Y(v, h)); g.lineTo(X(0.8, w), Y(v, h)); g.stroke(); g.fillText(v.toFixed(1), 22, Y(v, h) + 5); }
      g.fillText('x', w - 30, h - 36); g.fillText('y', 30, 60);
      g.fillStyle = 'rgba(255,255,255,.07)'; g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2.5;
      g.beginPath(); LOCUS.forEach(([x, y], i) => (i ? g.lineTo(X(x, w), Y(y, h)) : g.moveTo(X(x, w), Y(y, h)))); g.closePath(); g.fill(); g.stroke();
      [[460, 1], [520, 18], [560, 26], [600, 34], [700, 43]].forEach(([nm, i]) => { const [x, y] = LOCUS[i]; g.fillStyle = '#a8aebf'; g.font = '14px sans-serif'; g.fillText(nm + ' nm', X(x, w) + 8, Y(y, h) - 4); });
      for (const p of pts) { g.fillStyle = p.c; g.fillRect(X(p.x, w) - 2, Y(p.y, h) - 2, 4, 4); }
      Object.entries(GAMUTS).forEach(([k, G]) => {
        const on = k === gam;
        g.strokeStyle = G.col; g.globalAlpha = on ? 1 : 0.35; g.lineWidth = on ? 4 : 2;
        g.beginPath(); G.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x, w), Y(y, h)) : g.moveTo(X(x, w), Y(y, h)))); g.closePath(); g.stroke();
        g.fillStyle = G.col; g.font = (on ? '600 ' : '') + '18px sans-serif'; g.fillText(`${G.label} ${fmt.pct(coverage(k))}`, w - 230, 70 + Object.keys(GAMUTS).indexOf(k) * 26);
        g.globalAlpha = 1;
      });
    }, [2.75, 1.75, -0.9], -0.55);
    // Nits ladder.
    let marks = null;
    const ladder = board(stage.root, 1.0, 1.5, 380, 570, (g, w, h, m) => {
      g.fillStyle = '#eef0f6'; g.font = '600 24px sans-serif'; g.fillText('Brightness (nits)', 16, 32);
      const Yn = (n) => h - 40 - ((Math.log10(n) + 1) / 5) * (h - 90);
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(90, Yn(0.1)); g.lineTo(90, Yn(10000)); g.stroke();
      [[0.1, '0.1'], [1, '1'], [10, '10'], [100, '100'], [1000, '1,000'], [10000, '10,000']].forEach(([n, t]) => { g.fillStyle = '#737a8e'; g.font = '15px sans-serif'; g.fillText(t, 20, Yn(n) + 5); g.fillRect(84, Yn(n), 12, 1.5); });
      [[48, 'cinema screen (DCI)', '#a8aebf'], [100, 'SDR white', '#ffffff'], [203, 'HDR diffuse white', '#9fdcff'], [1000, 'HDR TV peak', '#38bdf8'], [4000, 'mastering monitor', '#38bdf8'], [10000, 'PQ ceiling', '#737a8e']].forEach(([n, t, c]) => {
        g.fillStyle = c; g.font = '15px sans-serif'; g.fillText(t, 104, Yn(n) + 5);
      });
      if (m) m.forEach(([n, t, c], i) => { g.fillStyle = c; g.beginPath(); g.arc(90, Yn(Math.max(0.1, n)), 7, 0, Math.PI * 2); g.fill(); g.font = '600 15px sans-serif'; g.fillText(t, 250, Yn(Math.max(0.1, n)) + 5 + (i % 2 ? 9 : -4)); });
    }, [-2.05, 1.6, -1.1], 0.5);

    let cal = {}, cur = '', meas = null, tMeas = -1;
    const measure = (set, s) => {
      set.group.updateMatrixWorld(true);
      const U = set.sky.material.uniforms;
      const hiPt = set.kind === 'sunset' ? set.cam.position.clone().addScaledVector(U.uSun.value, 80).toArray() : set.kind === 'faces' ? [1.9, 2.0, -2.45] : set.poi.sky;
      const pick = (p) => { const uv = set.project(p); if (!uv) return null; const lin = gS.readLinear(uv[0] * gS.w, uv[1] * gS.h, 3); return lin ? { uv, lin: luma(...lin) * cal[s.scene] } : null; };
      const face = pick(set.people[set.kind === 'faces' ? 1 : 0].head), hi = pick(hiPt), gUV = set.patchUV(GREY);
      const out = [];
      const add = (name, m) => { if (!m) return; const v = scopes.avg(m.uv[0], m.uv[1], 1); out.push({ name, sdr: sdrNits(luma(...v)), hdr: hdrNits(m.lin, s.peak) }); };
      add(set.kind === 'faces' ? 'Window' : set.kind === 'sunset' ? 'Sun' : 'Sky', hi);
      add('Face', face);
      if (gUV) { const lin = gS.readLinear(gUV[0] * gS.w, gUV[1] * gS.h, 3); if (lin) add('Grey card', { uv: gUV, lin: luma(...lin) * cal[s.scene] }); }
      // The picture's colours on the CIE diagram.
      pts = [];
      const b = scopes.buf;
      for (let i = 0; i < b.length; i += 4 * 7) {
        const [r, g, bl] = [b[i], b[i + 1], b[i + 2]].map((v) => inv709(v / 255));
        const Xc = 0.4124 * r + 0.3576 * g + 0.1805 * bl, Yc = 0.2126 * r + 0.7152 * g + 0.0722 * bl, Zc = 0.0193 * r + 0.1192 * g + 0.9505 * bl, S = Xc + Yc + Zc;
        if (S > 0.02) pts.push({ x: Xc / S, y: Yc / S, c: `rgb(${b[i]},${b[i + 1]},${b[i + 2]})` });
      }
      return out;
    };
    return {
      update(dt, s, time) {
        dt = Math.max(0, dt);
        const set = getSet(s.scene);
        if (cur !== s.scene) { Object.values(sets).forEach((x) => { x.group.visible = x === set; }); cur = s.scene; }
        set.pose(time);
        gS.shoot(set.cam);
        if (cal[s.scene] === undefined) cal[s.scene] = autoCal(gS, set);
        gS.grade({ cal: cal[s.scene], lut });
        scopes.read(gS.texture);
        if (s.map) gS.grade({ cal: cal[s.scene], lut, out: 'nitsSdr' });
        gH.grade({ cal: cal[s.scene], lut, out: s.map ? 'nitsHdr' : 'hdr', peak: s.peak });
        if (time - tMeas > 0.4 || time < tMeas) {
          tMeas = time; meas = measure(set, s);
          marks = meas.flatMap((m) => [[m.sdr, `${m.name} SDR`, '#ffffff'], [m.hdr, `${m.name} HDR`, '#38bdf8']]).slice(0, 4);
          ladder.redraw(marks); cie.redraw(s.gamut);
        }
        lblH.element.textContent = `HDR · ${s.peak.toLocaleString('en')} nits peak${s.map ? '' : ' (shrunk to fit)'}`;
        lblS.element.textContent = 'SDR · 100 nits white';
      },
      readout: (s) => {
        if (!meas) return '';
        const rows = meas.filter((m) => m.hdr >= 0.5).map((m) => `<div class="row"><span>${m.name}: SDR / HDR</span><b>${Math.round(m.sdr)} / ${Math.round(m.hdr).toLocaleString('en')} nits</b></div>`).join('');
        return compact(stage, `<div class="big">SDR 100 · HDR ${s.peak.toLocaleString('en')} nits</div>${rows}
          <div class="row"><span>${GAMUTS[s.gamut].label} covers</span><b>${fmt.pct(coverage(s.gamut))} of visible colours</b></div>
          <div class="row"><span>Used for</span><b>${GAMUTS[s.gamut].use}</b></div>`, 3);
      },
      dispose() { gS.dispose(); gH.dispose(); scopes.dispose(); lut.dispose(); },
    };
  },
};
