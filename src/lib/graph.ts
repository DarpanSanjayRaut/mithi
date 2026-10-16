import { run } from "./db";

export interface GNode {
  id: string;
  label: string;
  type: string;
  self?: boolean;
  verified?: boolean;
}
export interface GEdge {
  source: string;
  target: string;
  type: string;
  closed?: boolean;
  unverified?: boolean;
}

const ENTITY = "n:Person OR n:Place OR n:Event OR n:Story OR n:Thing OR n:Topic OR n:Routine OR n:Med";

/** Entity-level view of the memory graph for the UI (sessions and utterances are left out). */
export async function snapshot(pid: string): Promise<{ nodes: GNode[]; edges: GEdge[] }> {
  const nodes = await run<{ id: string; label: string; type: string; self: boolean | null; verified: boolean | null }>(
    pid,
    `MATCH (n) WHERE ${ENTITY}
     RETURN n.id AS id, coalesce(n.name, n.title) AS label, labels(n)[0] AS type,
            n.self AS self, n.verified AS verified`,
  );
  const edges = await run<{ s: string; t: string; type: string; closed: boolean; unverified: boolean; rejected: boolean }>(
    pid,
    `MATCH (a)-[r]->(b)
     WHERE (a:Person OR a:Place OR a:Event OR a:Story OR a:Thing OR a:Topic OR a:Routine OR a:Med)
       AND (b:Person OR b:Place OR b:Event OR b:Story OR b:Thing OR b:Topic OR b:Routine OR b:Med)
       AND type(r) <> 'TOOK'
     WITH a, b, type(r) AS type, r.valid_to IS NOT NULL AS closed, r.verified = false AS unverified,
          coalesce(r.rejected, false) AS rejected
     RETURN DISTINCT a.id AS s, b.id AS t, type, closed, unverified, rejected`,
  );
  return {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, self: !!n.self, verified: n.verified !== false })),
    edges: edges
      .filter((e) => !e.rejected)
      .map((e) => ({ source: e.s, target: e.t, type: e.type, closed: e.closed, unverified: e.unverified })),
  };
}
