/**
 * Turns an MCP tool's JSON `inputSchema` into command-line flags, and the flags back into the
 * tool's arguments. Nothing here knows about any particular tool, so new tools on the server get
 * flags without a CLI release.
 *
 * - string, number, integer, enum: `--name value` (enums and numbers are checked here)
 * - boolean: `--name` / `--no-name` / `--name=false`
 * - array of scalars: repeat the flag, or separate with commas (long free text is never split)
 * - object, array of objects, unions: a JSON value, `@file` or `-` (stdin)
 * - `--input <json|@file|->`: the whole arguments object; flags given alongside override it
 * - required scalar fields may also be given positionally, in schema order
 */
import { readFileSync } from 'node:fs';

import { FlagSpec, parseArgs, UsageError } from './args';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  additionalProperties?: unknown;
}

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  /** Which server lists it: the public one, or only the signed-in account server. */
  server?: 'open' | 'account';
}

export type FlagKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'json';

export interface ToolFlag {
  flag: string;
  property: string;
  kind: FlagKind;
  required: boolean;
  nullable: boolean;
  description?: string;
  enumValues?: string[];
  /** For arrays: what each item is. */
  item?: { kind: Exclude<FlagKind, 'array'>; enumValues?: string[]; splitCommas: boolean };
  /** For json: a plain string is also acceptable. */
  allowsString?: boolean;
  schema: JsonSchema;
}

/** camelCase, snake_case and spaces to kebab-case: linkedInPdf → linked-in-pdf, set_up_profile → set-up-profile. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function typesOf(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (schema.type) return [schema.type];
  if (schema.enum) return ['enum'];
  return [];
}

function scalarKind(schema: JsonSchema): Exclude<FlagKind, 'array'> {
  if (schema.enum && schema.enum.every((value) => typeof value === 'string')) return 'enum';
  const [type] = typesOf(schema).filter((item) => item !== 'null');
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return type;
  return 'json';
}

function describeFlag(property: string, schema: JsonSchema, required: boolean): ToolFlag {
  const base = { flag: kebab(property), property, required, description: schema.description, schema };
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const nonNull = options.filter((option) => !typesOf(option).includes('null') || typesOf(option).length > 1);
    const nullable = nonNull.length < options.length;
    if (nonNull.length === 1) return { ...describeFlag(property, { description: schema.description, ...nonNull[0] }, required), nullable };
    return { ...base, kind: 'json', nullable, allowsString: nonNull.some((option) => typesOf(option).includes('string')) };
  }
  const types = typesOf(schema);
  const nullable = types.includes('null');
  if (types.includes('array') && schema.items) {
    const kind = scalarKind(schema.items);
    // Long free text (e.g. a paragraph to translate) can contain commas, so it is never split.
    const splitCommas = kind !== 'json' && !(kind === 'string' && (schema.items.maxLength === undefined ? false : schema.items.maxLength > 200));
    return { ...base, kind: 'array', nullable, item: { kind, enumValues: kind === 'enum' ? schema.items.enum!.map(String) : undefined, splitCommas } };
  }
  const kind = scalarKind(schema);
  return { ...base, kind, nullable, enumValues: kind === 'enum' ? schema.enum!.map(String) : undefined, allowsString: kind === 'json' && types.length === 0 };
}

/** The flags for a tool, in the schema's own order. */
export function flagsFor(schema: JsonSchema | undefined): ToolFlag[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([property, value]) => describeFlag(property, value ?? {}, required.has(property)));
}

/** Reads `@path` as a file and `-` as stdin; anything else is the value itself. */
export function readValue(raw: string, stdin: () => string = () => readFileSync(0, 'utf8')): string {
  if (raw === '-') return stdin();
  if (raw.startsWith('@') && raw.length > 1) {
    try { return readFileSync(raw.slice(1), 'utf8'); } catch { throw new UsageError(`Can’t read ${raw.slice(1)}.`); }
  }
  return raw;
}

function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw); } catch { throw new UsageError(`${label} must be JSON (or @file, or - for stdin).`); }
}

