import type Anthropic from "@anthropic-ai/sdk";
import { run } from "./db";
import { embedOne } from "./embed";
import { SELF_ID, dayKey, logMedTaken, resolvePerson } from "./memory";

/*
 * Read side of the memory graph, exposed to the Companion agent as tools.
 * Every tool returns the data for the model plus a trace (the Cypher that ran and the node ids /
 * edges it touched), so the UI can light up the exact path an answer came from.
 */

export type Edge = [string, string, string]; // [fromId, toId, TYPE]

export interface Trace {
  tool: string;
  input: Record<string, unknown>;
  cypher: string[];
  nodes: string[];
  edges: Edge[];
}

type ToolOut = { data: unknown; trace: Trace };

const KIN = "CHILD_OF|SPOUSE_OF|SIBLING_OF|FRIEND_OF|CAREGIVER_OF|NEIGHBOUR_OF|COLLEAGUE_OF";
const fmtDay = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : null;
const ago = (ms: number) => {
  const d = Math.round((Date.now() - ms) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function start(pid: string, tool: string, input: Record<string, unknown>) {
  const t: Trace = { tool, input, cypher: [], nodes: [], edges: [] };
  const q = async <T extends Record<string, unknown>>(cypher: string, params: Record<string, unknown> = {}) => {
    t.cypher.push(cypher.replace(/\n\s+/g, "\n  ").trim());
    return run<T>(pid, cypher, params);
  };
  const lit = (ids: (string | null | undefined)[], edges: Edge[] = []) => {
    for (const id of ids) if (id && !t.nodes.includes(id)) t.nodes.push(id);
    for (const e of edges) t.edges.push(e);
  };
  return { t, q, lit };
}

const PATH_CYPHER = `MATCH (me:Person {id: $self}), (t {id: $target})
  MATCH p = (me)-[:${KIN}*1..4]-(t)
  WITH p ORDER BY length(p) LIMIT 1
  RETURN [n IN nodes(p) | n.id] AS ids, [n IN nodes(p) | n.name] AS names,
         [r IN relationships(p) | [startNode(r).id, endNode(r).id, type(r)]] AS rels`;

function describePath(ids: string[], names: string[], rels: Edge[]) {
  const nameOf = Object.fromEntries(ids.map((id, i) => [id, names[i]]));
  return rels.map(([a, b, ty]) => `${nameOf[a]} -${ty}-> ${nameOf[b]}`).join(", ");
}

async function findPersonId(q: ReturnType<typeof start>["q"], pid: string, name: string) {
  const direct = await resolvePerson(pid, name);
  if (direct) return direct;
  const term = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (!term) return null;
  const rows = await q<{ id: string }>(
    `CALL db.idx.fulltext.queryNodes('Person', $term) YIELD node, score
     RETURN node.id AS id ORDER BY score DESC LIMIT 1`,
    { term: term.split(/\s+/).map((w) => `${w}*`).join(" ") },
  );
  return rows[0]?.id ?? null;
}

/* ---------------- tools ---------------- */

async function recallPerson(pid: string, input: { name: string }): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "recall_person", input);
  const id = await findPersonId(q, pid, input.name);
  if (!id) return { data: { found: false, note: `No one called ${input.name} in memory yet.` }, trace: t };

  const [person] = await q<{ name: string; nicknames: string[]; note: string; verified: boolean; source: string }>(
    `MATCH (p:Person {id: $id})
     RETURN p.name AS name, p.nicknames AS nicknames, p.note AS note, p.verified AS verified, p.source AS source`,
    { id },
  );
  const path = await q<{ ids: string[]; names: string[]; rels: Edge[] }>(PATH_CYPHER, { self: SELF_ID, target: id });
  if (path[0]) lit(path[0].ids, path[0].rels);
  else lit([id]);

  const homes = await q<{ place: string; pid: string; from: number; to: number | null; verified: boolean; source: string }>(
    `MATCH (p:Person {id: $id})-[r:LIVES_IN]->(pl:Place)
     RETURN pl.name AS place, pl.id AS pid, r.valid_from AS from, r.valid_to AS to,
            coalesce(r.verified, true) AS verified, r.source AS source
     ORDER BY r.valid_from DESC`,
    { id },
  );
  const current = homes.filter((h) => h.to == null && !(h as { rejected?: boolean }).rejected);
  for (const h of current) lit([h.pid], [[id, h.pid, "LIVES_IN"]]);

  const events = await q<{ id: string; title: string; date: number }>(
    `MATCH (p:Person {id: $id})-[:HAS_EVENT]->(e:Event)
     RETURN e.id AS id, e.title AS title, e.date AS date ORDER BY e.date DESC LIMIT 5`,
    { id },
  );
  const facts = await q<{ text: string; source: string; at: number }>(
    `MATCH (f:Fact)-[:ABOUT]->(:Person {id: $id})
     RETURN f.text AS text, f.source AS source, f.valid_from AS at ORDER BY f.valid_from DESC LIMIT 6`,
    { id },
  );
  const mentions = await q<{ text: string; at: number; speaker: string }>(
    `MATCH (u:Utterance)-[:MENTIONS]->(:Person {id: $id})
     RETURN u.text AS text, u.at AS at, u.speaker AS speaker ORDER BY u.at DESC LIMIT 3`,
    { id },
  );
  const conflicts = await q<{ text: string }>(
    `MATCH (c:Conflict {status: 'open'})-[:ABOUT]->(:Person {id: $id}) RETURN c.text AS text`,
    { id },
  );

  return {
    data: {
      found: true,
      ...person,
      relation_path: path[0] ? describePath(path[0].ids, path[0].names, path[0].rels) : "no family link recorded",
      lives_in: current.map((h) => ({ place: h.place, since: fmtDay(h.from), verified: h.verified, source: h.source })),
      lived_before: homes.filter((h) => h.to != null).map((h) => ({ place: h.place, until: fmtDay(h.to) })),
      open_conflicts: conflicts.map((c) => c.text),
      events: events.map((e) => ({ title: e.title, date: fmtDay(e.date), upcoming: e.date > Date.now() })),
      facts: facts.map((f) => ({ text: f.text, source: f.source, when: fmtDay(f.at) })),
      last_mentioned: mentions.map((m) => ({ text: m.text, when: ago(m.at), by: m.speaker })),
    },
    trace: t,
  };
}

