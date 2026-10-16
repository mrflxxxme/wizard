// First screen «shader»: a slow WebGL gradient field in the brand colours with grain, the offer on the dark side.
// The heavy effect of a page (D80 (4)); the static frame is the same field in CSS gradients and is what phones,
// reduced motion, no WebGL and the server render show. Idea after Magic UI «Animated Gradient» (MIT, © Magic UI),
// shader code our own.
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { useStill } from "../kit/motion.js";
import { line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { Grain, inverseBtn, type Link, Section } from "../kit/ui.js";

const VARIANTS = ["left", "center"] as const;

export type HeroShaderProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  /** Up to three short facts under the actions. */
  facts?: string[];
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 a;uniform vec3 b;uniform vec3 c;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,s=.5;for(int i=0;i<4;i++){v+=s*n(p);p*=2.;s*=.5;}return v;}
void main(){vec2 uv=gl_FragCoord.xy/r;vec2 p=uv*vec2(r.x/r.y,1.)*1.6;
vec2 q=vec2(fbm(p+t*.03),fbm(p+vec2(5.2,1.3)-t*.02));
float f=fbm(p+2.*q+t*.015);
float m=smoothstep(.25,.95,f*uv.x*1.6+uv.y*.35);
vec3 col=mix(a,b,m);col=mix(col,c,smoothstep(.6,1.,q.y*uv.x)*.55);
gl_FragColor=vec4(col,1.);}`;
const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

/** A token colour as linear 0..1 RGB, resolved by the browser (works for oklch and any CSS colour). */
function tokenRgb(el: HTMLElement, v: string): [number, number, number] {
  el.style.color = `var(${v})`;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d");
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = getComputedStyle(el).color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/** Runs the shader on the canvas; returns false when WebGL is not available (the static frame stays). */
function runShader(canvas: HTMLCanvasElement): (() => void) | null {
  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!prog || !vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook.
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const probe = document.createElement("span");
  canvas.parentElement?.appendChild(probe);
  gl.uniform3fv(gl.getUniformLocation(prog, "a"), tokenRgb(probe, "--color-inverse"));
  gl.uniform3fv(gl.getUniformLocation(prog, "b"), tokenRgb(probe, "--color-primary"));
  gl.uniform3fv(gl.getUniformLocation(prog, "c"), tokenRgb(probe, "--color-muted"));
  probe.remove();
  const uR = gl.getUniformLocation(prog, "r");
  const uT = gl.getUniformLocation(prog, "t");
  let raf = 0;
  const t0 = performance.now();
  const frame = () => {
    // Half resolution: the field is soft, the GPU cost stays low.
    const w = Math.max(1, Math.floor(canvas.clientWidth / 2));
    const h = Math.max(1, Math.floor(canvas.clientHeight / 2));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uR, w, h);
    gl.uniform1f(uT, (performance.now() - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  };
  frame();
  return () => cancelAnimationFrame(raf);
}

/** The static frame: the same field drawn with CSS gradients over the inverse colour. */
const STATIC_FIELD = {
  backgroundImage: [
    "radial-gradient(60% 80% at 85% 20%, color-mix(in oklab, var(--color-primary) 85%, transparent), transparent 70%)",
    "radial-gradient(45% 60% at 70% 90%, color-mix(in oklab, var(--color-muted) 40%, transparent), transparent 70%)",
    "radial-gradient(50% 70% at 100% 60%, color-mix(in oklab, var(--color-primary) 55%, transparent), transparent 75%)",
  ].join(","),
};

export default function HeroShader({
  eyebrow,
  title,
  lead,
  action,
  secondary,
  facts,
  variant = "left",
  wzId,
}: HeroShaderProps) {
  const still = useStill();
  const ref = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (still || !ref.current) return;
    const stop = runShader(ref.current);
    setLive(Boolean(stop));
    return () => stop?.();
  }, [still]);
  const center = variant === "center";
  return (
    <Section
      block="HeroShader"
      wzId={wzId}
      className="bg-inverse text-inverse-foreground"
      inner="flex min-h-[min(88svh,860px)] flex-col justify-end py-section"
      backdrop={
        <>
          <div aria-hidden="true" className="absolute inset-0 bg-inverse" style={STATIC_FIELD} />
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the canvas is decorative and never focusable. */}
          <canvas
            ref={ref}
            aria-hidden="true"
            className={`absolute inset-0 size-full transition-opacity duration-1000 ${live ? "opacity-100" : "opacity-0"}`}
          />
          {/* Scrim on the text side keeps the copy AA over any frame of the field. */}
          <div
            aria-hidden="true"
            className={`absolute inset-0 ${center ? "bg-[radial-gradient(60%_60%_at_50%_60%,var(--color-inverse),transparent)]" : "bg-[linear-gradient(90deg,var(--color-inverse)_20%,transparent_75%)]"} opacity-80`}
          />
          <Grain opacity={0.18} />
        </>
      }
    >
      <div className={`relative max-w-[46rem] ${center ? "mx-auto text-center" : ""}`}>
        {eyebrow ? (
          <p className="inline-flex items-center gap-2 rounded-control border border-inverse-foreground/25 px-3 py-1 text-small">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-6 font-display text-hero font-bold text-balance">{title}</h1>
        {lead ? <p className="mt-6 max-w-text text-lead text-pretty opacity-85">{lead}</p> : null}
        <div className={`mt-10 flex flex-col gap-3 sm:flex-row ${center ? "sm:justify-center" : ""}`}>
          <a href={action.href} className={inverseBtn} data-testid="wz-hero-primary">
            {action.label}
          </a>
          {secondary ? (
            <a
              href={secondary.href}
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-inverse-foreground/30 px-6 text-body font-semibold transition-colors hover:bg-inverse-foreground/10"
            >
              {secondary.label}
            </a>
          ) : null}
        </div>
        {facts?.length ? (
          <ul
            className={`mt-12 flex flex-wrap gap-x-8 gap-y-3 border-t border-inverse-foreground/20 pt-6 text-small ${center ? "justify-center" : ""}`}
          >
            {facts.map((f) => (
              <li key={f} className="opacity-85">
                {f}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof HeroShader>()({
  id: "hero-shader",
  kind: "hero",
  title: "Первый экран с живым градиентом",
  description:
    "Тёмный первый экран: медленное поле цветов бренда на WebGL с зерном, оффер поверх. Тяжёлый эффект страницы — другие тяжёлые блоки на ту же страницу не ставить. Для технологичных, премиальных и ночных вайбов, когда фото нет.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(90),
    lead: para(220).optional(),
    action: linkSlot,
    secondary: linkSlot.optional(),
    facts: z.array(line(40)).max(3).optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "left", title: "Текст слева, поле справа" },
    { id: "center", title: "Текст по центру" },
  ],
  effect: "heavy",
  origin: "magic-ui",
  example: {
    eyebrow: "Принимаем заказы на ноябрь",
    title: "Свет для дома, который настраивается под ваш день",
    lead: "Проектируем и монтируем умное освещение в квартирах и загородных домах. Один сценарий — и утро начинается без выключателей.",
    action: { label: "Рассчитать проект", href: "#form" },
    secondary: { label: "Смотреть работы", href: "#gallery" },
    facts: ["Проект за 5 дней", "Гарантия 3 года", "120 объектов в Москве"],
  },
});
