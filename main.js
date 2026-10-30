/* =====================================================================
 * AP2 · 三维层级场景：太阳系
 * 原生 WebGL2 + MV.js（教材 Common/ 工具库）
 * 核心要点：层级建模（矩阵逐层相乘）、手动矩阵（Ch4 推导）、
 * 双投影对比、相机漫游、参数面板、选做 E1(完整太阳系) / E3(轨迹球)
 * ===================================================================== */
"use strict";

/* ---------- 1. 天体参数集中配置（半径/距离/周期，便于统一调整） ---------- */
const BASE_DAYS_PER_SEC = 26;   // 动画推进的模拟天数/秒（控制整体公转速度）

const SYSTEM = {
  sun: { name: "太阳", tex: "textures/sun.jpg", radius: 1.0, spin: 8.0 },
  /* spin 为可视化显示周期（天），非真实自转周期；负值表示逆向自转 */
  planets: [
    { name: "水星", tex: "textures/mercury.jpg", radius: 0.10, orbit: 1.85, period: 88.0,   spin: 40,  tilt: 0.03 },
    { name: "金星", tex: "textures/venus.jpg",   radius: 0.16, orbit: 2.45, period: 224.7, spin: -90, tilt: 177.4 },
    { name: "地球", tex: "textures/earth_day.jpg",radius: 0.175, orbit: 3.15, period: 365.25, spin: 60, tilt: 23.5,
      moon: { name: "月球", tex: "textures/moon.jpg", radius: 0.048, orbit: 0.42, period: 27.3, tilt: 5.1, spin: 50 } },
    { name: "火星", tex: "textures/mars.jpg",    radius: 0.135, orbit: 4.0,  period: 687.0, spin: 45,  tilt: 25.2 },
    { name: "木星", tex: "textures/jupiter.jpg", radius: 0.52,  orbit: 5.5,  period: 4333,  spin: 28,  tilt: 3.1 },
    { name: "土星", tex: "textures/saturn.jpg",  radius: 0.44,  orbit: 7.0,  period: 10759, spin: 35,  tilt: 26.7,
      ring: { inner: 0.62, outer: 1.35, tex: "textures/saturn_ring.png" } },
    { name: "天王星", tex: "textures/uranus.jpg",radius: 0.30, orbit: 8.6,  period: 30687, spin: -70, tilt: 97.8 },
    { name: "海王星", tex: "textures/neptune.jpg",radius: 0.29, orbit: 9.9, period: 60190, spin: 50,  tilt: 28.3 }
  ],
  asteroidBelt: { inner: 4.55, outer: 5.05, count: 1200 }
};

/* 相机漫游预设路径：绕场景一周（方位角 + 高度起伏的关键帧插值） */
const TOUR = { radius: 17, height: 5, amp: 5, periodSec: 12, target: [0, 0, 0] };

/* ---------- 2. 全局状态 ---------- */
let gl, canvas, program, orbitProgram, asteroidProgram;
let uniforms = {}, orbitUniforms = {}, astUniforms = {};
let sphereGeo, ringGeo, beltGeo;
let texCache = {};
let camera = {
  eye: vec3(TOUR.radius, TOUR.height, 0),
  target: vec3(0, 0, 0),
  up: vec3(0, 1, 0),
  view: mat4(), proj: mat4(),
  mode: "tour",          // 'tour' 自动漫游 / 'free' 自由拖拽
  t: 0, paused: false,
  blend: 0, blendFrom: null
};
let projection = { isPersp: true, fovy: 55 };
let simDays = 0, lastNow = 0;
let spinFactor = 1, orbitFactor = 1;
let tiltOverride = 23.5;
let showOrbit = true, animPaused = false, tourPaused = false;
let pickables = [];
let selected = "太阳";
let drag = { active: false, lx: 0, ly: 0, moved: false };
let sphereVAO, orbitVAO, orbitBuf, beltBuf, ringVAO;

