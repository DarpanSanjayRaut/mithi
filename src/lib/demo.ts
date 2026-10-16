import type { CompanionResult } from "./companion";
import type { Extraction } from "./extractor";
import type { Persona } from "./personas";
import { runTool, type Trace } from "./tools";

/*
 * Offline demo mode (no API key, or MITHI_DEMO=1).
 * The language parts are scripted, but everything else is real: the same graph tools run the same
 * Cypher against FalkorDB, and the scripted extractions go through the same write path.
 */

export const demoMode = () => process.env.MITHI_DEMO === "1" || !process.env.ANTHROPIC_API_KEY;

type Data = Record<string, unknown>;
interface Scene {
  match: RegExp;
  tools: { name: string; input: Data }[];
  reply: (out: Data[], p: Persona) => string;
}

const first = <T>(xs: unknown): T | undefined => (Array.isArray(xs) ? (xs[0] as T) : undefined);
const dayName = (s?: string | null) => (s ? s.split(",")[0].replace("Sun", "Sunday").replace("Mon", "Monday").replace("Tue", "Tuesday").replace("Wed", "Wednesday").replace("Thu", "Thursday").replace("Fri", "Friday").replace("Sat", "Saturday") : "soon");

const SCENES: Record<string, Scene[]> = {
  kamala: [
    {
      match: /who is raju|raju again|who.*raju/i,
      tools: [{ name: "recall_person", input: { name: "Raju" } }],
      reply: ([r]) => {
        const ev = (r.events as { title: string; date: string; upcoming: boolean }[] | undefined)?.find((e) => e.upcoming);
        const home = first<{ place: string }>(r.lives_in)?.place;
        return `Raju is your grandson, Aaji. He is Priya's son${home ? `, and he lives in ${home}` : ""}. He called you yesterday${ev ? `, and he's coming to see you on ${dayName(ev.date)}` : ""}. He promised to bring jalebi!`;
      },
    },
    {
      match: /(just|have) (took|taken)|i took/i,
      tools: [{ name: "log_med_taken", input: { med: "BP tablet" } }],
      reply: ([r]) => (r.logged ? "Wonderful, I've noted it. That's your BP tablet done for today. Shall we have some tea now?" : "I couldn't find that one in your routine. I'll ask Sunita to check."),
    },
    {
      match: /tablet|medicine|pill/i,
      tools: [{ name: "todays_routine", input: {} }],
      reply: ([r]) => {
        const bp = (r.items as { med: string | null; time: string; status: string | null }[]).find((i) => i.med?.startsWith("BP"));
        if (!bp) return "You have no tablets planned for today, Aaji.";
        if (bp.status?.startsWith("taken")) return `Yes, Aaji, you already had your BP tablet today, ${bp.status.replace("taken ", "")}. Well done!`;
        if (bp.status?.startsWith("due")) return "Not yet today, Aaji. It's time for your BP tablet. Shall I mark it once you've had it with some water?";
        return `Your BP tablet is at ${bp.time}, Aaji. I'll remind you when it's time.`;
      },
    },
    {
      match: /moved to (\w+)/i,
      tools: [{ name: "recall_person", input: { name: "Raju" } }],
      reply: () => "Bangalore! That's a big move for him. I'll remember it, and I'll ask Priya to tell us all about his new home.",
    },
    {
      match: /mango/i,
      tools: [{ name: "search_memories", input: { query: "mango tree Nashik village" } }],
      reply: () => "Oh, I love that one. The tree your father planted in Nashik, the summer you were seven. Tell me again, what did the first mango taste like?",
    },
  ],
  arjun: [
    {
      match: /anxious|nervous|dread|worried/i,
      tools: [{ name: "mood_patterns", input: {} }],
      reply: ([r]) => {
        const low = first<string>(r.mentioned_on_low_days)?.split(" (")[0] ?? "work";
        return `That Sunday-night feeling again. The last two times it was the ${low}, and both times it went better than you feared. Want to jot down the two things you'll say tomorrow?`;
      },
    },
    {
      match: /book/i,
      tools: [{ name: "search_memories", input: { query: "book Ankit suggested" } }],
      reply: () => "Four Thousand Weeks. Ankit brought it up over chai about two weeks ago, when you said you never have enough time. He asked again on Tuesday if you'd started it.",
    },
    {
      match: /forget|this week|coming up/i,
      tools: [{ name: "upcoming_events", input: { days: 7 } }],
      reply: ([r]) => {
        const rows = r as unknown as { person: string; event: string; date: string; last_talked_about: string }[];
        const mom = rows.find((x) => /surgery/i.test(x.event));
        const bday = rows.find((x) => /birthday/i.test(x.event));
        const parts = [
          mom && "Mom's knee surgery is today, so a call tonight would mean a lot to her.",
          bday && `And ${bday.person}'s birthday is on ${dayName(bday.date)}. You two haven't talked in ${bday.last_talked_about.replace(" ago", "")}.`,
        ].filter(Boolean);
        return parts.length ? `Two things. ${parts.join(" ")}` : "Your week looks clear. Maybe plan something nice for yourself.";
      },
    },
    {
      match: /talked to|reconnect|haven't (spoken|talked)|lost touch/i,
      tools: [{ name: "people_to_reconnect", input: {} }],
      reply: ([r]) => {
        const p = first<{ person: string; last_mentioned: string }>(r);
        return p ? `${p.person}. She matters a lot to you and hasn't come up in ${p.last_mentioned.replace(" ago", "")}. Her birthday is this week, the perfect excuse to call.` : "You've been in touch with everyone who matters lately. Nice.";
      },
    },
  ],
};

