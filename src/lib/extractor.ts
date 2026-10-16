import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { run } from "./db";
import {
  SELF_ID,
  addFact,
  addMood,
  addPreference,
  linkKin,
  logMedTaken,
  setLivesIn,
  slug,
  tellStory,
  upsertEvent,
  upsertPerson,
  upsertPlace,
  upsertThing,
  upsertTopic,
  type Source,
} from "./memory";
import { KINSHIP, type Persona } from "./personas";
import type { Edge, Trace } from "./tools";

/*
 * Memory-keeper agent. Reads one utterance and turns it into graph writes.
 * The model only proposes structured facts; every write is deterministic Cypher in memory.ts,
 * so the model can never run arbitrary queries against the database.
 */

let client: Anthropic | null = null;
const ai = () => (client ??= new Anthropic());
const MODEL = process.env.MITHI_EXTRACT_MODEL ?? "claude-haiku-4-5";

const Extraction = z.object({
  mood: z.number().int().min(1).max(5).nullable().describe("Speaker's mood 1 (low) to 5 (bright); null if unclear or not the user speaking"),
  people: z.array(
    z.object({
      name: z.string().describe("Canonical first name, e.g. 'Raju'. Use 'SELF' for the user."),
      nicknames: z.array(z.string()),
      note: z.string().nullable().describe("Short descriptor worth remembering, e.g. 'neighbour, makes great puran poli'"),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string(),
      type: z.enum(KINSHIP),
      to: z.string().describe("Person name or 'SELF'"),
    }),
  ).describe("CHILD_OF points child -> parent. A grandson is CHILD_OF the user's child."),
  lives_in: z.array(z.object({ person: z.string(), place: z.string() })).describe("Only where someone lives now, e.g. after a move"),
  events: z.array(
    z.object({
      title: z.string().describe("Short, unique title, e.g. 'Raju's visit' or 'Mom's knee surgery'"),
      date: z.string().nullable().describe("ISO date YYYY-MM-DD if known or inferable from today's date"),
      kind: z.enum(["birthday", "visit", "appointment", "celebration", "milestone", "other"]),
      person: z.string().nullable(),
      place: z.string().nullable(),
    }),
  ),
  stories: z.array(
    z.object({
      title: z.string(),
      summary: z.string().describe("One or two sentences"),
      about: z.array(z.string()).describe("People or places in the story"),
    }),
  ).describe("Only real reminiscences (past memories being told), not small talk"),
  things: z.array(
    z.object({ name: z.string(), kind: z.string(), recommended_by: z.string().nullable() }),
  ).describe("Books, films, songs, dishes, objects worth remembering"),
  topics: z.array(z.string()).describe("Recurring life topics, e.g. 'Monday standup', 'knee pain'. At most 3."),
  facts: z.array(z.object({ text: z.string(), about: z.array(z.string()) })).describe(
    "Other durable facts as short sentences in third person, e.g. 'Priya is a teacher'",
  ),
  meds_taken: z.array(z.string()).describe("Medicines the user says they have just taken"),
  preferences: z.array(z.string()).describe("Likes, dislikes, or how they want to be treated"),
});
export type Extraction = z.infer<typeof Extraction>;

async function knownPeople(pid: string) {
  const rows = await run<{ name: string; nick: string[]; note: string | null }>(
    pid,
    `MATCH (p:Person) WHERE p.id <> $self RETURN p.name AS name, p.nicknames AS nick, p.note AS note LIMIT 60`,
    { self: SELF_ID },
  );
  return rows.map((r) => `${r.name}${r.nick?.length ? ` (aka ${r.nick.join(", ")})` : ""}${r.note ? `: ${r.note}` : ""}`).join("\n");
}

export async function extract(
  pid: string,
  persona: Persona,
  text: string,
  speaker: { source: Source; name: string },
): Promise<Extraction | null> {
  const today = new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" });
  const res = await ai().messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: `You maintain the long-term memory graph for ${persona.fullName} ("${persona.name}"). ${persona.about}
Extract only what is actually stated or clearly implied. Never invent people, dates or relations.
Resolve people to the known names below when they match a nickname or relation word ("my grandson" -> the known grandson).
Use "SELF" for ${persona.name}. Today is ${today}.

Known people:
${await knownPeople(pid)}`,
    messages: [
      {
        role: "user",
        content: `Speaker: ${speaker.source === "self" ? persona.name : `${speaker.name} (${speaker.source})`}\nSaid: "${text}"`,
      },
    ],
    output_config: { format: zodOutputFormat(Extraction) },
  });
  return res.parsed_output ?? null;
}

export interface MemoryWrite {
  summary: string[];
  mentionIds: string[];
  trace: Trace;
  storyRepeat?: { title: string; times: number };
  conflict?: string;
}

