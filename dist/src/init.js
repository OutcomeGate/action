import { lstat, mkdir, readFile, realpath, writeFile, } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_STARTER_DIRECTORY = "outcomegate-starter";
const STARTER_FILES = Object.freeze([
    [".github/workflows/outcomegate.yml", ".github/workflows/outcomegate.yml"],
    ["gitignore", ".gitignore"],
    ["README.md", "README.md"],
    ["agentci/adapter.bundle/adapter.mjs", "agentci/adapter.bundle/adapter.mjs"],
    ["agentci/adapter.manifest.json", "agentci/adapter.manifest.json"],
    ["agentci/release.bundle/candidate.mjs", "agentci/release.bundle/candidate.mjs"],
    ["agentci/release.bundle/prompt.md", "agentci/release.bundle/prompt.md"],
    ["agentci/release.bundle/tool-schema.json", "agentci/release.bundle/tool-schema.json"],
    ["agentci/release.manifest.json", "agentci/release.manifest.json"],
    ["agentci/suite.json", "agentci/suite.json"],
]);
function isWithin(root, candidate) {
    const pathFromRoot = relative(root, candidate);
    return (pathFromRoot.length > 0 &&
        pathFromRoot !== ".." &&
        !pathFromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromRoot));
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
function starterTemplateRoot() {
    // The compiled CLI lives at dist/src/init.js while templates are shipped at
    // the package root. Keeping a fixed file manifest avoids copying unexpected
    // files if the package contents are tampered with.
    return fileURLToPath(new URL("../../templates/starter/", import.meta.url));
}
export async function initializeStarter(requestedDirectory = DEFAULT_STARTER_DIRECTORY, workingDirectory = process.cwd()) {
    if (requestedDirectory.length === 0 ||
        requestedDirectory !== requestedDirectory.trim() ||
        isAbsolute(requestedDirectory) ||
        /[\u0000-\u001f\u007f]/u.test(requestedDirectory)) {
        throw new Error("init target must be a non-empty relative directory within the current working directory");
    }
    const canonicalWorkingDirectory = await realpath(workingDirectory);
    const target = resolve(canonicalWorkingDirectory, requestedDirectory);
    if (!isWithin(canonicalWorkingDirectory, target)) {
        throw new Error("init target must remain within the current working directory");
    }
    if (await pathExists(target)) {
        throw new Error("init target already exists; refusing to overwrite it");
    }
    const parent = dirname(target);
    let canonicalParent;
    try {
        canonicalParent = await realpath(parent);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("init target parent directory must already exist");
        }
        throw error;
    }
    if (canonicalParent !== canonicalWorkingDirectory &&
        !isWithin(canonicalWorkingDirectory, canonicalParent)) {
        throw new Error("init target parent must remain within the current working directory");
    }
    await mkdir(target);
    const templateRoot = starterTemplateRoot();
    for (const [sourcePath, destinationPath] of STARTER_FILES) {
        const source = resolve(templateRoot, sourcePath);
        const destination = resolve(target, destinationPath);
        if (!isWithin(templateRoot, source) ||
            !isWithin(target, destination)) {
            throw new Error("starter template contains an unsafe path");
        }
        await mkdir(dirname(destination), { recursive: true });
        const contents = await readFile(source);
        await writeFile(destination, contents, { flag: "wx" });
    }
    return target;
}
