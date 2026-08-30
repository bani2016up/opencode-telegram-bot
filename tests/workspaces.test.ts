import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspace } from "../src/workspaces.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opencode-telegram-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("resolveWorkspace", () => {
  it("expands home paths and resolves an existing directory", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "projects", "api"), { recursive: true });
    const result = await resolveWorkspace("~/projects/api", root, [root]);
    expect(result.directory).toBe(await realpath(join(root, "projects", "api")));
  });

  it("lists the deepest existing directory without running a shell", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "projects", "api"), { recursive: true });
    await writeFile(join(root, "projects", "README.md"), "test");
    const result = await resolveWorkspace(join(root, "projects", "missing", "src"), root, [root]);
    expect(result.nearestDirectory).toBe(await realpath(join(root, "projects")));
    expect(result.missingSegment).toBe("missing");
    expect(result.entries).toEqual(["api/", "README.md"]);
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const result = await resolveWorkspace(outside, root, [root]);
    expect(result.error).toContain("outside");
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(root, "escape"));
    const result = await resolveWorkspace(join(root, "escape"), root, [root]);
    expect(result.error).toContain("escapes");
  });
});