/** Apply an extraction to the graph. Returns what changed, ids to link the utterance to, and a trace. */
export async function applyExtraction(
  pid: string,
  persona: Persona,
  x: Extraction,
  source: Source,
  sessionId: string | null,
): Promise<MemoryWrite> {
  const now = Date.now();
  const summary: string[] = [];
  const nodes = new Set<string>();
  const edges: Edge[] = [];
  const cypher: string[] = [];
  // In elder mode, new people mentioned by the elder stay unverified until family confirms them.
  const verified = source !== "self" || persona.mode === "personal";

  const ids = new Map<string, string>([["self", SELF_ID]]);
  const personId = async (name: string | null | undefined) => {
    if (!name) return null;
    const k = name.trim().toLowerCase();
    if (k === "self" || k === persona.name.toLowerCase()) return SELF_ID;
    if (ids.has(k)) return ids.get(k)!;
    const id = await upsertPerson(pid, { name: name.trim(), source, verified });
    ids.set(k, id);
    return id;
  };
  const anyId = async (name: string) => {
    const pidHit = await run<{ id: string }>(
      pid,
      `MATCH (x) WHERE (x:Person OR x:Place) AND (toLower(x.name) = $n OR any(k IN coalesce(x.nicknames, []) WHERE toLower(k) = $n))
       RETURN x.id AS id LIMIT 1`,
      { n: name.toLowerCase() },
    );
    return pidHit[0]?.id ?? (await personId(name));
  };

  for (const p of x.people) {
    if (p.name.toUpperCase() === "SELF") continue;
    const id = await upsertPerson(pid, { name: p.name, nicknames: p.nicknames, note: p.note, source, verified });
    ids.set(p.name.toLowerCase(), id);
    nodes.add(id);
  }
  if (x.people.length) cypher.push("MERGE (p:Person {id: $id}) ON CREATE SET p.name = $name, p.source = $source, p.verified = $verified");

  for (const r of x.relations) {
    const a = await personId(r.from);
    const b = await personId(r.to);
    if (!a || !b) continue;
    await linkKin(pid, a, b, r.type, source);
    nodes.add(a).add(b);
    edges.push([a, b, r.type]);
  }
  if (x.relations.length) cypher.push("MATCH (a:Person {id: $a}), (b:Person {id: $b})\nMERGE (a)-[r:CHILD_OF]->(b) ON CREATE SET r.source = $source");

  let conflict: string | undefined;
  for (const l of x.lives_in) {
    const p = await personId(l.person);
    if (!p) continue;
    const res = await setLivesIn(pid, p, l.place, source, persona.mode);
    const placeId = `place:${slug(l.place)}`;
    nodes.add(p).add(placeId);
    edges.push([p, placeId, "LIVES_IN"]);
    if (res.action === "moved") summary.push(`${l.person} moved ${res.from} → ${res.to} (old fact closed, kept in history)`);
    if (res.action === "added") summary.push(`${l.person} lives in ${res.to}`);
    if (res.action === "conflict") {
      conflict = `${l.person}: said ${res.to}, family says ${res.from}`;
      summary.push(`Conflict flagged for family: ${conflict}`);
    }
  }
  if (x.lives_in.length)
    cypher.push(
      "MATCH (p:Person {id: $p})-[r:LIVES_IN]->() WHERE r.valid_to IS NULL\nSET r.valid_to = timestamp()   // close, never delete\nCREATE (p)-[:LIVES_IN {valid_from: timestamp(), source: $source}]->(:Place {id: $place})",
    );

  for (const e of x.events) {
    const pId = await personId(e.person);
    const plId = e.place ? await upsertPlace(pid, e.place) : null;
    const date = e.date ? new Date(`${e.date}T10:00:00`).getTime() : null;
    const id = await upsertEvent(pid, { title: e.title, date: Number.isFinite(date) ? date : null, kind: e.kind, personId: pId, placeId: plId, source });
    nodes.add(id);
    if (pId) edges.push([pId, id, "HAS_EVENT"]);
    summary.push(`Event: ${e.title}${e.date ? ` on ${e.date}` : ""}`);
  }

  let storyRepeat: MemoryWrite["storyRepeat"];
  for (const s of x.stories) {
    const about = (await Promise.all(s.about.map(anyId))).filter((v): v is string => !!v);
    const res = await tellStory(pid, { title: s.title, summary: s.summary, aboutIds: about, at: now });
    nodes.add(res.id);
    edges.push([SELF_ID, res.id, "TOLD"]);
    about.forEach((a) => edges.push([res.id, a, "ABOUT"]));
    if (res.retold) {
      summary.push(`Retold story “${s.title}” (${res.times7d}× this week)`);
      if (res.times7d >= 3) storyRepeat = { title: s.title, times: res.times7d };
    } else summary.push(`New story: ${s.title}`);
  }
  if (x.stories.length)
    cypher.push("CALL db.idx.vector.queryNodes('Story', 'embedding', 1, vecf32($vec)) YIELD node, score\n// score < 0.35 → same story retold, else a new Story node\nCREATE (me)-[:TOLD {at: timestamp()}]->(story)");

  for (const t of x.things) {
    const by = await personId(t.recommended_by);
    const id = await upsertThing(pid, t.name, t.kind, by);
    nodes.add(id);
    if (by) edges.push([by, id, "RECOMMENDED"]);
    summary.push(`Remembered ${t.kind}: ${t.name}`);
  }
  for (const name of x.topics.slice(0, 3)) nodes.add(await upsertTopic(pid, name));

  for (const f of x.facts) {
    const about = (await Promise.all(f.about.map(anyId))).filter((v): v is string => !!v);
    await addFact(pid, { text: f.text, aboutIds: about, source, confidence: source === "self" && persona.mode === "elder" ? 0.6 : 0.9, at: now });
    about.forEach((a) => nodes.add(a));
    summary.push(`Fact: ${f.text}`);
  }
  for (const m of x.meds_taken) {
    const name = await logMedTaken(pid, m, now);
    if (name) summary.push(`Logged dose: ${name}`);
  }
  for (const p of x.preferences) {
    await addPreference(pid, p, source);
    summary.push(`Preference: ${p}`);
  }
  if (sessionId && x.mood && source === "self") await addMood(pid, sessionId, x.mood);

  const mentionIds = [...nodes].filter((id) => id !== SELF_ID);
  return {
    summary,
    mentionIds,
    storyRepeat,
    conflict,
    trace: { tool: "memory_keeper", input: {}, cypher, nodes: [...nodes], edges },
  };
}
