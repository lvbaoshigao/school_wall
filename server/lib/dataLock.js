'use strict';

const fs = require('node:fs');
const path = require('node:path');

// SQLite's VFS holds an OS file lock for the lifetime of BEGIN EXCLUSIVE. This
// file is deliberately empty: no application data, secrets, PID or lease time.
// Never unlink it (even at shutdown): unlink/recreate would create two lock
// inodes and let two writers proceed. The OS releases the lock after a crash.
// This is a single-host, local-filesystem lock, not a distributed/NFS lock.
const LOCK_DIRECTORY = '.school-wall.lock';
const LOCK_FILENAME = 'owner.sqlite';
const registryKey = Symbol.for('school-wall.data-locks');
const owners = globalThis[registryKey] || (globalThis[registryKey] = new Map());

function lockError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function inspectDirectory(directory, privateDirectory = false) {
  const stat = fs.lstatSync(directory);
  // Symlink DATA_DIR aliases are resolved once before this check. The private
  // lock directory itself must never be a link. Trusted shared groups are OK
  // on DATA_DIR; its members and the directory's ancestors must be trusted.
  if (!stat.isDirectory() || (process.platform !== 'win32' &&
      ((stat.mode & (privateDirectory ? 0o077 : 0o002)) ||
       (privateDirectory && stat.uid !== process.geteuid())))) {
    throw lockError('DATA_DIR_LOCK_UNSAFE', `Unsafe data lock directory: ${directory}. Use a local trusted directory; the lock subdirectory must be private to the service user.`);
  }
  return stat;
}

function inspectFile(filename, allowReadPermissions = false) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0 ||
      (process.platform !== 'win32' && (stat.uid !== process.geteuid() ||
        (stat.mode & (allowReadPermissions ? 0o022 : 0o077)))))) {
    throw lockError('DATA_DIR_LOCK_UNSAFE', `Unsafe data lock file: ${filename}. Do not replace, link or edit the lock file; it must be an empty private regular file.`);
  }
  return stat;
}

function sqliteConstructor() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (cause) {
    throw lockError('DATA_DIR_LOCK_UNAVAILABLE', 'Data directory locking requires Node.js >=22.13.0 with the built-in node:sqlite module enabled. Refusing to open the database without a reliable OS lock.', cause);
  }
}

function acquireDataLock(directory) {
  const DatabaseSync = sqliteConstructor();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(directory);
  const existing = owners.get(canonical);
  if (existing) return existing.lease(directory);

  const rootStat = inspectDirectory(canonical);
  const lockDirectory = path.join(canonical, LOCK_DIRECTORY);
  try { fs.mkdirSync(lockDirectory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const directoryStat = inspectDirectory(lockDirectory, true);
  const filename = path.join(lockDirectory, LOCK_FILENAME);
  // A crash between SQLite creating its empty file and chmod can leave 0644.
  // Reader bits are harmless inside the private directory; recover by
  // tightening only our owned empty lock file, never a group-writable file.
  const previous = inspectFile(filename, true);
  let connection;
  try {
    // Do not pre-open this file with fs.open()/close(). On POSIX, closing any
    // descriptor for an inode can release that process's SQLite record locks,
    // including locks held by another worker thread. Let SQLite own all FDs.
    connection = new DatabaseSync(filename);
    const opened = fs.lstatSync(filename);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0 ||
        (previous && !sameFile(previous, opened))) {
      throw lockError('DATA_DIR_LOCK_UNSAFE', `Data lock file changed while opening: ${filename}`);
    }
    // SQLite may create files as 0644. The enclosing directory is already
    // private, so there is no disclosure window before this chmod. Only this
    // service-owned empty lock file may be tightened; directories stay intact.
    if (process.platform !== 'win32' && (opened.mode & 0o077)) fs.chmodSync(filename, 0o600);
    inspectFile(filename);
    connection.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    const fileStat = inspectFile(filename);
    if (!sameFile(opened, fileStat)) {
      throw lockError('DATA_DIR_LOCK_UNSAFE', `Data lock file changed while acquiring: ${filename}`);
    }

    let closed = false;
    let references = 0;
    const owner = {
      lease(requestedDirectory) {
        let released = false;
        const lease = {
          assertOwned() {
            if (released || closed) throw lockError('DATA_DIR_LOCK_LOST', 'Data directory lock has been released; refusing to save a stale database.');
            try {
              if (fs.realpathSync(requestedDirectory) !== canonical ||
                  !sameFile(rootStat, inspectDirectory(canonical)) ||
                  !sameFile(directoryStat, inspectDirectory(lockDirectory, true)) ||
                  !sameFile(fileStat, inspectFile(filename) || {})) {
                throw new Error('The data root or lock inode was replaced');
              }
            } catch (cause) {
              throw lockError('DATA_DIR_LOCK_LOST', 'Data directory lock path changed; refusing to save. Stop all instances and restore the original trusted data directory.', cause);
            }
          },
          release() {
            if (released) return;
            released = true;
            if (--references === 0) {
              connection.close();
              closed = true;
              owners.delete(canonical);
            }
          },
        };
        lease.assertOwned();
        references++;
        return lease;
      },
    };
    const lease = owner.lease(directory);
    owners.set(canonical, owner);
    return lease;
  } catch (cause) {
    if (connection) { try { connection.close(); } catch {} }
    if (cause.code?.startsWith('DATA_DIR_')) throw cause;
    if (cause.errcode === 5 || cause.errcode === 6) {
      throw lockError('DATA_DIR_IN_USE', `DATA_DIR is already in use by another backend process: ${canonical}. Run only one backend per data directory, even on different ports.`, cause);
    }
    throw lockError('DATA_DIR_LOCK_UNAVAILABLE', `Cannot acquire the data directory OS lock: ${canonical}. Refusing to open the database.`, cause);
  }
}

module.exports = { acquireDataLock };
