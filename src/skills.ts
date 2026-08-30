import { createHash } from "node:crypto";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parse } from "yaml";

export interface SkillDefinition {
  name: string;
  description: string;
  alias: string;
  path: string;
}

const reservedCommands = new Set(["start"]);
const maximumSkillBytes = 256 * 1024;

function commandAlias(name: string): string {
  let alias = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (!alias) alias = "skill";
  if (reservedCommands.has(alias)) alias = `skill_${alias}`;
  if (alias.length > 32) {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
    alias = `${alias.slice(0, 25)}_${hash}`;
  }
  return alias;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function skillDirectories(base: string): Promise<string[]> {
  try {
    const info = await lstat(base);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  return (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name, "SKILL.md"));
}

async function findGitRoot(directory: string): Promise<string> {
  let cursor = directory;
  while (true) {
    if (await directoryExists(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return directory;
    cursor = parent;
  }
}

async function candidateFiles(directory: string, agentHome: string): Promise<string[]> {
  const files = (
    await Promise.all([
      skillDirectories(join(agentHome, ".config/opencode/skills")),
      skillDirectories(join(agentHome, ".claude/skills")),
      skillDirectories(join(agentHome, ".agents/skills")),
    ])
  ).flat();

  const gitRoot = await findGitRoot(directory);
  let cursor = directory;
  while (true) {
    files.push(
      ...(await skillDirectories(join(cursor, ".opencode/skills"))),
      ...(await skillDirectories(join(cursor, ".claude/skills"))),
      ...(await skillDirectories(join(cursor, ".agents/skills"))),
    );
    if (cursor === gitRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return files;
}

function frontmatter(source: string): { name: string; description: string } | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---/u.exec(source);
  if (!match?.[1]) return undefined;
  const metadata = parse(match[1]) as { name?: unknown; description?: unknown };
  return typeof metadata.name === "string" && typeof metadata.description === "string"
    ? { name: metadata.name.trim(), description: metadata.description.trim() }
    : undefined;
}

export async function discoverSkills(
  directory: string,
  agentHome: string,
): Promise<SkillDefinition[]> {
  const byName = new Map<string, SkillDefinition>();
  for (const path of await candidateFiles(directory, agentHome)) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maximumSkillBytes) continue;
      const handle = await open(path, "r");
      const buffer = Buffer.alloc(Math.min(info.size, maximumSkillBytes));
      try {
        await handle.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle.close();
      }
      const metadata = frontmatter(buffer.toString("utf8"));
      if (!metadata || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.name)) continue;
      byName.set(metadata.name, { ...metadata, alias: commandAlias(metadata.name), path });
    } catch {
      // A disappearing or unreadable skill should not break the bot command menu.
    }
  }

  const aliases = new Map<string, string>();
  for (const skill of byName.values()) {
    const existing = aliases.get(skill.alias);
    if (existing && existing !== skill.name) {
      const hash = createHash("sha256").update(skill.name).digest("hex").slice(0, 6);
      skill.alias = `${skill.alias.slice(0, 25)}_${hash}`;
    }
    aliases.set(skill.alias, skill.name);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseSkillInvocation(
  text: string,
  skills: readonly SkillDefinition[],
): { skill: SkillDefinition; arguments: string } | undefined {
  const match = /^\/([a-z0-9_]{1,32})(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match?.[1]) return undefined;
  const skill = skills.find((candidate) => candidate.alias === match[1]);
  return skill ? { skill, arguments: match[2]?.trim() ?? "" } : undefined;
}

export function skillPrompt(skill: SkillDefinition, argumentsText: string): string {
  const task = argumentsText || "Apply this skill to the current project and report the result.";
  return `Load and follow the \`${skill.name}\` skill.\n\nUser request:\n${task}`;
}