function convertScalar(kind: Exclude<FlagKind, 'array'>, raw: string, label: string, flag: Pick<ToolFlag, 'enumValues' | 'allowsString' | 'schema'>, stdin: () => string): unknown {
  switch (kind) {
    case 'string': return raw;
    case 'integer': case 'number': {
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value) || (kind === 'integer' && !Number.isInteger(value))) throw new UsageError(`${label} must be ${kind === 'integer' ? 'a whole number' : 'a number'}.`);
      return value;
    }
    case 'boolean': {
      if (/^(true|yes|1)$/i.test(raw)) return true;
      if (/^(false|no|0)$/i.test(raw)) return false;
      throw new UsageError(`${label} is true or false.`);
    }
    case 'enum': {
      if (!flag.enumValues!.includes(raw)) throw new UsageError(`${label} must be one of: ${flag.enumValues!.join(', ')}.`);
      return raw;
    }
    case 'json': {
      const text = readValue(raw, stdin);
      try { return JSON.parse(text); } catch {
        if (flag.allowsString) return raw;
        throw new UsageError(`${label} must be JSON (or @file, or - for stdin).`);
      }
    }
  }
}

function convert(flag: ToolFlag, values: string[], stdin: () => string): unknown {
  const label = `--${flag.flag}`;
  if (flag.nullable && values.length === 1 && values[0] === 'null') return null;
  if (flag.kind === 'array') {
    const item = flag.item!;
    const out: unknown[] = [];
    for (const raw of values) {
      if (raw.trim().startsWith('[')) {
        const parsed = parseJson(raw, label);
        if (Array.isArray(parsed)) { out.push(...parsed); continue; }
      }
      if (item.kind === 'json') {
        const parsed = parseJson(readValue(raw, stdin), label);
        if (Array.isArray(parsed)) out.push(...parsed); else out.push(parsed);
        continue;
      }
      const parts = item.splitCommas ? raw.split(/(?<!\\),/).map((part) => part.replace(/\\,/g, ',').trim()).filter(Boolean) : [raw];
      for (const part of parts) out.push(convertScalar(item.kind, part, label, { enumValues: item.enumValues, schema: flag.schema.items ?? {} }, stdin));
    }
    return out;
  }
  if (values.length > 1) throw new UsageError(`${label} was given more than once.`);
  return convertScalar(flag.kind, values[0], label, flag, stdin);
}

/** Flag specs for the parser: booleans are switches, arrays repeat, everything else takes a value. */
export function specsFor(flags: ToolFlag[]): FlagSpec[] {
  return flags.map((flag) => ({ name: flag.flag, value: flag.kind !== 'boolean', repeat: flag.kind !== 'boolean' }));
}

/**
 * Builds a tool's arguments from argv (with the global flags already removed). Positionals fill
 * the required scalar fields in order; extra words join into the last text field, so
 * `open-media publish-post Hello there` works.
 */
export function buildArguments(tool: Tool, argv: string[], options: { stdin?: () => string } = {}): Record<string, unknown> {
  const stdin = options.stdin ?? (() => readFileSync(0, 'utf8'));
  const flags = flagsFor(tool.inputSchema);
  const specs = [...specsFor(flags), { name: 'input', value: true }];
  const parsed = parseArgs(argv, specs);
  let args: Record<string, unknown> = {};
  if (typeof parsed.flags.input === 'string') {
    const base = parseJson(readValue(parsed.flags.input, stdin), '--input');
    if (!base || typeof base !== 'object' || Array.isArray(base)) throw new UsageError('--input must be a JSON object of the tool’s arguments.');
    args = { ...(base as Record<string, unknown>) };
  }
  for (const flag of flags) {
    const value = parsed.flags[flag.flag];
    if (value === undefined) continue;
    if (typeof value === 'boolean') { args[flag.property] = value; continue; }
    args[flag.property] = convert(flag, Array.isArray(value) ? value : [value], stdin);
  }
  const slots = flags.filter((flag) => flag.required && args[flag.property] === undefined && ['string', 'number', 'integer', 'enum'].includes(flag.kind));
  const words = [...parsed.positional];
  if (words.length && !slots.length) throw new UsageError(`Unexpected argument “${words[0]}”. Run open-media ${kebab(tool.name)} --help.`);
  slots.forEach((slot, index) => {
    if (!words.length) return;
    const last = index === slots.length - 1;
    const raw = last && slot.kind === 'string' ? words.splice(0).join(' ') : words.shift()!;
    args[slot.property] = convertScalar(slot.kind as Exclude<FlagKind, 'array'>, raw, `--${slot.flag}`, slot, stdin);
  });
  if (words.length) throw new UsageError(`Unexpected argument “${words[0]}”. Run open-media ${kebab(tool.name)} --help.`);
  const missing = flags.filter((flag) => flag.required && args[flag.property] === undefined);
  if (missing.length) throw new UsageError(`${kebab(tool.name)} needs ${missing.map((flag) => `--${flag.flag}`).join(', ')}. Run open-media ${kebab(tool.name)} --help.`);
  return args;
}

