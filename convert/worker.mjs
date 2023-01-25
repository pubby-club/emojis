import { parentPort } from "worker_threads";
import { exec } from "child_process";
import { fileURLToPath } from "url";

parentPort.on("message", async (file) => {
  const out = file.replace(".svg", ".png");
  const cmd = `convert -background none -resize 32x32 ./svg/${file} ./png/${out}`;

  exec(
    cmd,
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    },
    (err) => parentPort.postMessage(true)
  );
});
