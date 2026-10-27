/**
 * Atomic, durable I/O on the credential store (Layer 0): read the current text
 * (a missing store reads as empty), prepare the 0700 store directory, and
 * replace the file through a 0600 temp sibling that is `fsync`ed, renamed into
 * place and followed by a directory `fsync`. Every `node:fs` failure on the
 * store leaves here wrapped by {@link storeFailure} (CC-CFG-12).
 *
 * Which file is replaced — the name itself or the target of a symlink there — is
 * `core/store-link.ts`; the lock around the read-modify-write is
 * `core/config-lock.ts`. Moved unchanged from `core/config-write.ts` on
 * 2026-10-27.
 */
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { InstagramError } from './types.js';

/**
 * The remedy each side of the store names when `node:fs` refuses it. A lookup
 * rather than a conditional so that {@link storeFailure} has no branch of its
 * own: the two verbs are reached by different tests, and each message is pinned
 * whole.
 */
const STORE_REMEDY = {
  read: 'check the permissions on the file and its directory',
  write: 'check free space and the permissions on its directory',
} as const;

/**
 * Wrap a `node:fs` failure from the credential store in the one error shape the
 * rest of the server speaks (CC-CFG-12, the "error surface" half).
 *
 * Before this, a failing `mkdir`/`chmod`/`writeFile`/`rename` — and any read
 * failure other than "not there yet" — escaped
 * {@link import('./config-write.js').writeCredentials} as the raw `node:fs` error: an `Error` whose message is `ENOSPC: no space left on
 * device, open '/…/.env.3f9a2c.tmp'`, naming a temp sibling the operator has
 * never heard of and no remedy. Everything that reaches the `login` CLI or the
 * MCP boundary is otherwise an `InstagramError` with a `kind`, so this was the
 * one path on which the operator met Node's wording instead of ours.
 *
 * The message names the file the operator knows about (the store, never the temp
 * sibling), the `code` — the only part of the raw error worth carrying, since
 * `ENOSPC` vs `EACCES` is the diagnosis — and the remedy for that side. The raw
 * error rides along as `cause`, so nothing is lost for a log that wants the
 * syscall and the temp path. `kind: 'validation'` is the kind this repo already
 * gives a local-environment failure with a raw error as `cause` (the OAuth
 * redirect listener in `cli/login.ts`): nothing upstream was involved, it is
 * not retryable (`core/http.ts` retries only `rate_limit`/`upstream`), and it
 * is the operator, not the model, who can act on it.
 *
 * `code` is interpolated as-is: every `node:fs/promises` rejection carries one,
 * and a `?? 'unknown'` fallback would be a branch no test can take.
 */
export function storeFailure(
  err: unknown,
  verb: keyof typeof STORE_REMEDY,
  filePath: string,
): InstagramError {
  const { code } = err as NodeJS.ErrnoException;
  return new InstagramError(
    `Cannot ${verb} the credential store at ${filePath} (${code}): ${STORE_REMEDY[verb]}`,
    { kind: 'validation', cause: err },
  );
}

/**
 * Read the current file text, treating a missing file as empty.
 *
 * Only `ENOENT` means "there is no store yet". Any other failure (`EISDIR`,
 * `ENOTDIR`, `EACCES`, `ELOOP`, …) means the file may exist and cannot be seen,
 * and continuing would replace an unread store — so it is wrapped and rethrown,
 * never treated as empty.
 */
export async function readExisting(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw storeFailure(err, 'read', filePath);
  }
}

/** Create the store directory at 0700, tightening one that already exists. */
export async function prepareStoreDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  // One wrapper around each half of the sequence (CC-CFG-12): whichever fs call
  // fails, the operator is told about the store, not about the step. The temp
  // sibling is cleaned up by `replaceFile` (CC-CFG-48) and flushed before its
  // rename (CC-CFG-54); a symlinked store is written through the link
  // (`followStoreLink`, CC-CFG-68).
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Corner case: the directory is already there at a looser mode. `mkdir`
    // applies `mode` only to directories it CREATES, so a store that predates
    // this rule — or one an operator recreated by hand, `chmod -R`'d, or restored
    // from an archive that dropped modes — keeps whatever it had. 0600 on the
    // file does not cover that: write permission on the DIRECTORY is what lets
    // another local account rename our `.env` away and leave its own behind, and
    // the next `login` then writes a fresh token into a file somebody else
    // controls. Unconditional rather than stat-then-chmod — the wanted mode is a
    // constant, so the check would only add a race with the same outcome. If the
    // directory belongs to another user this now fails loudly instead of quietly
    // filling a store we cannot secure.
    if (process.platform !== 'win32') await chmod(dir, 0o700);
  } catch (err) {
    throw storeFailure(err, 'write', filePath);
  }
}

/**
 * Write `content` atomically and durably: temp sibling (created 0600, `fsync`ed)
 * → `chmod 0600` (POSIX) → `rename` → directory `fsync` (POSIX, best-effort).
 * The mode is set on the temp file before the rename so the final file is never
 * momentarily world-readable; on Windows chmod is skipped (CC-CFG-8).
 *
 * Equivalence note, corrected on 2026-09-23: the mode is narrowed three times —
 * the `open` create mode, the chmod on the temp file, and the chmod after
 * the rename — and this note used to bless dropping any ONE of them as
 * unobservable. Measured: only the LAST one is. Dropping the create mode is
 * killed by "no file in the store is group- or world-accessible, not even
 * mid-write", which samples the directory every event-loop turn and catches the
 * temp while it still carries the umask-widened create mode; dropping the chmod
 * on the temp is killed by "the temp file is brought to 0600 whatever the
 * ambient umask". Only the post-rename chmod survives alone — `rename` carries
 * the temp's mode over, so by the time it runs the file is already 0600 — and it
 * stays as the belt to those braces. See the longer note in
 * test/core/config-write.test.ts.
 *
 * Dropping `encoding: 'utf8'` is unobservable for the same reason no test asserts
 * it: `writeFile` already defaults to utf8 for string content. It is written out
 * so the encoding is a property of this call rather than of a Node default.
 */
export async function replaceFile(filePath: string, content: string): Promise<void> {
  const posix = process.platform !== 'win32';
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // `wx`: the random name is ours alone, so an entry already there is refused
    // rather than followed — a planted symlink never receives the credentials.
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      // Flushed BEFORE the rename (CC-CFG-54). Without it a power loss shortly
      // after the rename can leave the new name pointing at a file whose data
      // never reached the disk — a zero-length `.env` that has lost every
      // profile's credentials, not just the one being written. `login` and
      // `refresh` are rare, so the disk barrier costs nothing that matters.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (posix) await chmod(tmp, 0o600);
    await rename(tmp, filePath);
    if (posix) await chmod(filePath, 0o600);
    // The rename itself is durable only once the directory entry is flushed.
    if (posix) await syncDir(path.dirname(filePath));
  } catch (err) {
    // The temp sibling holds the full credential set. Left behind by a failed
    // `chmod` or `rename`, it is a second copy of every secret that no later
    // write replaces or cleans up (each write picks a fresh random name). After
    // a successful rename it no longer exists, so `force` makes this a no-op.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw storeFailure(err, 'write', filePath);
  }
}

/**
 * Flush a directory so a rename inside it survives a power loss. POSIX only —
 * Windows cannot open a directory for `fsync` — and best-effort: it runs after
 * the rename has already replaced the store, so a filesystem that refuses a
 * directory `fsync` (`EINVAL` on some network mounts) must not turn a completed
 * write into a reported failure.
 */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability of the directory entry is a bonus, not a precondition.
  }
}
