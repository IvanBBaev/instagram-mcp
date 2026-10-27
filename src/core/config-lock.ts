/**
 * The credential store's writer lock (Layer 0): an `O_EXCL` sibling file at
 * `<store>.lock` holding its owner's pid, host and a nonce, judged stale by the
 * owner's liveness where it can be asked and by age where it cannot
 * (CC-CFG-55/56/58/62). {@link withStoreLock} is the one entry point.
 *
 * Moved unchanged from `core/config-write.ts` on 2026-10-27.
 */
import { open, readFile, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import { storeFailure } from './atomic-write.js';
import { InstagramError } from './types.js';

/** How long a writer waits for another writer's lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
/**
 * A lock older than this is taken to belong to a writer that crashed — but only
 * when its owner cannot be checked directly (see {@link lockIsStale}).
 */
const LOCK_STALE_MS = 30_000;
/** Pause between attempts to take a held lock. */
const LOCK_RETRY_MS = 20;
/**
 * What this process writes into a lock it takes: its pid and host, so a waiter
 * can ask whether the owner is still running instead of guessing from the age,
 * then a nonce that makes each lock's record its own (CC-CFG-62): a writer
 * removes a lock only while the record there is still the one it took, or the
 * one it judged stale — never a lock another writer has taken since.
 */
function newLockRecord(): string {
  return `${process.pid}@${hostname()}@${randomBytes(16).toString('hex')}\n`;
}
/**
 * The locks this process holds right now, each with the record it wrote. A
 * record naming this very process is alive only while it is the one held here:
 * one it failed to release (CC-CFG-56), or one left by a crashed predecessor
 * that ran under the same pid (a container's pid 1 after a restart), would
 * otherwise look held until this process exits.
 */
const heldLocks = new Map<string, string>();

/**
 * The record at `lockPath`, or `''` when there is none to read: gone, a
 * directory or a dangling link at the name. Every judgement and every removal
 * reads through here, so "unreadable" compares equal to itself (CC-CFG-55's
 * directory is still judged, and still fails its removal loudly).
 */
async function readLockRecord(lockPath: string): Promise<string> {
  return readFile(lockPath, 'utf8').catch(() => '');
}

/**
 * Remove the lock at `lockPath` only if it still holds `expected`. POSIX has no
 * compare-and-unlink, so a record that changes between this read and the
 * unlink is still removed — a window of one syscall, where the unconditional
 * `rm` this replaced was open for as long as the lock existed (CC-CFG-62).
 * Errors from the unlink propagate; the caller decides whether they matter.
 */
async function removeLockIf(lockPath: string, expected: string): Promise<void> {
  if ((await readLockRecord(lockPath)) !== expected) return;
  await rm(lockPath, { force: true });
}

/**
 * Give back a lock this process took. It is forgotten first, whatever happens
 * next (CC-CFG-58), and removed best-effort (CC-CFG-56) — and only while it is
 * still ours: a lock cleared under this writer and taken by another is that
 * writer's to release (CC-CFG-62). That includes a lock with no record yet,
 * which is another writer caught between its create and its write; whatever
 * else sits at the name (a directory, a dangling link) is left for the next
 * writer to judge, as a lock whose release failed always was.
 */
async function releaseLock(lockPath: string, record: string): Promise<void> {
  heldLocks.delete(lockPath);
  await removeLockIf(lockPath, record).catch(() => undefined);
}

/**
 * Age of the lock at `lockPath` in milliseconds. A lock that cannot be stat'ed —
 * released between our failed create and this call, or a dangling link that
 * nothing will ever remove — is reported as infinitely old, so the caller
 * clears it and tries again at once.
 */
async function lockAge(lockPath: string): Promise<number> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A lock record: `pid@host`, optionally followed by `@` and a 128-bit hex nonce. */
const LOCK_RECORD = /^([1-9]\d{0,8})@(.+?)(?:@[0-9a-f]{32})?\n$/;

/**
 * Whether the process named in a lock record is still running, or `undefined`
 * when the record cannot answer that: empty (a lock from a writer that predates
 * the record, or one caught between its create and its write), unreadable (a
 * directory or a dangling link at the name), malformed, or naming another host,
 * whose pids mean nothing here. Pid 0 and negative pids are never parsed: to
 * `kill` they address a process GROUP, not the owner.
 *
 * Signal 0 checks existence without delivering anything. Only `ESRCH` means the
 * owner is gone; `EPERM` is a live process owned by another user, and any other
 * failure is taken as alive too, so a doubt leaves the lock in place.
 *
 * Both record shapes parse: `pid@host` from a build before CC-CFG-62 and
 * `pid@host@nonce` from this one. The nonce is matched as exactly 32 hex digits
 * so a host name is never cut short at an `@` of its own.
 */
function lockOwnerAlive(lockPath: string, record: string): boolean | undefined {
  const owner = LOCK_RECORD.exec(record);
  if (owner?.[2] !== hostname()) return undefined;
  const pid = Number(owner[1]);
  if (pid === process.pid) return heldLocks.get(lockPath) === record;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a held lock belongs to a writer that can no longer release it.
 *
 * Corner case (CC-CFG-58): the age alone used to decide, so a LIVE writer
 * slower than {@link LOCK_STALE_MS} — a hung `fsync` on a network home, a
 * debugger pause, a laptop lid closed mid-login — had its lock cleared under it.
 * The next writer then read the store before the slow one renamed its copy in,
 * and whichever renamed last discarded the other profile's fresh token. A lock
 * whose owner is recorded on this host is now judged by asking the kernel
 * whether that pid still runs, and its age is ignored. A heartbeat (re-touching
 * the lock) was rejected: it stalls in exactly the pauses above, so it would
 * only move the threshold.
 *
 * The age is still the fallback wherever the owner cannot be asked (see
 * {@link lockOwnerAlive}), which keeps crash recovery for a lock written by an
 * older build and for a store shared across machines. Residuals, accepted: a
 * crashed owner's pid reused by an unrelated process keeps the lock "alive", so
 * the next writer times out with a message telling the operator to delete the
 * lock — a wait, never a lost token; two hosts that share a hostname AND a home
 * directory can judge each other's live writer dead; a writer on another host
 * slower than {@link LOCK_STALE_MS} is still cleared by age, as before.
 */
async function lockIsStale(lockPath: string, record: string): Promise<boolean> {
  const alive = lockOwnerAlive(lockPath, record);
  if (alive !== undefined) return !alive;
  return (await lockAge(lockPath)) > LOCK_STALE_MS;
}

/**
 * Take the lock: create it exclusively and record this process as its owner.
 * Returns the record written, or `undefined` when another writer holds the lock.
 */
async function acquireLock(lockPath: string, filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (err) {
    // `EEXIST` is the one failure waiting can cure: another writer holds the
    // lock. Anything else (`ENAMETOOLONG`, `EACCES` on a directory an ACL has
    // closed) will not clear by retrying, so it fails now like any other step.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storeFailure(err, 'write', filePath);
    }
    return undefined;
  }
  const record = newLockRecord();
  try {
    await handle.writeFile(record);
  } catch (err) {
    // A lock without its record would be judged by age alone; rather than hold
    // one, give it back (best-effort) and fail like any other write step.
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw storeFailure(err, 'write', filePath);
  }
  await handle.close();
  heldLocks.set(lockPath, record);
  return record;
}

/**
 * Run `critical` while holding an exclusive lock on the store.
 *
 * `writeCredentials` is a read-modify-write of ONE file shared by every profile.
 * The rename makes each write atomic, but not the sequence: two writers — a
 * `login` for one profile and a `refresh` for another, two server windows
 * refreshing at once (CC-AUTH-14), or two calls in one process — each read the
 * same old text, each merge in their own keys, and the second rename discards
 * the first writer's credentials without a word. The lock is a sibling file
 * created with `O_EXCL` (`wx`), which is atomic on every local filesystem, at
 * 0600 like everything else in the directory, holding its owner's pid and host.
 * A holder that crashed leaves it behind, so one {@link lockIsStale} judges
 * abandoned is cleared; otherwise a writer that waits past `timeoutMs` stops
 * with an error naming the lock file, rather than writing without it.
 *
 * Corner case (CC-CFG-62): every removal used to be an unconditional `rm` of
 * the NAME. Two waiters that judged the same stale lock could both clear it, the
 * later `rm` taking the earlier one's fresh lock with it; and a writer whose own
 * lock had been cleared under it (judged by age from another host, or by that
 * race) released by `rm` too, deleting whichever writer's lock sat there by then
 * and letting a third writer in beside it. Each lock now carries a nonce, and a
 * lock is removed only while its record is still the one judged stale, or the
 * one this writer took. Residual, accepted: POSIX has no compare-and-unlink, so
 * a lock replaced between that read and the unlink is still removed — one
 * syscall wide, and only after a writer has crashed or been judged so. A build
 * from before the nonce parses no owner from a new record and judges it by age
 * alone, as it judges a lock from another host.
 */
export async function withStoreLock(
  filePath: string,
  timeoutMs: number,
  critical: () => Promise<void>,
): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let held: string | undefined;
  while ((held = await acquireLock(lockPath, filePath)) === undefined) {
    if (Date.now() >= deadline) {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: its lock ${lockPath} is held by ` +
          `another writer and was not released within ${timeoutMs} ms; retry once any ` +
          'other login or refresh has finished, or delete the lock file if none is running',
        { kind: 'validation' },
      );
    }
    const record = await readLockRecord(lockPath);
    if (await lockIsStale(lockPath, record)) {
      // A stale lock that cannot be cleared (a directory now sits at the name, or
      // the store directory refuses the unlink) will not clear by waiting either,
      // and its raw `node:fs` error must not escape unwrapped (CC-CFG-55).
      try {
        await removeLockIf(lockPath, record);
      } catch (err) {
        throw storeFailure(err, 'write', filePath);
      }
    }
    await sleep(LOCK_RETRY_MS);
  }
  try {
    await critical();
  } catch (err) {
    // Released best-effort on this path: whatever made the write fail (a
    // directory that turned unwritable, say) can make the release fail too, and
    // its raw error must not replace the one that says why the write failed.
    await releaseLock(lockPath, held);
    throw err;
  }
  // Best-effort on the success path too (CC-CFG-56). The store has already been
  // replaced, so a failed release must not report a completed save as a failure
  // — the caller would retry a `login` whose token is already on disk. A lock left
  // behind costs at most one wait: the next writer clears it once its owner has
  // exited, or fails naming it if even that is impossible.
  await releaseLock(lockPath, held);
}
