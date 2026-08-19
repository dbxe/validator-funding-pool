import path from "node:path";
import { fileURLToPath } from "node:url";

/// The checkout root. Every command runs as a child process with this as its working
/// directory, because the scripts resolve `artifacts/` and the default deployment record
/// relative to the process's cwd.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
