/**
 * Owned-region markers inside a role's system prompt.
 *
 * A managed role's system is seeded as BEGIN + rendered body + END. The
 * context renderer replaces exactly the body between one complete pair of
 * markers, preserving prefixes, suffixes and every other system part.
 * Duplicated, reordered or altered markers fail instead of degrading; a system
 * with no marker at all is reported as `missing` so a restarted process can
 * re-seed the role before using this request.
 */
import { AdapterError } from './failure.ts';

export interface SystemPartLike {
  text: string;
}

const MARKER_ROOT = '<<<opencode-prompts';

export function beginMarker(generation: string, agentID: string): string {
  return `${MARKER_ROOT}|g=${generation}|agent=${agentID}|begin>>>`;
}

export function endMarker(generation: string, agentID: string): string {
  return `${MARKER_ROOT}|g=${generation}|agent=${agentID}|end>>>`;
}

export function wrapSeed(generation: string, agentID: string, body: string): string {
  return `${beginMarker(generation, agentID)}\n${body}\n${endMarker(generation, agentID)}`;
}

export function hasMarkerNamespace(system: string | undefined): boolean {
  return system !== undefined && system.includes(`${MARKER_ROOT}|`);
}

/** Number of owned marker tokens, valid or not, in one system text. */
export function markerNamespaceCount(system: string): number {
  return occurrences(system, `${MARKER_ROOT}|`);
}

/** True when the system text carries exactly one complete owned region for this generation. */
export function hasOwnedRegion(system: string | undefined, generation: string, agentID: string): boolean {
  if (system === undefined) return false;
  const begin = beginMarker(generation, agentID);
  const end = endMarker(generation, agentID);
  const beginAt = system.indexOf(begin);
  const endAt = system.indexOf(end);
  return (
    markerNamespaceCount(system) === 2 &&
    beginAt !== -1 &&
    endAt > beginAt &&
    occurrences(system, begin) === 1 &&
    occurrences(system, end) === 1
  );
}

export type RegionReplacement = 'replaced' | 'missing';

/**
 * Replaces exactly the owned body in one part. Returns `missing` when the host
 * rebuilt the role without any marker (a restarted process has no in-memory
 * seed), so the caller can re-seed that role. Duplicate or altered markers
 * still fail instead of being overwritten.
 */
export function replaceOwnedRegion(
  system: SystemPartLike[],
  generation: string,
  agentID: string,
  body: string,
): RegionReplacement {
  const begin = beginMarker(generation, agentID);
  const end = endMarker(generation, agentID);
  let namespace = 0;
  let beginPart = -1;
  let beginAt = -1;
  let endPart = -1;
  let endAt = -1;
  for (let index = 0; index < system.length; index += 1) {
    const part = system[index];
    if (part === undefined) continue;
    namespace += occurrences(part.text, `${MARKER_ROOT}|`);
    const currentBegin = part.text.indexOf(begin);
    if (currentBegin !== -1) {
      if (beginPart !== -1 || occurrences(part.text, begin) !== 1) throw regionFailure('region-duplicate', 1);
      beginPart = index;
      beginAt = currentBegin;
    }
    const currentEnd = part.text.indexOf(end);
    if (currentEnd !== -1) {
      if (endPart !== -1 || occurrences(part.text, end) !== 1) throw regionFailure('region-duplicate', 1);
      endPart = index;
      endAt = currentEnd;
    }
  }
  if (namespace === 0) return 'missing';
  if (namespace !== 2) throw regionFailure('region-malformed', namespace);
  if (beginPart === -1 || endPart === -1) throw regionFailure('region-malformed', namespace);
  if (beginPart !== endPart || beginAt === -1 || endAt <= beginAt) throw regionFailure('region-malformed', namespace);
  const part = system[beginPart];
  if (part === undefined) throw regionFailure('region-malformed', namespace);
  const prefix = part.text.slice(0, beginAt + begin.length);
  const suffix = part.text.slice(endAt);
  system[beginPart] = { ...part, text: `${prefix}\n${body}\n${suffix}` };
  return 'replaced';
}

/**
 * Swaps the one native system part of a role that lost its markers for a
 * freshly wrapped seed. An absent, empty or duplicated native text has no
 * unambiguous target and fails closed: replacing an arbitrary part could
 * delete a preceding plugin's instructions or the host's default prompt.
 */
export function seedNativeRegion(system: SystemPartLike[], native: string | undefined, seed: string): void {
  if (native === undefined || native.length === 0) throw regionFailure('region-missing', 0);
  let index = -1;
  for (let current = 0; current < system.length; current += 1) {
    const part = system[current];
    if (part === undefined || part.text !== native) continue;
    if (index !== -1) throw regionFailure('region-missing', 0);
    index = current;
  }
  const part = system[index];
  if (part === undefined) throw regionFailure('region-missing', 0);
  system[index] = { ...part, text: seed };
}

function occurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

function regionFailure(code: 'region-missing' | 'region-duplicate' | 'region-malformed', count: number): AdapterError {
  return new AdapterError({ code, slot: 'system', count });
}
