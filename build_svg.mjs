import { Octokit } from "octokit";
import { basename, join, resolve } from "node:path";
import { mkdir, rm, symlink } from "node:fs/promises";
import Zip from "adm-zip";

const GITHUB_SVG_URLS = process.env.GITHUB_SVG_URLS?.split(",") ?? [
  "https://github.com/googlefonts/noto-emoji/tree/main/svg",
  "https://github.com/googlefonts/noto-emoji/tree/main/third_party/region-flags/waved-svg",
];

const OUT_DIR = resolve(process.env.OUT_DIR ?? "./svg");

const octo = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

let total = 0;
let success = 0;
let failed = 0;

/**
 * @param {string} url
 * @returns {{
 *  owner: string;
 *  repo: string;
 *  type: string;
 *  branch: string;
 *  path: string;
 * } | undefined}
 **/
async function resolveUrl(url) {
  const reg =
    /^https?:\/\/github.com\/([^/]+)\/([^/]+)(?:\/?|\/(tree|blob)\/([^/\n]+)(?:\/?|\/(.+?)\/*)?)?$/;
  const match = (typeof url === "string" ? url : "").match(reg);

  if (!match || match.length < 3) {
    throw new Error(`Invalid url: ${url}`);
  }

  const owner = match[1];
  const repo = match[2];
  let type = match[3];
  let branch = match[4];
  const path = match[5] ?? "";

  if (!type) {
    const {
      data: { default_branch },
      status,
    } = await octo.request("GET /repos/{owner}/{repo}", {
      owner,
      repo,
      headers: {
        accept: "application/vnd.github+json",
      },
    });

    if (status !== 200) {
      throw new Error(
        `Failed to resolve default branch for ${owner}/${repo}: ${status}`
      );
    }

    type = "tree";
    branch = default_branch;
  }

  return { owner, repo, type, branch, path };
}

/**
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {string} path
 * @returns {string | undefined}
 */
function getTreeSha(owner, repo, branch, path) {
  return octo
    .request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: join(path, ".."),
      ref: branch,
      headers: {
        accept: "application/vnd.github+json",
      },
    })
    .then(({ data, status }) => {
      if (status !== 200) {
        throw new Error(
          `Failed to get tree sha for ${owner}/${repo}/${branch}: ${status}`
        );
      }
      return data.find((item) => item.type === "dir" && item.path === path)
        ?.sha;
    });
}

/**
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 */
function getZip(owner, repo, ref) {
  return octo
    .request("GET /repos/{owner}/{repo}/zipball/{ref}", {
      owner,
      repo,
      ref,
      headers: {
        accept: "application/vnd.github+json",
      },
    })
    .then(({ data }) => Buffer.from(data));
}

/**
 * Checks if a file is a symbolic link
 * @param {number} attr
 * @see https://github.com/LuaDist/zip/blob/f6cfe48f6bc5bf2d505a0e0eb265ce4cb238db89/fileio.c#L1124
 * @see https://docs.huihoo.com/doxygen/linux/kernel/3.7/include_2uapi_2linux_2stat_8h.html
 */
function isSymbolicLink(attr) {
  const S_IFLNK = parseInt("0120000", 8);
  const S_IFMT = parseInt("00170000", 8);
  return ((attr >>> 16) & S_IFMT) === S_IFLNK;
}

/** @param {string} path */
function isSvgPath(path) {
  return path.endsWith(".svg");
}

/**
 * @param {Buffer} buf
 */
function getZipSvgEntries(buf) {
  const zip = new Zip(buf);

  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && isSvgPath(entry.entryName));

  return { zip, entries };
}

/**
 *
 * @param {string} url
 */
async function getFiles(url) {
  const metadata = await resolveUrl(url);

  if (!metadata) return [];

  const { owner, repo, type, branch, path } = metadata;

  const treeSha = await getTreeSha(owner, repo, branch, path);

  const logMessage = (...args) => {
    console.log(`[${owner}/${repo}]`, ...args);
  };

  const logError = (...args) => {
    console.error(`[${owner}/${repo}]`, ...args);
  };

  if (!treeSha) {
    logError(`No tree hash found for: ${path}`);
    return [];
  }

  // Find tree files for post check
  const {
    data: { tree },
  } = await octo.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: treeSha,
    headers: {
      accept: "application/vnd.github+json",
    },
  });

  total += tree.filter((node) => isSvgPath(node.path)).length;

  logMessage(`Found ${tree.length} files for path ${path} [${treeSha}]`);
  logMessage(`Downloading zip from ref: ${treeSha}`);

  const zip = await getZip(owner, repo, treeSha);

  // logMessage(`Unzipping ${path}...`);
  return getZipSvgEntries(zip);

  // return entries;
}

console.log(`Fetching files from ${GITHUB_SVG_URLS.length} sources...`);
for (const src of GITHUB_SVG_URLS) {
  console.log(`- ${src}`);
}

const startTime = Date.now();
const files = await Promise.all(GITHUB_SVG_URLS.map(getFiles)).then((res) =>
  res.flat()
);

const downloaded = files.reduce((acc, { entries }) => acc + entries.length, 0);

console.log(
  `Downloaded ${downloaded} of ${total} files. (${
    (Date.now() - startTime) / 1000
  }s)`
);
console.log(`Extracting files...`);

// Prepare svg dir
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

// Write files to svg dir
await Promise.all(
  files.flatMap(async ({ zip, entries }) => {
    return entries.map(async (entry) => {
      try {
        if (isSymbolicLink(entry.header.attr)) {
          const target = entry.getData().toString();
          const path = join(OUT_DIR, basename(entry.entryName));
          await symlink(target, path, "file");
        } else {
          if (!zip.extractEntryTo(entry, OUT_DIR, false, true, true)) {
            throw new Error(`Failed to extract ${entry.entryName}`);
          }
        }

        success++;
      } catch (err) {
        console.error(`Failed to write ${entry.entryName}:`, err);
        failed++;
      }
    });
  })
);

console.log(`Success: ${success}`);
console.log(`Failed: ${failed}`);
console.log(`Done! (${(Date.now() - startTime) / 1000}s)`);
