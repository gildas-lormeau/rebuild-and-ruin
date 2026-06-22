/**
 * Extract frames from a video at a fixed rate (default 1 fps = one screenshot
 * per second) into a tmp subfolder, using ffmpeg (a standard CLI tool).
 *
 * Operates purely on the given video file — it never reads the host screen.
 * Frames are written as frame_0001.png, frame_0002.png, ... (at 1 fps each index
 * is the second of video it was taken at).
 *
 * Usage:
 *   deno run -A scripts/rampart-frames.ts <video> [outDir] [fps]
 *
 * Defaults: outDir = tmp/frames/<video-basename>, fps = 1.
 */

if (import.meta.main) await main();

async function main() {
  const [video, outArg, fpsArg] = Deno.args;
  if (!video) {
    console.error(
      "usage: deno run -A scripts/rampart-frames.ts <video> [outDir] [fps]",
    );
    Deno.exit(2);
  }
  const stat = await Deno.stat(video).catch(() => null);
  if (!stat?.isFile) {
    console.error(`no such video file: ${video}`);
    Deno.exit(1);
  }
  const fps = fpsArg ? Number(fpsArg) : 1;
  if (!(fps > 0)) {
    console.error(`invalid fps: ${fpsArg}`);
    Deno.exit(1);
  }
  const outDir = outArg ?? `tmp/frames/${baseNoExt(video)}`;

  // ensure a clean output dir (only ever removes its own .png frames)
  await Deno.mkdir(outDir, { recursive: true });
  for await (const entry of Deno.readDir(outDir)) {
    if (entry.isFile && entry.name.endsWith(".png")) {
      await Deno.remove(`${outDir}/${entry.name}`);
    }
  }

  const { success } = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      `fps=${fps}`,
      `${outDir}/frame_%04d.png`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) {
    console.error("ffmpeg failed");
    Deno.exit(1);
  }

  let count = 0;
  for await (const entry of Deno.readDir(outDir)) {
    if (entry.isFile && entry.name.endsWith(".png")) count++;
  }
  console.log(`extracted ${count} frames @ ${fps}fps -> ${outDir}/`);
}

function baseNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
