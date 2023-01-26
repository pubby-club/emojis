import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import { mkdir, readdir, rm } from "fs/promises";
import { fileURLToPath } from "url";
import { basename, join } from "path";
import os from "os";
import sharp from "sharp";

/**
 * @typedef {{
 * inputDir: string;
 * outputDir: string;
 * outputExt: string;
 * outputSize: number;
 * outputFormat: Parameters<import("sharp").Sharp['toFormat']>[0];
 * outputOptions: Parameters<import("sharp").Sharp['toFormat']>[1];
 * }} Options
 */

/**
 * @typedef {{
 * input: string;
 * output: string;
 * }} InputArgs
 */

/**
 * @typedef {{
 * err?: any;
 * info: import("sharp").OutputInfo;
 * } & InputArgs} Result
 */

/**
 * @param {string} file
 */
function isSvgFile(file) {
  return typeof file === "string" && file.endsWith(".svg");
}

if (isMainThread) {
  const cores = os.cpus().length;

  const inputDir = process.env.INPUT_DIR ?? "./svg";
  const outputFormat = (process.env.OUTPUT_FORMAT ?? "webp").replace(".", "");
  const outputDir = process.env.OUTPUT_DIR ?? `./${outputFormat}`;
  const outputExt = (process.env.OUTPUT_EXT ?? outputFormat).replace(".", "");
  const outputSize = Number(process.env.OUTPUT_SIZE ?? 32);

  /** @type {import("sharp").WebpOptions} */
  const outputOptions = {
    effort: 5,
    nearLossless: true,
    quality: 90,
    smartSubsample: true,
  };

  /** @type {Options} */
  const options = {
    inputDir,
    outputFormat,
    outputDir,
    outputExt,
    outputSize,
    outputOptions,
  };

  if (process.env.OUTPUT_OPTIONS) {
    try {
      Object.assign(outputOptions, JSON.parse(process.env.OUTPUT_OPTIONS));
    } catch (error) {
      throw new Error("Invalid output options:", error);
    }
  }

  const inputFiles = await readdir(inputDir).then((files) =>
    files.filter(isSvgFile)
  );

  // Prepare output dir
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const total = inputFiles.length;
  let success = 0;
  let failed = 0;
  let startTime = Date.now();
  let errors = [];

  /**
   * @param {Result} result
   */
  function progress({ err, input, output, info }) {
    if (err) {
      failed++;
      errors.push(err);
    } else {
      success++;
    }
    console.clear();
    console.log(
      `${input} => ${output} [format: ${outputFormat}] [size: ${outputSize}x${outputSize}]`
    );
    console.log("Total:", total);
    console.log("Success:", success);
    console.log("Failed:", failed);
    console.log("Remaining:", total - success - failed);
    console.log("Time:", `${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    console.log("-");
    errors.forEach((error) => console.log(error.message ?? error));
  }

  function fork() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(fileURLToPath(new URL(import.meta.url)), {
        workerData: options,
      });

      function next() {
        const filename = inputFiles.shift();

        if (filename) {
          const input = join(inputDir, filename);
          const output = join(
            outputDir,
            `${basename(filename, ".svg")}.${outputExt}`
          );

          worker.postMessage({
            input,
            output,
          });
        } else {
          worker.terminate();
        }
      }

      worker.on("message", (args) => {
        progress(args);
        next();
      });

      worker.on("error", reject);
      worker.on("exit", resolve);

      next();
    });
  }

  await Promise.all(Array.from({ length: cores }, fork));

  console.log("Done!");
} else {
  /** @type {Options} */
  const {
    outputSize: size,
    outputFormat: format,
    outputOptions: options,
  } = workerData;

  /**
   *
   * @param {InputArgs} args
   * @returns {Promise<import("sharp").OutputInfo>}
   */
  async function convert({ input, output }) {
    return new Promise((resolve, reject) => {
      sharp(input)
        .resize(size, size, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toFormat(format, options)
        .toFile(output, (err, info) => {
          err ? reject(err) : resolve(info);
        });
    });
  }

  parentPort.on("message", (args) => {
    convert(args)
      .then((info) => {
        parentPort.postMessage({ ...args, info });
      })
      .catch((err) => {
        parentPort.postMessage({ err });
      });
  });
}
