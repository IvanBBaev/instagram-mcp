/**
 * Symlink resolution for the credential store (Layer 0): the file a write to the
 * store's name must replace — the name itself, or the end of the link chain
 * there — with every link and every directory on the way owner-checked
 * (CC-CFG-68, CC-CFG-73, CC-CFG-74).
 *
 * Moved unchanged from `core/config-write.ts` on 2026-10-27.
 */
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { storeFailure } from './atomic-write.js';
import { InstagramError } from './types.js';

/**
 * The file a write to `filePath` must replace: `filePath` itself, or — when that
 * name is a symlink — the file the link resolves to.
 *
 * Corner case (CC-CFG-68, the symlink half of CC-CFG-12): the rename used to
 * land on the LINK, turning it into a regular file. A store kept in a dotfiles
 * repository and linked into place silently stopped receiving tokens after the
 * first `login`, while every read (dotenv, {@link import('./atomic-write.js').readExisting}) had always
 * followed the link — so the bytes read and the bytes written were not the same
 * file. Resolving the link first puts the temp sibling, the lock and the rename
 * beside the target: the replacement is still a fresh 0600 inode renamed into
 * place, never an in-place write, and two links to one store now contend for
 * the one lock beside it instead of each taking its own.
 *
 * Every LINK in the chain is judged, and only links are resolved: a symlinked
 * DIRECTORY on the way (macOS's `/var` → `/private/var`) is left out of the
 * reported path. Three refusals keep anyone else from choosing where
 * credentials go:
 *  - a link owned by another user is not followed — the name's own link or any
 *    link after it (CC-CFG-73). Whoever can plant a link at the store's name
 *    would otherwise pick which of our files is rewritten and re-permissioned,
 *    and the owner of a link in the MIDDLE of a chain picks the file just as
 *    surely: `realpath` used to follow every hop after the first one blind. A
 *    chain is walked hop by hop rather than refused outright, because dotfiles
 *    managers (GNU Stow folding, a relinked checkout) do produce chains of the
 *    operator's own links. The config-home directory is 0700, so this bites only
 *    in a directory the operator shares. Where there is no uid (Windows, which
 *    needs a privilege to create a link at all) the check is skipped.
 *  - a DIRECTORY on the way — every component of the store's directory and of
 *    each hop's, a directory link and the directory it leads to alike — owned
 *    by neither this user nor root is refused (CC-CFG-74). Its owner can
 *    rename or re-point what lies beneath it at will, so it chooses the file as
 *    surely as the owner of a store link; the kernel follows it on every open
 *    and used to be the only one that looked. Root is accepted because every
 *    path starts in root's directories (`/`, `/private`, the `/var` link, `/tmp`)
 *    and root can rewrite any file anyway. Store links themselves stay strictly
 *    the operator's own: a root-owned link at the store's name is still refused.
 *    Residual, accepted: a directory owned by this user or by root is not judged
 *    by its mode, so a group-writable one of the operator's own, or sticky `/tmp`
 *    (where others can create but not replace entries), is walked through.
 *  - a dangling link, at any hop, is refused rather than creating a store at
 *    whatever path it happens to name.
 * A chain longer than {@link MAX_LINK_HOPS} is reported as `ELOOP`, the code the
 * kernel gives a link loop. The target's directory is the operator's, like
 * `IG_ENV_FILE`'s: it is neither created nor re-permissioned.
 *
 * Resolved before the lock (to fail fast and to know WHICH lock to take) and
 * again under it (CC-CFG-72): see
 * {@link import('./config-write.js').writeCredentials}. A store directory
 * the write is about to create is judged only by the second pass, once it
 * exists.
 */