/* ---------- 3. 手动矩阵（教材 Ch4 基本旋转变换的手工构造） ----------
 * WebGL 中 MV.js 的 mat4 为列主序（column-major）数组。
 * 绕 X 轴旋转 R_x(θ)，按列主序手写为：
 *   第0列 [1,0,0,0]  第1列 [0,cosθ,sinθ,0]
 *   第2列 [0,-sinθ,cosθ,0]  第3列 [0,0,0,1]
 * 绕 Y 轴旋转 R_y(θ) 列主序：
 *   第0列 [cosθ,0,-sinθ,0]  第1列 [0,1,0,0]
 *   第2列 [sinθ,0,cosθ,0]  第3列 [0,0,0,1]
 * 平移 T(x,y,z) 列主序：
 *   第3列 [x,y,z,1]
 * 说明：这里不调用 MV.js 的 rotate/translate 封装，而是按 Ch4 推导
 * 直接写出矩阵元素，再用 MV.js 的 mult 组合（用于月球轨道面倾角）。
 */
function makeRotateX(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return mat4(1, 0, 0, 0,  0, c, s, 0,  0, -s, c, 0,  0, 0, 0, 1);
}
function makeRotateY(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return mat4(c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1);
}
function makeTranslate(x, y, z) {
  return mat4(1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  x, y, z, 1);
}

/* ---------- 4. 着色器（定义在 index.html 的 <script type="x-shader/…"> 标签中，
 * 由教材工具库 initShaders.js 通过 getElementById(id).text 读取） ---------- */

/* ---------- 5. 几何生成 ---------- */
function createSphere(r, stacks, slices) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= stacks; i++) {
    const v = i / stacks, phi = (v - 0.5) * Math.PI;
    for (let j = 0; j <= slices; j++) {
      const u = j / slices, theta = u * 2 * Math.PI;
      const x = r * Math.cos(phi) * Math.cos(theta);
      const y = r * Math.sin(phi);
      const z = r * Math.cos(phi) * Math.sin(theta);
      pos.push(x, y, z);
      nor.push(x / r, y / r, z / r);
      uv.push(u, v);
    }
  }
  for (let i = 0; i < stacks; i++)
    for (let j = 0; j < slices; j++) {
      const a = i * (slices + 1) + j, b = a + slices + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return { pos, nor, uv, idx, count: idx.length };
}
function createRing(inner, outer, slices) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let j = 0; j <= slices; j++) {
    const a = (j / slices) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    pos.push(inner * c, inner * s, 0);  uv.push(j / slices, 0);
    pos.push(outer * c, outer * s, 0);  uv.push(j / slices, 1);
    nor.push(0, 0, 1, 0, 0, 1);
  }
  for (let j = 0; j < slices; j++) {
    const a = j * 2, b = a + 2, c2 = a + 1, d = a + 3;
    idx.push(a, b, c2, b, d, c2);
  }
  return { pos, nor, uv, idx, count: idx.length };
}
function createBelt(inner, outer, count) {
  const pos = [], ang = [];
  for (let i = 0; i < count; i++) {
    const r = inner + Math.random() * (outer - inner);
    const a = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 0.22;
    pos.push(r * Math.cos(a), y, r * Math.sin(a));
    ang.push({ a0: a, r: r, w: 0.2 + Math.random() * 1.2 });
  }
  return { pos, ang };
}

/* ---------- 6. 纹理加载 ----------
 * 行星纹理常见上下颠倒问题：WebGL 纹理坐标原点在左下角，而位图数据
 * 第一行对应图片顶部（左上原点）。gl.UNPACK_FLIP_Y_WEBGL = 1 会在上传
 * 时把图片上下翻转，使 v=1 对应图片顶部（北极），从而显示正确。
 * 土星环为程序生成的径向剖面位图，其 v=0 已对应内缘，无需翻转。
 */
function loadTexture(url, flipY, done) {
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = function () {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY ? 1 : 0);
    const fmt = url.indexOf("ring") >= 0 ? gl.RGBA : gl.RGB;
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, fmt, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    done(tex);
  };
  img.onerror = function () { done(null); };
  img.src = url;
}

