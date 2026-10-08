/**
 * Path resolution and identity checks for definition, log and source options.
 *
 * Expansion mirrors the core reference behavior: `~` and `~/` resolve against
 * the user home, absolute paths stay absolute, everything else resolves
 * against the host location directory. `sameFile` additionally recognizes
 * normalized spellings, existing symlink/hardlink aliases and dangling
 * symlink targets so diagnostics can never append onto a declared input.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function resolvePath(directory: string, path: string): string {
  const expanded = expandUser(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(directory, expanded);
}

function expandUser(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

const MAX_LINK_DEPTH = 16;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** True when two paths denote the same existing file, symlinked parent or dangling link target. */
export function sameFile(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  if (leftPath === rightPath) return true;
  const leftIdentity = existingIdentity(leftPath);
  const rightIdentity = existingIdentity(rightPath);
  if (leftIdentity !== undefined && rightIdentity !== undefined && sameIdentity(leftIdentity, rightIdentity)) return true;
  return canonicalPath(leftPath) === canonicalPath(rightPath);
}

/** Follows symlinks for an existing path; undefined when the path cannot be stat'ed. */
function existingIdentity(path: string): FileIdentity | undefined {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined ? undefined : { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Best-effort canonical spelling of a path: resolves symlinked path segments
 * through the deepest existing ancestor and follows a final symlink (including
 * a dangling one) up to a bounded depth. Missing paths resolve lexically.
 */
function canonicalPath(path: string): string {
  let target = path;
  for (let depth = 0; depth < MAX_LINK_DEPTH; depth += 1) {
    const directory = realDirectory(dirname(target));
    const candidate = join(directory, basename(target));
    const link = linkTarget(candidate);
    if (link === undefined) return candidate;
    target = isAbsolute(link) ? resolve(link) : resolve(directory, link);
  }
  return target;
}

function realDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

function linkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isSymbolicLink()) return undefined;
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}
