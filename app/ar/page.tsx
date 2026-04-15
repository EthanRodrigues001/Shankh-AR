"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";

type Phase =
  | "checking"
  | "no-camera"
  | "splash"
  | "compiling"
  | "loading-ar"
  | "scanning"
  | "tracking"
  | "error";

export default function ARPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [statusText, setStatusText] = useState("Initialising…");
  const [statusType, setStatusType] = useState<"ok" | "warn" | "err">("ok");
  const [scriptsReady, setScriptsReady] = useState(false);
  const [aframeReady, setAframeReady] = useState(false);
  const [compileProgress, setCompileProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const sceneRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const arStartedRef = useRef(false);
  const mindDataRef = useRef<Blob | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mixerRef = useRef<any>(null);
  const clockRef = useRef<any>(null);

  // ─── Step 1: Check camera availability ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideo = devices.some((d) => d.kind === "videoinput");
        if (!hasVideo) {
          setPhase("no-camera");
          return;
        }
        // Try to get permission
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        stream.getTracks().forEach((t) => t.stop());
        setPhase("splash");
      } catch {
        setPhase("no-camera");
      }
    })();
  }, []);

  // ─── Step 2: Compile QR image → .mind targets when scripts are ready ──────
  useEffect(() => {
    if (!scriptsReady || phase !== "splash") return;
    // pre-compile in background so Start AR is instant
    compileMindTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptsReady, phase]);

  async function compileMindTarget() {
    if (mindDataRef.current) return;
    try {
      const w = window as any;
      if (!w.MINDAR || !w.MINDAR.IMAGE || !w.MINDAR.IMAGE.Compiler) {
        // Retry after a short wait
        setTimeout(compileMindTarget, 500);
        return;
      }
      setCompileProgress(1);
      const compiler = new w.MINDAR.IMAGE.Compiler();
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = "/qr/ar-qrcode.png";
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("QR image load failed"));
      });
      setCompileProgress(20);
      await compiler.compileImageTargets([img], (progress: number) => {
        setCompileProgress(Math.round(progress * 80) + 20);
      });
      const exportedBuffer = await compiler.exportData();
      mindDataRef.current = new Blob([exportedBuffer]);
      setCompileProgress(100);
      console.log("✅ MindAR target compiled from QR code");
    } catch (e: any) {
      console.error("Compile error:", e);
      // Non-fatal — user will see error on Start
    }
  }

  // ─── Start AR ─────────────────────────────────────────────────────────────
  async function startAR() {
    if (arStartedRef.current) return;
    arStartedRef.current = true;
    setPhase("compiling");
    setStatusText("Preparing AR target…");

    try {
      // Ensure compiled
      if (!mindDataRef.current) {
        setStatusText("Compiling QR target…");
        await compileMindTargetSync();
      }

      // Create object URL for .mind blob
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(mindDataRef.current!);

      setPhase("loading-ar");
      setStatusText("Starting AR engine…");
      initAFrame(objectUrlRef.current);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Unknown error");
      setPhase("error");
    }
  }

  async function compileMindTargetSync() {
    const w = window as any;
    let attempts = 0;
    while (!w.MINDAR?.IMAGE?.Compiler && attempts < 20) {
      await new Promise((r) => setTimeout(r, 300));
      attempts++;
    }
    if (!w.MINDAR?.IMAGE?.Compiler) throw new Error("MindAR not loaded");
    const compiler = new w.MINDAR.IMAGE.Compiler();
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = "/qr/ar-qrcode.png";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("QR image failed"));
    });
    await compiler.compileImageTargets([img], (p: number) => {
      setCompileProgress(Math.round(p * 100));
    });
    const buf = await compiler.exportData();
    mindDataRef.current = new Blob([buf]);
  }

  // ─── Inject A-Frame scene dynamically ─────────────────────────────────────
  function initAFrame(mindUrl: string) {
    const w = window as any;
    if (typeof w.AFRAME === "undefined") {
      setTimeout(() => initAFrame(mindUrl), 200);
      return;
    }

    // Build a-scene programmatically to avoid SSR issues
    const scene = document.createElement("a-scene") as any;
    scene.id = "ar-scene";
    scene.setAttribute(
      "mindar-image",
      `imageTargetSrc: ${mindUrl}; autoStart: false; uiLoading: no; uiError: no; uiScanning: no; maxTrack: 1; filterMinCF: 0.001; filterBeta: 0.01; missTolerance: 200; warmupTolerance: 1;`
    );
    scene.setAttribute("color-space", "sRGB");
    scene.setAttribute(
      "renderer",
      "colorManagement: true; physicallyCorrectLights: true;"
    );
    scene.setAttribute("vr-mode-ui", "enabled: false");
    scene.setAttribute("device-orientation-permission-ui", "enabled: false");
    scene.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;";

    const assets = document.createElement("a-assets");
    assets.setAttribute("timeout", "0");
    scene.appendChild(assets);

    const camera = document.createElement("a-camera");
    camera.setAttribute("active", "false");
    camera.setAttribute("position", "0 0 0");
    scene.appendChild(camera);

    const targetEntity = document.createElement("a-entity");
    targetEntity.id = "mindar-target";
    targetEntity.setAttribute("mindar-image-target", "targetIndex: 0");

    const anchor = document.createElement("a-entity");
    anchor.id = "avatar-anchor";
    targetEntity.appendChild(anchor);
    scene.appendChild(targetEntity);

    // Insert behind the UI overlay
    const container = document.getElementById("ar-container");
    if (container) container.appendChild(scene);
    else document.body.appendChild(scene);

    sceneRef.current = scene;
    anchorRef.current = anchor;

    // Event listeners
    scene.addEventListener("arReady", () => {
      setPhase("scanning");
      setStatusText("Point camera at QR code");
      setStatusType("ok");
      loadAvatar(anchor as any);
    });

    scene.addEventListener("arError", () => {
      setStatusText("AR camera error");
      setStatusType("err");
      setPhase("error");
      setErrorMsg("Camera access failed. Please reload and allow camera.");
    });

    targetEntity.addEventListener("targetFound", () => {
      setPhase("tracking");
      setStatusText("Character detected! 🎉");
      setStatusType("ok");
      if (anchor) (anchor as any).object3D.visible = true;
    });

    targetEntity.addEventListener("targetLost", () => {
      setPhase("scanning");
      setStatusText("Point camera at QR code");
      setStatusType("warn");
      if (anchor) (anchor as any).object3D.visible = false;
    });

    // Start the AR system after scene loads
    const tryStart = () => {
      const sys = (scene as any).systems?.["mindar-image-system"];
      if (sys) {
        setStatusText("Starting AR engine…");
        sys.start();
      } else {
        setPhase("error");
        setErrorMsg("AR system not found — try refreshing");
      }
    };

    if ((scene as any).hasLoaded) tryStart();
    else scene.addEventListener("loaded", tryStart, { once: true });
  }

  // ─── Load GLB avatar with wave animation ──────────────────────────────────
  function loadAvatar(anchorEl: any) {
    const w = window as any;
    if (!w.AFRAME) { setTimeout(() => loadAvatar(anchorEl), 200); return; }

    const THREE = w.AFRAME.THREE;

    // Use A-Frame's built-in gltf-model component (handles loading natively)
    anchorEl.setAttribute("gltf-model", "/exported_model.glb");
    anchorEl.setAttribute("position", "0 0 0.05");
    anchorEl.setAttribute("rotation", "90 0 0");
    anchorEl.setAttribute("scale", "2 2 2");

    anchorEl.addEventListener("model-loaded", (evt: any) => {
      // In A-Frame 1.5.0, evt.detail.model = gltfModel.scene (a THREE.Group).
      // A-Frame does: self.model = gltfModel.scene; self.model.animations = gltfModel.animations;
      // So modelGroup itself is the mixer root — modelGroup.scene does NOT exist.
      const modelGroup = evt.detail?.model;  // THREE.Group, IS the scene
      const clips: any[] = modelGroup?.animations ?? [];

      console.log("GLB loaded — clips found:", clips.length, clips.map((c: any) => c.name));

      if (clips.length) {
        setupAnimations(anchorEl, modelGroup, clips, THREE);
      } else {
        console.warn("No clips on model.animations — using manual wave");
        addManualWave(anchorEl);
      }
      console.log("✅ GLB model ready on QR target");
    });

    anchorEl.addEventListener("model-error", (e: any) => {
      console.error("GLB load error", e);
      setStatusText("Model load failed — check /exported_model.glb");
      setStatusType("err");
    });
  }

  function setupAnimations(anchorEl: any, scene: any, clips: any[], THREE: any) {
    if (!scene || !clips.length) { addManualWave(anchorEl); return; }

    console.log("Available animation clips:", clips.map((c: any) => c.name));

    // AnimationMixer root must be the exact object the clips reference (gltf.scene)
    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;

    // Always prefer the clip named exactly "wave"
    const clip = clips.find((c: any) => c.name === "wave")
      ?? clips.find((c: any) => /wave/i.test(c.name))
      ?? clips[0];
    console.log(`▶ Playing: "${clip.name}" (${clip.duration.toFixed(2)}s, loop)`);

    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();

    const clock = new THREE.Clock();
    clockRef.current = clock;

    // requestAnimationFrame loop — identical to the original HTML approach
    const animLoop = () => {
      if (mixerRef.current && clockRef.current) {
        mixerRef.current.update(clockRef.current.getDelta());
      }
      requestAnimationFrame(animLoop);
    };
    animLoop();

    console.log("✅ Animation loop started");
  }

  function addManualWave(anchorEl: any) {
    // Fallback: oscillate Y rotation gently
    let t = 0;
    const tick = () => {
      t += 0.04;
      const angle = Math.sin(t) * 20;
      anchorEl.setAttribute("rotation", `90 ${angle} 0`);
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* External scripts - loaded only once */}
      <Script
        src="https://aframe.io/releases/1.5.0/aframe.min.js"
        strategy="beforeInteractive"
        onLoad={() => {
          console.log("A-Frame loaded");
          setAframeReady(true);
        }}
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js"
        strategy="afterInteractive"
        onLoad={() => {
          console.log("MindAR loaded");
          setScriptsReady(true);
        }}
        onError={() => {
          setScriptsReady(true); // allow fallback
        }}
      />

      <div id="ar-container" style={{ position: "fixed", inset: 0, zIndex: 0 }} />

      {/* ── Status bar ── */}
      {phase !== "splash" && phase !== "checking" && (
        <div style={styles.statusBar}>
          <span
            style={{
              ...styles.statusDot,
              background:
                statusType === "err"
                  ? "#ff4f6d"
                  : statusType === "warn"
                  ? "#f5c842"
                  : "#00d4b4",
              boxShadow: `0 0 8px ${
                statusType === "err"
                  ? "#ff4f6d"
                  : statusType === "warn"
                  ? "#f5c842"
                  : "#00d4b4"
              }`,
            }}
          />
          <span style={styles.statusText}>{statusText}</span>
        </div>
      )}

      {/* ── Splash screen ── */}
      {(phase === "splash" || phase === "checking") && (
        <div style={styles.splash}>
          {/* Noise grain overlay */}
          <div style={styles.grain} />

          <div style={styles.splashCard}>
            {/* Top eyebrow */}
            <div style={styles.eyebrow}>
              <span style={styles.eyebrowDot} />
              <span style={styles.eyebrowText}>AUGMENTED REALITY</span>
              <span style={{ ...styles.eyebrowText, marginLeft: "auto", opacity: 0.45 }}>by Infinitypool</span>
            </div>

            {/* Product name */}
            <div style={styles.productName}>Shankh AR</div>

            {/* Hero headline */}
            <h1 style={styles.splashTitle}>
              Point &amp;
              <br />
              <span style={styles.accentWord}>See.</span>
            </h1>

            {/* QR + Steps side-by-side */}
            <div style={styles.qrStepRow}>
              {/* QR display */}
              <div style={styles.qrBlock}>
                <div style={styles.qrWrap}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/qr/ar-qrcode.png"
                    alt="AR QR Code"
                    style={styles.qrImg}
                  />
                  <div style={styles.scanLine} />
                  <div style={styles.qrCornerTL} />
                  <div style={styles.qrCornerTR} />
                  <div style={styles.qrCornerBL} />
                  <div style={styles.qrCornerBR} />
                </div>
                <p style={styles.qrCaption}>Scan to begin</p>
              </div>

              {/* Step column */}
              <div style={styles.stepRow}>
                {["Allow camera", "Point at QR", "Character appears"].map((s, i) => (
                  <div key={i} style={styles.stepItem}>
                    <span style={styles.stepIdx}>0{i + 1}</span>
                    <span style={styles.stepLabel}>{s}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* CTA */}
            <button
              id="start-ar-btn"
              style={{
                ...styles.startBtn,
                opacity: phase === "checking" ? 0.45 : 1,
                cursor: phase === "checking" ? "not-allowed" : "pointer",
              }}
              disabled={phase === "checking"}
              onClick={startAR}
            >
              {phase === "checking" ? "Checking camera…" : "Launch AR"}
              {phase !== "checking" && <span style={styles.btnArrow}>→</span>}
            </button>
          </div>
        </div>
      )}

      {/* ── No Camera fallback ── */}
      {phase === "no-camera" && (
        <div style={styles.splash}>
          <div style={styles.grain} />
          <div style={styles.splashCard}>
            <div style={{ ...styles.eyebrow, color: "#ff4f6d" }}>
              <span style={{ ...styles.eyebrowDot, background: "#ff4f6d" }} />
              <span style={styles.eyebrowText}>NO CAMERA DETECTED</span>
            </div>
            <h1 style={styles.splashTitle}>Camera<br />Required.</h1>
            <p style={{ ...styles.qrCaption, marginBottom: 24, opacity: 0.6 }}>
              Allow camera access or use a device with a camera to experience AR.
            </p>
            <div style={styles.qrBlock}>
              <div style={{ ...styles.qrWrap, opacity: 0.4 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/qr/ar-qrcode.png" alt="QR" style={styles.qrImg} />
              </div>
            </div>
            <button
              style={{ ...styles.startBtn, marginTop: 24 }}
              onClick={() => window.location.reload()}
            >
              Retry <span style={styles.btnArrow}>→</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Compiling overlay ── */}
      {(phase === "compiling" || phase === "loading-ar") && (
        <div style={styles.loadingOverlay}>
          <div style={styles.loaderRing} />
          <p style={styles.loadingText}>{statusText}</p>
          {phase === "compiling" && compileProgress > 0 && compileProgress < 100 && (
            <div style={styles.progressBar}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${compileProgress}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Scanning overlay ── */}
      {phase === "scanning" && (
        <div style={styles.scanOverlay}>
          <div style={styles.scanCorners}>
            <div style={{ ...styles.corner, ...styles.cornerTL }} />
            <div style={{ ...styles.corner, ...styles.cornerTR }} />
            <div style={{ ...styles.corner, ...styles.cornerBL }} />
            <div style={{ ...styles.corner, ...styles.cornerBR }} />
          </div>
          <p style={styles.scanHint}>Point at the QR code</p>
        </div>
      )}

      {/* ── Error screen ── */}
      {phase === "error" && (
        <div style={styles.splash}>
          <div style={styles.grain} />
          <div style={styles.splashCard}>
            <div style={{ ...styles.eyebrow, color: "#ff4f6d" }}>
              <span style={{ ...styles.eyebrowDot, background: "#ff4f6d" }} />
              <span style={styles.eyebrowText}>ERROR</span>
            </div>
            <h1 style={styles.splashTitle}>Something<br />went wrong.</h1>
            <p style={{ ...styles.qrCaption, opacity: 0.55, marginBottom: 32, textAlign: "left" }}>{errorMsg}</p>
            <button
              style={styles.startBtn}
              onClick={() => window.location.reload()}
            >
              Reload &amp; Retry <span style={styles.btnArrow}>→</span>
            </button>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

        :root {
          --safe-top: env(safe-area-inset-top, 0px);
          --safe-bottom: env(safe-area-inset-bottom, 0px);
          --accent: #C8FF00;
          --ink: #080808;
          --glass: rgba(255,255,255,0.03);
        }

        a-scene {
          position: fixed !important;
          top: 0; left: 0;
          width: 100% !important;
          height: 100% !important;
          z-index: 0;
        }

        .mindar-ui-overlay,
        .mindar-ui-loading,
        .mindar-ui-scanning { display: none !important; }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes scanLine {
          0%   { top: 0%;   opacity: 0; }
          8%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
        @keyframes loaderSpin {
          to { transform: rotate(360deg); }
        }
        @keyframes cornerPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulseAccent {
          0%, 100% { box-shadow: 0 0 0 0 rgba(200,255,0,0.4); }
          50%      { box-shadow: 0 0 0 8px rgba(200,255,0,0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        #start-ar-btn:hover {
          background: var(--accent) !important;
          color: var(--ink) !important;
          transform: translateY(-1px);
        }
        #start-ar-btn:active {
          transform: translateY(0px) scale(0.98);
        }
      `}</style>
    </>
  );
}

// ─── Design tokens ───────────────────────────────────────────────────────────
const INK    = "#080808";
const WHITE  = "#f5f5f0";
const ACCENT = "#C8FF00";    // electric lime — single sharp accent
const BORDER = "rgba(255,255,255,0.09)";
const TEAL   = "#00d4b4";    // kept for status dot only

const styles: Record<string, React.CSSProperties> = {

  // ── Status bar (camera mode — unchanged) ──
  statusBar: {
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + 12px)",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(8,8,8,0.78)",
    border: `1px solid ${BORDER}`,
    borderRadius: 40,
    padding: "8px 18px",
    zIndex: 500,
    pointerEvents: "none",
    backdropFilter: "blur(14px) saturate(180%)",
    WebkitBackdropFilter: "blur(14px) saturate(180%)",
    whiteSpace: "nowrap",
    maxWidth: "calc(100vw - 32px)",
  },
  statusDot: {
    width: 8, height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background 0.3s",
  },
  statusText: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 12, fontWeight: 500,
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 0.2,
  },

  // ── Splash wrapper ──
  splash: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: INK,
    overflow: "auto",
  },

  grain: {
    position: "absolute",
    inset: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
    backgroundSize: "200px 200px",
    pointerEvents: "none",
    zIndex: 1,
    opacity: 0.5,
  },

  // ── Card ──
  splashCard: {
    position: "relative",
    zIndex: 2,
    width: "min(400px, calc(100vw - 32px))",
    padding: "44px 32px 40px",
    animation: "fadeUp 0.6s cubic-bezier(0.22,1,0.36,1) both",
  },

  eyebrow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 18,
    animation: "fadeUp 0.5s 0.04s both",
  },
  eyebrowDot: {
    display: "inline-block",
    width: 6, height: 6,
    borderRadius: "50%",
    background: ACCENT,
    animation: "pulseAccent 2.5s ease-in-out infinite",
    flexShrink: 0,
  },
  eyebrowText: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.18em",
    color: "rgba(255,255,255,0.3)",
    textTransform: "uppercase" as const,
  },

  // Product name
  productName: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: "clamp(20px, 5vw, 26px)",
    fontWeight: 600,
    color: WHITE,
    letterSpacing: "-0.5px",
    lineHeight: 1.1,
    marginBottom: 2,
    animation: "fadeUp 0.52s 0.07s both",
  },

  splashTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: "clamp(36px, 9vw, 52px)",
    fontWeight: 700,
    color: WHITE,
    lineHeight: 0.95,
    letterSpacing: "-2px",
    marginBottom: 20,
    animation: "fadeUp 0.55s 0.1s both",
  },
  accentWord: {
    color: ACCENT,
    fontStyle: "italic" as const,
  },

  // QR + steps horizontal container
  qrStepRow: {
    display: "flex",
    gap: 12,
    marginBottom: 20,
    alignItems: "stretch",
    animation: "fadeUp 0.55s 0.18s both",
  },

  qrBlock: {
    flexShrink: 0,
    width: 120,
  },
  qrWrap: {
    position: "relative",
    width: 120,
    height: 120,
    background: "#ffffff",
    borderRadius: 8,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  qrImg: {
    width: "88%",
    height: "88%",
    objectFit: "contain" as const,
    display: "block",
  },
  qrCornerTL: {
    position: "absolute", top: 10, left: 10,
    width: 20, height: 20,
    borderTop: `2.5px solid ${ACCENT}`,
    borderLeft: `2.5px solid ${ACCENT}`,
    borderTopLeftRadius: 3,
  },
  qrCornerTR: {
    position: "absolute", top: 10, right: 10,
    width: 20, height: 20,
    borderTop: `2.5px solid ${ACCENT}`,
    borderRight: `2.5px solid ${ACCENT}`,
    borderTopRightRadius: 3,
  },
  qrCornerBL: {
    position: "absolute", bottom: 10, left: 10,
    width: 20, height: 20,
    borderBottom: `2.5px solid ${ACCENT}`,
    borderLeft: `2.5px solid ${ACCENT}`,
    borderBottomLeftRadius: 3,
  },
  qrCornerBR: {
    position: "absolute", bottom: 10, right: 10,
    width: 20, height: 20,
    borderBottom: `2.5px solid ${ACCENT}`,
    borderRight: `2.5px solid ${ACCENT}`,
    borderBottomRightRadius: 3,
  },
  scanLine: {
    position: "absolute",
    left: 0, right: 0, height: 2,
    background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
    animation: "scanLine 2.4s ease-in-out infinite",
    opacity: 0.7,
  },
  qrCaption: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 11,
    fontWeight: 400,
    color: "rgba(255,255,255,0.28)",
    letterSpacing: "0.06em",
    textAlign: "center" as const,
    margin: 0,
    textTransform: "uppercase" as const,
  },

  stepRow: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  stepItem: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
    padding: "8px 10px",
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    background: "rgba(255,255,255,0.04)",
    justifyContent: "center" as const,
  },
  stepIdx: {
    fontFamily: "'Space Mono', monospace",
    fontSize: 9,
    fontWeight: 700,
    color: ACCENT,
    letterSpacing: "0.1em",
    display: "block",
  },
  stepLabel: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 10,
    fontWeight: 500,
    color: "rgba(255,255,255,0.42)",
    lineHeight: 1.3,
    display: "block",
  },

  // CTA — clean white, no gradient
  startBtn: {
    width: "100%",
    padding: "16px 22px",
    border: "1px solid rgba(255,255,255,0.12)",
    outline: "none",
    borderRadius: 6,
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "0.01em",
    cursor: "pointer",
    background: WHITE,
    color: INK,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    transition: "background 0.18s, transform 0.14s",
    animation: "fadeUp 0.55s 0.32s both",
  },
  btnArrow: {
    fontSize: 18,
    lineHeight: 1,
    marginLeft: 8,
  },

  // Loading overlay
  loadingOverlay: {
    display: "flex",
    position: "fixed",
    inset: 0,
    background: "rgba(8,8,8,0.92)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column" as const,
    gap: 18,
    zIndex: 1500,
  },
  loaderRing: {
    width: 44, height: 44,
    border: "2px solid rgba(255,255,255,0.08)",
    borderTop: `2px solid ${ACCENT}`,
    borderRadius: "50%",
    animation: "loaderSpin 0.85s linear infinite",
  },
  loadingText: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 12,
    fontWeight: 400,
    color: "rgba(255,255,255,0.38)",
    textAlign: "center" as const,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
  },
  progressBar: {
    width: 140, height: 1,
    background: "rgba(255,255,255,0.08)",
    borderRadius: 1,
    overflow: "hidden" as const,
  },
  progressFill: {
    height: "100%",
    background: ACCENT,
    borderRadius: 1,
    transition: "width 0.3s ease",
  },

  // ── Scanning overlay (camera mode — unchanged) ──
  scanOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    pointerEvents: "none" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column" as const,
  },
  scanCorners: {
    position: "relative",
    width: 220, height: 220,
  },
  corner: {
    position: "absolute",
    width: 28, height: 28,
    animation: "cornerPulse 2s ease-in-out infinite",
  },
  cornerTL: { top: 0, left: 0,
    borderTop: `2.5px solid ${ACCENT}`, borderLeft: `2.5px solid ${ACCENT}`, borderTopLeftRadius: 4 },
  cornerTR: { top: 0, right: 0,
    borderTop: `2.5px solid ${ACCENT}`, borderRight: `2.5px solid ${ACCENT}`, borderTopRightRadius: 4 },
  cornerBL: { bottom: 0, left: 0,
    borderBottom: `2.5px solid ${ACCENT}`, borderLeft: `2.5px solid ${ACCENT}`, borderBottomLeftRadius: 4 },
  cornerBR: { bottom: 0, right: 0,
    borderBottom: `2.5px solid ${ACCENT}`, borderRight: `2.5px solid ${ACCENT}`, borderBottomRightRadius: 4 },
  scanHint: {
    marginTop: 24,
    color: "rgba(255,255,255,0.45)",
    fontSize: 11,
    fontFamily: "'Space Grotesk', sans-serif",
    letterSpacing: "0.1em",
    fontWeight: 500,
    animation: "fadeInUp 0.5s ease both",
    textTransform: "uppercase" as const,
  },
};

