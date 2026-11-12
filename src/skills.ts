// Built-in skills: design know-how shipped with the server as Markdown files
// (skills/<name>/SKILL.md), offered to agents as a tool, as MCP resources,
// and inside MCP prompts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  uri: string;
}

export const SKILLS_DIR = process.env.FIGMA_BRIDGE_SKILLS_DIR || fileURLToPath(new URL("../skills/", import.meta.url));

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: text.slice(match[0].length).trimStart() };
}

export function loadSkills(dir = SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const name = meta.name || entry.name;
    skills.push({ name, description: meta.description || "", body, uri: `skill://figma-bridge/${name}` });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
