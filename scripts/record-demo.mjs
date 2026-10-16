// Records the demo video: Playwright drives the running app (npm run dev), macOS `say` voices the
// narration and dialogue, ffmpeg merges them. Output: demo/mithi-demo.mp4
// Usage: node scripts/record-demo.mjs   (app must be running on http://localhost:3000)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve("demo");
const AUD = path.join(OUT, "audio");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(AUD, { recursive: true });

const VOICE = { narrator: "Samantha", mithi: "Tara", aaji: "Grandma (English (UK))", arjun: "Rishi" };
const RATE = { narrator: 182, mithi: 172, aaji: 150, arjun: 185 };

let n = 0;
const clips = []; // { file, at }
function tts(who, text) {
  const file = path.join(AUD, `${String(n++).padStart(2, "0")}-${who}.aiff`);
  execFileSync("say", ["-v", VOICE[who], "-r", String(RATE[who]), "-o", file, text]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  return { file, dur };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const wait = (s) => page.waitForTimeout(s * 1000);

async function caption(html) {
  await page.evaluate((h) => {
    let el = document.getElementById("demo-cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-cap";
      el.style.cssText =
        "position:fixed;right:97px;bottom:44px;width:672px;padding:12px 20px;border-radius:14px;background:rgba(20,22,26,.86);color:#fff;font:500 18px/1.4 var(--f-body);text-align:center;z-index:99;box-shadow:0 8px 30px rgba(0,0,0,.25);transition:opacity .3s";
      document.body.appendChild(el);
    }
    el.style.opacity = h ? "1" : "0";
    if (h) el.innerHTML = h;
  }, html);
}

async function title(lines, secs) {
  await page.evaluate((l) => {
    const el = document.createElement("div");
    el.id = "demo-title";
    el.style.cssText =
      "position:fixed;inset:0;display:grid;place-items:center;background:var(--bg);z-index:100;text-align:center;transition:opacity .6s";
    el.innerHTML = `<div><div style="font:700 72px/1 var(--f-display);color:var(--ink)">${l[0]}</div><div style="margin-top:14px;font:400 24px/1.4 var(--f-body);color:var(--muted)">${l[1]}</div><div style="margin-top:22px;font:500 15px var(--f-mono);color:var(--accent)">${l[2] ?? ""}</div></div>`;
    document.body.appendChild(el);
  }, lines);
  await wait(secs);
  await page.evaluate(() => {
    const el = document.getElementById("demo-title");
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 700);
  });
  await wait(0.7);
}

/** Narrator line with caption; waits for it to finish. */
async function say(text, extra = 0.35) {
  const c = tts("narrator", text);
  clips.push({ file: c.file, at: now() });
  await caption(text);
  await wait(c.dur + extra);
  await caption("");
}

/** The user speaks: their voice plays while the words appear in the input, then Mithi answers in her voice. */
async function ask(who, text) {
  const label = who === "aaji" ? "Aaji" : "Arjun";
  const c = tts(who, text);
  await caption(`<span style="opacity:.7">${label}:</span> “${text}”`);
  clips.push({ file: c.file, at: now() });
  await page.locator("#text").pressSequentially(text, { delay: Math.max(18, (c.dur * 1000) / text.length - 8) });
  await wait(0.3);
  const before = await page.locator(".msg.ai").count();
  await page.locator("#text").press("Enter");
  await caption("");
  await page.locator(".msg.ai").nth(before).waitFor({ timeout: 60000 });
  const reply = await page.locator(".msg.ai").nth(before).innerText();
  const m = tts("mithi", reply);
  clips.push({ file: m.file, at: now() });
  await wait(m.dur + 0.6);
}

async function tab(name) {
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
  await wait(0.6);
}

// ---------- prepare ----------
for (const p of ["kamala", "arjun"]) await fetch(`${BASE}/api/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: p }) });
await page.goto(BASE);
await page.locator(".graph .node").first().waitFor();
await page.locator("#voice").uncheck(); // audio is added from the recorded voice clips instead
await page.mouse.move(1430, 10);

// ---------- story ----------
await title(["Mithi", "a sweet voice companion that remembers your world", "built on a FalkorDB memory graph"], 1.2);
await say("Meet Mithi. A voice companion whose long-term memory is a FalkorDB graph.");
await say("This is Kamala. Her family calls her Aaji. She is seventy-eight, and has early memory loss. Her family seeded what Mithi knows: people, places, routines, and stories.");

await ask("aaji", "Who is Raju again?");
await page.locator(".trace details").last().evaluate((d) => (d.open = true));
await page.locator(".chat").evaluate((c) => c.scrollTo({ top: c.scrollHeight, behavior: "smooth" }));
await say("Mithi found Raju through a full-text search on names and nicknames, then walked the family path in the graph. Aaji, her daughter Priya, Priya's son Raju. Every answer shows the Cypher it ran, and lights up the path.");

await ask("aaji", "Did I take my tablet today?");
await ask("aaji", "I just took my BP tablet");
await say("Routines and medicines are procedural memory. Each dose becomes an edge for the day.");

await ask("aaji", "Raju told me he moved to Bangalore");
await say("That contradicts what the family recorded. Mithi does not argue with her. It stores the claim as unverified, and raises a conflict for the family.");
await tab("Family");
await wait(1.2);
await say("In the family portal, Priya confirms the move.");
await page.getByRole("button", { name: "Confirm new fact" }).first().click();
await wait(1);
await tab("Memory graph");
await say("The old Pune fact is closed, not deleted, so the history stays in the graph.");

await ask("aaji", "Let me tell you about the mango tree in our village");
await say("Vector search recognised a story she has already told twice this week, in different words. Mithi enjoys it with her, and the Care agent quietly notes it for the family.");
await tab("Nudges");
await wait(2.5);

await page.getByRole("button", { name: "Arjun", exact: true }).click();
await tab("Memory graph");
await page.locator(".graph .node").first().waitFor();
await wait(1);
await say("Same engine, everyday mode. Arjun is twenty-nine, and talks to Mithi in the evenings.");
await ask("arjun", "I'm feeling anxious about tomorrow");
await tab("Mood");
await say("Mood per session, joined with what came up on low days, reveals a pattern. Sunday nights, before the Monday standup.");
await ask("arjun", "Anything I'm forgetting this week?");
await ask("arjun", "Who haven't I talked to in a while?");
await say("That one is PageRank over the people in his life, joined with when each was last mentioned.");

await say("Three agents. One shared memory graph. Mithi, built with FalkorDB.", 0.2);
await title(["Mithi", "Companion · Memory-keeper · Care agents sharing one FalkorDB graph", "Graph Hacks 2026 · Track 2: Agent Memory and Coordination"], 3);

const total = now();
await context.close();
await browser.close();

// ---------- merge ----------
const webm = readdirSync(OUT).find((f) => f.endsWith(".webm"));
renameSync(path.join(OUT, webm), path.join(OUT, "screen.webm"));
const inputs = clips.flatMap((c) => ["-i", c.file]);
const filters = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`);
const mix = `${filters.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0[aout]`;
execFileSync("ffmpeg", ["-y", "-i", path.join(OUT, "screen.webm"), ...inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-t", String(total), path.join(OUT, "mithi-demo.mp4")], { stdio: "inherit" });
console.log(`done: demo/mithi-demo.mp4 (${total.toFixed(1)}s)`);
