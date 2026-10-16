import { run } from "./db";
import { SELF_ID, dayKey } from "./memory";

/*
 * Care agent. Reads the same graph the Companion writes to and turns it into check-ins for the
 * user and alerts for family: missed doses, upcoming events, people drifting away, stories
 * repeated often, and conflicting facts waiting for a family member to confirm.
 */

export interface Nudge {
  kind: "med" | "event" | "reconnect" | "repeat" | "conflict" | "unverified";
  title: string;
  detail: string;
  when: string;
  severity: "info" | "warn";
  ids: string[];
  conflictId?: string;
}

const W = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmt = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const daysAgo = (ms: number) => Math.round((Date.now() - ms) / 864e5);

export async function nudges(pid: string): Promise<Nudge[]> {
  const now = Date.now();
  const d = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const out: Nudge[] = [];

  const meds = await run<{ med: string; dose: string; time: string; mid: string }>(
    pid,
    `MATCH (me:Person {id: $self})-[:FOLLOWS]->(r:Routine)-[:INCLUDES]->(m:Med)
     WHERE r.time < $hhmm AND NOT (me)-[:TOOK {day: $day}]->(m)
     RETURN m.name AS med, m.dose AS dose, r.time AS time, m.id AS mid`,
    { self: SELF_ID, hhmm, day: dayKey(now) },
  );
  for (const m of meds)
    out.push({ kind: "med", title: `${m.med} not logged yet`, detail: `${m.dose} due at ${m.time}. Ask gently.`, when: m.time, severity: "warn", ids: [m.mid] });

  const events = await run<{ eid: string; title: string; date: number; pid: string; person: string; last: number | null }>(
    pid,
    `MATCH (p:Person)-[:HAS_EVENT]->(e:Event)
     WHERE e.date >= $from AND e.date <= $to
     OPTIONAL MATCH (u:Utterance {speaker: 'self'})-[:MENTIONS]->(p)
     RETURN e.id AS eid, e.title AS title, e.date AS date, p.id AS pid, p.name AS person, p.self AS self, max(u.at) AS last
     ORDER BY e.date`,
    { from: now - 12 * 3600e3, to: now + 7 * 864e5 },
  );
  const lastSaid = (ms: number) => (daysAgo(ms) <= 0 ? "today" : daysAgo(ms) === 1 ? "yesterday" : `${daysAgo(ms)} days ago`);
  for (const e of events)
    out.push({
      kind: "event",
      title: e.title,
      detail: (e as { self?: boolean }).self
        ? "On the calendar. A gentle reminder the day before helps."
        : e.last
          ? `${e.person} last came up ${lastSaid(e.last)}.`
          : `${e.person} hasn't come up in conversation yet.`,
      when: dayKey(e.date) === dayKey(now) ? "today" : fmt(e.date),
      severity: "info",
      ids: [e.pid, e.eid],
    });

  const repeats = await run<{ id: string; title: string; n: number }>(
    pid,
    `MATCH (:Person {id: $self})-[t:TOLD]->(s:Story) WHERE t.at > $since
     WITH s, count(t) AS n WHERE n >= 3
     RETURN s.id AS id, s.title AS title, n`,
    { self: SELF_ID, since: now - 7 * 864e5 },
  );
  for (const r of repeats)
    out.push({ kind: "repeat", title: `“${r.title}” told ${r.n}× this week`, detail: "Noted for family. Repetition alone is not a concern.", when: "this week", severity: "info", ids: [r.id] });

  const conflicts = await run<{ id: string; text: string; pid: string; name: string }>(
    pid,
    `MATCH (c:Conflict {status: 'open'})-[:ABOUT]->(p:Person) RETURN c.id AS id, c.text AS text, p.id AS pid, p.name AS name`,
  );
  for (const c of conflicts)
    out.push({ kind: "conflict", title: `Check: where does ${c.name} live?`, detail: c.text, when: "needs family", severity: "warn", ids: [c.pid], conflictId: c.id });

  const unverified = await run<{ id: string; name: string }>(
    pid,
    `MATCH (p:Person) WHERE p.verified = false RETURN p.id AS id, p.name AS name LIMIT 3`,
  );
  for (const u of unverified)
    out.push({ kind: "unverified", title: `New name mentioned: ${u.name}`, detail: "Family can confirm who this is.", when: "needs family", severity: "info", ids: [u.id] });

  const ranked = await run<{ id: string; name: string; score: number; last: number | null }>(
    pid,
    `CALL algo.pageRank('Person', null) YIELD node, score
     WHERE node.id <> $self AND coalesce(node.verified, false)
     OPTIONAL MATCH (u:Utterance {speaker: 'self'})-[:MENTIONS]->(node)
     RETURN node.id AS id, node.name AS name, score, max(u.at) AS last
     ORDER BY score DESC LIMIT 6`,
    { self: SELF_ID },
  );
  const drift = ranked.filter((r) => r.last && daysAgo(r.last) >= 14).slice(0, 1);
  for (const r of drift)
    out.push({ kind: "reconnect", title: `Reach out to ${r.name}?`, detail: `Important to you, not mentioned in ${daysAgo(r.last!)} days.`, when: "this week", severity: "info", ids: [r.id] });

  return out;
}

