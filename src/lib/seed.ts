/*
 * Seeds two fictional personas into FalkorDB, as if Mithi had been running for two weeks.
 * Everything here is invented demo data. Run: npm run seed
 */
import { addNote } from "./care";
import { dropGraph, run } from "./db";
import { embed } from "./embed";
import {
  SELF_ID,
  addFact,
  addMood,
  addPreference,
  addUtterance,
  createSession,
  ensureSchema,
  ensureSelf,
  linkKin,
  setLivesIn,
  upsertEvent,
  upsertPerson,
  upsertPlace,
  upsertRoutine,
  upsertThing,
  upsertTopic,
  dayKey,
} from "./memory";
import { PERSONAS } from "./personas";

const DAY = 864e5;
const now = Date.now();
const at = (daysAgo: number, hour: number, min = 0) => {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hour, min, 0, 0);
  return d.getTime();
};
/** Days ago of the nth most recent given weekday (0 = Sunday), never today. */
const agoFor = (weekday: number, nth: number) => {
  let found = 0;
  for (let ago = 1; ago < 60; ago++) {
    if (new Date(now - ago * DAY).getDay() === weekday && ++found === nth) return ago;
  }
  return 7 * nth;
};
const dateIn = (days: number, hour = 11) => {
  const d = new Date(now + days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

type Turn = [speaker: "self" | "mithi", text: string, mentions?: string[]];
interface Day {
  ago: number;
  hour: number;
  mood: number;
  turns: Turn[];
}

async function seedSessions(pid: string, days: Day[]) {
  for (const d of days) {
    const start = at(d.ago, d.hour);
    const sid = await createSession(pid, start);
    const vecs = await embed(d.turns.map((t) => t[1]));
    for (let i = 0; i < d.turns.length; i++) {
      const [speaker, text, mentions = []] = d.turns[i];
      await addUtterance(pid, { sessionId: sid, speaker, text, at: start + i * 60e3, mentionIds: mentions, vec: vecs[i] });
    }
    await addMood(pid, sid, d.mood);
  }
}

async function told(pid: string, storyId: string, daysAgo: number, hour: number) {
  await run(pid, `MATCH (me:Person {id: $self}), (s:Story {id: $id}) CREATE (me)-[:TOLD {at: $at}]->(s)`, {
    self: SELF_ID,
    id: storyId,
    at: at(daysAgo, hour),
  });
}

async function story(pid: string, id: string, title: string, summary: string, about: string[]) {
  const [vec] = await embed([`${title}. ${summary}`]);
  await run(
    pid,
    `CREATE (:Story {id: $id, title: $title, summary: $summary, embedding: vecf32($vec), created: $at})`,
    { id, title, summary, vec, at: at(20, 10) },
  );
  for (const a of about) await run(pid, `MATCH (s:Story {id: $id}), (x {id: $a}) MERGE (s)-[:ABOUT]->(x)`, { id, a });
}

async function tookMeds(pid: string, medId: string, skipDays: number[], hour: number) {
  for (let ago = 13; ago >= 1; ago--) {
    if (skipDays.includes(ago)) continue;
    const t = at(ago, hour, 10);
    await run(pid, `MATCH (me:Person {id: $self}), (m:Med {id: $m}) MERGE (me)-[x:TOOK {day: $day}]->(m) SET x.at = $at`, {
      self: SELF_ID,
      m: medId,
      day: dayKey(t),
      at: t,
    });
  }
}

/* ======================= Kamala "Aaji" (elder mode) ======================= */

export async function seedKamala() {
  const pid = "kamala";
  const P = PERSONAS[pid];
  await dropGraph(pid);
  await ensureSchema(pid);
  await ensureSelf(pid, P.name, P.fullName);
  await run(pid, `MATCH (p:Person {id: $id}) SET p.nicknames = ['Kamala'], p.aliases = 'Aaji Kamala'`, { id: SELF_ID });

  const fam = { source: "family" as const, verified: true };
  const priya = await upsertPerson(pid, { name: "Priya", note: "daughter, school teacher, calls every evening", ...fam });
  const raju = await upsertPerson(pid, { name: "Raju", nicknames: ["Raj"], note: "grandson, Priya's son, software engineer", ...fam });
  const anil = await upsertPerson(pid, { name: "Anil", note: "son, lives in Mumbai", ...fam });
  const vasant = await upsertPerson(pid, { name: "Vasant", note: "late husband, passed away in 2019. Approach gently.", ...fam });
  const sunita = await upsertPerson(pid, { name: "Sunita", note: "day caregiver, weekdays 9 to 5", source: "caregiver", verified: true });
  const meera = await upsertPerson(pid, { name: "Meera", note: "neighbour, brings puran poli on festivals", ...fam });

  await linkKin(pid, priya, SELF_ID, "CHILD_OF", "family");
  await linkKin(pid, anil, SELF_ID, "CHILD_OF", "family");
  await linkKin(pid, raju, priya, "CHILD_OF", "family");
  await linkKin(pid, vasant, SELF_ID, "SPOUSE_OF", "family");
  await linkKin(pid, sunita, SELF_ID, "CAREGIVER_OF", "caregiver");
  await linkKin(pid, meera, SELF_ID, "NEIGHBOUR_OF", "family");

  await setLivesIn(pid, SELF_ID, "Pune", "family", "elder");
  await setLivesIn(pid, priya, "Pune", "family", "elder");
  await setLivesIn(pid, raju, "Pune", "family", "elder");
  await setLivesIn(pid, anil, "Mumbai", "family", "elder");
  const nashik = await upsertPlace(pid, "Nashik");

  await upsertEvent(pid, { title: "Raju's visit", date: dateIn(8, 16), kind: "visit", personId: raju, placeId: null, source: "family" });
  await upsertEvent(pid, { title: "Priya's wedding", date: new Date("1998-05-12T10:00:00").getTime(), kind: "celebration", personId: priya, placeId: nashik, source: "family" });
  await upsertEvent(pid, { title: "Aaji's 79th birthday", date: dateIn(26), kind: "birthday", personId: SELF_ID, placeId: null, source: "family" });
  await upsertEvent(pid, { title: "Eye check-up", date: dateIn(3, 11), kind: "appointment", personId: SELF_ID, placeId: null, source: "caregiver" });

  await story(pid, "story:mango-tree", "The mango tree in Nashik", "Her father planted a mango tree in their Nashik courtyard the summer she was seven; she climbed it with her brothers.", [nashik]);
  await story(pid, "story:bicycle", "Learning to ride a bicycle with Vasant", "Vasant taught her to ride a bicycle on the empty Pune roads in 1972, holding the seat and pretending he had not let go.", [vasant]);
  await told(pid, "story:mango-tree", 5, 10);
  await told(pid, "story:mango-tree", 2, 11);
  await told(pid, "story:bicycle", 10, 17);

  // Keep the morning dose "due" whenever the demo is run, even before 9 am.
  const h = new Date(now).getHours();
  const morning = h >= 10 ? "09:00" : `${String(Math.max(h - 1, 0)).padStart(2, "0")}:00`;
  await upsertRoutine(pid, "Morning medicines", morning, [{ name: "BP tablet (Amlodipine)", dose: "5 mg" }]);
  await upsertRoutine(pid, "Night medicines", "21:00", [{ name: "Calcium", dose: "500 mg" }]);
  await tookMeds(pid, "med:bp-tablet-amlodipine", [6, 11], 9);
  await tookMeds(pid, "med:calcium", [3], 21);

  await addPreference(pid, "Likes to be called Aaji, not Amma", "family");
  await addPreference(pid, "Loves old Marathi natya sangeet in the evening", "family");
  await addFact(pid, { text: "Raju will bring jalebi when he visits", aboutIds: [raju], source: "family", confidence: 0.95, at: at(1, 20) });
  await addFact(pid, { text: "Blood pressure was 142/90 yesterday evening and she skipped lunch", aboutIds: [SELF_ID], source: "caregiver", confidence: 0.95, at: at(1, 18) });

  await addNote(pid, priya, "family", "Aaji likes to be called Aaji, not Amma. Please don't bring up Baba (Vasant) suddenly.", at(9, 21));
  await addNote(pid, raju, "family", "Tell Aaji I'll visit next week and bring jalebi!", at(1, 20));
  await addNote(pid, sunita, "caregiver", "BP was 142/90 yesterday evening. Skipped lunch, ate a good dinner.", at(1, 18));

  const days: Day[] = [
    { ago: 13, hour: 10, mood: 4, turns: [["self", "Priya called last night, she sounded tired from school.", [priya]], ["mithi", "Teaching all day is hard work. Did she say how the children are?"]] },
    { ago: 12, hour: 18, mood: 3, turns: [["self", "The evenings feel long these days.", []], ["mithi", "Shall we put on some natya sangeet? You always enjoy it in the evening."]] },
    { ago: 11, hour: 10, mood: 4, turns: [["self", "Meera brought puran poli today, it was so soft.", [meera]], ["mithi", "How lovely of Meera! Did you save one for Sunita?"]] },
    { ago: 10, hour: 17, mood: 5, turns: [["self", "Vasant taught me to ride a bicycle, you know, in 1972. He pretended he was still holding the seat.", [vasant, "story:bicycle"]], ["mithi", "That is such a sweet memory, Aaji. Were you angry or proud when you found out?"]] },
    { ago: 9, hour: 19, mood: 2, turns: [["self", "I miss Vasant in the evenings.", [vasant]], ["mithi", "Of course you do. Would you like to tell me about one of your favourite evenings with him?"]] },
    { ago: 8, hour: 10, mood: 4, turns: [["self", "Raju sent me a photo of his office. So tall!", [raju]], ["mithi", "Your grandson in a big tall office. You must be proud of him."]] },
    { ago: 7, hour: 11, mood: 4, turns: [["self", "Anil called from Mumbai. The rains are heavy there.", [anil]], ["mithi", "I hope he stays dry. Did he say when he might visit?"]] },
    { ago: 6, hour: 19, mood: 2, turns: [["self", "My knee is hurting and I forgot what I came into the kitchen for.", []], ["mithi", "That happens to everyone, Aaji. Let's sit for a minute. Shall I remind Sunita about your knee tomorrow?"]] },
    { ago: 5, hour: 10, mood: 5, turns: [["self", "Let me tell you about the mango tree my father planted in Nashik.", [nashik, "story:mango-tree"]], ["mithi", "I would love to hear it. How old were you then?"]] },
    { ago: 4, hour: 11, mood: 4, turns: [["self", "Sunita made sheera for breakfast.", [sunita]], ["mithi", "Sheera in the morning, what a treat. Was it with lots of ghee?"]] },
    { ago: 3, hour: 18, mood: 3, turns: [["self", "Priya says she will come on Sunday.", [priya]], ["mithi", "Something to look forward to! What would you like to make for her?"]] },
    { ago: 2, hour: 11, mood: 5, turns: [["self", "The mango tree in our Nashik house, I used to climb it with my brothers.", [nashik, "story:mango-tree"]], ["mithi", "You and your brothers up in the branches! Who was the best climber?"]] },
    { ago: 1, hour: 19, mood: 3, turns: [["self", "Raju called. He is coming to see me next week.", [raju, "event:raju-s-visit"]], ["mithi", "How wonderful, Aaji! Raju's visit is just a week away."]] },
  ];
  await seedSessions(pid, days);
  console.log("seeded kamala");
}

/* ======================= Arjun (personal mode) ======================= */

export async function seedArjun() {
  const pid = "arjun";
  const P = PERSONAS[pid];
  await dropGraph(pid);
  await ensureSchema(pid);
  await ensureSelf(pid, P.name, P.fullName);

  const me = { source: "self" as const, verified: true };
  const mom = await upsertPerson(pid, { name: "Sunanda", nicknames: ["Mom", "Aai"], note: "mother, retired bank officer", ...me });
  const sneha = await upsertPerson(pid, { name: "Sneha", note: "younger sister, product designer", ...me });
  const ankit = await upsertPerson(pid, { name: "Ankit", note: "college friend, chai buddy", ...me });
  const karan = await upsertPerson(pid, { name: "Karan", note: "engineering manager", ...me });
  const riya = await upsertPerson(pid, { name: "Riya", note: "girlfriend, doctor doing residency", ...me });

  await linkKin(pid, SELF_ID, mom, "CHILD_OF", "self");
  await linkKin(pid, sneha, mom, "CHILD_OF", "self");
  await linkKin(pid, SELF_ID, sneha, "SIBLING_OF", "self");
  await linkKin(pid, ankit, SELF_ID, "FRIEND_OF", "self");
  await linkKin(pid, karan, SELF_ID, "COLLEAGUE_OF", "self");
  await linkKin(pid, riya, SELF_ID, "FRIEND_OF", "self");

  await setLivesIn(pid, SELF_ID, "Pune", "self", "personal");
  await setLivesIn(pid, mom, "Nashik", "self", "personal");
  await setLivesIn(pid, sneha, "Bangalore", "self", "personal");
  await setLivesIn(pid, ankit, "Pune", "self", "personal");

  await upsertEvent(pid, { title: "Mom's knee surgery", date: dateIn(0, 10), kind: "appointment", personId: mom, placeId: null, source: "self" });
  await upsertEvent(pid, { title: "Sneha's birthday", date: dateIn(4, 9), kind: "birthday", personId: sneha, placeId: null, source: "self" });
  await upsertEvent(pid, { title: "Quarterly review", date: dateIn(6, 15), kind: "milestone", personId: SELF_ID, placeId: null, source: "self" });

  const book = await upsertThing(pid, "Four Thousand Weeks", "book", ankit);
  const standup = await upsertTopic(pid, "Monday standup");
  const deadline = await upsertTopic(pid, "release deadline");
  await upsertRoutine(pid, "Evening walk", "18:30", []);
  await upsertRoutine(pid, "Morning supplements", "09:00", [{ name: "Vitamin D3", dose: "1000 IU" }]);
  await tookMeds(pid, "med:vitamin-d3", [2, 5, 9], 9);
  await addPreference(pid, "Prefers a call over texts with Mom", "self");

  const days: Day[] = [
    { ago: 23, hour: 21, mood: 4, turns: [["self", "Sneha and I talked for an hour about her new job in Bangalore.", [sneha]], ["mithi", "An hour with your sister! How is she finding Bangalore?"]] },
    { ago: 15, hour: 20, mood: 4, turns: [["self", "Had chai with Ankit, he suggested I read Four Thousand Weeks since I keep saying I have no time.", [ankit, book]], ["mithi", "Ankit knows you well. A book about time for someone who has none of it."]] },
    { ago: agoFor(0, 2), hour: 22, mood: 2, turns: [["self", "Dreading tomorrow. Karan will grill me in the Monday standup again.", [karan, standup]], ["mithi", "That knot before Monday sounds heavy. What is the one update you're worried about?"]] },
    { ago: agoFor(0, 2) - 1, hour: 21, mood: 4, turns: [["self", "Standup went fine actually. Karan liked the demo.", [karan, standup]], ["mithi", "See, it went better than the Sunday-night version of you feared."]] },
    { ago: 11, hour: 19, mood: 4, turns: [["self", "Went for a long walk by the river, felt good.", []], ["mithi", "Walks always seem to reset you. How far did you go?"]] },
    { ago: 10, hour: 22, mood: 3, turns: [["self", "Riya had a night shift again, barely saw her this week.", [riya]], ["mithi", "Residency is brutal. Maybe plan something small for her day off?"]] },
    { ago: 9, hour: 23, mood: 2, turns: [["self", "Release deadline moved up. I'm exhausted.", [deadline]], ["mithi", "That's a lot to carry. What can you drop or hand off this week?"]] },
    { ago: 8, hour: 20, mood: 3, turns: [["self", "Mom told me her knee surgery is scheduled. She's nervous.", [mom, "event:mom-s-knee-surgery"]], ["mithi", "Of course she is. A call from you before the day will mean a lot to her."]] },
    { ago: 7, hour: 19, mood: 4, turns: [["self", "Walked 6 km today and cooked dal.", []], ["mithi", "A walk and home-cooked dal. That's a good day."]] },
    { ago: agoFor(0, 1), hour: 22, mood: 2, turns: [["self", "Sunday night again. Monday standup tomorrow and I'm not ready.", [standup, karan]], ["mithi", "Sunday nights keep doing this to you. Want to write down the two things you'll say?"]] },
    { ago: 5, hour: 21, mood: 4, turns: [["self", "Riya and I watched an old movie, first evening together in ages.", [riya]], ["mithi", "That sounds lovely. What did you watch?"]] },
    { ago: 4, hour: 20, mood: 3, turns: [["self", "Ankit asked if I started the book yet. I haven't.", [ankit, book]], ["mithi", "No pressure. Maybe ten pages before bed tonight?"]] },
    { ago: 3, hour: 21, mood: 4, turns: [["self", "Karan said the release is in good shape.", [karan, deadline]], ["mithi", "That must be a relief after the last few weeks."]] },
    { ago: 2, hour: 19, mood: 4, turns: [["self", "Called Mom, the surgery is still on as planned.", [mom, "event:mom-s-knee-surgery"]], ["mithi", "I'm glad you called her. I'll remind you to check in after."]] },
    { ago: 1, hour: 22, mood: 3, turns: [["self", "Long day of meetings, too tired to walk.", []], ["mithi", "Rest is fine too. Tomorrow's walk will feel better."]] },
  ];
  await seedSessions(pid, days);
  console.log("seeded arjun");
}

export async function seed(pid?: string) {
  if (!pid || pid === "kamala") await seedKamala();
  if (!pid || pid === "arjun") await seedArjun();
}