export async function followStoreLink(filePath: string): Promise<string> {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch {
    // Nothing at the name yet (or nothing that can be seen): the read below
    // tells a missing store from an unreadable one.
    entry = undefined;
  }
  if (entry === undefined || !entry.isSymbolicLink()) {
    await judgeStoreDirectory(filePath);
    return filePath;
  }
  try {
    return await resolveLinkChain(filePath, entry);
  } catch (err) {
    if (err instanceof InstagramError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: it is a symbolic link whose ` +
          'target does not exist; create the target file, or replace the link with a ' +
          'regular file',
        { kind: 'validation' },
      );
    }
    throw storeFailure(err, 'read', filePath);
  }
}

/**
 * Owner-check every directory on the way to a store that is not a link
 * (CC-CFG-74). Only the refusal is raised: a directory that cannot be walked
 * yet — the config home before its first write creates it — is left to the
 * read, the `mkdir` and the second pass under the lock, which report it better.
 */
async function judgeStoreDirectory(filePath: string): Promise<void> {
  try {
    await realDirectory(path.dirname(filePath), filePath);
  } catch (err) {
    if (err instanceof InstagramError) throw err;
  }
}

/** Links followed before a chain is reported as a loop — Linux's own limit. */
const MAX_LINK_HOPS = 40;

/**
 * The physical path of the absolute directory `dir`, walked one component at a time the way
 * the kernel walks it: a directory link is replaced by its target (relative to
 * the directory holding it) and a `..` is taken from wherever the walk has
 * physically arrived — never cancelled against the name before it. Every
 * component, links and their targets alike, must be owned by this user or by
 * root (CC-CFG-74); where there is no uid (Windows) nothing is judged and
 * `realpath` answers.
 *
 * @throws {InstagramError} for a component owned by another user; the raw fs
 *   error (`ENOENT`, `ENOTDIR`, `ELOOP` past {@link MAX_LINK_HOPS}) otherwise.
 */
async function realDirectory(dir: string, filePath: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) return realpath(dir);
  // Split as given: `path.resolve` would cancel a `..` as text. Every store path
  // is absolute by now (`StoreTarget.filePath`).
  const pending = dir.split('/');
  let resolved = '/';
  let hops = 0;
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    // `resolved` is physical, so joining `..` onto it climbs the real tree.
    const component = path.join(resolved, name);
    const entry = await lstat(component);
    if (entry.uid !== uid && entry.uid !== 0) {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: the path component ${component} ` +
          'on the way to it is owned by another user, so the store is not written through ' +
          'it; keep the store under directories owned by you or by root',
        { kind: 'validation' },
      );
    }
    if (!entry.isSymbolicLink()) {
      resolved = component;
      continue;
    }
    if (hops === MAX_LINK_HOPS) {
      throw Object.assign(new Error(`too many levels of symbolic links at ${filePath}`), {
        code: 'ELOOP',
      });
    }
    hops += 1;
    const target = await readlink(component);
    pending.unshift(...target.split('/'));
    if (path.isAbsolute(target)) resolved = '/';
  }
  return resolved;
}

/**
 * Walk the link chain that starts at `filePath` (whose `lstat` is `entry`), one
 * hop at a time, refusing a hop owned by another user; the real path of the file
 * it ends at. Each relative target is resolved against the real directory of the
 * link holding it, as the kernel resolves it: a `..` in a target is climbed
 * physically by {@link realDirectory}, never cancelled against the name before
 * it, and every directory on the way is owner-checked there (CC-CFG-74).
 *
 * @throws {InstagramError} for a link or a directory owned by another user; the
 *   raw fs error (`ENOENT` for a dangling hop, `ELOOP` past {@link MAX_LINK_HOPS})
 *   otherwise.
 */
async function resolveLinkChain(
  filePath: string,
  entry: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  const uid = process.getuid?.();
  let current = filePath;
  let hops = 0;
  while (entry.isSymbolicLink()) {
    if (hops === MAX_LINK_HOPS) {
      throw Object.assign(new Error(`too many levels of symbolic links at ${filePath}`), {
        code: 'ELOOP',
      });
    }
    hops += 1;
    if (uid !== undefined && entry.uid !== uid) {
      throw new InstagramError(
        current === filePath
          ? `Cannot write the credential store at ${filePath}: it is a symbolic link owned ` +
              'by another user, so it is not followed; replace it with a regular file or a ' +
              'link of your own'
          : `Cannot write the credential store at ${filePath}: the symbolic link ${current} ` +
              'on the way to it is owned by another user, so it is not followed; replace it ' +
              'with a regular file or a link of your own',
        { kind: 'validation' },
      );
    }
    const target = await readlink(current);
    const holder = await realDirectory(path.dirname(current), filePath);
    // Joined, not resolved: `path.resolve` would cancel a `..` against the name
    // before it, which the kernel does not do when that name is a link.
    current = path.isAbsolute(target) ? target : `${holder}/${target}`;
    entry = await lstat(current);
  }
  return path.join(await realDirectory(path.dirname(current), filePath), path.basename(current));
}