/* ---------- 7. 向量工具 ---------- */
function toArr(v) { return Array.isArray(v) ? v : Array.from(v); }
function vecLen(v) { v = toArr(v); return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function vecNorm(v) { v = toArr(v); const l = vecLen(v) || 1; return vec3(v[0]/l, v[1]/l, v[2]/l); }
function vecSub(a, b) { a = toArr(a); b = toArr(b); return vec3(a[0]-b[0], a[1]-b[1], a[2]-b[2]); }
function vecAdd(a, b) { a = toArr(a); b = toArr(b); return vec3(a[0]+b[0], a[1]+b[1], a[2]+b[2]); }
function vecCross(a, b) { a = toArr(a); b = toArr(b);
  return vec3(a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]); }
function vecDot(a, b) { a = toArr(a); b = toArr(b); return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vecScale(a, s) { a = toArr(a); return vec3(a[0]*s, a[1]*s, a[2]*s); }
/* Rodrigues 旋转：绕轴 k 旋转角度 θ */
function rotateVec(v, k, theta) {
  v = toArr(v); k = vecNorm(k);
  const c = Math.cos(theta), s = Math.sin(theta);
  const kv = vecCross(k, v), kk = vecScale(k, vecDot(k, v));
  return vec3(v[0]*c + kv[0]*s + kk[0]*(1-c), v[1]*c + kv[1]*s + kk[1]*(1-c), v[2]*c + kv[2]*s + kk[2]*(1-c));
}
function setupBuffer(target, data, size) {
  const buf = gl.createBuffer();
  gl.bindBuffer(target, buf);
  gl.bufferData(target, new Float32Array(data), gl.STATIC_DRAW);
  return buf;
}

/* ---------- 8. 初始化 ---------- */
function initGL() {
  canvas = document.getElementById("glcanvas");
  gl = canvas.getContext("webgl2", { antialias: true, depth: true });
  if (!gl) { document.body.innerHTML = "<p style='color:#fff'>当前浏览器不支持 WebGL2。</p>"; return false; }
  program = initShaders(gl, "main-vs", "main-fs");
  uniforms.aPosition = gl.getAttribLocation(program, "aPosition");
  uniforms.aNormal = gl.getAttribLocation(program, "aNormal");
  uniforms.aTexCoord = gl.getAttribLocation(program, "aTexCoord");
  uniforms.uModelMatrix = gl.getUniformLocation(program, "uModelMatrix");
  uniforms.uViewMatrix = gl.getUniformLocation(program, "uViewMatrix");
  uniforms.uProjectionMatrix = gl.getUniformLocation(program, "uProjectionMatrix");
  uniforms.uTexture = gl.getUniformLocation(program, "uTexture");
  uniforms.uLightDir = gl.getUniformLocation(program, "uLightDir");
  uniforms.uCamPos = gl.getUniformLocation(program, "uCamPos");
  uniforms.uEmissive = gl.getUniformLocation(program, "uEmissive");
  uniforms.uAlphaMode = gl.getUniformLocation(program, "uAlphaMode");

  orbitProgram = initShaders(gl, "orbit-vs", "orbit-fs");
  orbitUniforms.aPosition = gl.getAttribLocation(orbitProgram, "aPosition");
  orbitUniforms.uViewMatrix = gl.getUniformLocation(orbitProgram, "uViewMatrix");
  orbitUniforms.uProjectionMatrix = gl.getUniformLocation(orbitProgram, "uProjectionMatrix");
  orbitUniforms.uColor = gl.getUniformLocation(orbitProgram, "uColor");

  asteroidProgram = initShaders(gl, "ast-vs", "ast-fs");
  astUniforms.aPosition = gl.getAttribLocation(asteroidProgram, "aPosition");
  astUniforms.uViewMatrix = gl.getUniformLocation(asteroidProgram, "uViewMatrix");
  astUniforms.uProjectionMatrix = gl.getUniformLocation(asteroidProgram, "uProjectionMatrix");
  astUniforms.uPointSize = gl.getUniformLocation(asteroidProgram, "uPointSize");
  astUniforms.uColor = gl.getUniformLocation(asteroidProgram, "uColor");

  sphereGeo = createSphere(1, 32, 48);
  beltGeo = createBelt(SYSTEM.asteroidBelt.inner, SYSTEM.asteroidBelt.outer, SYSTEM.asteroidBelt.count);

  gl.clearColor(0.02, 0.03, 0.06, 1.0);
  gl.enable(gl.DEPTH_TEST);
  resize();
  window.addEventListener("resize", resize);
  return true;
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w; canvas.height = h;
  gl.viewport(0, 0, w, h);
}

/* ---------- 9. 缓冲 / VAO 构建 ---------- */
function buildSphereVAO() {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  setupBuffer(gl.ARRAY_BUFFER, sphereGeo.pos, 3);
  gl.enableVertexAttribArray(uniforms.aPosition);
  gl.vertexAttribPointer(uniforms.aPosition, 3, gl.FLOAT, false, 0, 0);
  setupBuffer(gl.ARRAY_BUFFER, sphereGeo.nor, 3);
  gl.enableVertexAttribArray(uniforms.aNormal);
  gl.vertexAttribPointer(uniforms.aNormal, 3, gl.FLOAT, false, 0, 0);
  setupBuffer(gl.ARRAY_BUFFER, sphereGeo.uv, 2);
  gl.enableVertexAttribArray(uniforms.aTexCoord);
  gl.vertexAttribPointer(uniforms.aTexCoord, 2, gl.FLOAT, false, 0, 0);
  const bIdx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(sphereGeo.idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  sphereVAO = vao;
}
function buildOrbitVAO() {
  const pts = [];
  const N = 128;
  for (const p of SYSTEM.planets) {
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * 2 * Math.PI;
      pts.push(p.orbit * Math.cos(a), 0, p.orbit * Math.sin(a));
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  orbitBuf = setupBuffer(gl.ARRAY_BUFFER, pts, 3);
  gl.enableVertexAttribArray(orbitUniforms.aPosition);
  gl.vertexAttribPointer(orbitUniforms.aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  orbitVAO = vao;
}
function buildRingVAO() {
  const sat = SYSTEM.planets.find(p => p.ring);
  ringGeo = createRing(sat.ring.inner, sat.ring.outer, 64);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  setupBuffer(gl.ARRAY_BUFFER, ringGeo.pos, 3);
  gl.enableVertexAttribArray(uniforms.aPosition);
  gl.vertexAttribPointer(uniforms.aPosition, 3, gl.FLOAT, false, 0, 0);
  setupBuffer(gl.ARRAY_BUFFER, ringGeo.nor, 3);
  gl.enableVertexAttribArray(uniforms.aNormal);
  gl.vertexAttribPointer(uniforms.aNormal, 3, gl.FLOAT, false, 0, 0);
  setupBuffer(gl.ARRAY_BUFFER, ringGeo.uv, 2);
  gl.enableVertexAttribArray(uniforms.aTexCoord);
  gl.vertexAttribPointer(uniforms.aTexCoord, 2, gl.FLOAT, false, 0, 0);
  const bIdx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ringGeo.idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  ringVAO = vao;
}
function buildBeltBuf() {
  beltBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, beltBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(beltGeo.pos), gl.DYNAMIC_DRAW);
}

/* ---------- 10. 相机：漫游路径 + 轨迹球拖拽 ---------- */
function tourPos(t) {
  const a = t * 2 * Math.PI;
  const y = TOUR.height + TOUR.amp * Math.sin(3 * Math.PI * t);
  return vec3(TOUR.radius * Math.cos(a), y, TOUR.radius * Math.sin(a));
}
function updateCamera(dt) {
  if (camera.mode === "tour" && !tourPaused && !animPaused) {
    camera.t = (camera.t + dt / TOUR.periodSec) % 1;
    const pe = tourPos(camera.t), pt = vec3(TOUR.target[0], TOUR.target[1], TOUR.target[2]);
    if (camera.blend > 0) {
      camera.blend -= dt;
      const k = Math.max(0, Math.min(1, 1 - camera.blend / 0.8));
      camera.eye = vecAdd(vecScale(camera.blendFrom.eye, 1 - k), vecScale(pe, k));
      camera.target = vecAdd(vecScale(camera.blendFrom.target, 1 - k), vecScale(pt, k));
    } else { camera.eye = pe; camera.target = pt; }
  }
  camera.up = vec3(0, 1, 0);
}

/* ---------- 11. 绘制 ---------- */
function drawSphere(tex, model, emissive, alphaMode) {
  if (!tex) return;
  gl.useProgram(program);
  gl.uniformMatrix4fv(uniforms.uModelMatrix, false, flatten(model));
  gl.uniformMatrix4fv(uniforms.uViewMatrix, false, flatten(camera.view));
  gl.uniformMatrix4fv(uniforms.uProjectionMatrix, false, flatten(camera.proj));
  gl.uniform1i(uniforms.uTexture, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform3f(uniforms.uLightDir, 0, 0, 0);
  gl.uniform3f(uniforms.uCamPos, camera.eye[0], camera.eye[1], camera.eye[2]);
  gl.uniform1f(uniforms.uEmissive, emissive ? 1 : 0);
  gl.uniform1f(uniforms.uAlphaMode, alphaMode ? 1 : 0);
  const vao = alphaMode ? ringVAO : sphereVAO;
  const geo = alphaMode ? ringGeo : sphereGeo;
  if (alphaMode) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
  gl.bindVertexArray(vao);
  gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
  gl.bindVertexArray(null);
  if (alphaMode) { gl.disable(gl.BLEND); gl.depthMask(true); }
}

/* 逐层绘制场景：parentModel 为父节点世界矩阵（层级嵌套的关键） */
function drawNode(node, parentModel, tDays) {
  let model;
  if (node.isSun) {
    const m = mult(makeRotateY((tDays / node.spin) * 2 * Math.PI), scalem(node.radius, node.radius, node.radius));
    model = mult(parentModel, m);
    drawSphere(texCache[node.tex], model, true, false);
  } else {
    const ang = (tDays / node.period) * 2 * Math.PI;
    const pos = vec3(Math.cos(ang) * node.orbit, 0, Math.sin(ang) * node.orbit);
    /* 轴倾角：滑条只作用于地球（演示先转后挂）；其余行星用各自真实倾角 */
    const tiltDeg = node.name === "地球" ? tiltOverride : node.tilt;
    /* 自身局部变换（先转后挂）：最内层先绕局部 Y 自转，再绕 X 施加轴倾角
       （自转轴随之倾斜），再缩放；最后被公转轨道变换整体搬移 */
    const local = mult(mult(scalem(node.radius, node.radius, node.radius),
                     makeRotateX(tiltDeg * Math.PI / 180)),
                     makeRotateY(spinAng(node, tDays) * spinFactor));
    model = mult(parentModel, mult(makeTranslate(pos[0], pos[1], pos[2]), local));

    pickables.push({ name: node.name, pos: [model[3][0], model[3][1], model[3][2]], radius: node.radius });
    drawSphere(texCache[node.tex], model, false, false);
    if (node.ring && texCache[node.ring.tex]) drawSphere(texCache[node.ring.tex], model, false, true);
  }
  if (node.moon) drawMoon(node.moon, model, tDays);
  if (node.isSun) for (const p of SYSTEM.planets) drawNode(p, model, tDays);
}
function spinAng(node, tDays) { return (tDays / Math.abs(node.spin)) * 2 * Math.PI * Math.sign(node.spin); }

function drawMoon(moon, earthModel, tDays) {
  const ang = (tDays / moon.period) * 2 * Math.PI;
  const pos = vec3(Math.cos(ang) * moon.orbit, 0, Math.sin(ang) * moon.orbit);
  /* 月球轨道面倾角：手动矩阵构造（makeRotateX），挂在地球之下。变换顺序
     —— 先用手写矩阵倾斜轨道参考系，再平移至轨道位置、自转、缩放，
     体现"变换顺序决定结构"（教材 Ch4） */
  const moonLocal = mult(scalem(moon.radius, moon.radius, moon.radius), makeRotateY((tDays / moon.spin) * 2 * Math.PI));
  const model = mult(earthModel, mult(makeRotateX(moon.tilt * Math.PI / 180),
                        mult(makeTranslate(pos[0], pos[1], pos[2]), moonLocal)));
  pickables.push({ name: moon.name, pos: [model[3][0], model[3][1], model[3][2]], radius: moon.radius });
  drawSphere(texCache[moon.tex], model, false, false);
}

/* 轨道线（世界坐标固定圆环，逐行星绘制，独立着色器纯色） */
function drawOrbitLines() {
  if (!showOrbit) return;
  gl.useProgram(orbitProgram);
  gl.uniformMatrix4fv(orbitUniforms.uViewMatrix, false, flatten(camera.view));
  gl.uniformMatrix4fv(orbitUniforms.uProjectionMatrix, false, flatten(camera.proj));
  gl.uniform4f(orbitUniforms.uColor, 0.30, 0.42, 0.65, 0.9);
  gl.bindVertexArray(orbitVAO);
  const N = 129;
  for (let i = 0; i < SYSTEM.planets.length; i++) gl.drawArrays(gl.LINE_LOOP, i * N, N);
  gl.bindVertexArray(null);
}

/* 小行星带（选做 E1）：点精灵，绕太阳缓慢公转 */
function drawBelt(tDays) {
  const pos = new Float32Array(beltGeo.pos.length);
  for (let i = 0; i < beltGeo.ang.length; i++) {
    const b = beltGeo.ang[i];
    const a = b.a0 + (tDays / 1200) * b.w * 2 * Math.PI;
    pos[i * 3] = b.r * Math.cos(a);
    pos[i * 3 + 1] = beltGeo.pos[i * 3 + 1];
    pos[i * 3 + 2] = b.r * Math.sin(a);
  }
  gl.useProgram(asteroidProgram);
  gl.uniformMatrix4fv(astUniforms.uViewMatrix, false, flatten(camera.view));
  gl.uniformMatrix4fv(astUniforms.uProjectionMatrix, false, flatten(camera.proj));
  gl.uniform1f(astUniforms.uPointSize, 2.2);
  gl.uniform4f(astUniforms.uColor, 0.62, 0.56, 0.48, 1.0);
  gl.bindBuffer(gl.ARRAY_BUFFER, beltBuf);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(astUniforms.aPosition);
  gl.vertexAttribPointer(astUniforms.aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.POINTS, 0, beltGeo.ang.length);
}

/* ---------- 12. 拾取（近似：投影中心到屏幕距离） ---------- */
function projectToScreen(worldPos) {
  const T = makeTranslate(worldPos[0], worldPos[1], worldPos[2]);
  const clip = mult(camera.proj, mult(camera.view, T));
  const w = clip[3][3], ndx = clip[3][0] / w, ndy = clip[3][1] / w;
  return [(ndx * 0.5 + 0.5) * canvas.width, (1 - (ndy * 0.5 + 0.5)) * canvas.height];
}
function pick(px, py) {
  let best = null, bestD = 1e9;
  for (const p of pickables) {
    const s = projectToScreen(p.pos);
    const d = Math.hypot(s[0] - px, s[1] - py);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best && bestD < 42) { selected = best.name; updateHud(); }
}

/* ---------- 13. 交互事件 ---------- */
function bindEvents() {
  window.addEventListener("keydown", function (e) {
    if (e.code === "Space") {
      e.preventDefault();
      if (camera.mode === "tour") tourPaused = !tourPaused;
      else resumeTour();
      updateHud();
    } else if (e.code === "KeyO") {
      projection.isPersp = !projection.isPersp;
      document.getElementById("mode").innerHTML =
        "投影模式：<b>" + (projection.isPersp ? "透视 (Perspective)" : "正交 (Orthographic)") +
        "</b>　[O 切换]";
    } else if (e.code === "KeyR") { resetCamera(); }
  });
  canvas.addEventListener("mousedown", function (e) {
    drag.active = true; drag.moved = false;
    drag.lx = e.clientX; drag.ly = e.clientY;
    camera.mode = "free";
  });
  window.addEventListener("mousemove", function (e) {
    if (!drag.active) return;
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
    drag.lx = e.clientX; drag.ly = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    /* 虚拟轨迹球（选做 E3）：屏幕位移 → 绕场景的旋转轴与角度 */
    const dir = vecSub(camera.eye, camera.target);
    const dist = vecLen(dir);
    const axis = vec3(-dy, -dx, 0);
    const angle = 0.006 * Math.sqrt(dx * dx + dy * dy);
    camera.eye = vecAdd(camera.target, vecScale(vecNorm(rotateVec(dir, axis, angle)), dist));
  });
  window.addEventListener("mouseup", function (e) {
    if (drag.active && !drag.moved) pick(e.clientX, e.clientY);
    drag.active = false;
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    const dir = vecSub(camera.eye, camera.target);
    const dist = vecLen(dir);
    const f = e.deltaY > 0 ? 1.12 : 0.89;
    camera.eye = vecAdd(camera.target, vecScale(vecNorm(dir), dist * f));
  }, { passive: false });

  const sOrbit = document.getElementById("sOrbit"), sSpin = document.getElementById("sSpin"),
        sTilt = document.getElementById("sTilt"),
        cOrbit = document.getElementById("cOrbit"), cPause = document.getElementById("cPause");
  sOrbit.oninput = () => { orbitFactor = +sOrbit.value; document.getElementById("vOrbit").textContent = orbitFactor.toFixed(1) + "×"; };
  sSpin.oninput = () => { spinFactor = +sSpin.value; document.getElementById("vSpin").textContent = spinFactor.toFixed(1) + "×"; };
  sTilt.oninput = () => { tiltOverride = +sTilt.value; document.getElementById("vTilt").textContent = tiltOverride.toFixed(1) + "°"; };
  cOrbit.onchange = () => { showOrbit = cOrbit.checked; };
  cPause.onchange = () => { animPaused = cPause.checked; if (!animPaused) lastNow = performance.now(); updateHud(); };
}
function resetCamera() {
  camera.eye = vec3(TOUR.radius, TOUR.height, 0);
  camera.target = vec3(0, 0, 0);
  camera.t = 0; camera.mode = "tour"; camera.blend = 0;
  tourPaused = false;
  updateHud();
}
function resumeTour() {
  camera.mode = "tour";
  camera.blend = 0.8;
  camera.blendFrom = { eye: vec3(camera.eye[0], camera.eye[1], camera.eye[2]),
                       target: vec3(camera.target[0], camera.target[1], camera.target[2]) };
  tourPaused = false;
  updateHud();
}
function updateHud() {
  const s = document.getElementById("hud").querySelector(".hint");
  const mode = camera.mode === "tour" ? (tourPaused ? "漫游暂停" : "漫游中") : "自由视角";
  s.textContent = "| " + mode + " | 当前选中: " + selected;
}

/* ---------- 14. 主循环 ---------- */
function render() {
  const now = performance.now();
  const dt = lastNow ? (now - lastNow) / 1000 : 0;
  lastNow = now;
  if (!animPaused) simDays += dt * BASE_DAYS_PER_SEC * orbitFactor;

  updateCamera(dt);
  camera.view = lookAt(camera.eye, camera.target, camera.up);
  const aspect = canvas.width / canvas.height;
  if (projection.isPersp) {
    camera.proj = perspective(projection.fovy, aspect, 0.1, 300);
  } else {
    const dist = vecLen(vecSub(camera.eye, camera.target));
    const halfH = dist * Math.tan(projection.fovy * Math.PI / 360);
    const halfW = halfH * aspect;
    camera.proj = ortho(-halfW, halfW, -halfH, halfH, 0.1, 300);
  }

  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  pickables = [];
  drawOrbitLines();
  drawBelt(simDays);
  drawNode({ isSun: true, name: SYSTEM.sun.name, tex: SYSTEM.sun.tex, spin: SYSTEM.sun.spin, radius: SYSTEM.sun.radius }, mat4(), simDays);
  requestAnimationFrame(render);
}

/* ---------- 15. 启动 ---------- */
(function main() {
  if (!initGL()) return;
  bindEvents();
  buildSphereVAO();
  buildOrbitVAO();
  buildRingVAO();
  buildBeltBuf();
  const texNames = [SYSTEM.sun.tex];
  for (const p of SYSTEM.planets) {
    texNames.push(p.tex);
    if (p.moon) texNames.push(p.moon.tex);
    if (p.ring) texNames.push(p.ring.tex);
  }
  let loaded = 0;
  texNames.forEach(function (url) {
    loadTexture(url, url.indexOf("ring") < 0, function (tex) {
      texCache[url] = tex;
      if (++loaded === texNames.length) { updateHud(); requestAnimationFrame(render); }
    });
  });
})();
