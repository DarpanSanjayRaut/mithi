"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import MemoryGraph from "@/components/MemoryGraph";
import MoodChart from "@/components/MoodChart";
import Orb, { type OrbMode } from "@/components/Orb";
import type { Nudge } from "@/lib/care";
import type { MemoryWrite } from "@/lib/extractor";
import type { GEdge, GNode } from "@/lib/graph";
import type { Persona } from "@/lib/personas";
import type { Edge, Trace } from "@/lib/tools";

interface State {
  persona: Persona;
  graph: { nodes: GNode[]; edges: GEdge[] };
  nudges: Nudge[];
  mood: { day: string; label: string; mood: number | null }[];
  insights: { title: string; text: string }[];
  family: { author: string; role: string; text: string; at: number }[];
  people: { id: string; name: string; note: string | null }[];
}

type Msg =
  | { kind: "me" | "ai" | "sys" | "err"; text: string }
  | { kind: "trace"; traces: Trace[]; memory: MemoryWrite | null };

const SUGGEST: Record<string, string[]> = {
  kamala: [
    "Who is Raju again?",
    "Did I take my tablet today?",
    "Raju told me he moved to Bangalore",
    "Let me tell you about the mango tree in our village",
    "I just took my BP tablet",
  ],
  arjun: [
    "I'm feeling anxious about tomorrow",
    "What was that book Ankit suggested?",
    "Anything I'm forgetting this week?",
    "Who haven't I talked to in a while?",
  ],
};

const GREETING: Record<string, string> = {
  kamala: "Namaste, Aaji! How are you feeling today?",
  arjun: "Hey Arjun. Long week? I'm here if you want to talk it out.",
};

const CARE_TOOLS = new Set(["todays_routine", "log_med_taken", "mood_patterns", "people_to_reconnect", "upcoming_events"]);
const ICON: Record<Nudge["kind"], [string, string]> = {
  med: ["Rx", "--accent"],
  event: ["E", "--plum"],
  reconnect: ["R", "--rose"],
  repeat: ["S", "--plum"],
  conflict: ["!", "--warn"],
  unverified: ["?", "--sky"],
};

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};