export async function demoReply(pid: string, persona: Persona, text: string): Promise<CompanionResult> {
  const scene = (SCENES[pid] ?? []).find((s) => s.match.test(text));
  const traces: Trace[] = [];
  if (!scene) {
    const out = await runTool(pid, "search_memories", { query: text });
    traces.push(out.trace);
    const hit = first<{ said: string }>((out.data as Data).conversations);
    return {
      reply: persona.mode === "elder" ? "That's lovely, Aaji. Tell me a little more?" : hit ? "Got it, I'll remember that. It reminds me of something you said a while back." : "Got it, I'll remember that.",
      traces,
    };
  }
  const outs: Data[] = [];
  for (const t of scene.tools) {
    const out = await runTool(pid, t.name, t.input);
    traces.push(out.trace);
    outs.push(out.data as Data);
  }
  await new Promise((r) => setTimeout(r, 700)); // feel like thinking
  return { reply: scene.reply(outs, persona), traces };
}

const empty = (): Extraction => ({
  mood: null,
  people: [],
  relations: [],
  lives_in: [],
  events: [],
  stories: [],
  things: [],
  topics: [],
  facts: [],
  meds_taken: [],
  preferences: [],
});

/** Scripted Memory-keeper for the demo lines. Everything it returns is written by memory.ts as usual. */
export function demoExtract(text: string, fromFamily: boolean): Extraction {
  const x = empty();
  const t = text.toLowerCase();
  const moved = text.match(/(\w+)\s+(?:told me he |has |had )?moved to (\w+)/i) ?? text.match(/(\w+) .*moved to (\w+)/i);
  if (moved) {
    const who = /^(he|she)$/i.test(moved[1]) ? "Raju" : moved[1];
    x.lives_in.push({ person: who.replace(/^\w/, (c) => c.toUpperCase()), place: moved[2].replace(/^\w/, (c) => c.toUpperCase()) });
  }
  if (t.includes("mango")) {
    x.stories.push({ title: "The mango tree in Nashik", summary: "Her father planted a mango tree in the Nashik courtyard; she climbed it with her brothers.", about: ["Nashik"] });
    x.mood = 5;
  }
  if (/(just|have) (took|taken)|i took/.test(t)) x.meds_taken.push("BP tablet");
  if (/anxious|nervous|dread|worried|tired|exhausted/.test(t)) {
    x.mood = 2;
    if (t.includes("tomorrow")) x.topics.push("Monday standup");
  }
  if (/visit|coming/.test(t) && /sunday|saturday|monday|tomorrow|next week/.test(t)) {
    const who = fromFamily ? "Raju" : (text.match(/^(\w+)/)?.[1] ?? "Raju");
    const day = new Date();
    const want = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].findIndex((d) => t.includes(d));
    if (want >= 0) day.setDate(day.getDate() + ((want - day.getDay() + 7) % 7 || 7));
    x.events.push({ title: `${who}'s visit`, date: day.toLocaleDateString("en-CA"), kind: "visit", person: who, place: null });
    if (t.includes("jalebi")) x.facts.push({ text: `${who} will bring jalebi when he visits`, about: [who] });
  }
  if (x.mood === null && !fromFamily) x.mood = /love|happy|lovely|good/.test(t) ? 4 : 3;
  return x;
}
