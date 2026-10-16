import { runTool } from "../src/lib/tools";
import { nudges, moodSeries, insights } from "../src/lib/care";
import { snapshot } from "../src/lib/graph";
async function main() {
  const show = async (pid: string, n: string, i: Record<string, unknown> = {}) => {
    const o = await runTool(pid, n, i);
    console.log(`\n== ${pid} ${n}`, JSON.stringify(o.data).slice(0, 700), "\n  nodes:", o.trace.nodes.join(","), "\n  edges:", JSON.stringify(o.trace.edges));
  };
  await show("kamala", "recall_person", { name: "Raju" });
  await show("kamala", "search_memories", { query: "mango tree village" });
  await show("kamala", "todays_routine");
  await show("kamala", "find_connection", { from: "Raju", to: "Nashik" });
  await show("arjun", "search_memories", { query: "book Ankit suggested" });
  await show("arjun", "mood_patterns");
  await show("arjun", "upcoming_events", { days: 7 });
  await show("arjun", "people_to_reconnect");
  for (const p of ["kamala", "arjun"]) {
    console.log("\n== nudges", p, JSON.stringify(await nudges(p)).slice(0, 900));
    console.log("== insights", p, JSON.stringify(await insights(p)));
    console.log("== mood", p, JSON.stringify((await moodSeries(p)).map((m) => m.mood)));
    const s = await snapshot(p); console.log("== graph", p, s.nodes.length, s.edges.length);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
