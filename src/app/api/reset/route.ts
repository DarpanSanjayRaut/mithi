import { getPersona } from "@/lib/personas";
import { seed } from "@/lib/seed";

export const maxDuration = 60;

/** Restore a persona to its demo state. */
export async function POST(req: Request) {
  const { persona } = (await req.json()) as { persona: string };
  await seed(getPersona(persona).id);
  return Response.json({ ok: true });
}
