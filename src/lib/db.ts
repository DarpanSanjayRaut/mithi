import { FalkorDB, type Graph } from "falkordb";

// One FalkorDB connection per server process; one graph per person we care for.
const g = globalThis as unknown as { __falkor?: Promise<FalkorDB> };

function connect(): Promise<FalkorDB> {
  if (!g.__falkor) {
    // falkor://[user:password@]host:port. Parsed by hand so we can set family: 0, which lets
    // the socket resolve IPv6-only private hostnames (e.g. *.railway.internal) as well as IPv4.
    const u = new URL(process.env.FALKORDB_URL ?? "falkor://localhost:6379");
    g.__falkor = FalkorDB.connect({
      socket: { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 6379), family: 0, tls: u.protocol === "falkors:" ? undefined : false } as never,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    }).catch((err) => {
      g.__falkor = undefined;
      throw err;
    });
  }
  return g.__falkor;
}

export async function graphFor(personaId: string): Promise<Graph> {
  const db = await connect();
  return db.selectGraph(`mithi:${personaId}`);
}

export type Row = Record<string, unknown>;

export async function run<T extends Row = Row>(
  personaId: string,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const graph = await graphFor(personaId);
  const res = await graph.query<T>(cypher, { params: params as never });
  return (res.data ?? []) as T[];
}

export async function dropGraph(personaId: string) {
  const graph = await graphFor(personaId);
  try {
    await graph.delete();
  } catch {
    // graph did not exist yet
  }
}
