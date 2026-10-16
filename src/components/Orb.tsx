"use client";
import { useEffect, useRef } from "react";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

/** Mithi's face: a soft breathing blob that listens, thinks and talks. Drawn on canvas. */
export default function Orb({ mode }: { mode: OrbMode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pal = { a: "", b: "", eye: "", ring: "", dot: "" };
    const readPal = () => {
      const cs = getComputedStyle(document.documentElement);
      const v = (n: string) => cs.getPropertyValue(n).trim();
      pal = { a: v("--orb-a"), b: v("--orb-b"), eye: v("--eye"), ring: v("--rose"), dot: v("--plum") };
    };
    readPal();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", readPal);

    let raf = 0;
    let amp = 0;
    let blinkAt = 0;
    const look = { x: 0, y: 0 };
    const t0 = performance.now();

    const draw = (now: number) => {
      const mode = modeRef.current;
      const t = (now - t0) / 1000;
      const W = canvas.width;
      const cx = W / 2;
      const cy = W / 2;
      const k = reduced ? 0.25 : 1;
      ctx.clearRect(0, 0, W, W);
      const target =
        mode === "listening" ? 0.5 + 0.5 * Math.abs(Math.sin(t * 7) * Math.sin(t * 3.1)) : mode === "speaking" ? 0.35 + 0.35 * Math.abs(Math.sin(t * 9)) : 0;
      amp += (target - amp) * 0.15;
      const R = 74 + Math.sin(t * 1.6) * 3 * k + amp * 6;

      if (mode === "listening") {
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.9 + i / 3) % 1;
          ctx.beginPath();
          ctx.arc(cx, cy, R + 8 + p * 38, 0, Math.PI * 2);
          ctx.strokeStyle = pal.ring;
          ctx.globalAlpha = (1 - p) * 0.55;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const wob = (Math.sin(a * 3 + t * 1.3) * 3 + Math.sin(a * 5 - t * 1.9) * 2) * k + Math.sin(a * 4 + t * 6) * amp * 5;
        const r = R + wob;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.96;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      const g = ctx.createRadialGradient(cx - 26, cy - 30, 10, cx, cy, R + 10);
      g.addColorStop(0, pal.a);
      g.addColorStop(1, pal.b);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.beginPath();
      ctx.ellipse(cx - 30, cy - 34, 20, 12, -0.5, 0, Math.PI * 2);
      ctx.fill();

      const want = mode === "thinking" ? { x: 8, y: -10 } : mode === "listening" ? { x: 0, y: 2 } : { x: Math.sin(t * 0.5) * 4 * k, y: 0 };
      look.x += (want.x - look.x) * 0.08;
      look.y += (want.y - look.y) * 0.08;
      if (now > blinkAt + 3200 + Math.random() * 2000) blinkAt = now;
      const bl = now - blinkAt < 140 ? 0.12 : 1;
      ctx.fillStyle = pal.eye;
      for (const dx of [-22, 22]) {
        ctx.beginPath();
        ctx.ellipse(cx + dx + look.x, cy - 6 + look.y, 7, 10 * bl, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,255,255,.22)";
      for (const dx of [-40, 40]) {
        ctx.beginPath();
        ctx.ellipse(cx + dx, cy + 16, 9, 5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = pal.eye;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (mode === "speaking") {
        ctx.ellipse(cx + look.x * 0.5, cy + 20, 9, (3 + amp * 14) / 2 + 1, 0, 0, Math.PI * 2);
        ctx.fillStyle = pal.eye;
        ctx.fill();
      } else if (mode === "thinking") {
        ctx.moveTo(cx - 6, cy + 22);
        ctx.lineTo(cx + 8, cy + 20);
        ctx.stroke();
      } else {
        ctx.arc(cx + look.x * 0.5, cy + 12, 12, 0.2 * Math.PI, 0.8 * Math.PI);
        ctx.stroke();
      }
      if (mode === "thinking") {
        for (let i = 0; i < 3; i++) {
          const a = t * 2.4 + i * 2.09;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * (R + 18), cy + Math.sin(a) * (R + 18) * 0.5 - 6, 6, 0, Math.PI * 2);
          ctx.fillStyle = pal.dot;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", readPal);
    };
  }, []);

  return <canvas ref={ref} width={264} height={264} aria-hidden="true" />;
}
