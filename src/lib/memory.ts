import { run } from "./db";
import { EMBED_DIM, embed } from "./embed";
import { KINSHIP, type Kinship, type PersonaMode } from "./personas";

/*
 * Write side of Mithi's memory graph.
 *
 * Semantic memory  : Person, Place, Thing, Topic, Fact and the edges between them
 * Episodic memory  : Session -> Utterance -> MENTIONS -> entity, Story told on a date, Event
 * Procedural memory: Routine -> INCLUDES -> Med, Preference, TOOK (adherence log)
 *
 * Facts that change are never deleted. LIVES_IN edges carry valid_from / valid_to, and every
 * edge or fact remembers who said it (source) and how sure we are (confidence).
 */

export const SELF_ID = "person:self";

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

export type Source = "self" | "family" | "caregiver" | "agent";

export async function ensureSchema(pid: string) {
  const stmts = [
    "CREATE INDEX FOR (n:Person) ON (n.id)",
    "CREATE INDEX FOR (n:Place) ON (n.id)",
    "CREATE INDEX FOR (n:Event) ON (n.id)",
    "CREATE INDEX FOR (n:Story) ON (n.id)",
    "CREATE INDEX FOR (n:Thing) ON (n.id)",
    "CREATE INDEX FOR (n:Topic) ON (n.id)",
    "CREATE INDEX FOR (n:Med) ON (n.id)",
    "CREATE INDEX FOR (n:Routine) ON (n.id)",
    "CREATE INDEX FOR (n:Session) ON (n.id)",
    "CREATE INDEX FOR (n:Session) ON (n.at)",
    "CREATE INDEX FOR (n:Utterance) ON (n.at)",
    "CALL db.idx.fulltext.createNodeIndex('Person', 'name', 'aliases')",
    `CREATE VECTOR INDEX FOR (u:Utterance) ON (u.embedding) OPTIONS {dimension:${EMBED_DIM}, similarityFunction:'cosine'}`,
    `CREATE VECTOR INDEX FOR (f:Fact) ON (f.embedding) OPTIONS {dimension:${EMBED_DIM}, similarityFunction:'cosine'}`,
    `CREATE VECTOR INDEX FOR (s:Story) ON (s.embedding) OPTIONS {dimension:${EMBED_DIM}, similarityFunction:'cosine'}`,
  ];
  for (const s of stmts) {
    try {
      await run(pid, s);
    } catch {
      // index already exists
    }
  }
}

/* ---------------- people ---------------- */

export async function ensureSelf(pid: string, name: string, fullName: string) {
  await run(
    pid,
    `MERGE (p:Person {id: $id})
     ON CREATE SET p.name = $name, p.fullName = $fullName, p.self = true, p.verified = true,
                   p.aliases = $name, p.nicknames = [], p.source = 'self', p.created = timestamp()`,
    { id: SELF_ID, name, fullName },
  );
}

/** Find an existing person by name or nickname. Returns their id or null. */
export async function resolvePerson(pid: string, name: string): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if (["me", "i", "myself"].includes(n)) return SELF_ID;
  const rows = await run<{ id: string }>(
    pid,
    `MATCH (p:Person)
     WHERE toLower(p.name) = $n OR any(x IN p.nicknames WHERE toLower(x) = $n)
        OR toLower(split(p.name, ' ')[0]) = $n
     RETURN p.id AS id ORDER BY p.self DESC LIMIT 1`,
    { n },
  );
  return rows[0]?.id ?? null;
}