async function searchMemories(pid: string, input: { query: string }): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "search_memories", input);
  const vec = await embedOne(input.query);
  const utt = await q<{ id: string; text: string; at: number; speaker: string; score: number; about: { id: string; name: string }[] }>(
    `CALL db.idx.vector.queryNodes('Utterance', 'embedding', 6, vecf32($vec)) YIELD node, score
     OPTIONAL MATCH (node)-[:MENTIONS]->(x)
     RETURN node.id AS id, node.text AS text, node.at AS at, node.speaker AS speaker, score,
            collect({id: x.id, name: coalesce(x.name, x.title)}) AS about
     ORDER BY score`,
    { vec },
  );
  const facts = await q<{ text: string; source: string; at: number; score: number; about: { id: string; name: string }[] }>(
    `CALL db.idx.vector.queryNodes('Fact', 'embedding', 4, vecf32($vec)) YIELD node, score
     OPTIONAL MATCH (node)-[:ABOUT]->(x)
     RETURN node.text AS text, node.source AS source, node.valid_from AS at, score,
            collect({id: x.id, name: coalesce(x.name, x.title)}) AS about
     ORDER BY score`,
    { vec },
  );
  const stories = await q<{ id: string; title: string; summary: string; score: number; told: number }>(
    `CALL db.idx.vector.queryNodes('Story', 'embedding', 2, vecf32($vec)) YIELD node, score
     OPTIONAL MATCH (:Person {id: $self})-[t:TOLD]->(node)
     RETURN node.id AS id, node.title AS title, node.summary AS summary, score, count(t) AS told
     ORDER BY score`,
    { vec, self: SELF_ID },
  );
  const keep = <T extends { score: number }>(xs: T[], max = 0.62) => xs.filter((x) => x.score < max);
  const U = keep(utt).slice(0, 5);
  const F = keep(facts);
  const S = keep(stories, 0.55);
  for (const u of U) lit(u.about.filter((a) => a.id).map((a) => a.id));
  for (const f of F) lit(f.about.filter((a) => a.id).map((a) => a.id));
  for (const s of S) lit([s.id]);
  return {
    data: {
      conversations: U.map((u) => ({
        said: u.text,
        by: u.speaker,
        when: `${fmtDay(u.at)} (${ago(u.at)})`,
        mentions: u.about.filter((a) => a.id).map((a) => a.name),
      })),
      facts: F.map((f) => ({ text: f.text, source: f.source, when: fmtDay(f.at) })),
      stories: S.map((s) => ({ title: s.title, summary: s.summary, times_told: s.told })),
    },
    trace: t,
  };
}

