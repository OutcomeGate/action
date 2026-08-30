import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";

import { digestValue } from "./canonical.js";
import type { BundleFileIdentity } from "./types.js";

export const MAX_BUNDLE_FILES = 1_000;
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

export interface CapturedBundleFile extends BundleFileIdentity {
  content: Uint8Array;
}

export interface CapturedBundle {
  sourceRoot: string;
  files: CapturedBundleFile[];
}

type ErrorFactory = (issues: string[]) => Error;

function fail(createError: ErrorFactory, issues: string[]): never {
  throw createError(issues);
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    value !== "." &&
    posix.normalize(value) === value &&
    !value.split("/").some((segment) => segment.length === 0 || segment === "..")
  );
}

export function bundleFileIdentities(
  files: readonly CapturedBundleFile[],
): BundleFileIdentity[] {
  return files.map(({ path, digest, bytes, mode }) => ({
    path,
    digest,
    bytes,
    mode,
  }));
}

export function computeBundleDigest(
  domain: string,
  files: readonly CapturedBundleFile[],
): string {
  return digestValue({ domain, files: bundleFileIdentities(files) });
}

async function captureBundleOnce(
  root: string,
  createError: ErrorFactory,
): Promise<CapturedBundleFile[]> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    fail(createError, [
      `bundle.root could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail(createError, ["bundle.root must identify a real directory"]);
  }
  const captured: CapturedBundleFile[] = [];
  let totalBytes = 0;

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonicalText(left.name, right.name));
    if (relativeDirectory.length > 0 && entries.length === 0) {
      fail(createError, [`bundle contains an empty directory: ${relativeDirectory}`]);
    }
    for (const entry of entries) {
      if (entry.name.includes("\\")) {
        fail(createError, ["bundle file names cannot contain backslashes"]);
      }
      const absolutePath = join(directory, entry.name);
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : posix.join(relativeDirectory, entry.name);
      const before = await lstat(absolutePath);
      if (before.isSymbolicLink()) {
        fail(createError, [`bundle contains symlink: ${relativePath}`]);
      }
      if (before.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!before.isFile()) {
        fail(createError, [`bundle contains special file: ${relativePath}`]);
      }
      if (before.nlink !== 1) {
        fail(createError, [`bundle contains hard-linked file: ${relativePath}`]);
      }
      if (captured.length + 1 > MAX_BUNDLE_FILES) {
        fail(createError, [
          `bundle exceeds the ${MAX_BUNDLE_FILES}-file pilot limit`,
        ]);
      }
      if (before.size > MAX_BUNDLE_BYTES - totalBytes) {
        fail(createError, [
          `bundle exceeds the ${MAX_BUNDLE_BYTES}-byte pilot limit`,
        ]);
      }
      const content = await readFile(absolutePath);
      const after = await lstat(absolutePath);
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        fail(createError, [`bundle changed during capture: ${relativePath}`]);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        fail(createError, [
          `bundle exceeds the ${MAX_BUNDLE_BYTES}-byte pilot limit`,
        ]);
      }
      captured.push({
        path: relativePath,
        digest: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        mode: after.mode & 0o777,
        content,
      });
    }
  };

  await walk(root, "");
  return captured.sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  );
}

async function assertRootPathHasNoSymlinks(
  manifestDirectory: string,
  relativeRoot: string,
  createError: ErrorFactory,
): Promise<void> {
  if (!isSafeRelativePath(relativeRoot)) {
    fail(createError, [
      "bundle.root must be a normalized relative POSIX path without traversal",
    ]);
  }
  let current = manifestDirectory;
  for (const segment of relativeRoot.split("/")) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      fail(createError, [
        `bundle.root could not be inspected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
    if (metadata.isSymbolicLink()) {
      fail(createError, [`bundle.root traverses a symlink at ${segment}`]);
    }
  }
}

export async function captureDeclaredBundle(options: {
  manifestDirectory: string;
  relativeRoot: string;
  createError: ErrorFactory;
}): Promise<CapturedBundle> {
  await assertRootPathHasNoSymlinks(
    options.manifestDirectory,
    options.relativeRoot,
    options.createError,
  );
  const sourceRoot = resolve(options.manifestDirectory, options.relativeRoot);
  const first = await captureBundleOnce(sourceRoot, options.createError);
  const second = await captureBundleOnce(sourceRoot, options.createError);
  if (
    digestValue(bundleFileIdentities(first)) !==
    digestValue(bundleFileIdentities(second))
  ) {
    fail(options.createError, ["bundle changed between capture passes"]);
  }
  return { sourceRoot, files: second };
}

function validateCapturedFiles(
  files: readonly CapturedBundleFile[],
  createError: ErrorFactory,
): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      fail(createError, [`captured bundle contains unsafe path: ${file.path}`]);
    }
    if (paths.has(file.path)) {
      fail(createError, [`captured bundle contains duplicate path: ${file.path}`]);
    }
    paths.add(file.path);
    if (
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      file.bytes !== file.content.byteLength ||
      !/^[a-f0-9]{64}$/.test(file.digest) ||
      createHash("sha256").update(file.content).digest("hex") !== file.digest
    ) {
      fail(createError, [`captured bundle metadata is invalid for ${file.path}`]);
    }
  }
}

export async function materializeCapturedBundle(options: {
  files: readonly CapturedBundleFile[];
  prefix: string;
  createError: ErrorFactory;
}): Promise<string> {
  validateCapturedFiles(options.files, options.createError);
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  try {
    for (const file of options.files) {
      const destination = join(root, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, { mode: file.mode });
      await chmod(destination, file.mode);
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function materializedBundleMatches(options: {
  root: string;
  expectedFiles: readonly CapturedBundleFile[];
  createError: ErrorFactory;
}): Promise<boolean> {
  const current = await captureBundleOnce(options.root, options.createError);
  return (
    digestValue(bundleFileIdentities(current)) ===
    digestValue(bundleFileIdentities(options.expectedFiles))
  );
}

export async function cleanupMaterializedBundle(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