export async function moodSeries(pid: string) {
  const now = Date.now();
  const rows = await run<{ day: string; mood: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session)
     WHERE s.at > $since AND s.mood IS NOT NULL
     RETURN s.day AS day, avg(s.mood) AS mood ORDER BY day`,
    { self: SELF_ID, since: now - 14 * 864e5 },
  );
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.mood]));
  const series: { day: string; label: string; mood: number | null }[] = [];
  for (let i = 13; i >= 0; i--) {
    const t = now - i * 864e5;
    const k = dayKey(t);
    series.push({ day: k, label: i === 0 ? "today" : W[new Date(t).getDay()], mood: byDay[k] ?? null });
  }
  return series;
}

export async function insights(pid: string) {
  const since = Date.now() - 30 * 864e5;
  const out: { title: string; text: string }[] = [];
  const wd = await run<{ wd: number; m: number; n: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session) WHERE s.at > $since AND s.mood IS NOT NULL
     RETURN s.weekday AS wd, avg(s.mood) AS m, count(s) AS n ORDER BY m`,
    { self: SELF_ID, since },
  );
  if (wd.length >= 3) out.push({ title: `${WEEKDAY[wd[0].wd]}s are hardest`, text: `Average mood ${wd[0].m.toFixed(1)} vs ${wd[wd.length - 1].m.toFixed(1)} on ${WEEKDAY[wd[wd.length - 1].wd]}s.` });

  const tod = await run<{ part: string; m: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session) WHERE s.at > $since AND s.mood IS NOT NULL
     RETURN CASE WHEN s.hour < 12 THEN 'morning' WHEN s.hour < 18 THEN 'afternoon' ELSE 'evening' END AS part,
            avg(s.mood) AS m ORDER BY m DESC`,
    { self: SELF_ID, since },
  );
  if (tod.length >= 2) out.push({ title: `Brightest in the ${tod[0].part}`, text: `${tod[0].m.toFixed(1)} on average, ${tod[tod.length - 1].m.toFixed(1)} in the ${tod[tod.length - 1].part}.` });

  const low = await run<{ name: string; n: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session)-[:CONTAINS]->(:Utterance)-[:MENTIONS]->(x)
     WHERE s.at > $since AND s.mood <= 2.5 AND x.id <> $self
     RETURN coalesce(x.name, x.title) AS name, count(DISTINCT s) AS n ORDER BY n DESC LIMIT 1`,
    { self: SELF_ID, since },
  );
  if (low[0]) out.push({ title: `Low days mention ${low[0].name}`, text: `Came up in ${low[0].n} of the low-mood sessions this month.` });

  const high = await run<{ name: string; n: number }>(
    pid,
    `MATCH (:Person {id: $self})-[:HAD]->(s:Session)-[:CONTAINS]->(:Utterance)-[:MENTIONS]->(x:Person)
     WHERE s.at > $since AND s.mood >= 4 AND x.id <> $self
     RETURN x.name AS name, count(DISTINCT s) AS n ORDER BY n DESC LIMIT 1`,
    { self: SELF_ID, since },
  );
  if (high[0]) out.push({ title: `${high[0].name} lifts the mood`, text: `Mentioned in ${high[0].n} bright sessions this month.` });
  return out;
}

export async function familyFeed(pid: string) {
  return run<{ author: string; role: string; text: string; at: number }>(
    pid,
    `MATCH (a:Person)-[:WROTE]->(n:Note)
     RETURN a.name AS author, n.role AS role, n.text AS text, n.at AS at ORDER BY n.at DESC LIMIT 12`,
  );
}

export async function addNote(pid: string, authorId: string, role: string, text: string, at: number) {
  await run(
    pid,
    `MATCH (a:Person {id: $a}) CREATE (a)-[:WROTE]->(:Note {id: $id, text: $text, role: $role, at: $at})`,
    { a: authorId, id: `note:${at}`, text, role, at },
  );
  return `note:${at}`;
}
