/**
 * The override key shapes this strategy reads and writes. compatible and latest have
 * their own, narrower reading in reconcile.ts, which stays as it is: their behaviour
 * must not change because this strategy exists.
 */

/** The package an override key names, whatever follows the version `@`. */
export function overrideKeyName(key: string): string {
  // Wider than selectorKeyName: "foo@<2.0.0" still names foo for a hand-written pin.
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * The package behind a key the agent could own, stripping a selector that starts with a
 * digit or with ">=": "qs@>=6.0.0 <6.7.3" and "qs@6" both give "qs". Any other selector,
 * such as "foo@<2.0.0", stays whole: it is not a shape the agent writes.
 */
export function selectorKeyName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 && /^(\d|>=)/.test(key.slice(at + 1)) ? key.slice(0, at) : key;
}

/**
 * Whether the agent could have written this override, as opposed to a person's pin. Two
 * shapes are the agent's: a spec starting with ">=" (what compatible and latest write),
 * and exactly the key this strategy writes, "name@>=X.Y.Z <A.B.C" with the value "A.B.C".
 * A key like `foo@2: "2.3.1"`, `foo@<2.0.0: "2.0.0"` or a flat `foo: "2.3.1"` is a pin
 * someone chose, and so is a range key whose value isn't its upper bound.
 */
export function isAgentAuthoredOverride(key: string, spec: string): boolean {
  if (spec.startsWith(">=")) return true;
  const at = key.lastIndexOf("@");
  if (at <= 0) return false;
  const m = /^>=\d+\.\d+\.\d+ <(\d+\.\d+\.\d+)$/.exec(key.slice(at + 1));
  return m !== null && m[1] === spec;
}
