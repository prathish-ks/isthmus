/**
 * Per-checkout install identifiers. Lets two NanoClaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `nanoclaw-agent:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/**
 * Short, install-scoped directory for Unix domain sockets (the kernel
 * socket, `ncl.sock`). Deliberately NOT under the project's own `data/` —
 * a Unix socket path is capped at 104 bytes on macOS/BSD (108 on Linux;
 * see go-host/internal/kernel/server.go's maxSocketPathLen), and a
 * project checkout can live arbitrarily deep (corporate directory
 * policies, cloud-sync folders, long usernames, WSL2 under
 * /mnt/c/Users/...). Keying off DATA_DIR made the socket's viability a
 * function of where the user happened to clone the repo — this doesn't.
 *
 * Prefers XDG_RUNTIME_DIR (Linux: already user-scoped, mode 0700, tmpfs,
 * cleared on logout — the semantically correct place for this) and falls
 * back to os.tmpdir() (macOS: Apple's per-user confined temp dir; Linux
 * without XDG_RUNTIME_DIR: /tmp). Either base is short enough on its own
 * that a slug-keyed subdirectory plus a short filename never approaches
 * the limit, regardless of install path depth.
 *
 * Deliberately pure — no filesystem access. config.ts computes
 * KERNEL_SOCKET_PATH (and socket-client.ts DEFAULT_SOCKET_PATH) from this
 * at module-load time, so this must stay side-effect-free the same way
 * the DATA_DIR-relative path it replaced was: importing a config module
 * should never itself create a directory on disk. Call
 * ensureRuntimeSocketDir before actually binding a socket here.
 */
export function getRuntimeSocketDir(projectRoot?: string): string {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  // False positive: projectRoot never reaches path.join raw — getInstallSlug
  // hashes it first (sha1, hex, sliced to 8 chars), a fixed-charset,
  // fixed-length output that cannot contain '/' or '..' regardless of
  // projectRoot's value. Same disposition as this project's other
  // path-join-resolve-traversal false positives (see .github/workflows/
  // ci.yml's semgrep-scope comment) — a hash-sanitized value, not raw input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.join(base, `nanoclaw-${getInstallSlug(projectRoot)}`);
}

/**
 * Creates getRuntimeSocketDir's directory, verifying — not assuming — that
 * it's actually private to this user before anything binds a socket
 * underneath it. This directory now lives under a shared base
 * (XDG_RUNTIME_DIR or, on its fallback path, plain os.tmpdir()/`/tmp` —
 * world-writable on Linux without a systemd user session) rather than
 * inside the project's own checkout, and its name is fully deterministic
 * (`nanoclaw-${sha1(projectRoot).slice(0,8)}`, no secret in it) — so unlike
 * before this relocation, another local user can predict and pre-create
 * this exact path. Two things a naive mkdir+chmod misses against that:
 *
 *   1. TOCTOU: `mkdirSync(dir, {recursive:true})` treats "already exists"
 *      as success regardless of who created it or whether it's a symlink,
 *      and `chmodSync` follows symlinks (no lchmod semantics in Node) — so
 *      an attacker who pre-plants a symlink at this path can redirect
 *      where the socket actually gets created, and a chmodSync EPERM
 *      against a dir genuinely owned by someone else is easy to swallow
 *      silently, letting execution proceed to bind inside it anyway.
 *   2. A relative `dir` (e.g. a bare-filename NANOCLAW_KERNEL_SOCKET /
 *      NANOCLAW_NCL_SOCKET override, whose path.dirname() is `.`) would
 *      have this chmod the process's actual cwd instead of a runtime dir.
 *
 * Fixed by: rejecting a non-absolute dir outright, and using a single
 * atomic `mkdirSync(dir, {recursive:false})` to create-or-detect-existing
 * with no separate check-then-act window; on EEXIST, lstat (not stat — do
 * not follow symlinks) and require a real directory owned by this uid
 * before trusting it. Every failure mode here throws rather than being
 * swallowed — call this right before binding a socket (kernel-supervisor
 * before spawning `nanogo serve`, socket-server.ts before listen()), not
 * at path-computation time; see getRuntimeSocketDir's doc comment for why
 * the two are split, and let the caller's own error handling decide how a
 * refusal here is surfaced.
 */
export function ensureRuntimeSocketDir(dir: string): void {
  if (!path.isAbsolute(dir)) {
    throw new Error(
      `refusing to use a non-absolute socket directory (${JSON.stringify(dir)}) — ` +
        'check NANOCLAW_KERNEL_SOCKET / NANOCLAW_NCL_SOCKET are set to absolute paths if overridden',
    );
  }

  try {
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    return; // Created fresh, by us, just now — nothing to verify.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Something is already at this path — verify it's actually ours before
  // trusting it. lstat, never stat: following a symlink here is exactly
  // the redirection this check exists to catch.
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to use ${dir} for a socket directory — it's a symlink, not a real directory`);
  }
  if (!info.isDirectory()) {
    throw new Error(`refusing to use ${dir} for a socket directory — a non-directory already exists there`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    // POSIX-only check (this project supports macOS/Linux only); if
    // process.getuid is somehow unavailable, fail closed rather than skip
    // the check silently.
    throw new Error(`refusing to use ${dir} for a socket directory — could not determine this process's uid`);
  }
  if (info.uid !== uid) {
    throw new Error(
      `refusing to use ${dir} for a socket directory — it's owned by uid ${info.uid}, not this process's uid ${uid}`,
    );
  }
  // Ownership confirmed — now safe to tighten permissions if they'd drifted
  // (e.g. created by a process with a looser umask). Not swallowed: if this
  // fails despite owning the directory, something unexpected is going on
  // and binding a socket underneath it isn't safe to proceed with anyway.
  fs.chmodSync(dir, 0o700);
}

/** launchd Label + plist basename. e.g. `com.nanoclaw-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return `com.nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** systemd unit name (no .service suffix). e.g. `nanoclaw-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `nanoclaw-agent-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