export async function upsertPerson(
  pid: string,
  p: { name: string; nicknames?: string[]; note?: string | null; source: Source; verified: boolean },
): Promise<string> {
  const existing = await resolvePerson(pid, p.name);
  const nick = (p.nicknames ?? []).filter(Boolean);
  if (existing) {
    await run(
      pid,
      `MATCH (x:Person {id: $id})
       SET x.nicknames = [n IN coalesce(x.nicknames, []) WHERE NOT n IN $nick] + $nick,
           x.note = coalesce($note, x.note),
           x.verified = x.verified OR $verified
       SET x.aliases = x.name + ' ' + reduce(s = '', n IN x.nicknames | s + ' ' + n)`,
      { id: existing, nick, note: p.note ?? null, verified: p.verified },
    );
    return existing;
  }
  const id = `person:${slug(p.name)}`;
  await run(
    pid,
    `MERGE (x:Person {id: $id})
     ON CREATE SET x.name = $name, x.nicknames = $nick, x.note = $note, x.source = $source,
                   x.verified = $verified, x.created = timestamp(),
                   x.aliases = $name + ' ' + reduce(s = '', n IN $nick | s + ' ' + n)`,
    { id, name: p.name, nick, note: p.note ?? null, source: p.source, verified: p.verified },
  );
  return id;
}

export async function linkKin(pid: string, fromId: string, toId: string, type: Kinship, source: Source) {
  if (!KINSHIP.includes(type) || fromId === toId) return;
  // relationship type comes from the KINSHIP allow-list, never from user text
  await run(
    pid,
    `MATCH (a:Person {id: $a}), (b:Person {id: $b})
     MERGE (a)-[r:${type}]->(b)
     ON CREATE SET r.source = $source, r.at = timestamp()`,
    { a: fromId, b: toId, source },
  );
}

/* ---------------- places & time-versioned facts ---------------- */

export async function upsertPlace(pid: string, name: string): Promise<string> {
  const id = `place:${slug(name)}`;
  await run(pid, `MERGE (p:Place {id: $id}) ON CREATE SET p.name = $name`, { id, name });
  return id;
}

export interface LivesInResult {
  action: "same" | "added" | "moved" | "conflict";
  from?: string;
  to: string;
}

/**
 * LIVES_IN is functional: a person lives in one place at a time.
 * - Same place: nothing to do.
 * - Personal mode, or the new claim comes from family: close the old edge (valid_to) and add the new one.
 * - Elder mode and an unverified self claim contradicts a family fact: keep both, mark the new one
 *   unverified and raise a conflict for the family to confirm.
 */
export async function setLivesIn(
  pid: string,
  personId: string,
  placeName: string,
  source: Source,
  mode: PersonaMode,
): Promise<LivesInResult> {
  const placeId = await upsertPlace(pid, placeName);
  const cur = await run<{ place: string; pname: string; source: string }>(
    pid,
    `MATCH (:Person {id: $p})-[r:LIVES_IN]->(pl:Place)
     WHERE r.valid_to IS NULL AND coalesce(r.verified, true)
     RETURN pl.id AS place, pl.name AS pname, r.source AS source`,
    { p: personId },
  );
  const now = Date.now();
  if (cur.some((c) => c.place === placeId)) return { action: "same", to: placeName };

  const old = cur[0];
  const trusted = source === "family" || source === "caregiver" || mode === "personal";
  if (old && !trusted && (old.source === "family" || old.source === "caregiver")) {
    await run(
      pid,
      `MATCH (p:Person {id: $p}), (pl:Place {id: $pl})
       MERGE (p)-[r:LIVES_IN {verified: false}]->(pl)
       ON CREATE SET r.valid_from = $now, r.source = $source, r.confidence = 0.6
       MERGE (c:Conflict {id: $cid})
       ON CREATE SET c.at = $now, c.kind = 'lives_in', c.status = 'open',
                     c.text = $text
       MERGE (c)-[:ABOUT]->(p)`,
      {
        p: personId,
        pl: placeId,
        now,
        source,
        cid: `conflict:${slug(personId)}:${placeId}`,
        text: `Said ${placeName}, family record says ${old.pname}`,
      },
    );
    return { action: "conflict", from: old.pname, to: placeName };
  }

  await run(
    pid,
    `MATCH (p:Person {id: $p})-[r:LIVES_IN]->(:Place)
     WHERE r.valid_to IS NULL
     SET r.valid_to = $now`,
    { p: personId, now },
  );
  await run(
    pid,
    `MATCH (p:Person {id: $p}), (pl:Place {id: $pl})
     CREATE (p)-[:LIVES_IN {valid_from: $now, source: $source, confidence: $conf, verified: true}]->(pl)`,
    { p: personId, pl: placeId, now, source, conf: trusted ? 0.95 : 0.7 },
  );
  return { action: old ? "moved" : "added", from: old?.pname, to: placeName };
}

