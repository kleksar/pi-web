import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export class BoundedFileError extends Error {}

/** Read a regular configuration file without ever allocating more than its cap. */
export function readBoundedRegularFile(path: string, maxBytes: number, label: string): Buffer {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new BoundedFileError("Secure configuration reading is not available on this platform");
  }
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new BoundedFileError(`${label} must be a regular file`);
    if (stat.size > maxBytes) throw new BoundedFileError(`${label} exceeds the ${maxBytes}-byte limit`);
    // A file may grow after fstat. One extra byte detects that race without
    // allocating from the new size or reading the rest of the file.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size) throw new BoundedFileError(`${label} changed during reading`);
    return buffer.subarray(0, length);
  } finally {
    closeSync(file);
  }
}
