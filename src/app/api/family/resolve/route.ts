import { resolveConflict } from "@/lib/memory";
import { getPersona } from "@/lib/personas";

export async function POST(req: Request) {
  const { persona, conflictId, accept } = (await req.json()) as { persona: string; conflictId: string; accept: boolean };
  await resolveConflict(getPersona(persona).id, conflictId, !!accept);
  return Response.json({ ok: true });
}