/** Family confirms a conflicting claim: the new place wins and the old edge closes. */
export async function resolveConflict(pid: string, conflictId: string, accept: boolean) {
  const now = Date.now();
  if (accept) {
    await run(
      pid,
      `MATCH (c:Conflict {id: $id})-[:ABOUT]->(p:Person)
       MATCH (p)-[old:LIVES_IN]->(:Place) WHERE old.valid_to IS NULL AND coalesce(old.verified, true)
       SET old.valid_to = $now`,
      { id: conflictId, now },
    );
    await run(
      pid,
      `MATCH (c:Conflict {id: $id})-[:ABOUT]->(p:Person)
       MATCH (p)-[r:LIVES_IN {verified: false}]->(:Place) WHERE r.valid_to IS NULL
       SET r.verified = true, r.source = 'family', r.confidence = 0.95`,
      { id: conflictId },
    );
  } else {
    await run(
      pid,
      `MATCH (c:Conflict {id: $id})-[:ABOUT]->(p:Person)
       MATCH (p)-[r:LIVES_IN {verified: false}]->(:Place) WHERE r.valid_to IS NULL
       SET r.valid_to = $now, r.rejected = true`,
      { id: conflictId, now },
    );
  }
  await run(pid, `MATCH (c:Conflict {id: $id}) SET c.status = $s, c.resolved = $now`, {
    id: conflictId,
    s: accept ? "accepted" : "rejected",
    now,
  });
}

/* ---------------- events, stories, things, topics ---------------- */

export async function upsertEvent(
  pid: string,
  e: { title: string; date: number | null; kind: string; personId?: string | null; placeId?: string | null; source: Source },
): Promise<string> {
  const id = `event:${slug(e.title)}`;
  await run(
    pid,
    `MERGE (e:Event {id: $id})
     ON CREATE SET e.title = $title, e.kind = $kind, e.source = $source, e.created = timestamp()
     SET e.date = coalesce($date, e.date)`,
    { id, title: e.title, kind: e.kind, date: e.date, source: e.source },
  );
  if (e.personId)
    await run(pid, `MATCH (p:Person {id: $p}), (e:Event {id: $e}) MERGE (p)-[:HAS_EVENT]->(e)`, {
      p: e.personId,
      e: id,
    });
  if (e.placeId)
    await run(pid, `MATCH (pl:Place {id: $pl}), (e:Event {id: $e}) MERGE (e)-[:AT]->(pl)`, {
      pl: e.placeId,
      e: id,
    });
  return id;
}

/** Find a story already in memory that this one is a retelling of (vector similarity). */
async function similarStory(pid: string, vec: number[]): Promise<string | null> {
  const rows = await run<{ id: string; score: number }>(
    pid,
    `CALL db.idx.vector.queryNodes('Story', 'embedding', 1, vecf32($vec)) YIELD node, score
     RETURN node.id AS id, score`,
    { vec },
  );
  // cosine distance: 0 is identical. 0.35 catches retellings in different words.
  return rows[0] && rows[0].score < 0.35 ? rows[0].id : null;
}

