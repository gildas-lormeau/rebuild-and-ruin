import { spawnSync } from "node:child_process";
import type { Project } from "ts-morph";

export interface VerifyResult {
  verified: boolean;
  rolledBack: boolean;
  tscOutput?: string;
}

export async function verifyWrites(
  project: Project,
  doWrite: () => Promise<void> | void,
): Promise<VerifyResult> {
  const snapshots = snapshotChangedFiles(project);
  await doWrite();
  await project.save();
  const tsc = runTsc();
  if (tsc.ok) {
    return { verified: true, rolledBack: false };
  }
  for (const [filePath, text] of snapshots) {
    const sf = project.getSourceFile(filePath);
    if (sf) sf.replaceWithText(text);
  }
  await project.save();
  return { verified: false, rolledBack: true, tscOutput: tsc.output };
}

function snapshotChangedFiles(project: Project): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    snapshots.set(sf.getFilePath(), sf.getFullText());
  }
  return snapshots;
}

function runTsc(): { ok: boolean; output: string } {
  const result = spawnSync("npx", ["tsc", "--noEmit"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}
