/* @ds-bundle: {"format":4,"namespace":"SantiGlass","components":[{"name":"GlassToggle"},{"name":"GlassScene"},{"name":"Button"},{"name":"GlassCard"},{"name":"Switch"},{"name":"SegmentedControl"},{"name":"Slider"},{"name":"SearchField"},{"name":"List"},{"name":"ListRow"},{"name":"TabBar"},{"name":"Icon"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useLayoutEffect = React.useLayoutEffect;
  var useRef = React.useRef;
  var useContext = React.useContext;

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(' ');
  }

  function omit(obj, keys) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && keys.indexOf(k) === -1) out[k] = obj[k];
    }
    return out;
  }

  // controlled when value is passed, uncontrolled otherwise
  function useControl(value, fallback, onChange) {
    var s = useState(fallback);
    var controlled = value !== undefined;
    return [
      controlled ? value : s[0],
      function (next) {
        if (!controlled) s[1](next);
        if (onChange) onChange(next);
      }
    ];
  }

  /* ------------------------------------------------------------------
     platform
     ------------------------------------------------------------------ */
  var IS_TAURI = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  var IS_ELECTRON = /\bElectron\//.test(navigator.userAgent);
  if (IS_TAURI) document.documentElement.setAttribute('data-tauri', '');
  if (IS_ELECTRON) document.documentElement.setAttribute('data-electron', '');

  /* ------------------------------------------------------------------
     liquid glass setting: one system-wide switch, on by default.
     stored on <html data-glass="on|off">, persisted when storage exists.
     ------------------------------------------------------------------ */
  var STORAGE_KEY = 'santi.glass.liquid';
  var listeners = [];

  function readStored() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      if (v === '0') return false;
      if (v === '1') return true;
    } catch (e) {}
    return null;
  }

  function prefersReducedTransparency() {
    try {
      return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  var stored = readStored();
  var glassOn = stored === null ? !prefersReducedTransparency() : stored;

  function writeAttr() {
    document.documentElement.setAttribute('data-glass', glassOn ? 'on' : 'off');
  }
  writeAttr();

  // desktop apps outlive a settings change: follow the OS transparency switch
  // (windows "transparency effects", macOS "reduce transparency") until the
  // person picks a side in GlassToggle
  try {
    window.matchMedia('(prefers-reduced-transparency: reduce)').addEventListener('change', function (e) {
      if (readStored() === null) setLiquidGlass(!e.matches, { persist: false });
    });
  } catch (e) {}

  function getLiquidGlass() {
    return glassOn;
  }

  function setLiquidGlass(on, opts) {
    on = !!on;
    if (!(opts && opts.persist === false)) {
      try { window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) {}
    }
    if (on === glassOn) return;
    glassOn = on;
    writeAttr();
    listeners.slice().forEach(function (fn) { fn(on); });
  }

  function subscribeLiquidGlass(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function useLiquidGlass() {
    var s = useState(glassOn);
    useEffect(function () {
      s[1](glassOn);
      return subscribeLiquidGlass(function (v) { s[1](v); });
    }, []);
    return [s[0], setLiquidGlass];
  }

  /* ------------------------------------------------------------------
     window glass: keep the native window material (liquid glass, vibrancy,
     mica, acrylic) in step with the toggle. the host applies it:
       - tauri: a rust command (default set_liquid_glass), docs/tauri.md
       - electron, or any other shell: window.santiGlassHost.setWindowGlass(on)
         exposed by a preload / host object, docs/electron.md
       - anything else: pass opts.set
     ------------------------------------------------------------------ */
  function tauriInvoke() {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) return window.__TAURI__.core.invoke;
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) return window.__TAURI_INTERNALS__.invoke;
    return null;
  }

  function windowGlassSetter(opts) {
    opts = opts || {};
    if (opts.set) return opts.set;
    var invoke = opts.invoke || tauriInvoke();
    if (invoke) {
      var command = opts.command || 'set_liquid_glass';
      return function (on) { return invoke(command, { on: on }); };
    }
    var host = window.santiGlassHost;
    if (host && host.setWindowGlass) return function (on) { return host.setWindowGlass(on); };
    return null;
  }

  function syncWindowGlass(opts) {
    var set = windowGlassSetter(opts);
    if (!set) return function () {};
    var root = document.documentElement;
    function apply(on) {
      Promise.resolve().then(function () { return set(on); }).then(function () {
        if (on !== glassOn) return; // a newer toggle already won
        if (on) root.setAttribute('data-window-glass', '');
        else root.removeAttribute('data-window-glass');
      }, function (err) {
        if (on !== glassOn) return;
        root.removeAttribute('data-window-glass');
        console.warn('[santi.glass] window glass unavailable:', err);
      });
    }
    apply(glassOn);
    return subscribeLiquidGlass(apply);
  }

  /* ------------------------------------------------------------------
     shared lens optics
     squircle bezel: height y(t) = (1 - (1 - t)^4)^(1/4), t = 0 at the rim.
     the same curve drives the svg lens and the gpu shaders.
     ------------------------------------------------------------------ */
  function slopeAt(t) {
    t = Math.min(Math.max(t, 0.002), 1);
    var a = 1 - t;
    var inner = 1 - a * a * a * a;
    return (a * a * a) * Math.pow(inner, -0.75);
  }

  function bend(t, ior) {
    var a = 1 - t;
    var hgt = Math.pow(Math.max(1 - a * a * a * a, 0), 0.25);
    var th1 = Math.atan(slopeAt(t));
    var th2 = Math.asin(Math.min(1, Math.sin(th1) / ior));
    return Math.tan(th1 - th2) * (0.35 + hgt);
  }

  function num(style, name, fallback) {
    var v = parseFloat(style.getPropertyValue(name));
    return isNaN(v) ? fallback : v;
  }

  function readLensTokens(el) {
    var s = getComputedStyle(el);
    return {
      bezel: num(s, '--lens-bezel', 28),
      depth: num(s, '--lens-depth', 26),
      ior: num(s, '--lens-ior', 1.5),
      aberration: num(s, '--lens-aberration', 0.12),
      frost: num(s, '--lens-frost', 1.5),
      frostStrong: num(s, '--lens-frost-strong', 7),
      specular: num(s, '--lens-specular', 0.6),
      saturation: num(s, '--lens-saturation', 1.5)
    };
  }

  /* ------------------------------------------------------------------
     svg lens: refracts live page content through backdrop-filter: url().
     chromium only (chrome, edge, electron, webview2 / tauri on windows).
     ------------------------------------------------------------------ */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 0;
  // each entry holds two full-size png data urls; a desktop window resized for
  // hours would otherwise keep every size it ever passed through
  var MAP_CACHE_MAX = 24;
  var mapCache = new Map();

  function mapKey(W, H, R, p) {
    return [W, H, R, p.bezel, p.depth, p.ior, p.specular].join('|');
  }

  function cachedMaps(key) {
    var hit = mapCache.get(key);
    if (hit) { mapCache.delete(key); mapCache.set(key, hit); } // most recent last
    return hit;
  }

  var SVG_LENS = (function () {
    try {
      if (!window.CSS || !CSS.supports('backdrop-filter', 'url(#a)')) return false;
      var brands = navigator.userAgentData && navigator.userAgentData.brands;
      if (brands && brands.some(function (b) { return /Chromium|Chrome|Edge/.test(b.brand); })) return true;
      var ua = navigator.userAgent;
      return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
    } catch (e) {
      return false;
    }
  })();
  document.documentElement.setAttribute('data-lens', SVG_LENS ? 'refract' : 'blur');

  function buildMaps(W, H, R, p) {
    var key = mapKey(W, H, R, p);
    var hit = cachedMaps(key);
    if (hit) return hit;

    var bezel = Math.max(2, Math.min(p.bezel, Math.min(W, H) / 2 - 1));
    var cxm = W / 2, cym = H / 2;
    var hx = W / 2 - R, hy = H / 2 - R;
    var n = W * H;
    var vx = new Float32Array(n), vy = new Float32Array(n), sp = new Float32Array(n);
    var maxD = 0.0001;
    var lx = -0.6, ly = -0.8; // light from the top left
    var rimBend = bend(0.002, p.ior);

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var px = x + 0.5 - cxm, py = y + 0.5 - cym;
        var sx = px < 0 ? -1 : 1, sy = py < 0 ? -1 : 1;
        var qx = Math.abs(px) - hx, qy = Math.abs(py) - hy;
        var nx, ny, dist;
        if (qx > 0 && qy > 0) {
          var len = Math.sqrt(qx * qx + qy * qy);
          dist = len - R;
          nx = sx * qx / len;
          ny = sy * qy / len;
        } else if (qx > qy) {
          dist = qx - R;
          nx = sx; ny = 0;
        } else {
          dist = qy - R;
          nx = 0; ny = sy;
        }
        var d = -dist;
        if (d <= 0 || d >= bezel) continue;
        var t = d / bezel;

        var disp = p.depth * Math.pow(bend(t, p.ior) / rimBend, 0.45);
        vx[i] = -nx * disp;
        vy[i] = -ny * disp;
        if (disp > maxD) maxD = disp;

        var facing = nx * lx + ny * ly;
        var rim = Math.pow(1 - t, 3);
        var edge = d < 1.5 ? 0.9 : 0;
        var key1 = Math.pow(Math.max(0, facing), 1.6);
        var key2 = 0.45 * Math.pow(Math.max(0, -facing), 2);
        sp[i] = Math.min(1, (key1 + key2) * rim * 1.4 + edge * (0.35 + 0.65 * Math.max(key1, key2)));
      }
    }

    var scale = maxD * 2;
    var c1 = document.createElement('canvas');
    c1.width = W; c1.height = H;
    var g1 = c1.getContext('2d');
    var im1 = g1.createImageData(W, H);
    var c2 = document.createElement('canvas');
    c2.width = W; c2.height = H;
    var g2 = c2.getContext('2d');
    var im2 = g2.createImageData(W, H);
    for (var j = 0; j < n; j++) {
      var o = j * 4;
      im1.data[o] = Math.round((0.5 + vx[j] / scale) * 255);
      im1.data[o + 1] = Math.round((0.5 + vy[j] / scale) * 255);
      im1.data[o + 2] = 128;
      im1.data[o + 3] = 255;
      im2.data[o] = 255;
      im2.data[o + 1] = 255;
      im2.data[o + 2] = 255;
      im2.data[o + 3] = Math.round(sp[j] * p.specular * 255);
    }
    g1.putImageData(im1, 0, 0);
    g2.putImageData(im2, 0, 0);
    var out = { disp: c1.toDataURL('image/png'), spec: c2.toDataURL('image/png'), scale: scale };
    mapCache.set(key, out);
    if (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value);
    return out;
  }

  function defsRoot() {
    var svg = document.getElementById('sg-lens-defs');
    if (!svg) {
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('id', 'sg-lens-defs');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.position = 'absolute';
      svg.style.width = '0';
      svg.style.height = '0';
      svg.style.overflow = 'hidden';
      svg.style.pointerEvents = 'none';
      document.body.appendChild(svg);
    }
    return svg;
  }

  function channel(r, g, b) {
    return r + ' 0 0 0 0  0 ' + g + ' 0 0 0  0 0 ' + b + ' 0 0  0 0 0 1 0';
  }

  function writeFilter(id, W, H, maps, p, frost) {
    var root = defsRoot();
    var f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(SVGNS, 'filter');
      f.setAttribute('id', id);
      root.appendChild(f);
    }
    var a = p.aberration;
    var s = maps.scale;
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', String(W));
    f.setAttribute('height', String(H));
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML =
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + frost + '" edgeMode="duplicate" result="frost"/>' +
      '<feImage href="' + maps.disp + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="none" result="map"/>' +
      '<feDisplacementMap in="frost" in2="map" scale="' + (s * (1 + a)).toFixed(2) + '" xChannelSelector="R" yChannelSelector="G" result="dR"/>' +
      '<feDisplacementMap in="frost" in2="map" scale="' + s.toFixed(2) + '" xChannelSelector="R" yChannelSelector="G" result="dG"/>' +
      '<feDisplacementMap in="frost" in2="map" scale="' + (s * (1 - a)).toFixed(2) + '" xChannelSelector="R" yChannelSelector="G" result="dB"/>' +
      '<feColorMatrix in="dR" type="matrix" values="' + channel(1, 0, 0) + '" result="r"/>' +
      '<feColorMatrix in="dG" type="matrix" values="' + channel(0, 1, 0) + '" result="g"/>' +
      '<feColorMatrix in="dB" type="matrix" values="' + channel(0, 0, 1) + '" result="b"/>' +
      '<feComposite in="r" in2="g" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg"/>' +
      '<feComposite in="rg" in2="b" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rgb"/>' +
      '<feColorMatrix in="rgb" type="saturate" values="' + p.saturation + '" result="sat"/>' +
      '<feImage href="' + maps.spec + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="none" result="spec"/>' +
      '<feComposite in="spec" in2="sat" operator="over"/>';
  }

  /* ------------------------------------------------------------------
     gpu lens: a GlassScene renders its backdrop (image, video or canvas)
     on the gpu and refracts it under every glass element inside it.
     webgpu first (wgsl), webgl2 second (glsl), then the svg lens.
     ------------------------------------------------------------------ */
  var MAX_GLASS = 16;
  var UNIFORM_FLOATS = (5 + MAX_GLASS * 2) * 4;

  var WGSL = [
    'struct U { p: array<vec4f, 5>, rects: array<vec4f, 16>, info: array<vec4f, 16> };',
    '@group(0) @binding(0) var<uniform> u: U;',
    '@group(0) @binding(1) var samp: sampler;',
    '@group(0) @binding(2) var tex: texture_2d<f32>;',
    '',
    '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {',
    '  var pos = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));',
    '  return vec4f(pos[i], 0.0, 1.0);',
    '}',
    '',
    'fn backdrop(p: vec2f) -> vec3f {',
    '  let uv = (p - u.p[1].xy) / u.p[1].zw;',
    '  return textureSampleLevel(tex, samp, uv, 0.0).rgb;',
    '}',
    '',
    'fn slopeAt(t: f32) -> f32 {',
    '  let tt = clamp(t, 0.002, 1.0);',
    '  let a = 1.0 - tt;',
    '  let inner = 1.0 - a * a * a * a;',
    '  return a * a * a * pow(inner, -0.75);',
    '}',
    '',
    'fn bend(t: f32, ior: f32) -> f32 {',
    '  let a = 1.0 - t;',
    '  let hgt = pow(max(1.0 - a * a * a * a, 0.0), 0.25);',
    '  let th1 = atan(slopeAt(t));',
    '  let th2 = asin(min(1.0, sin(th1) / ior));',
    '  return tan(th1 - th2) * (0.35 + hgt);',
    '}',
    '',
    'fn frosted(p: vec2f, radius: f32) -> vec3f {',
    '  var acc = backdrop(p);',
    '  if (radius < 0.5) { return acc; }',
    '  for (var k = 0; k < 12; k++) {',
    '    let fk = f32(k);',
    '    let ang = fk * 2.39996;',
    '    let r = radius * sqrt((fk + 0.5) / 12.0);',
    '    acc += backdrop(p + vec2f(cos(ang), sin(ang)) * r);',
    '  }',
    '  return acc / 13.0;',
    '}',
    '',
    '@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {',
    '  let p = fc.xy / u.p[0].z;',
    '  var col = backdrop(p);',
    '  let count = i32(u.p[0].w);',
    '  for (var i = 0; i < 16; i++) {',
    '    if (i >= count) { break; }',
    '    let r = u.rects[i];',
    '    let m = u.info[i];',
    '    let hs = r.zw * 0.5;',
    '    let c = r.xy + hs;',
    '    let rad = min(m.x, min(hs.x, hs.y));',
    '    let lp = p - c;',
    '    let q = abs(lp) - (hs - vec2f(rad));',
    '    let sg = vec2f(select(-1.0, 1.0, lp.x >= 0.0), select(-1.0, 1.0, lp.y >= 0.0));',
    '    var d = 0.0;',
    '    var n = vec2f(0.0, 0.0);',
    '    if (q.x > 0.0 && q.y > 0.0) { let l = length(q); d = l - rad; n = sg * q / l; }',
    '    else if (q.x > q.y) { d = q.x - rad; n = vec2f(sg.x, 0.0); }',
    '    else { d = q.y - rad; n = vec2f(0.0, sg.y); }',
    '    if (d > 0.5) { continue; }',
    '    let inset = -d;',
    '    let bezel = max(2.0, min(u.p[2].w, min(hs.x, hs.y) - 1.0));',
    '    let t = clamp(inset / bezel, 0.0, 1.0);',
    '    var disp = 0.0;',
    '    if (t < 1.0) { disp = u.p[3].x * pow(max(bend(t, u.p[3].y) / u.p[4].w, 0.0), 0.45); }',
    '    let frost = select(u.p[3].w, u.p[4].x, m.y > 0.5);',
    '    let ab = u.p[3].z;',
    '    var g = vec3f(frosted(p - n * disp * (1.0 + ab), frost).r, frosted(p - n * disp, frost).g, frosted(p - n * disp * (1.0 - ab), frost).b);',
    '    let luma = dot(g, vec3f(0.2126, 0.7152, 0.0722));',
    '    g = mix(vec3f(luma), g, u.p[4].z);',
    '    let facing = dot(n, vec2f(-0.6, -0.8));',
    '    let rim = pow(1.0 - t, 3.0);',
    '    let k1 = pow(max(facing, 0.0), 1.6);',
    '    let k2 = 0.45 * pow(max(-facing, 0.0), 2.0);',
    '    let edge = 1.0 - smoothstep(0.0, 1.5, inset);',
    '    var spec = min(1.0, (k1 + k2) * rim * 1.4 + edge * (0.35 + 0.65 * max(k1, k2)));',
    '    if (u.p[2].z > 0.5) {',
    '      let toP = u.p[2].xy - p;',
    '      let dist = max(length(toP), 0.001);',
    '      spec = min(1.0, spec + pow(max(dot(n, toP / dist), 0.0), 2.0) * rim * exp(-dist / 160.0) * 0.9);',
    '    }',
    '    g = mix(g, vec3f(1.0), spec * u.p[4].y);',
    '    col = mix(col, clamp(g, vec3f(0.0), vec3f(1.0)), clamp(0.5 - d, 0.0, 1.0));',
    '    break;',
    '  }',
    '  return vec4f(col, 1.0);',
    '}'
  ].join('\n');

  var GLSL_VS = [
    '#version 300 es',
    'void main() {',
    '  vec2 pos[3] = vec2[3](vec2(-1.0, -3.0), vec2(-1.0, 1.0), vec2(3.0, 1.0));',
    '  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);',
    '}'
  ].join('\n');

  var GLSL_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec4 u_p[5];',
    'uniform vec4 u_rect[16];',
    'uniform vec4 u_meta[16];',
    'uniform sampler2D u_tex;',
    'out vec4 outColor;',
    '',
    'vec3 backdrop(vec2 p) {',
    '  vec2 uv = (p - u_p[1].xy) / u_p[1].zw;',
    '  return textureLod(u_tex, uv, 0.0).rgb;',
    '}',
    '',
    'float slopeAt(float t) {',
    '  float tt = clamp(t, 0.002, 1.0);',
    '  float a = 1.0 - tt;',
    '  float inner = 1.0 - a * a * a * a;',
    '  return a * a * a * pow(inner, -0.75);',
    '}',
    '',
    'float bend(float t, float ior) {',
    '  float a = 1.0 - t;',
    '  float hgt = pow(max(1.0 - a * a * a * a, 0.0), 0.25);',
    '  float th1 = atan(slopeAt(t));',
    '  float th2 = asin(min(1.0, sin(th1) / ior));',
    '  return tan(th1 - th2) * (0.35 + hgt);',
    '}',
    '',
    'vec3 frosted(vec2 p, float radius) {',
    '  vec3 acc = backdrop(p);',
    '  if (radius < 0.5) return acc;',
    '  for (int k = 0; k < 12; k++) {',
    '    float fk = float(k);',
    '    float ang = fk * 2.39996;',
    '    float r = radius * sqrt((fk + 0.5) / 12.0);',
    '    acc += backdrop(p + vec2(cos(ang), sin(ang)) * r);',
    '  }',
    '  return acc / 13.0;',
    '}',
    '',
    'void main() {',
    '  float dpr = u_p[0].z;',
    '  vec2 p = vec2(gl_FragCoord.x, u_p[0].y * dpr - gl_FragCoord.y) / dpr;',
    '  vec3 col = backdrop(p);',
    '  int count = int(u_p[0].w);',
    '  for (int i = 0; i < 16; i++) {',
    '    if (i >= count) break;',
    '    vec4 r = u_rect[i];',
    '    vec4 m = u_meta[i];',
    '    vec2 hs = r.zw * 0.5;',
    '    vec2 c = r.xy + hs;',
    '    float rad = min(m.x, min(hs.x, hs.y));',
    '    vec2 lp = p - c;',
    '    vec2 q = abs(lp) - (hs - vec2(rad));',
    '    vec2 sg = vec2(lp.x >= 0.0 ? 1.0 : -1.0, lp.y >= 0.0 ? 1.0 : -1.0);',
    '    float d;',
    '    vec2 n;',
    '    if (q.x > 0.0 && q.y > 0.0) { float l = length(q); d = l - rad; n = sg * q / l; }',
    '    else if (q.x > q.y) { d = q.x - rad; n = vec2(sg.x, 0.0); }',
    '    else { d = q.y - rad; n = vec2(0.0, sg.y); }',
    '    if (d > 0.5) continue;',
    '    float inset = -d;',
    '    float bezel = max(2.0, min(u_p[2].w, min(hs.x, hs.y) - 1.0));',
    '    float t = clamp(inset / bezel, 0.0, 1.0);',
    '    float disp = 0.0;',
    '    if (t < 1.0) disp = u_p[3].x * pow(max(bend(t, u_p[3].y) / u_p[4].w, 0.0), 0.45);',
    '    float frost = m.y > 0.5 ? u_p[4].x : u_p[3].w;',
    '    float ab = u_p[3].z;',
    '    vec3 g = vec3(frosted(p - n * disp * (1.0 + ab), frost).r, frosted(p - n * disp, frost).g, frosted(p - n * disp * (1.0 - ab), frost).b);',
    '    float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));',
    '    g = mix(vec3(luma), g, u_p[4].z);',
    '    float facing = dot(n, vec2(-0.6, -0.8));',
    '    float rim = pow(1.0 - t, 3.0);',
    '    float k1 = pow(max(facing, 0.0), 1.6);',
    '    float k2 = 0.45 * pow(max(-facing, 0.0), 2.0);',
    '    float edge = 1.0 - smoothstep(0.0, 1.5, inset);',
    '    float spec = min(1.0, (k1 + k2) * rim * 1.4 + edge * (0.35 + 0.65 * max(k1, k2)));',
    '    if (u_p[2].z > 0.5) {',
    '      vec2 toP = u_p[2].xy - p;',
    '      float dist = max(length(toP), 0.001);',
    '      spec = min(1.0, spec + pow(max(dot(n, toP / dist), 0.0), 2.0) * rim * exp(-dist / 160.0) * 0.9);',
    '    }',
    '    g = mix(g, vec3(1.0), spec * u_p[4].y);',
    '    col = mix(col, clamp(g, 0.0, 1.0), clamp(0.5 - d, 0.0, 1.0));',
    '    break;',
    '  }',
    '  outColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function sourceSize(src) {
    if (!src) return null;
    var w = src.videoWidth || src.naturalWidth || src.width;
    var hh = src.videoHeight || src.naturalHeight || src.height;
    return w && hh ? [w, hh] : null;
  }

  function initWebGPU(canvas, onLost) {
    if (!navigator.gpu) return Promise.reject(new Error('no webgpu'));
    return navigator.gpu.requestAdapter().then(function (adapter) {
      if (!adapter) throw new Error('no adapter');
      return adapter.requestDevice();
    }).then(function (device) {
      device.addEventListener('uncapturederror', function (e) { console.error('[santi.glass] webgpu:', e.error && e.error.message); });
      // sleep / resume, a driver update or a laptop switching gpus drops the device
      device.lost.then(function (info) { if (info.reason !== 'destroyed') onLost(); });
      var ctx = canvas.getContext('webgpu');
      if (!ctx) throw new Error('no webgpu context');
      var format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device: device, format: format, alphaMode: 'premultiplied' });
      var module = device.createShaderModule({ code: WGSL });
      var pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: module, entryPoint: 'vs' },
        fragment: { module: module, entryPoint: 'fs', targets: [{ format: format }] },
        primitive: { topology: 'triangle-list' }
      });
      var ubuf = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      var sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      var texture = null, texSize = [0, 0], bindGroup = null;

      function makeTexture(w, hh) {
        if (texture) texture.destroy();
        texture = device.createTexture({
          size: [w, hh],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        texSize = [w, hh];
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: texture.createView() }
          ]
        });
      }
      makeTexture(1, 1);

      return {
        kind: 'webgpu',
        upload: function (src) {
          var sz = sourceSize(src);
          if (!sz) return false;
          if (sz[0] !== texSize[0] || sz[1] !== texSize[1]) makeTexture(sz[0], sz[1]);
          device.queue.copyExternalImageToTexture({ source: src }, { texture: texture }, sz);
          return true;
        },
        draw: function (u) {
          device.queue.writeBuffer(ubuf, 0, u);
          var enc = device.createCommandEncoder();
          var pass = enc.beginRenderPass({
            colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }]
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([enc.finish()]);
        },
        destroy: function () {
          if (texture) texture.destroy();
          ubuf.destroy();
          device.destroy();
        }
      };
    });
  }

  function initWebGL2(canvas) {
    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('no webgl2');
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, GLSL_VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, GLSL_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var locP = gl.getUniformLocation(prog, 'u_p');
    var locR = gl.getUniformLocation(prog, 'u_rect');
    var locM = gl.getUniformLocation(prog, 'u_meta');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    var tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return {
      kind: 'webgl2',
      upload: function (src) {
        if (!sourceSize(src)) return false;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        return true;
      },
      draw: function (u) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform4fv(locP, u.subarray(0, 20));
        gl.uniform4fv(locR, u.subarray(20, 20 + MAX_GLASS * 4));
        gl.uniform4fv(locM, u.subarray(20 + MAX_GLASS * 4));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      destroy: function () {
        var ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    };
  }

  function init2D(canvas) {
    var g = canvas.getContext('2d');
    var src = null;
    return {
      kind: 'none',
      upload: function (s) { src = s; return !!sourceSize(s); },
      draw: function (u) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, canvas.width, canvas.height);
        if (!src) return;
        var dpr = u[2];
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.drawImage(src, u[4], u[5], u[6], u[7]);
      },
      destroy: function () {}
    };
  }

  function createRenderer(wrap, canvas, onEngine, prefer) {
    var R = {
      entries: [],
      source: null,
      live: false,
      fit: 'cover',
      pointer: null,
      dirty: true,
      needsUpload: false,
      gpu: null,
      raf: 0,
      dead: false,
      visible: true,
      last: ''
    };
    var u = new Float32Array(UNIFORM_FLOATS);

    // desktop shells often keep rendering a minimized or tray-hidden window
    // (electron with backgroundThrottling off, webview2): skip every layout read
    // and draw while the scene can't be seen
    var io = window.IntersectionObserver ? new IntersectionObserver(function (list) {
      R.visible = list[list.length - 1].isIntersecting;
      if (R.visible) R.dirty = true;
    }) : null;
    if (io) io.observe(wrap);
    function onVisibility() { if (!document.hidden) R.dirty = true; }
    document.addEventListener('visibilitychange', onVisibility);

    function start(backend) {
      if (R.dead) { if (backend) backend.destroy(); return; }
      R.gpu = backend;
      R.needsUpload = true;
      R.dirty = true;
      onEngine(backend.kind);
    }

    var tryGL = function () {
      try { start(initWebGL2(canvas)); } catch (e) { start(init2D(canvas)); }
    };
    function boot() {
      if (prefer !== 'webgl2' && navigator.gpu) initWebGPU(canvas, onGpuLost).then(start, tryGL);
      else tryGL();
    }
    function onGpuLost() {
      if (R.dead) return;
      console.warn('[santi.glass] webgpu device lost, restarting');
      R.gpu = null;
      boot();
    }
    // webgl2 keeps its canvas: hold the frame until the context comes back
    function onGlLost(e) { e.preventDefault(); R.gpu = null; }
    function onGlRestored() { if (!R.dead) tryGL(); }
    canvas.addEventListener('webglcontextlost', onGlLost);
    canvas.addEventListener('webglcontextrestored', onGlRestored);
    boot();

    function frame() {
      if (R.dead) return;
      R.raf = requestAnimationFrame(frame);
      if (!R.gpu || !R.visible || document.hidden) return;
      var W = wrap.clientWidth, H = wrap.clientHeight;
      if (!W || !H) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var cw = Math.round(W * dpr), ch = Math.round(H * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        R.dirty = true;
      }
      var src = R.source;
      var sz = sourceSize(src);
      if (src && sz && (R.needsUpload || R.live)) {
        if (R.gpu.upload(src)) {
          R.needsUpload = false;
          R.dirty = true;
        }
      }
      var ox = 0, oy = 0, dw = W, dh = H;
      if (sz && R.fit === 'cover') {
        var s = Math.max(W / sz[0], H / sz[1]);
        dw = sz[0] * s;
        dh = sz[1] * s;
        ox = (W - dw) / 2;
        oy = (H - dh) / 2;
      }
      var base = wrap.getBoundingClientRect();
      var tok = R.tokens || (R.tokens = readLensTokens(wrap));
      var sig = [cw, ch, ox, oy, dw, dh, R.pointer ? R.pointer[0] + ',' + R.pointer[1] : '-'];
      var count = 0;
      for (var i = 0; i < R.entries.length && count < MAX_GLASS; i++) {
        var e = R.entries[i];
        var r = e.layer.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        var x = r.left - base.left, y = r.top - base.top;
        var o = 20 + count * 4, m = 20 + MAX_GLASS * 4 + count * 4;
        u[o] = x; u[o + 1] = y; u[o + 2] = r.width; u[o + 3] = r.height;
        if (e.radius == null || e.w !== r.width || e.h !== r.height) {
          e.radius = parseFloat(getComputedStyle(e.layer).borderTopLeftRadius) || 0;
          e.w = r.width;
          e.h = r.height;
        }
        u[m] = e.radius; u[m + 1] = e.strong ? 1 : 0; u[m + 2] = 0; u[m + 3] = 0;
        sig.push(x.toFixed(1), y.toFixed(1), r.width.toFixed(1), r.height.toFixed(1), e.radius, e.strong ? 1 : 0);
        count++;
      }
      var key = sig.join('|');
      if (!R.dirty && key === R.last && !R.live) return;
      R.last = key;
      R.dirty = false;
      u[0] = W; u[1] = H; u[2] = dpr; u[3] = count;
      u[4] = ox; u[5] = oy; u[6] = dw; u[7] = dh;
      u[8] = R.pointer ? R.pointer[0] : 0;
      u[9] = R.pointer ? R.pointer[1] : 0;
      u[10] = R.pointer ? 1 : 0;
      u[11] = tok.bezel;
      u[12] = tok.depth; u[13] = tok.ior; u[14] = tok.aberration; u[15] = tok.frost;
      u[16] = tok.frostStrong; u[17] = tok.specular; u[18] = tok.saturation; u[19] = bend(0.002, tok.ior);
      R.gpu.draw(u);
    }
    R.raf = requestAnimationFrame(frame);

    function move(e) {
      var b = wrap.getBoundingClientRect();
      R.pointer = [e.clientX - b.left, e.clientY - b.top];
    }
    function leave() { R.pointer = null; }
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', leave);

    return {
      setSource: function (src, live, fit) {
        R.live = !!live;
        R.fit = fit || 'cover';
        R.dirty = true;
        if (typeof src === 'string') {
          var img = new Image();
          img.crossOrigin = 'anonymous';
          img.decoding = 'async';
          img.onload = function () {
            if (!window.createImageBitmap) { R.source = img; R.needsUpload = true; return; }
            createImageBitmap(img).then(function (bmp) { R.source = bmp; R.needsUpload = true; }, function () { R.source = img; R.needsUpload = true; });
          };
          img.src = src;
        } else {
          R.source = src || null;
          R.needsUpload = true;
        }
      },
      register: function (entry) {
        R.entries.push(entry);
        R.dirty = true;
        return function () {
          var i = R.entries.indexOf(entry);
          if (i !== -1) R.entries.splice(i, 1);
          R.dirty = true;
        };
      },
      refreshTokens: function () { R.tokens = null; R.dirty = true; },
      destroy: function () {
        R.dead = true;
        cancelAnimationFrame(R.raf);
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onGlLost);
        canvas.removeEventListener('webglcontextrestored', onGlRestored);
        wrap.removeEventListener('pointermove', move);
        wrap.removeEventListener('pointerleave', leave);
        if (R.gpu) R.gpu.destroy();
      }
    };
  }

  var SceneContext = React.createContext(null);

  function GlassScene(p) {
    var wrap = useRef(null);
    var canvas = useRef(null);
    var renderer = useRef(null);
    var eng = useState('pending');

    useLayoutEffect(function () {
      var r = createRenderer(wrap.current, canvas.current, function (kind) { eng[1](kind); }, p.engine);
      renderer.current = r;
      return function () {
        r.destroy();
        renderer.current = null;
      };
    }, [p.engine]);

    useEffect(function () {
      if (renderer.current) renderer.current.setSource(p.backdrop, p.live, p.fit);
    }, [p.backdrop, p.live, p.fit, eng[0]]);

    useEffect(function () {
      if (p.onEngine && eng[0] !== 'pending') p.onEngine(eng[0]);
    }, [eng[0]]);

    var gpuReady = eng[0] === 'webgpu' || eng[0] === 'webgl2';
    var ctx = { engine: eng[0], gpu: gpuReady, renderer: renderer };
    var rest = omit(p, ['backdrop', 'live', 'fit', 'engine', 'onEngine', 'className', 'children']);
    return h(
      'div',
      Object.assign({}, rest, { ref: wrap, className: cx('sg-scene', p.className), 'data-engine': eng[0] }),
      h('canvas', { ref: canvas, className: 'sg-scene-canvas', 'aria-hidden': true }),
      h(SceneContext.Provider, { value: ctx }, h('div', { className: 'sg-scene-content' }, p.children))
    );
  }

  /* ------------------------------------------------------------------
     useLens: picks the gpu scene when the element sits in a GlassScene
     with a live gpu engine, otherwise the svg lens, otherwise css blur.
     ------------------------------------------------------------------ */
  function useLens(ref, opts) {
    var glass = useLiquidGlass()[0];
    var scene = useContext(SceneContext);
    var strong = !!(opts && opts.strong);
    var enabled = !(opts && opts.enabled === false);
    var mode = !glass || !enabled || prefersReducedTransparency()
      ? 'off'
      : scene && scene.gpu
        ? 'gpu'
        : scene && scene.engine === 'pending'
          ? 'wait'
          : SVG_LENS
            ? 'svg'
            : 'off';

    useLayoutEffect(function () {
      var el = ref.current;
      if (!el || mode === 'off' || mode === 'wait') return;
      var layer = document.createElement('span');
      layer.className = 'sg-lens-layer';
      layer.setAttribute('aria-hidden', 'true');
      el.insertBefore(layer, el.firstChild);
      el.classList.add('sg-lens-on');

      if (mode === 'gpu') {
        el.classList.add('sg-lens-gpu');
        var unregister = scene.renderer.current.register({ layer: layer, strong: strong });
        return function () {
          unregister();
          if (layer.parentNode) layer.parentNode.removeChild(layer);
          el.classList.remove('sg-lens-on', 'sg-lens-gpu');
        };
      }

      var id = 'sg-lens-' + (++uid);
      var last = '';
      var maps = null, exact = false, raf = 0, settle = 0;
      // a live window resize reports a new size every frame. building maps is
      // per-pixel work plus two png encodes, so while the size is moving the
      // current maps are stretched to the new box (an attribute rewrite) and
      // rebuilt exactly once it holds still
      function apply(final) {
        var W = Math.round(layer.offsetWidth), H = Math.round(layer.offsetHeight);
        if (W < 4 || H < 4 || W * H > 1600000) return;
        var R = parseFloat(getComputedStyle(layer).borderTopLeftRadius) || 0;
        R = Math.min(R, W / 2, H / 2);
        var p = readLensTokens(el);
        var frost = strong ? p.frostStrong : p.frost;
        var sig = [W, H, R, p.bezel, p.depth, p.ior, p.aberration, frost, p.specular, p.saturation].join('|');
        if (sig === last && (exact || !final)) return;
        var hit = cachedMaps(mapKey(W, H, R, p));
        clearTimeout(settle);
        if (hit || final || !maps) {
          maps = hit || buildMaps(W, H, R, p);
          exact = true;
        } else {
          exact = false;
          settle = setTimeout(function () { apply(true); }, 160);
        }
        last = sig;
        writeFilter(id, W, H, maps, p, frost);
        layer.style.backdropFilter = 'url(#' + id + ')';
        layer.style.webkitBackdropFilter = 'url(#' + id + ')';
      }
      function schedule() {
        if (!raf) raf = requestAnimationFrame(function () { raf = 0; apply(false); });
      }
      function move(e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      }
      function enter() { el.classList.add('is-lit'); }
      function leave() { el.classList.remove('is-lit'); }
      apply(true);
      var ro = new ResizeObserver(schedule);
      ro.observe(el);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerenter', enter);
      el.addEventListener('pointerleave', leave);
      return function () {
        ro.disconnect();
        cancelAnimationFrame(raf);
        clearTimeout(settle);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerenter', enter);
        el.removeEventListener('pointerleave', leave);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
        el.classList.remove('sg-lens-on', 'is-lit');
        var f = document.getElementById(id);
        if (f && f.parentNode) f.parentNode.removeChild(f);
      };
    }, [mode, strong]);
  }

  /* ------------------------------------------------------------------
     icons
     ------------------------------------------------------------------ */
  var PATHS = {
    house: 'M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5.5h-5V21H5a1 1 0 0 1-1-1z',
    search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20',
    sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
    person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
    bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4',
    wifi: 'M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a7.5 7.5 0 0 1 11 0M9.5 16a3 3 0 0 1 5 0M12 19.2v.1',
    moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z',
    music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
    lock: 'M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    plus: 'M12 5v14M5 12h14',
    drop: 'M12 3.5c3.5 4.2 6 7.6 6 10.5a6 6 0 0 1-12 0c0-2.9 2.5-6.3 6-10.5z',
    play: 'M8 5.5v13l10.5-6.5z',
    chevron: 'M9.5 6l6 6-6 6'
  };

  function Icon(p) {
    var size = p.size || 22;
    return h(
      'svg',
      {
        className: cx('sg-icon', p.className),
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: p.weight || 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        role: p.label ? 'img' : undefined,
        'aria-label': p.label,
        'aria-hidden': p.label ? undefined : true
      },
      h('path', { d: PATHS[p.name] || '' })
    );
  }

  /* ------------------------------------------------------------------
     components
     ------------------------------------------------------------------ */
  function Switch(p) {
    var st = useControl(p.checked, !!p.defaultChecked, p.onChange);
    return h(
      'label',
      { className: cx('sg-switch', p.className) },
      p.label ? h('span', { className: 'sg-switch-label' }, p.label) : null,
      h('input', {
        type: 'checkbox',
        role: 'switch',
        checked: st[0],
        disabled: p.disabled,
        'aria-label': p.label ? undefined : p['aria-label'],
        onChange: function (e) { st[1](e.target.checked); }
      }),
      h('span', { className: 'sg-switch-track', 'aria-hidden': true }, h('span', { className: 'sg-switch-knob' }))
    );
  }

  function GlassToggle(p) {
    var g = useLiquidGlass();
    return h(Switch, {
      label: p.label === undefined ? 'Liquid Glass' : p.label,
      'aria-label': p['aria-label'] || 'Liquid Glass',
      checked: g[0],
      className: p.className,
      onChange: function (v) {
        g[1](v);
        if (p.onChange) p.onChange(v);
      }
    });
  }

  function Button(p) {
    var ref = useRef(null);
    var variant = p.variant || 'filled';
    var size = p.size || 'regular';
    useLens(ref, { enabled: variant === 'glass' });
    var rest = omit(p, ['variant', 'size', 'className', 'children', 'icon']);
    return h(
      'button',
      Object.assign({ type: 'button' }, rest, {
        ref: ref,
        className: cx('sg-btn', 'sg-btn-' + variant, 'sg-btn-' + size, variant === 'glass' && 'sg-glass', p.className)
      }),
      p.icon ? h(Icon, { name: p.icon, size: size === 'small' ? 16 : 19, weight: 2 }) : null,
      p.children
    );
  }

  function GlassCard(p) {
    var ref = useRef(null);
    var strong = p.strength === 'strong';
    useLens(ref, { strong: strong });
    var rest = omit(p, ['strength', 'className', 'children', 'as']);
    return h(
      p.as || 'div',
      Object.assign({}, rest, {
        ref: ref,
        className: cx('sg-glass', 'sg-card', strong && 'sg-glass-strong', p.className)
      }),
      p.children
    );
  }

  function SegmentedControl(p) {
    var options = p.options || [];
    var st = useControl(p.value, p.defaultValue !== undefined ? p.defaultValue : options[0], p.onChange);
    var index = Math.max(0, options.indexOf(st[0]));
    return h(
      'div',
      {
        className: cx('sg-seg', p.className),
        role: 'radiogroup',
        'aria-label': p['aria-label'],
        style: { '--n': options.length, '--i': index }
      },
      h('span', { className: 'sg-seg-thumb', 'aria-hidden': true }),
      options.map(function (o) {
        var on = o === st[0];
        return h(
          'button',
          {
            key: o,
            type: 'button',
            role: 'radio',
            'aria-checked': on,
            className: cx('sg-seg-item', on && 'is-on'),
            onClick: function () { st[1](o); }
          },
          o
        );
      })
    );
  }

  function Slider(p) {
    var min = p.min == null ? 0 : p.min;
    var max = p.max == null ? 100 : p.max;
    var st = useControl(p.value, p.defaultValue == null ? (min + max) / 2 : p.defaultValue, p.onChange);
    var pct = ((st[0] - min) / (max - min)) * 100;
    return h(
      'div',
      { className: cx('sg-slider', p.className) },
      p.minIcon ? h(Icon, { name: p.minIcon, size: 18 }) : null,
      h('input', {
        type: 'range',
        min: min,
        max: max,
        step: p.step || 1,
        value: st[0],
        'aria-label': p['aria-label'],
        style: { '--pct': pct + '%' },
        onChange: function (e) { st[1](Number(e.target.value)); }
      }),
      p.maxIcon ? h(Icon, { name: p.maxIcon, size: 22 }) : null
    );
  }

  function SearchField(p) {
    var ref = useRef(null);
    useLens(ref, { strong: true });
    var st = useControl(p.value, p.defaultValue || '', p.onChange);
    var placeholder = p.placeholder || 'Search';
    return h(
      'label',
      { ref: ref, className: cx('sg-search', 'sg-glass', 'sg-glass-strong', p.className) },
      h(Icon, { name: 'search', size: 18, weight: 2 }),
      h('input', {
        type: 'search',
        value: st[0],
        placeholder: placeholder,
        'aria-label': placeholder,
        onChange: function (e) { st[1](e.target.value); }
      })
    );
  }

  function List(p) {
    var ref = useRef(null);
    useLens(ref, { strong: true, enabled: !!p.glass });
    return h(
      'section',
      { className: cx('sg-list-wrap', p.className) },
      p.header ? h('h3', { className: 'sg-list-header' }, p.header) : null,
      h('div', { ref: ref, className: cx('sg-list', p.glass && 'sg-glass sg-glass-strong') }, p.children),
      p.footer ? h('p', { className: 'sg-list-footer' }, p.footer) : null
    );
  }

  function ListRow(p) {
    var accessory = p.accessory === undefined ? 'chevron' : p.accessory;
    var isButton = typeof p.onClick === 'function';
    var icon = null;
    if (p.icon) {
      icon = h(
        'span',
        { className: 'sg-row-icon', style: { background: p.iconColor || 'var(--accent)' } },
        typeof p.icon === 'string' ? h(Icon, { name: p.icon, size: 18, weight: 2 }) : p.icon
      );
    }
    var tail = null;
    if (accessory === 'chevron') tail = h(Icon, { name: 'chevron', size: 16, weight: 2.2, className: 'sg-row-chevron' });
    else if (accessory !== 'none') tail = accessory;
    return h(
      isButton ? 'button' : 'div',
      {
        className: cx('sg-row', p.icon && 'has-icon', isButton && 'is-button', p.className),
        type: isButton ? 'button' : undefined,
        onClick: p.onClick
      },
      icon,
      h(
        'span',
        { className: 'sg-row-text' },
        h('span', { className: 'sg-row-title' }, p.title),
        p.subtitle ? h('span', { className: 'sg-row-subtitle' }, p.subtitle) : null
      ),
      p.detail ? h('span', { className: 'sg-row-detail' }, p.detail) : null,
      tail
    );
  }

  function TabBar(p) {
    var ref = useRef(null);
    useLens(ref, { strong: true });
    var items = p.items || [];
    var st = useControl(p.value, p.defaultValue !== undefined ? p.defaultValue : items[0] && items[0].id, p.onChange);
    return h(
      'nav',
      { ref: ref, className: cx('sg-tabbar', 'sg-glass', 'sg-glass-strong', p.className), 'aria-label': p['aria-label'] || 'Tabs' },
      items.map(function (it) {
        var on = it.id === st[0];
        return h(
          'button',
          {
            key: it.id,
            type: 'button',
            className: cx('sg-tab', on && 'is-on'),
            'aria-current': on ? 'page' : undefined,
            onClick: function () { st[1](it.id); }
          },
          h(Icon, { name: it.icon, size: 24 }),
          h('span', { className: 'sg-tab-label' }, it.label)
        );
      })
    );
  }

  window.SantiGlass = Object.assign(window.SantiGlass || {}, {
    GlassToggle: GlassToggle,
    GlassScene: GlassScene,
    Button: Button,
    GlassCard: GlassCard,
    Switch: Switch,
    SegmentedControl: SegmentedControl,
    Slider: Slider,
    SearchField: SearchField,
    List: List,
    ListRow: ListRow,
    TabBar: TabBar,
    Icon: Icon,
    useLiquidGlass: useLiquidGlass,
    useLens: useLens,
    getLiquidGlass: getLiquidGlass,
    setLiquidGlass: setLiquidGlass,
    subscribeLiquidGlass: subscribeLiquidGlass,
    syncWindowGlass: syncWindowGlass,
    syncTauriWindowGlass: syncWindowGlass, // older name, same function
    lensSupported: SVG_LENS,
    gpuSupported: { webgpu: !!navigator.gpu, webgl2: (function () { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })() },
    isTauri: IS_TAURI,
    isElectron: IS_ELECTRON
  });
})();