export default function Home() {
  const [pid, setPid] = useState("kamala");
  const [state, setState] = useState<State | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [mode, setMode] = useState<OrbMode>("idle");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [tab, setTab] = useState<"memory" | "mood" | "nudges" | "family">("memory");
  const [voice, setVoice] = useState(true);
  const [lit, setLit] = useState<{ nodes: string[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (p: string) => {
    const r = await fetch(`/api/state?persona=${p}`, { cache: "no-store" });
    if (r.ok) setState(await r.json());
  }, []);

  useEffect(() => {
    load(pid);
    setMsgs([{ kind: "ai", text: GREETING[pid] }]);
    setLit({ nodes: [], edges: [] });
    document.body.classList.toggle("big", pid === "kamala");
  }, [pid, load]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const speak = useCallback(
    (line: string) =>
      new Promise<void>((resolve) => {
        if (!voice || typeof speechSynthesis === "undefined") return resolve();
        const u = new SpeechSynthesisUtterance(line);
        const voices = speechSynthesis.getVoices();
        u.voice = voices.find((v) => v.lang === "en-IN" && /female|veena|rishi|lekha|google/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en-IN")) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
        u.rate = pid === "kamala" ? 0.9 : 1.02;
        u.pitch = 1.1;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      }),
    [voice, pid],
  );

  const send = useCallback(
    async (said: string) => {
      const line = said.trim();
      if (!line || busy) return;
      setBusy(true);
      setText("");
      setMsgs((m) => [...m, { kind: "me", text: line }]);
      setMode("thinking");
      setTab("memory");
      try {
        const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: pid, text: line }) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Something went wrong.");
        const traces: Trace[] = data.traces ?? [];
        const memory: MemoryWrite | null = data.memory ?? null;
        await load(pid);
        const all = [...traces, ...(memory ? [memory.trace] : [])];
        setLit({ nodes: [...new Set(all.flatMap((t) => t.nodes))], edges: all.flatMap((t) => t.edges) });
        setMsgs((m) => [...m, { kind: "trace", traces, memory }, { kind: "ai", text: data.reply }]);
        setMode("speaking");
        await speak(data.reply);
        if (!voice) await new Promise((res) => setTimeout(res, 900));
      } catch (e) {
        setMsgs((m) => [...m, { kind: "err", text: (e as Error).message }]);
      } finally {
        setMode("idle");
        setBusy(false);
      }
    },
    [busy, pid, load, speak, voice],
  );

  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) {
      setMsgs((m) => [...m, { kind: "sys", text: "Voice input needs Chrome or Edge. You can type instead." }]);
      return;
    }
    speechSynthesis?.cancel();
    const rec = new Ctor();
    rec.lang = state?.persona.locale ?? "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText = r[0].transcript;
        else interim += r[0].transcript;
      }
      setText(finalText || interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") setMsgs((m) => [...m, { kind: "sys", text: "Microphone access was blocked. Allow it in the address bar, or type instead." }]);
    };
    rec.onend = () => {
      setListening(false);
      setMode("idle");
      if (finalText) send(finalText);
    };
    recRef.current = rec;
    setListening(true);
    setMode("listening");
    rec.start();
  };

  const resolve = async (conflictId: string, accept: boolean) => {
    await fetch("/api/family/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: pid, conflictId, accept }) });
    await load(pid);
  };

  const reset = async () => {
    setBusy(true);
    await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: pid }) });
    await load(pid);
    setMsgs([{ kind: "sys", text: "Demo memory restored." }, { kind: "ai", text: GREETING[pid] }]);
    setLit({ nodes: [], edges: [] });
    setBusy(false);
  };

  const p = state?.persona;
  const counts = state ? { nodes: state.graph.nodes.length, edges: state.graph.edges.length } : null;
  const needsFamily = state?.nudges.filter((n) => n.kind === "conflict" || n.kind === "unverified").length ?? 0;

  return (
    <div className="wrap">
      <header>
        <div className="brand">
          <h1>Mithi</h1>
          <span>a sweet companion that remembers</span>
        </div>
        <div className="seg" role="group" aria-label="Persona">
          <button aria-pressed={pid === "arjun"} onClick={() => !busy && setPid("arjun")}>Arjun</button>
          <button aria-pressed={pid === "kamala"} onClick={() => !busy && setPid("kamala")}>Aaji (elder mode)</button>
        </div>
        <label className="toggle">
          <input type="checkbox" id="voice" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Speak replies
        </label>
        <button className="ghost" onClick={reset} disabled={busy}>Reset demo</button>
      </header>

      <main>
        <section className="panel companion" aria-label="Companion">
          <div className="stage">
            <div className="orb"><Orb mode={mode} /></div>
            <div className="who">
              <h2>{p ? (p.mode === "elder" ? `Namaste, ${p.name}` : `Hi ${p.name}`) : "Mithi"}</h2>
              <p>{counts ? `${counts.nodes} things and ${counts.edges} connections remembered` : "Waking up…"}</p>
              <div className="state" data-s={mode}>
                <i />
                <span>{{ idle: "Here for you", listening: "Listening…", thinking: "Remembering…", speaking: "Speaking" }[mode]}</span>
              </div>
            </div>
          </div>

          <div className="chat" ref={chatRef} aria-live="polite">
            {msgs.map((m, i) =>
              m.kind === "trace" ? (
                <TraceCard key={i} traces={m.traces} memory={m.memory} />
              ) : (
                <div key={i} className={`msg ${m.kind}`}>{m.text}</div>
              ),
            )}
          </div>

          <div className="chips">
            {SUGGEST[pid].map((s) => (
              <button key={s} className="chip" disabled={busy} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
          <form className="inputbar" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <button type="button" className={`mic${listening ? " on" : ""}`} onClick={toggleMic} disabled={busy && !listening} aria-label={listening ? "Stop listening" : "Talk to Mithi"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
            <input id="text" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="Say or type something…" aria-label="Message" />
            <button className="send" type="submit" disabled={busy}>Send</button>
          </form>
          <p className="note">Tap the mic and speak (Chrome or Edge). Everything here is fictional demo data.</p>
        </section>

        <section className="panel" aria-label="Memory workspace">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>Memory graph</button>
            <button role="tab" aria-selected={tab === "mood"} onClick={() => setTab("mood")}>Mood</button>
            <button role="tab" aria-selected={tab === "nudges"} onClick={() => setTab("nudges")}>
              Nudges {state && state.nudges.length > 0 && <span className="count">{state.nudges.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === "family"} onClick={() => setTab("family")}>
              Family {needsFamily > 0 && <span className="count">{needsFamily}</span>}
            </button>
          </div>

          {tab === "memory" && (
            <div className="view">
              <h3>{p ? `${p.mode === "elder" ? `${p.name}'s` : `${p.name}'s`} world` : "Memory"}</h3>
              <p className="sub">Live from FalkorDB. Each answer lights up the path it was recalled from. Dashed lines are past or unverified facts.</p>
              <div className="graphbox">
                {state && <MemoryGraph nodes={state.graph.nodes} edges={state.graph.edges} litNodes={lit.nodes} litEdges={lit.edges} />}
              </div>
              <div className="legend">
                <span style={{ ["--c" as string]: "var(--rose)" }}>Person</span>
                <span style={{ ["--c" as string]: "var(--sage)" }}>Place</span>
                <span style={{ ["--c" as string]: "var(--plum)" }}>Event / Story</span>
                <span style={{ ["--c" as string]: "var(--accent)" }}>Routine / Med</span>
                <span style={{ ["--c" as string]: "var(--sky)" }}>Thing / Topic</span>
              </div>
            </div>
          )}

          {tab === "mood" && state && (
            <div className="view">
              <h3>Last 14 days</h3>
              <p className="sub">Mood per session, inferred from what was said. 1 is low, 5 is bright.</p>
              <MoodChart series={state.mood} />
              <div className="insights">
                {state.insights.map((x) => (
                  <div className="insight" key={x.title}><b>{x.title}</b>{x.text}</div>
                ))}
              </div>
            </div>
          )}

          {tab === "nudges" && state && (
            <div className="view">
              <h3>Today</h3>
              <p className="sub">Check-ins the Care agent found in the graph.</p>
              <div className="list">
                {state.nudges.length === 0 && <p className="empty">Nothing needs attention right now.</p>}
                {state.nudges.map((n, i) => (
                  <NudgeItem key={i} n={n} onResolve={resolve} onShow={() => { setLit({ nodes: n.ids, edges: [] }); setTab("memory"); }} />
                ))}
              </div>
            </div>
          )}

          {tab === "family" && state && (
            <FamilyView state={state} pid={pid} onResolve={resolve} onSaved={(mem) => { load(pid); if (mem) setLit({ nodes: mem.trace.nodes, edges: mem.trace.edges }); }} />
          )}
        </section>
      </main>
    </div>
  );
}

function TraceCard({ traces, memory }: { traces: Trace[]; memory: MemoryWrite | null }) {
  const agents: [string, string][] = [];
  if (memory && memory.summary.length) agents.push(["Memory-keeper", "--plum"]);
  agents.push(["Companion", "--accent"]);
  if (traces.some((t) => CARE_TOOLS.has(t.tool))) agents.push(["Care", "--rose"]);
  const recalled = new Set(traces.flatMap((t) => t.nodes)).size;
  const all = [...traces, ...(memory && memory.trace.cypher.length ? [memory.trace] : [])];
  return (
    <div className="trace">
      <div className="agents">
        {agents.map(([n, c]) => (
          <span key={n} className="ag" style={{ ["--c" as string]: `var(${c})` }}>{n}</span>
        ))}
        <span>{traces.length ? `${traces.length} graph ${traces.length === 1 ? "query" : "queries"} · ${recalled} memories recalled` : "answered from conversation"}</span>
      </div>
      {memory && memory.summary.length > 0 && (
        <ul>
          {memory.summary.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      {all.length > 0 && (
        <details>
          <summary>Cypher run on FalkorDB</summary>
          {all.map((t, i) => (
            <div key={i}>
              <span className="tool">{t.tool}({Object.values(t.input).map((v) => JSON.stringify(v)).join(", ")})</span>
              <pre>{t.cypher.join("\n\n")}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function NudgeItem({ n, onResolve, onShow }: { n: Nudge; onResolve: (id: string, ok: boolean) => void; onShow: () => void }) {
  const [ico, c] = ICON[n.kind];
  return (
    <div className={`item${n.severity === "warn" ? " warn" : ""}`}>
      <div className="ico" style={{ ["--c" as string]: `var(${c})` }}>{ico}</div>
      <div>
        <div className="t">{n.title}</div>
        <div className="d">{n.detail}</div>
        <div className="actions">
          {n.conflictId ? (
            <>
              <button className="btn" onClick={() => onResolve(n.conflictId!, true)}>Confirm new fact</button>
              <button className="btn quiet" onClick={() => onResolve(n.conflictId!, false)}>Keep family record</button>
            </>
          ) : (
            <button className="btn quiet" onClick={onShow}>Show in graph</button>
          )}
        </div>
      </div>
      <time>{n.when}</time>
    </div>
  );
}

function FamilyView({ state, pid, onResolve, onSaved }: { state: State; pid: string; onResolve: (id: string, ok: boolean) => void; onSaved: (m: MemoryWrite | null) => void }) {
  const [author, setAuthor] = useState(state.people[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);
  const pending = state.nudges.filter((n) => n.kind === "conflict" || n.kind === "unverified");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    const r = await fetch("/api/family", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: pid, authorId: author, text: note }) });
    const data = await r.json();
    setSaving(false);
    if (r.ok) {
      setNote("");
      setResult(data.memory?.summary ?? []);
      onSaved(data.memory ?? null);
    } else setResult([data.error ?? "Could not save."]);
  };

  return (
    <div className="view">
      <h3>{state.persona.mode === "elder" ? "Family portal" : "People you trust"}</h3>
      <p className="sub">Family and caregivers add memories here. Their facts outrank unverified ones, and every fact keeps its source.</p>

      {pending.length > 0 && (
        <div className="list">
          {pending.map((n, i) => <NudgeItem key={i} n={n} onResolve={onResolve} onShow={() => {}} />)}
        </div>
      )}

      <form className="familyform" onSubmit={save}>
        <div className="row">
          <label htmlFor="author">Writing as</label>
          <select id="author" value={author} onChange={(e) => setAuthor(e.target.value)}>
            {state.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.note ? ` · ${p.note.split(",")[0]}` : ""}</option>)}
          </select>
        </div>
        <textarea id="familynote" value={note} onChange={(e) => setNote(e.target.value)} placeholder={state.persona.mode === "elder" ? "e.g. Raju has moved to Bangalore for his new job. He visits on the 25th." : "e.g. Book club moved to Saturdays."} />
        <div className="row">
          <button className="btn" type="submit" disabled={saving}>{saving ? "Remembering…" : "Add memory"}</button>
          {result && <span className="empty">{result.length ? result.join(" · ") : "Saved. Nothing new to extract."}</span>}
        </div>
      </form>

      <div className="list">
        {state.family.map((f) => (
          <div className="item" key={f.at}>
            <div className="ico" style={{ ["--c" as string]: f.role === "caregiver" ? "var(--sky)" : "var(--rose)" }}>{f.author[0]}</div>
            <div>
              <div className="t">{f.author}</div>
              <div className="d">{f.text}</div>
            </div>
            <span className={`pill ${f.role === "caregiver" ? "info" : "ok"}`}>{f.role}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
