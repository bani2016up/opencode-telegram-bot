import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export interface WorkspaceResolution {
  requested: string;
  directory?: string;
  nearestDirectory?: string;
  missingSegment?: string;
  entries?: string[];
  error?: string;
}

function isWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

export async function resolveWorkspace(
  input: string,
  agentHome: string,
  allowedRoots: readonly string[],
): Promise<WorkspaceResolution> {
  const requested = input.trim();
  if (!requested || requested.includes("\0")) return { requested, error: "Invalid path." };

  const expanded =
    requested === "~"
      ? agentHome
      : requested.startsWith("~/")
        ? resolve(agentHome, requested.slice(2))
        : requested;
  if (!isAbsolute(expanded))
    return { requested, error: "Enter an absolute path or a path starting with ~/." };
  const normalized = normalize(expanded);
  const normalizedRoots = allowedRoots.map((root) => normalize(resolve(root)));
  const canonicalRoots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  if (!normalizedRoots.some((root) => isWithin(normalized, root))) {
    return { requested, error: "The path is outside the configured workspace roots." };
  }

  let cursor = normalized;
  while (true) {
    try {
      const info = await stat(cursor);
      if (!info.isDirectory())
        return { requested, error: "The requested path is not a directory." };
      const canonical = await realpath(cursor);
      if (!canonicalRoots.some((root) => isWithin(canonical, root))) {
        return { requested, error: "The resolved path escapes the configured workspace roots." };
      }
      if (cursor === normalized) return { requested, directory: canonical };

      const remainder = relative(cursor, normalized);
      const [missingSegment] = remainder.split(sep);
      const entries = await readdir(canonical, { withFileTypes: true });
      return {
        requested,
        nearestDirectory: canonical,
        missingSegment: missingSegment ?? remainder,
        entries: entries
          .sort(
            (left, right) =>
              Number(right.isDirectory()) - Number(left.isDirectory()) ||
              left.name.localeCompare(right.name),
          )
          .slice(0, 100)
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        return { requested, error: "The path cannot be accessed." };
      const parent = dirname(cursor);
      if (parent === cursor)
        return { requested, error: "No accessible parent directory was found." };
      cursor = parent;
    }
  }
}
