// Reading image files for place_image.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";

const MAX_BYTES = 20 * 1024 * 1024;

/** Accepts ~/…, relative paths, and Windows paths such as C:\Users\me\logo.png (read through /mnt/c under WSL). */
export function normalizeImagePath(input: string): string {
  let path = input.trim();
  const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (windows && process.platform !== "win32") {
    path = `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, "/")}`;
  }
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  return resolve(path);
}

function imageType(bytes: Buffer): string | undefined {
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47) return "PNG";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
  if (bytes.length > 6 && bytes.toString("ascii", 0, 3) === "GIF") return "GIF";
  return undefined;
}

export async function readImageFile(input: string): Promise<{ base64: string; name: string; type: string; path: string }> {
  const path = normalizeImagePath(input);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`No file at ${path}${path !== input ? ` (from "${input}")` : ""}.`);
  }
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > MAX_BYTES) throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
  const bytes = await readFile(path);
  const type = imageType(bytes);
  if (!type) {
    throw new Error(`${path} is not a PNG, JPEG or GIF file, which are the formats Figma accepts. Convert it first (SVG markup can go into build_design as type "svg").`);
  }
  return { base64: bytes.toString("base64"), name: basename(path, extname(path)), type, path };
}
