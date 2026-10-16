export type PersonaMode = "personal" | "elder";

export interface Persona {
  id: string;
  name: string; // what Mithi calls them
  fullName: string;
  mode: PersonaMode;
  locale: string; // speech recognition / synthesis language
  about: string; // short framing for the companion prompt
}

// Both personas are fictional. No real personal data is stored anywhere in this project.
export const PERSONAS: Record<string, Persona> = {
  arjun: {
    id: "arjun",
    name: "Arjun",
    fullName: "Arjun Mehta",
    mode: "personal",
    locale: "en-IN",
    about:
      "Arjun is a 29-year-old software engineer in Pune. Talks to Mithi in the evenings to unwind.",
  },
  kamala: {
    id: "kamala",
    name: "Aaji",
    fullName: "Kamala Deshpande",
    mode: "elder",
    locale: "en-IN",
    about:
      "Kamala is 78, lives in Pune with a day-time caregiver, and has early memory loss. Family calls her Aaji (grandmother in Marathi). Long-term memories are vivid, recent ones fade.",
  },
};

export function getPersona(id: string | null | undefined): Persona {
  return PERSONAS[id ?? ""] ?? PERSONAS.arjun;
}

// Relationship types the graph allows between people. Cypher cannot parameterise
// relationship types, so anything written into a query must come from this list.
export const KINSHIP = [
  "CHILD_OF",
  "SPOUSE_OF",
  "SIBLING_OF",
  "FRIEND_OF",
  "CAREGIVER_OF",
  "NEIGHBOUR_OF",
  "COLLEAGUE_OF",
] as const;
export type Kinship = (typeof KINSHIP)[number];
