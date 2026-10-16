import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { recentTurns } from "./memory";
import type { Persona } from "./personas";
import { TOOLS, runTool, type Trace } from "./tools";

/*
 * Companion agent. Talks to the user and answers from the memory graph through tools.
 * Conversation history itself is read back from the graph (Session -> Utterance), so it
 * survives restarts and is shared with the other agents.
 */

let client: Anthropic | null = null;
const ai = () => (client ??= new Anthropic());
const MODEL = process.env.MITHI_COMPANION_MODEL ?? "claude-opus-5-5";

function systemPrompt(p: Persona) {
  const now = new Date();
  const when = now.toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const tone =
    p.mode === "elder"
      ? `You are talking with ${p.fullName}. Call her "${p.name}". She has early memory loss.
- Short, warm, simple sentences. One idea at a time. Never quiz her or say "I already told you".
- If she repeats a story, enjoy it again and ask a gentle detail question.
- If what she says conflicts with what family recorded, do not argue. Acknowledge kindly and move on; the family will check.
- Medicines: you may remind and log doses. Never give medical advice or change doses.`
      : `You are talking with ${p.name}, like a caring friend who remembers their life.
- Warm, natural, a little playful. Notice patterns and gently point them out.
- Keep it light; never lecture.`;
  return `You are Mithi, a sweet personal companion with a long-term memory stored in a graph.
${p.about}
Now: ${when}.

${tone}

Memory rules:
- Before answering anything about people, the past, plans, routines, medicines or feelings over time, look it up with the tools. Do not guess.
- Weave remembered details in naturally ("you told me on Tuesday..."). If a memory is marked unverified, say it softly.
- If memory has nothing, say so simply and ask.
- Your reply is spoken aloud: 1 to 3 short sentences, no lists, no markdown, no emoji.`;
}

/** Collapse stored turns into alternating user/assistant messages. */
function historyMessages(turns: { speaker: string; text: string }[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const t of turns) {
    const role = t.speaker === "mithi" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${t.text}`;
    else out.push({ role, content: t.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export interface CompanionResult {
  reply: string;
  traces: Trace[];
}

export async function companionReply(pid: string, persona: Persona, userText: string): Promise<CompanionResult> {
  const turns = await recentTurns(pid, 12);
  const messages = historyMessages(turns);
  if (messages.length && messages[messages.length - 1].role === "user") {
    messages[messages.length - 1].content = `${messages[messages.length - 1].content as string}\n${userText}`;
  } else messages.push({ role: "user", content: userText });

  const traces: Trace[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await ai().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: systemPrompt(persona),
      tools: TOOLS,
      messages,
    });

    if (res.stop_reason === "refusal") {
      return { reply: "Let's talk about something else for a bit. How has your day been?", traces };
    }
    if (res.stop_reason !== "tool_use") {
      const text = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join(" ")
        .trim();
      return { reply: text || "I'm here.", traces };
    }

    messages.push({ role: "assistant", content: res.content as BetaContentBlockParam[] });
    const calls = res.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    const results: BetaToolResultBlockParam[] = await Promise.all(
      calls.map(async (c) => {
        try {
          const out = await runTool(pid, c.name, (c.input ?? {}) as Record<string, unknown>);
          traces.push(out.trace);
          return { type: "tool_result" as const, tool_use_id: c.id, content: JSON.stringify(out.data) };
        } catch (err) {
          return { type: "tool_result" as const, tool_use_id: c.id, content: String(err), is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { reply: "Give me a moment, I'm still remembering.", traces };
}
