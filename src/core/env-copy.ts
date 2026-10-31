/**
 * The bootstrap's private copy of the client environment (Layer 0).
 *
 * Bootstrap resolves the env files into a copy instead of `process.env`
 * (V3-P2). A plain spread is not a faithful copy on Windows: there
 * `process.env` matches names case-insensitively, so an MCP client config
 * that spells `ig_access_token`, or an env file line that does, used to reach
 * every `IG_ACCESS_TOKEN` read, and dotenv's "already set" test saw a
 * client-passed `IG_ACCESS_TOKEN` when the file spelled it in lower case. The
 * spread object is case-sensitive, so both silently stopped working. On win32
 * the copy keeps those semantics: every name is stored upper-cased, and every
 * read, write, `in` test and delete goes through the same fold. Elsewhere a
 * spread is exact, because the process environment is case-sensitive there too.
 */

/**
 * A copy of `source` that a loader can read and write without touching the
 * process environment, with the same name matching as `process.env` has on
 * `platform`. Two Windows names that differ only in case cannot both exist in a
 * real environment; if a hand-built `source` carries both, the first one wins.
 */
export function copyEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...source };
  const target: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const folded = name.toUpperCase();
    if (!Object.hasOwn(target, folded)) target[folded] = value;
  }
  const fold = (key: string | symbol): string | symbol =>
    typeof key === 'string' ? key.toUpperCase() : key;
  return new Proxy(target, {
    get: (env, key): unknown => Reflect.get(env, fold(key)) as unknown,
    set: (env, key, value) => Reflect.set(env, fold(key), value),
    has: (env, key) => Reflect.has(env, fold(key)),
    deleteProperty: (env, key) => Reflect.deleteProperty(env, fold(key)),
    getOwnPropertyDescriptor: (env, key) => Reflect.getOwnPropertyDescriptor(env, fold(key)),
    defineProperty: (env, key, descriptor) => Reflect.defineProperty(env, fold(key), descriptor),
  });
}
