/**
 * ---------------------------------------------------------------------------
 * Configuration, read portably
 * ---------------------------------------------------------------------------
 * `process` DOES NOT EXIST IN A BROWSER. Not as an empty object, not as
 * undefined - the identifier is unbound, so `process.env.FOO` throws a
 * ReferenceError rather than returning undefined.
 *
 * That matters here more than it usually would, because every one of these
 * reads happens at MODULE SCOPE:
 *
 *     export const mainTable = new DynamoTable(process.env.TABLE_NAME ?? '...');
 *
 * so the failure is not "this feature misbehaves", it is "the bundle throws
 * while evaluating and the page renders nothing". A blank screen with one
 * ReferenceError in the console, pointing at a line that looks completely
 * ordinary.
 *
 * This is the same class of problem as the `node:` imports that live behind
 * `src/platform/` - code that is invisible to the type checker, fine
 * under Node, and fatal in a browser - and it is worth noting that it slipped
 * past the CI check written for exactly that class, because that check looked
 * for imports and this is a bare global. The check now looks for both.
 *
 * In the browser the defaults ARE the configuration: the local stand-ins in
 * `src/aws/` do not talk to anything, so their resource names are labels.
 */

/**
 * Read a configuration value, falling back to the default.
 *
 * `globalThis.process` rather than `process`, deliberately: reading a property
 * of `globalThis` is safe when the property does not exist, whereas naming an
 * unbound identifier is not.
 */
export function env(name: string, fallback: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] ?? fallback;
}

/** True when a variable is set to anything non-empty. For feature flags. */
export function envFlag(name: string): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value !== undefined && value !== '';
}

/** Exact-match check, for a variable with a small set of valid values. */
export function envIs(name: string, expected: string): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] === expected;
}