async function findConnection(pid: string, input: { from: string; to: string }): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "find_connection", input);
  const lookup = async (name: string) => {
    const pidHit = await findPersonId(q, pid, name);
    if (pidHit) return pidHit;
    const rows = await q<{ id: string }>(
      `MATCH (x) WHERE (x:Place OR x:Event OR x:Story OR x:Thing OR x:Topic)
         AND (toLower(x.name) CONTAINS $n OR toLower(x.title) CONTAINS $n)
       RETURN x.id AS id LIMIT 1`,
      { n: name.toLowerCase() },
    );
    return rows[0]?.id ?? null;
  };
  const a = await lookup(input.from);
  const b = await lookup(input.to);
  if (!a || !b) return { data: { found: false, missing: !a ? input.from : input.to }, trace: t };
  const rows = await q<{ ids: string[]; names: string[]; rels: Edge[] }>(
    `MATCH (a {id: $a}), (b {id: $b})
     MATCH p = (a)-[*1..5]-(b)
     WHERE none(n IN nodes(p) WHERE n:Utterance OR n:Session OR n:Fact)
     WITH p ORDER BY length(p) LIMIT 1
     RETURN [n IN nodes(p) | n.id] AS ids, [n IN nodes(p) | coalesce(n.name, n.title)] AS names,
            [r IN relationships(p) | [startNode(r).id, endNode(r).id, type(r)]] AS rels`,
    { a, b },
  );
  if (!rows[0]) return { data: { found: false }, trace: t };
  lit(rows[0].ids, rows[0].rels);
  return { data: { found: true, path: describePath(rows[0].ids, rows[0].names, rows[0].rels) }, trace: t };
}

async function todaysRoutine(pid: string): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "todays_routine", {});
  const now = new Date();
  const rows = await q<{ rid: string; routine: string; time: string; mid: string; med: string; dose: string; takenAt: number | null }>(
    `MATCH (me:Person {id: $self})-[:FOLLOWS]->(r:Routine)
     OPTIONAL MATCH (r)-[:INCLUDES]->(m:Med)
     OPTIONAL MATCH (me)-[t:TOOK {day: $day}]->(m)
     RETURN r.id AS rid, r.name AS routine, r.time AS time, m.id AS mid, m.name AS med, m.dose AS dose,
            t.at AS takenAt
     ORDER BY r.time`,
    { self: SELF_ID, day: dayKey(now.getTime()) },
  );
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  for (const r of rows) {
    lit([SELF_ID, r.rid], [[SELF_ID, r.rid, "FOLLOWS"]]);
    if (r.mid) lit([r.mid], [[r.rid, r.mid, "INCLUDES"]]);
  }
  return {
    data: {
      now: hhmm,
      items: rows.map((r) => ({
        routine: r.routine,
        time: r.time,
        med: r.med ? `${r.med} ${r.dose ?? ""}`.trim() : null,
        status: !r.med ? null : r.takenAt ? `taken at ${new Date(r.takenAt).toTimeString().slice(0, 5)}` : r.time < hhmm ? "due, not taken yet" : "later today",
      })),
    },
    trace: t,
  };
}

