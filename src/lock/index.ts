export {
  classifyLock,
  isLockInfo,
  DEFAULT_STALE_AFTER_MS,
  type ClassifyContext,
  type LockInfo,
  type LockVerdict,
} from './classify.js';
export {
  FileLock,
  inspectLock,
  defaultIsAlive,
  type AcquireResult,
  type FileLockOptions,
  type InspectResult,
  type LockLogger,
} from './file-lock.js';