/** Publishing, sending, paying and deleting ask first; reads and quiet settings changes don't. */
export function needsConfirmation(tool: Tool): boolean {
  if (tool.annotations?.readOnlyHint) return false;
  if (tool.annotations?.destructiveHint) return true;
  return /^(publish|send|comment|reshare|delete|remove|disconnect|block|report|start_payment|submit_payment|start_payout)(_|$)/.test(tool.name);
}

function flagUsage(flag: ToolFlag): string {
  const value = flag.kind === 'boolean' ? ''
    : flag.kind === 'enum' ? ` <${flag.enumValues!.join('|')}>`
    : flag.kind === 'array' ? (flag.item!.kind === 'enum' ? ` <${flag.item!.enumValues!.join('|')}>…` : flag.item!.kind === 'json' ? ' <json>…' : ` <${flag.item!.kind}>…`)
    : flag.kind === 'json' ? ' <json>'
    : ` <${flag.kind}>`;
  return `--${flag.flag}${value}`;
}

/** `open-media <tool> --help`: the description and every flag, straight from the schema. */
export function toolHelp(tool: Tool, command: string): string {
  const flags = flagsFor(tool.inputSchema);
  const positional = flags.filter((flag) => flag.required && ['string', 'number', 'integer', 'enum'].includes(flag.kind)).map((flag) => `<${flag.flag}>`);
  const lines = [`open-media ${command}${positional.length ? ` ${positional.join(' ')}` : ''}${flags.length ? ' [options]' : ''}`, ''];
  if (tool.title) lines.push(tool.title);
  if (tool.description) lines.push(tool.description);
  const notes = [
    tool.annotations?.readOnlyHint ? 'Reads only.' : 'Changes your account.',
    needsConfirmation(tool) ? 'Asks before running (pass --yes to skip).' : '',
    tool.server === 'account' ? 'Needs you signed in (open-media login).' : '',
  ].filter(Boolean);
  lines.push('', notes.join(' '), `MCP tool: ${tool.name}`);
  if (flags.length) {
    lines.push('', 'Options');
    const width = Math.min(34, Math.max(...flags.map((flag) => flagUsage(flag).length)) + 2);
    for (const flag of flags) {
      const usage = flagUsage(flag);
      const facts = [flag.required ? 'required' : '', flag.kind === 'array' ? 'repeatable' : '', flag.nullable ? '“null” clears it' : '', flag.schema.default !== undefined ? `default ${JSON.stringify(flag.schema.default)}` : '']
        .filter(Boolean).join(', ');
      const text = [flag.description, facts ? `(${facts})` : ''].filter(Boolean).join(' ');
      lines.push(usage.length + 2 > width && text ? `  ${usage}\n  ${''.padEnd(width)}${text}` : `  ${usage.padEnd(width)}${text}`.trimEnd());
    }
  }
  lines.push('', 'Also', '  --input <json|@file|->  All arguments as one JSON object (flags override it)', '  --json                  Print the raw result', '  --yes                   Don’t ask before publishing, sending, paying or deleting');
  return lines.join('\n');
}
