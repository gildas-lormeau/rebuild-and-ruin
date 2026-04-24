import path from "node:path";
import { Project } from "ts-morph";

let cached: Project | null = null;

export function createProject(tsConfigPath?: string): Project {
  if (cached) return cached;
  cached = new Project({
    tsConfigFilePath: tsConfigPath ?? path.resolve("tsconfig.json"),
  });
  return cached;
}

export function resetProject(): void {
  cached = null;
}
