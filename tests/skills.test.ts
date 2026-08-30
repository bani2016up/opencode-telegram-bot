import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverSkills, parseSkillInvocation, skillPrompt } from "../src/skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("skills", () => {
  it("discovers skills and maps hyphens to Telegram-compatible aliases", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencode-skills-"));
    temporaryDirectories.push(home);
    const skillDirectory = join(home, ".agents", "skills", "security-review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: security-review\ndescription: Review code securely\n---\nInstructions",
    );

    const [skill] = await discoverSkills(home, home);
    expect(skill).toMatchObject({ name: "security-review", alias: "security_review" });
    const invocation = parseSkillInvocation("/security_review inspect auth", [skill!]);
    expect(invocation?.arguments).toBe("inspect auth");
    expect(skillPrompt(skill!, invocation!.arguments)).toContain("security-review");
  });
});
