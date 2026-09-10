import { useEffect, useRef } from 'react';
import { useReducedMotion, useCanHover } from '../hooks/useMediaQuery';
import { useScrollProgress } from '../hooks/useScrollProgress';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The site's "living" backdrop: a drifting particle field, a cursor-tracked
 * glow, a scroll progress thread, and a back-to-top control. Replaces the
 * old bounded card grid with one continuous ambient layer behind everything.
 */
export function AmbientField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const backToTopRef = useRef<HTMLButtonElement | null>(null);
  const reduceMotion = useReducedMotion();
  const canHover = useCanHover();
  const progress = useScrollProgress();

  useEffect(() => {
    if (progressRef.current) {
      progressRef.current.style.transform = `scaleX(${progress})`;
    }
    if (backToTopRef.current) {
      backToTopRef.current.classList.toggle('visible', window.scrollY > 700);
    }
  }, [progress]);

  // cursor glow
  useEffect(() => {
    if (reduceMotion || !canHover) return;
    const glow = glowRef.current;
    if (!glow) return;
    let tx = 0, ty = 0, cx = 0, cy = 0;
    let raf: number;

    const onMove = (e: MouseEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      glow.style.opacity = '1';
    };
    const onLeave = () => {
      glow.style.opacity = '0';
    };
    const loop = () => {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      glow.style.transform = `translate3d(${cx}px,${cy}px,0)`;
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeave);
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      cancelAnimationFrame(raf);
    };
  }, [reduceMotion, canHover]);

  // ambient node field on canvas
  useEffect(() => {
    if (reduceMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0, h = 0;
    let nodes: Node[] = [];
    let raf: number;
    const nodeCount = window.innerWidth < 700 ? 26 : 52;
    const maxDist = 160;

    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    const makeNodes = () => {
      nodes = Array.from({ length: nodeCount }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
      }));
    };

    resize();
    makeNodes();
    const onResize = () => {
      resize();
      makeNodes();
    };
    window.addEventListener('resize', onResize);

    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < 0 || a.x > w) a.vx *= -1;
        if (a.y < 0 || a.y > h) a.vy *= -1;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < maxDist) {
            ctx.strokeStyle = `rgba(34,211,238,${0.09 * (1 - dist / maxDist)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        ctx.fillStyle = 'rgba(124,92,255,0.4)';
        ctx.beginPath();
        ctx.arc(a.x, a.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [reduceMotion]);

  return (
    <>
      <canvas className="bg-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="cursor-glow" ref={glowRef} aria-hidden="true" />
      <div className="scroll-progress" ref={progressRef} aria-hidden="true" />
      <button
        className="back-to-top"
        ref={backToTopRef}
        aria-label="Back to top"
        onClick={() => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })}
      >
        <i className="fas fa-arrow-up" />
      </button>
    </>
  );
}
