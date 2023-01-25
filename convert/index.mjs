import os from "os";
import { mkdir, readdir, rm } from "fs/promises";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";

const outPath = fileURLToPath(new URL("../png", import.meta.url));

await rm(outPath, { recursive: true, force: true });
await mkdir(outPath, {
  recursive: true,
});

const files = await readdir("./svg").then((files) =>
  files.filter((f) => f?.endsWith(".svg"))
);
const cores = os.cpus().length;

const total = files.length;

for (let i = 0; i < cores; i++) {
  const worker = new Worker(
    fileURLToPath(new URL("./worker.mjs", import.meta.url))
  );

  const next = () => {
    const file = files.pop();
    if (file) {
      worker.postMessage(file);
    } else {
      worker.terminate();
    }
    console.clear();
    console.log("Remaining:", total - files.length, "of", total);
  };

  worker.on("message", next);
  next();
}