export async function tellStory(
  pid: string,
  s: { title: string; summary: string; aboutIds: string[]; at: number },
): Promise<{ id: string; times7d: number; retold: boolean }> {
  const [vec] = await embed([`${s.title}. ${s.summary}`]);
  const match = await similarStory(pid, vec);
  const id = match ?? `story:${slug(s.title)}`;
  await run(
    pid,
    `MERGE (st:Story {id: $id})
     ON CREATE SET st.title = $title, st.summary = $summary, st.embedding = vecf32($vec), st.created = $at`,
    { id, title: s.title, summary: s.summary, vec, at: s.at },
  );
  await run(
    pid,
    `MATCH (me:Person {id: $self}), (st:Story {id: $id}) CREATE (me)-[:TOLD {at: $at}]->(st)`,
    { self: SELF_ID, id, at: s.at },
  );
  for (const a of s.aboutIds)
    await run(pid, `MATCH (st:Story {id: $id}), (x {id: $a}) MERGE (st)-[:ABOUT]->(x)`, { id, a });
  const [{ n }] = await run<{ n: number }>(
    pid,
    `MATCH (:Person {id: $self})-[t:TOLD]->(:Story {id: $id}) WHERE t.at > $since RETURN count(t) AS n`,
    { self: SELF_ID, id, since: s.at - 7 * 864e5 },
  );
  return { id, times7d: n, retold: !!match };
}

export async function upsertThing(pid: string, name: string, kind: string, recommendedBy?: string | null) {
  const id = `thing:${slug(name)}`;
  await run(pid, `MERGE (t:Thing {id: $id}) ON CREATE SET t.name = $name, t.kind = $kind`, { id, name, kind });
  if (recommendedBy)
    await run(
      pid,
      `MATCH (p:Person {id: $p}), (t:Thing {id: $t}) MERGE (p)-[r:RECOMMENDED]->(t) ON CREATE SET r.at = timestamp()`,
      { p: recommendedBy, t: id },
    );
  return id;
}

export async function upsertTopic(pid: string, name: string) {
  const id = `topic:${slug(name)}`;
  await run(pid, `MERGE (t:Topic {id: $id}) ON CREATE SET t.name = $name`, { id, name });
  return id;
}

export async function addFact(
  pid: string,
  f: { text: string; aboutIds: string[]; source: Source; confidence: number; at: number },
) {
  const [vec] = await embed([f.text]);
  const id = `fact:${f.at}:${slug(f.text).slice(0, 40)}`;
  await run(
    pid,
    `CREATE (f:Fact {id: $id, text: $text, source: $source, confidence: $conf, valid_from: $at,
                     embedding: vecf32($vec)})`,
    { id, text: f.text, source: f.source, conf: f.confidence, at: f.at, vec },
  );
  for (const a of f.aboutIds)
    await run(pid, `MATCH (f:Fact {id: $id}), (x {id: $a}) MERGE (f)-[:ABOUT]->(x)`, { id, a });
  return id;
}

export async function addPreference(pid: string, text: string, source: Source) {
  await run(
    pid,
    `MATCH (me:Person {id: $self})
     MERGE (p:Preference {text: $text}) ON CREATE SET p.source = $source, p.at = timestamp()
     MERGE (me)-[:PREFERS]->(p)`,
    { self: SELF_ID, text, source },
  );
}

/* ---------------- routines & meds (procedural) ---------------- */

export async function upsertRoutine(pid: string, name: string, time: string, meds: { name: string; dose: string }[]) {
  const id = `routine:${slug(name)}`;
  await run(
    pid,
    `MATCH (me:Person {id: $self})
     MERGE (r:Routine {id: $id}) ON CREATE SET r.name = $name SET r.time = $time
     MERGE (me)-[:FOLLOWS]->(r)`,
    { self: SELF_ID, id, name, time },
  );
  for (const m of meds)
    await run(
      pid,
      `MATCH (r:Routine {id: $r})
       MERGE (m:Med {id: $id}) ON CREATE SET m.name = $name SET m.dose = $dose
       MERGE (r)-[:INCLUDES]->(m)`,
      { r: id, id: `med:${slug(m.name)}`, name: m.name, dose: m.dose },
    );
  return id;
}

