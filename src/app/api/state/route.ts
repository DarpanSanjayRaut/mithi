import { familyFeed, insights, moodSeries, nudges } from "@/lib/care";
import { run } from "@/lib/db";
import { snapshot } from "@/lib/graph";
import { getPersona } from "@/lib/personas";
import { seed } from "@/lib/seed";

export const maxDuration = 60;

// First visit on a fresh database (e.g. a new deploy): load the demo persona once.
const seeding = new Map<string, Promise<void>>();
async function ensureSeeded(pid: string) {
  const rows = await run(pid, `MATCH (p:Person {id: 'person:self'}) RETURN p.id LIMIT 1`).catch(() => []);
  if (rows.length) return;
  if (!seeding.has(pid)) seeding.set(pid, seed(pid).finally(() => seeding.delete(pid)));
  await seeding.get(pid);
}

export async function GET(req: Request) {
  const persona = getPersona(new URL(req.url).searchParams.get("persona"));
  const pid = persona.id;
  await ensureSeeded(pid);
  const [graph, n, mood, ins, family, people, facts] = await Promise.all([
    snapshot(pid),
    nudges(pid),
    moodSeries(pid),
    insights(pid),
    familyFeed(pid),
    run<{ id: string; name: string; note: string | null }>(
      pid,
      `MATCH (p:Person) WHERE p.id <> 'person:self' AND coalesce(p.verified, false)
       RETURN p.id AS id, p.name AS name, p.note AS note ORDER BY p.name`,
    ),
    run<{ text: string; source: string; at: number }>(
      pid,
      `MATCH (f:Fact) RETURN f.text AS text, f.source AS source, f.valid_from AS at ORDER BY f.valid_from DESC LIMIT 5`,
    ),
  ]);
  return Response.json({ persona, graph, nudges: n, mood, insights: ins, family, people, facts });
}