async function logMed(pid: string, input: { med: string }): Promise<ToolOut> {
  const { t } = start(pid, "log_med_taken", input);
  t.cypher.push(`MATCH (me:Person {id: $self}), (m:Med {id: $med})\nMERGE (me)-[t:TOOK {day: $today}]->(m)\nON CREATE SET t.at = timestamp()`);
  const name = await logMedTaken(pid, input.med, Date.now());
  if (name) t.nodes.push(SELF_ID);
  return { data: name ? { logged: name } : { logged: false, note: "No matching medicine in the routine." }, trace: t };
}

async function upcomingEvents(pid: string, input: { days?: number }): Promise<ToolOut> {
  const days = Math.min(Math.max(input.days ?? 7, 1), 60);
  const { t, q, lit } = start(pid, "upcoming_events", { days });
  const now = Date.now();
  const rows = await q<{ eid: string; title: string; date: number; pid: string; person: string; lastTalk: number | null }>(
    `MATCH (p:Person)-[:HAS_EVENT]->(e:Event)
     WHERE e.date >= $from AND e.date <= $to
     OPTIONAL MATCH (u:Utterance {speaker: 'self'})-[:MENTIONS]->(p)
     RETURN e.id AS eid, e.title AS title, e.date AS date, p.id AS pid, p.name AS person, max(u.at) AS lastTalk
     ORDER BY e.date`,
    { from: now - 12 * 3600e3, to: now + days * 864e5 },
  );
  for (const r of rows) {
    lit([r.pid, r.eid], [[r.pid, r.eid, "HAS_EVENT"]]);
    const path = await q<{ ids: string[]; names: string[]; rels: Edge[] }>(PATH_CYPHER, { self: SELF_ID, target: r.pid });
    if (path[0]) lit(path[0].ids, path[0].rels);
  }
  return {
    data: rows.map((r) => ({
      person: r.person,
      event: r.title,
      date: fmtDay(r.date),
      last_talked_about: r.lastTalk ? ago(r.lastTalk) : "never",
    })),
    trace: t,
  };
}

