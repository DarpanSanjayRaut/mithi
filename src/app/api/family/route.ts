import { addNote } from "@/lib/care";
import { demoExtract, demoMode } from "@/lib/demo";
import { applyExtraction, extract } from "@/lib/extractor";
import { run } from "@/lib/db";
import { getPersona } from "@/lib/personas";

export const maxDuration = 60;

/** A family member or caregiver adds a memory. It is stored as a Note and extracted with a trusted source. */
export async function POST(req: Request) {
  const { persona: pidIn, authorId, text } = (await req.json()) as { persona: string; authorId: string; text: string };
  const persona = getPersona(pidIn);
  const pid = persona.id;
  const note = String(text ?? "").trim().slice(0, 1000);
  const [author] = await run<{ name: string; caregiver: boolean }>(
    pid,
    `MATCH (a:Person {id: $id}) RETURN a.name AS name, exists((a)-[:CAREGIVER_OF]->()) AS caregiver`,
    { id: authorId },
  );
  if (!author || !note) return Response.json({ error: "Pick who is writing and add a note." }, { status: 400 });

  const source = author.caregiver ? "caregiver" : "family";
  const at = Date.now();
  await addNote(pid, authorId, source, note, at);
  const x = demoMode() ? demoExtract(note, true) : await extract(pid, persona, note, { source, name: author.name });
  const memory = x ? await applyExtraction(pid, persona, x, source, null) : null;
  return Response.json({ ok: true, memory });
}
