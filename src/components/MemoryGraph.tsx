"use client";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useEffect, useRef, useState } from "react";
import type { GEdge, GNode } from "@/lib/graph";

const COLOR: Record<string, string> = {
  Person: "--rose",
  Place: "--sage",
  Event: "--plum",
  Story: "--plum",
  Routine: "--accent",
  Med: "--accent",
  Thing: "--sky",
  Topic: "--sky",
};
const W = 640;
const H = 440;

type SimNode = GNode & SimulationNodeDatum;
const key = (a: string, b: string) => [a, b].sort().join("|");
// Deterministic jitter so a new node starts near the centre without Math.random during render.
const jitter = (id: string, salt: number) => {
  let h = salt;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * 80;
};
interface Layout {
  sim: SimNode[];
  byId: Map<string, SimNode>;
}

/** Force-laid-out view of the memory graph. Nodes keep their positions between updates. */
export default function MemoryGraph({ nodes, edges, litNodes, litEdges }: { nodes: GNode[]; edges: GEdge[]; litNodes: string[]; litEdges: [string, string, string][] }) {
  const pos = useRef(new Map<string, { x: number; y: number }>());
  const [layout, setLayout] = useState<Layout>({ sim: [], byId: new Map() });

  useEffect(() => {
    const sim: SimNode[] = nodes.map((n) => {
      const p = pos.current.get(n.id);
      return { ...n, x: p?.x ?? W / 2 + jitter(n.id, 7) - 40, y: p?.y ?? H / 2 + jitter(n.id, 13) - 40, fx: n.self ? W / 2 : undefined, fy: n.self ? H / 2 : undefined };
    });
    const ids = new Set(sim.map((n) => n.id));
    const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    const s = forceSimulation(sim)
      .force("link", forceLink<SimNode, (typeof links)[number]>(links).id((d) => d.id).distance(70).strength(0.5))
      .force("charge", forceManyBody().strength(-260))
      .force("collide", forceCollide(30))
      .force("x", forceX(W / 2).strength(0.05))
      .force("y", forceY(H / 2).strength(0.07))
      .stop();
    for (let i = 0; i < 260; i++) s.tick();
    for (const n of sim) {
      n.x = Math.max(40, Math.min(W - 40, n.x!));
      n.y = Math.max(24, Math.min(H - 30, n.y!));
      pos.current.set(n.id, { x: n.x, y: n.y });
    }
    setLayout({ sim, byId: new Map(sim.map((n) => [n.id, n])) });
  }, [nodes, edges]);

  const lit = new Set(litNodes);
  const litE = new Set(litEdges.map(([a, b]) => key(a, b)));
  const anyLit = lit.size > 0;

  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Memory graph">
      <g>
        {edges.map((e, i) => {
          const a = layout.byId.get(e.source);
          const b = layout.byId.get(e.target);
          if (!a || !b) return null;
          const cls = ["edge", e.closed && "closed", e.unverified && "unverified", litE.has(key(e.source, e.target)) && "lit"].filter(Boolean).join(" ");
          return (
            <g key={`${e.source}-${e.target}-${e.type}-${i}`} className={cls}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <text x={(a.x! + b.x!) / 2} y={(a.y! + b.y!) / 2 - 4} textAnchor="middle">
                {e.type}
                {e.closed ? " (past)" : e.unverified ? " (unverified)" : ""}
              </text>
            </g>
          );
        })}
      </g>
      <g>
        {layout.sim.map((n) => {
          const r = n.self ? 18 : 11;
          const cls = ["node", lit.has(n.id) && "lit", anyLit && !lit.has(n.id) && "dim", !n.verified && "unverified"].filter(Boolean).join(" ");
          return (
            <g key={n.id} className={cls} style={{ ["--c" as string]: `var(${COLOR[n.type] ?? "--sky"})` }}>
              <g style={{ transform: `translate(${n.x}px, ${n.y}px)` }}>
                <circle className="halo" r={r + 9} />
                <circle className="ring" r={r} />
                <circle className="dot" r={n.self ? 6 : 4} />
                <text y={r + 13}>{n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}</text>
                <title>{`${n.type}: ${n.label}${n.verified ? "" : " (unverified)"}`}</title>
              </g>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