async function moodPatterns(pid: string): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "mood_patterns", {});
  const since = Date.now() - 30 * 864e5;
  const byDay = await q<{ wd: number; mood: number; n: number }>(
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session) WHERE s.at > $since AND s.mood IS NOT NULL
     RETURN s.weekday AS wd, avg(s.mood) AS mood, count(s) AS n ORDER BY wd`,
    { self: SELF_ID, since },
  );
  const low = await q<{ id: string; name: string; times: number }>(
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session)-[:CONTAINS]->(:Utterance)-[:MENTIONS]->(x)
     WHERE s.at > $since AND s.mood <= 2.5 AND NOT x:Utterance AND x.id <> $self
     RETURN x.id AS id, coalesce(x.name, x.title) AS name, count(DISTINCT s) AS times
     ORDER BY times DESC LIMIT 4`,
    { self: SELF_ID, since },
  );
  const high = await q<{ id: string; name: string; times: number }>(
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session)-[:CONTAINS]->(:Utterance)-[:MENTIONS]->(x)
     WHERE s.at > $since AND s.mood >= 4 AND x.id <> $self
     RETURN x.id AS id, coalesce(x.name, x.title) AS name, count(DISTINCT s) AS times
     ORDER BY times DESC LIMIT 4`,
    { self: SELF_ID, since },
  );
  lit([SELF_ID, ...low.map((l) => l.id)], low.map((l) => [SELF_ID, l.id, "LOW_MOOD_WITH"] as Edge));
  const W = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    data: {
      average_by_weekday: byDay.map((d) => ({ day: W[d.wd], mood: Math.round(d.mood * 10) / 10, sessions: d.n })),
      mentioned_on_low_days: low.map((l) => `${l.name} (${l.times} sessions)`),
      mentioned_on_bright_days: high.map((h) => `${h.name} (${h.times} sessions)`),
      scale: "1 low .. 5 bright",
    },
    trace: t,
  };
}

async function peopleToReconnect(pid: string): Promise<ToolOut> {
  const { t, q, lit } = start(pid, "people_to_reconnect", {});
  const rank = await q<{ id: string; name: string; score: number }>(
    `CALL algo.pageRank('Person', null) YIELD node, score
     WHERE node.id <> $self AND coalesce(node.verified, false)
     RETURN node.id AS id, node.name AS name, score ORDER BY score DESC`,
    { self: SELF_ID },
  );
  const last = await q<{ id: string; lastAt: number | null; n: number }>(
    `MATCH (p:Person) WHERE p.id <> $self
     OPTIONAL MATCH (u:Utterance {speaker: 'self'})-[:MENTIONS]->(p)
     RETURN p.id AS id, max(u.at) AS lastAt, count(u) AS n`,
    { self: SELF_ID },
  );
  const lastBy = Object.fromEntries(last.map((l) => [l.id, l]));
  const out = rank
    .map((r) => ({ ...r, lastAt: lastBy[r.id]?.lastAt ?? null, mentions: lastBy[r.id]?.n ?? 0 }))
    .filter((r) => !r.lastAt || Date.now() - r.lastAt > 14 * 864e5)
    .slice(0, 4);
  lit(out.map((o) => o.id));
  return {
    data: out.map((o) => ({
      person: o.name,
      importance: Math.round(o.score * 100) / 100,
      last_mentioned: o.lastAt ? ago(o.lastAt) : "never",
    })),
    trace: t,
  };
}

/* ---------------- registry ---------------- */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "recall_person",
    description:
      "Look up one person in memory: how they are related to the user (family path), where they live now and before, upcoming and past events, facts family added, and when they were last mentioned. Use for any question about a named person, nickname or relation.",
    input_schema: obj({ name: { type: "string", description: "Name, nickname, or relation word as said, e.g. 'Raju'" } }, ["name"]),
  },
  {
    name: "search_memories",
    description:
      "Semantic search over past conversations, stored facts and stories, then expands to the people, places and things they mention. Use for 'what was that…', 'did I tell you…', or anything not tied to one person.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "find_connection",
    description: "Find how two remembered things are connected (people, places, events, stories, things). Returns the shortest path.",
    input_schema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    name: "todays_routine",
    description: "Today's routines and medicines, with whether each dose was taken. Use for any question about pills, tablets, meds or the daily schedule.",
    input_schema: obj({}),
  },
  {
    name: "log_med_taken",
    description: "Record that the user has just taken a medicine. Only call when the user says they took it.",
    input_schema: obj({ med: { type: "string", description: "Medicine as the user named it" } }, ["med"]),
  },
  {
    name: "upcoming_events",
    description: "Birthdays, visits, appointments and other events for the people in the user's life in the next N days.",
    input_schema: obj({ days: { type: "integer", minimum: 1, maximum: 60 } }),
  },
  {
    name: "mood_patterns",
    description: "Mood trends from past sessions: average by weekday and what tends to come up on low and bright days.",
    input_schema: obj({}),
  },
  {
    name: "people_to_reconnect",
    description: "Important people (ranked with PageRank over the relationship graph) who have not come up in conversation for two weeks or more.",
    input_schema: obj({}),
  },
];

export async function runTool(pid: string, name: string, input: Record<string, unknown>): Promise<ToolOut> {
  switch (name) {
    case "recall_person":
      return recallPerson(pid, input as { name: string });
    case "search_memories":
      return searchMemories(pid, input as { query: string });
    case "find_connection":
      return findConnection(pid, input as { from: string; to: string });
    case "todays_routine":
      return todaysRoutine(pid);
    case "log_med_taken":
      return logMed(pid, input as { med: string });
    case "upcoming_events":
      return upcomingEvents(pid, input as { days?: number });
    case "mood_patterns":
      return moodPatterns(pid);
    case "people_to_reconnect":
      return peopleToReconnect(pid);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
