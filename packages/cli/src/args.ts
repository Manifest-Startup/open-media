/**
 * A small, strict argv parser shared by the built-in commands and the generated tool commands.
 * Flags are declared up front, so a typo is a usage error (exit 2) rather than a silent no-op.
 */

export class UsageError extends Error {}

export interface FlagSpec {
  /** The long name without dashes, e.g. "base-url". */
  name: string;
  /** Takes a value (`--name value` or `--name=value`); otherwise it is a switch. */
  value: boolean;
  /** May be given more than once; values collect into an array. */
  repeat?: boolean;
  /** One-letter alias, e.g. "h". */
  short?: string;
}

export type FlagValue = string | boolean | string[];

export interface Parsed { flags: Record<string, FlagValue>; positional: string[] }

/**
 * Parses argv against the given flags. `--name=value`, `--name value`, `--no-name` (switches),
 * `-x` aliases and `--` (everything after it is positional) are understood.
 */
export function parseArgs(argv: string[], specs: FlagSpec[], options: { allowUnknown?: boolean } = {}): Parsed {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byShort = new Map(specs.filter((spec) => spec.short).map((spec) => [spec.short!, spec]));
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];
  const set = (spec: FlagSpec, value: string | boolean) => {
    if (spec.repeat && typeof value === 'string') flags[spec.name] = [...((flags[spec.name] as string[] | undefined) ?? []), value];
    else flags[spec.name] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (/^-[a-zA-Z]$/.test(arg)) {
      const spec = byShort.get(arg.slice(1));
      if (!spec) { if (options.allowUnknown) { positional.push(arg); continue; } throw new UsageError(`Unknown option ${arg}.`); }
      if (spec.value) { if (index + 1 >= argv.length) throw new UsageError(`${arg} needs a value.`); set(spec, argv[++index]); }
      else set(spec, true);
      continue;
    }
    if (!arg.startsWith('--') || arg === '--') { positional.push(arg); continue; }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    let spec = byName.get(name);
    if (!spec && name.startsWith('no-') && inline === undefined) {
      const negated = byName.get(name.slice(3));
      if (negated && !negated.value) { flags[negated.name] = false; continue; }
    }
    if (!spec) {
      if (options.allowUnknown) { positional.push(arg); continue; }
      throw new UsageError(`Unknown option --${name}.`);
    }
    if (spec.value) {
      if (inline !== undefined) set(spec, inline);
      else if (index + 1 < argv.length) set(spec, argv[++index]);
      else throw new UsageError(`--${name} needs a value.`);
    } else if (inline === undefined) set(spec, true);
    else if (/^(true|yes|1)$/i.test(inline)) set(spec, true);
    else if (/^(false|no|0)$/i.test(inline)) set(spec, false);
    else throw new UsageError(`--${name} is a switch: use --${name} or --no-${name}.`);
  }
  return { flags, positional };
}

/** The flags every command understands. */
export const globalFlags: FlagSpec[] = [
  { name: 'json', value: false },
  { name: 'base-url', value: true },
  { name: 'help', value: false, short: 'h' },
  { name: 'yes', value: false, short: 'y' },
  { name: 'refresh-tools', value: false },
];