/** Log a dose. Matches the med loosely ("tablet", "BP pill"), so the companion can pass what was said. */
export async function logMedTaken(pid: string, medName: string, at: number) {
  const rows = await run<{ id: string; name: string }>(
    pid,
    `MATCH (:Person {id: $self})-[:FOLLOWS]->(:Routine)-[:INCLUDES]->(m:Med)
     RETURN m.id AS id, m.name AS name`,
    { self: SELF_ID },
  );
  const q = medName.toLowerCase();
  const hit =
    rows.find((r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase())) ??
    rows.find((r) => r.name.toLowerCase().split(/\W+/).some((w) => w.length > 2 && q.includes(w))) ??
    (rows.length === 1 ? rows[0] : undefined);
  if (!hit) return null;
  await run(
    pid,
    `MATCH (me:Person {id: $self}), (m:Med {id: $id})
     MERGE (me)-[t:TOOK {day: $day}]->(m) ON CREATE SET t.at = $at`,
    { self: SELF_ID, id: hit.id, day: dayKey(at), at },
  );
  return hit.name;
}

/* ---------------- sessions & utterances (episodic) ---------------- */

const SESSION_GAP = 3 * 3600e3;

export async function currentSession(pid: string, now: number): Promise<string> {
  const rows = await run<{ id: string; last: number }>(
    pid,
    `MATCH (me:Person {id: $self})-[:HAD]->(s:Session)
     RETURN s.id AS id, s.last AS last ORDER BY s.at DESC LIMIT 1`,
    { self: SELF_ID },
  );
  if (rows[0] && now - rows[0].last < SESSION_GAP && dayKey(rows[0].last) === dayKey(now)) return rows[0].id;
  return createSession(pid, now);
}

export async function createSession(pid: string, at: number, kind = "chat"): Promise<string> {
  const id = `session:${at}`;
  const d = new Date(at);
  await run(
    pid,
    `MATCH (me:Person {id: $self})
     CREATE (me)-[:HAD]->(:Session {id: $id, at: $at, last: $at, day: $day, weekday: $wd, hour: $hour,
                                    kind: $kind, moodSum: 0, moodN: 0})`,
    { self: SELF_ID, id, at, day: dayKey(at), wd: d.getDay(), hour: d.getHours(), kind },
  );
  return id;
}

export async function addUtterance(
  pid: string,
  u: { sessionId: string; speaker: string; text: string; at: number; mentionIds: string[]; vec?: number[] },
) {
  const vec = u.vec ?? (await embed([u.text]))[0];
  const id = `utt:${u.at}:${u.speaker}`;
  await run(
    pid,
    `MATCH (s:Session {id: $sid})
     CREATE (s)-[:CONTAINS]->(:Utterance {id: $id, speaker: $speaker, text: $text, at: $at,
                                          embedding: vecf32($vec)})
     SET s.last = $at`,
    { sid: u.sessionId, id, speaker: u.speaker, text: u.text, at: u.at, vec },
  );
  for (const m of u.mentionIds)
    await run(pid, `MATCH (u:Utterance {id: $id}), (x {id: $m}) MERGE (u)-[:MENTIONS]->(x)`, { id, m });
  return id;
}

export async function addMood(pid: string, sessionId: string, mood: number) {
  await run(
    pid,
    `MATCH (s:Session {id: $sid})
     SET s.moodSum = s.moodSum + $m, s.moodN = s.moodN + 1, s.mood = (s.moodSum + $m) / (s.moodN + 1.0)`,
    { sid: sessionId, m: mood },
  );
}

export async function recentTurns(pid: string, limit = 12) {
  const rows = await run<{ speaker: string; text: string; at: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(:Session)-[:CONTAINS]->(u:Utterance)
     WHERE u.speaker IN ['self', 'mithi']
     RETURN u.speaker AS speaker, u.text AS text, u.at AS at
     ORDER BY u.at DESC LIMIT $limit`,
    { self: SELF_ID, limit },
  );
  return rows.reverse();
}
