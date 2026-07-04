/**
 * Liquid-metal background shader for the caara site.
 *
 * Renders a slow, domain-warped flow field shaded like brushed chrome, with
 * faint thin-film iridescence on the ridges. Runs at reduced resolution for
 * cheap fullscreen coverage, pauses when the tab is hidden, and renders a
 * single static frame when the user prefers reduced motion. Falls back to the
 * plain CSS background when WebGL is unavailable.
 */
(() => {
  const canvas = document.getElementById("metal");
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) return;

  const VERT = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 2.03 + vec2(11.3, 7.9);
        a *= 0.5;
      }
      return v;
    }

    // thin-film style spectral tint
    vec3 irid(float t) {
      return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res.xy;
      vec2 p = uv;
      p.x *= u_res.x / u_res.y;

      float t = u_time * 0.03;

      // domain-warped flow
      vec2 q = vec2(fbm(p * 1.6 + vec2(t, -t * 0.7)), fbm(p * 1.6 + vec2(-t * 0.4, t)));
      vec2 r = vec2(fbm(p * 2.2 + 3.0 * q + vec2(1.7, 9.2)), fbm(p * 2.2 + 3.0 * q + vec2(8.3, 2.8)));
      float f = fbm(p * 1.4 + 2.5 * r);

      // deep graphite base with a vertical falloff
      vec3 col = mix(vec3(0.027, 0.031, 0.043), vec3(0.043, 0.051, 0.071), uv.y);

      // metallic ridges: bright bands where the field folds
      float ridge = smoothstep(0.42, 0.62, f) * smoothstep(0.82, 0.62, f);
      float sheen = pow(ridge, 2.4);
      col += vec3(0.10, 0.11, 0.13) * sheen;

      // spectral edge tint on the sharpest folds only
      float edge = smoothstep(0.55, 0.62, f) * smoothstep(0.69, 0.62, f);
      col += irid(f * 2.0 + q.x) * edge * 0.06;

      // faint broad glow following the warp
      col += vec3(0.035, 0.045, 0.065) * q.y * 0.3;

      // vignette
      float d = distance(uv, vec2(0.5, 0.42));
      col *= 1.0 - 0.55 * smoothstep(0.35, 0.95, d);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
    }
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, "u_res");
  const uTime = gl.getUniformLocation(prog, "u_time");

  // half-resolution is plenty for a blurred-feel background
  const SCALE = 0.5;
  function resize() {
    const w = Math.max(1, Math.floor(innerWidth * devicePixelRatio * SCALE));
    const h = Math.max(1, Math.floor(innerHeight * devicePixelRatio * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;

  function frame(ms) {
    resize();
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, ms / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reducedMotion) raf = requestAnimationFrame(frame);
  }

  addEventListener("resize", () => {
    if (reducedMotion) frame(performance.now());
  });

  document.addEventListener("visibilitychange", () => {
    if (reducedMotion) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(frame);
    }
  });

  raf = requestAnimationFrame(frame);
})();
