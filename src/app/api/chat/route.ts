import { companionReply } from "@/lib/companion";
import { demoExtract, demoMode, demoReply } from "@/lib/demo";
import { applyExtraction, extract, type MemoryWrite } from "@/lib/extractor";
import { addUtterance, currentSession } from "@/lib/memory";
import { getPersona } from "@/lib/personas";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { persona: pidIn, text } = (await req.json()) as { persona: string; text: string };
  const persona = getPersona(pidIn);
  const pid = persona.id;
  const said = String(text ?? "").trim().slice(0, 1000);
  if (!said) return Response.json({ error: "Say something first." }, { status: 400 });

  const at = Date.now();
  const sessionId = await currentSession(pid, at);

  // Memory-keeper and Companion run side by side; both see the same graph.
  const demo = demoMode();
  const [extraction, companion] = await Promise.allSettled([
    demo ? Promise.resolve(demoExtract(said, false)) : extract(pid, persona, said, { source: "self", name: persona.name }),
    demo ? demoReply(pid, persona, said) : companionReply(pid, persona, said),
  ]);

  let memory: MemoryWrite | null = null;
  if (extraction.status === "fulfilled" && extraction.value) {
    memory = await applyExtraction(pid, persona, extraction.value, "self", sessionId);
  } else if (extraction.status === "rejected") {
    console.error("memory-keeper failed", extraction.reason);
  }
  if (companion.status === "rejected") {
    console.error("companion failed", companion.reason);
    return Response.json({ error: "Mithi couldn't answer just now. Check the server log and API key." }, { status: 502 });
  }

  const { reply, traces } = companion.value;
  await addUtterance(pid, { sessionId, speaker: "self", text: said, at, mentionIds: memory?.mentionIds ?? [] });
  const recalled = [...new Set(traces.flatMap((t) => t.nodes))].filter((id) => id !== "person:self");
  await addUtterance(pid, { sessionId, speaker: "mithi", text: reply, at: Date.now(), mentionIds: recalled });

  return Response.json({ reply, traces, memory });
}
