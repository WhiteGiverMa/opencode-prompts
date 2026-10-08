import { PromptsError, type SourceLocation } from './errors.ts';

export type PlaceholderMode = 'use' | 'omit';

export interface PlaceholderRef {
  readonly name: string;
  readonly mode: PlaceholderMode;
  readonly location: SourceLocation;
}

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly ref: PlaceholderRef };

export interface ParsedTemplate {
  readonly segments: readonly Segment[];
  readonly refs: readonly PlaceholderRef[];
}

export interface SlotUsage {
  readonly name: string;
  readonly uses: readonly PlaceholderRef[];
  readonly omits: readonly PlaceholderRef[];
}

const SLOT_NAME_PATTERN = /^[^\s{}:]+$/;

/** Slot names are user-defined; they only need to be placeholder-safe. */
export function isValidSlotName(name: string): boolean {
  return SLOT_NAME_PATTERN.test(name);
}

/**
 * Parses a template into literal segments and placeholder refs.
 * `\{{` escapes an opening placeholder and renders as a literal `{{`.
 */
export function parseTemplate(text: string, file: string): ParsedTemplate {
  const segments: Segment[] = [];
  const refs: PlaceholderRef[] = [];
  let literal = '';
  let line = 1;
  let column = 1;
  let index = 0;

  const flushText = (): void => {
    if (literal.length > 0) {
      segments.push({ kind: 'text', text: literal });
      literal = '';
    }
  };
  const advance = (from: number, to: number): void => {
    for (let step = from; step < to; step += 1) {
      if (text[step] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  };

  while (index < text.length) {
    if (text.startsWith('\\{{', index)) {
      literal += '{{';
      advance(index, index + 3);
      index += 3;
      continue;
    }
    if (text.startsWith('{{', index)) {
      const location: SourceLocation = { line, column };
      const close = text.indexOf('}}', index + 2);
      if (close === -1) {
        throw new PromptsError({ code: 'template-parse', file, locations: [location], detail: 'unclosed placeholder' });
      }
      const ref = parsePlaceholder(text.slice(index + 2, close), location, file);
      flushText();
      segments.push({ kind: 'placeholder', ref });
      refs.push(ref);
      advance(index, close + 2);
      index = close + 2;
      continue;
    }
    const current = text[index];
    if (current !== undefined) literal += current;
    advance(index, index + 1);
    index += 1;
  }

  flushText();
  return { segments, refs };
}

function parsePlaceholder(raw: string, location: SourceLocation, file: string): PlaceholderRef {
  const colon = raw.indexOf(':');
  const name = colon === -1 ? raw : raw.slice(0, colon);
  const modifier = colon === -1 ? undefined : raw.slice(colon + 1);
  if (!isValidSlotName(name)) {
    throw new PromptsError({
      code: 'template-parse',
      file,
      locations: [location],
      detail: 'invalid placeholder name; names must be nonempty and free of whitespace, braces and colons',
    });
  }
  if (modifier === undefined) return { name, mode: 'use', location };
  if (modifier === 'omit') return { name, mode: 'omit', location };
  throw new PromptsError({
    code: 'template-parse',
    file,
    locations: [location],
    detail: 'unknown placeholder modifier; only ":omit" is supported',
  });
}

/**
 * Validates placeholder cardinality against the declared slots:
 * every declared slot is referenced exactly once as use or omit, uses may
 * repeat only when allowed, and omit/use conflicts always fail.
 */
export function analyzeReferences(
  parsed: ParsedTemplate,
  declared: readonly string[],
  allowRepeatedSlots: boolean,
  file: string,
): ReadonlyMap<string, SlotUsage> {
  const byName = new Map<string, PlaceholderRef[]>();
  for (const ref of parsed.refs) {
    const list = byName.get(ref.name);
    if (list === undefined) byName.set(ref.name, [ref]);
    else list.push(ref);
  }

  const declaredSet = new Set(declared);
  for (const [name, list] of byName) {
    if (!declaredSet.has(name)) {
      throw new PromptsError({
        code: 'slot-unknown',
        file,
        slot: name,
        count: list.length,
        locations: list.map((ref) => ref.location),
        detail: `placeholder ${JSON.stringify(name)} is not declared under "slots"`,
      });
    }
  }

  const usage = new Map<string, SlotUsage>();
  for (const name of declared) {
    const list = byName.get(name) ?? [];
    const uses = list.filter((ref) => ref.mode === 'use');
    const omits = list.filter((ref) => ref.mode === 'omit');
    if (list.length === 0) {
      throw new PromptsError({
        code: 'slot-missing',
        file,
        slot: name,
        count: 0,
        detail: `declared slot is never referenced; use {{${name}}} or {{${name}:omit}}`,
      });
    }
    if (uses.length > 0 && omits.length > 0) {
      throw new PromptsError({
        code: 'slot-conflict',
        file,
        slot: name,
        count: list.length,
        locations: list.map((ref) => ref.location),
        detail: 'slot is both used and omitted in the same template',
      });
    }
    if (omits.length > 1) {
      throw new PromptsError({
        code: 'slot-omit-repeated',
        file,
        slot: name,
        count: omits.length,
        locations: omits.map((ref) => ref.location),
        detail: `slot is declared with {{${name}:omit}} more than once`,
      });
    }
    if (uses.length > 1 && !allowRepeatedSlots) {
      throw new PromptsError({
        code: 'slot-repeated',
        file,
        slot: name,
        count: uses.length,
        locations: uses.map((ref) => ref.location),
        detail: `slot is referenced ${uses.length} times; repeat requires "allowRepeatedSlots": true`,
      });
    }
    usage.set(name, { name, uses, omits });
  }
  return usage;
}

/** Substitutes prepared values; inserted text is never re-parsed as a template. */
export function renderTemplate(parsed: ParsedTemplate, values: ReadonlyMap<string, string>): string {
  let output = '';
  for (const segment of parsed.segments) {
    if (segment.kind === 'text') {
      output += segment.text;
      continue;
    }
    const ref = segment.ref;
    if (ref.mode === 'omit') continue;
    const value = values.get(ref.name);
    if (value === undefined) {
      throw new PromptsError({
        code: 'slot-value',
        slot: ref.name,
        locations: [ref.location],
        detail: 'used slot has no prepared value',
      });
    }
    output += value;
  }
  return output;
}
