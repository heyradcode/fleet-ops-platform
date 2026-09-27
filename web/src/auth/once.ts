/**
 * Run an async job at most once per key; every later caller with the same
 * key gets the SAME promise.
 *
 * For the Cognito callback. The authorization code in the URL is single-use,
 * and the exchange consumes the stored PKCE state before it starts - so a
 * second run of the callback, which React's StrictMode makes on purpose in
 * development, found the state gone and reported "Sign-in could not be
 * verified" over a sign-in that had in fact just succeeded. Anything else
 * that runs the callback twice (a double render, a remount) hit the same.
 */
export function onceBy<T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = run();
    cache.set(key, p);
  }
  return p;
}
