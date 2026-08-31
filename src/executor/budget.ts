import type { Access, ProviderId } from "../manifest/index.js";

/**
 * Parallel admission (execution.md §Scheduler, §Workspace isolation). Pure: no
 * I/O, no clock, no process state — only the arithmetic of "given what is
 * already running, may this group start now?". The scheduler owns the loop;
 * this owns the budgets and the single-writer semaphore.
 *
 * A small state object with `admit`/`release` rather than free functions over a
 * count, because admission and release are the two ends of one fact: a group
 * takes its slots when its process spawns and returns them when the process
 * settles, and under parallelism the scheduler settles groups out of order.
 */

export interface AdmissionConfig {
  /** `--max-parallel` — the ceiling on provider processes running at once. */
  maxParallel: number;
  /**
   * Per-provider ceiling: each adapter's `capabilities.maxConcurrency`
   * (providers/types.ts). Conservative because these run on consumer
   * subscriptions that throttle. A provider absent from the map is bounded by
   * `maxParallel` alone.
   */
  perProvider: Readonly<Partial<Record<ProviderId, number>>>;
}

export interface GroupAdmission {
  /** The group leader's id — stable across the passes the group waits through. */
  id: string;
  provider: ProviderId;
  /**
   * `read-write` ⇒ the group needs the single writer slot (`--isolation
   * shared`): it starts only when no other writer is in flight, and while it
   * waits no new `read-only` group starts either, so an unbounded stream of
   * readers cannot starve it.
   */
  access: Access;
}

export class AdmissionState {
  private readonly maxParallel: number;
  private readonly perProvider: Readonly<Partial<Record<ProviderId, number>>>;
  private readonly inFlight = new Map<string, GroupAdmission>();
  /**
   * Writer groups that have been offered and refused. Keyed by id so re-offering
   * the same group across passes is idempotent. Cleared when the group is
   * finally admitted or is released; the scheduler must `release` a group it
   * abandons before admission, or its readers stay blocked.
   */
  private readonly waitingWriters = new Set<string>();

  constructor(config: AdmissionConfig) {
    this.maxParallel = Math.max(1, config.maxParallel);
    this.perProvider = config.perProvider;
  }

  /** Groups currently counted as running. */
  get running(): number {
    return this.inFlight.size;
  }

  /** Writer groups offered, refused, and not yet admitted. */
  get writersWaiting(): number {
    return this.waitingWriters.size;
  }

  /**
   * May this group start now? On `true` the group is recorded as in flight and
   * the caller must `release` it once its process settles. On `false` nothing
   * observable changes for the caller, which re-offers the group on a later
   * pass — but a refused writer is remembered, so readers offered after it in
   * this pass or any later one are held back until it gets in.
   */
  admit(group: GroupAdmission): boolean {
    if (this.inFlight.has(group.id)) return true;
    if (!this.hasRoom(group)) {
      if (group.access === "read-write") this.waitingWriters.add(group.id);
      return false;
    }
    this.waitingWriters.delete(group.id);
    this.inFlight.set(group.id, group);
    return true;
  }

  /** Return the group's slots. Idempotent — a group settles once. */
  release(id: string): void {
    this.inFlight.delete(id);
    this.waitingWriters.delete(id);
  }

  private hasRoom(group: GroupAdmission): boolean {
    if (this.inFlight.size >= this.maxParallel) return false;
    if (this.providerCount(group.provider) >= this.providerCap(group.provider)) {
      return false;
    }
    if (group.access === "read-write") return !this.writerInFlight();
    // A read-only group yields to any writer already waiting on the semaphore.
    return this.waitingWriters.size === 0;
  }

  private writerInFlight(): boolean {
    for (const inFlight of this.inFlight.values()) {
      if (inFlight.access === "read-write") return true;
    }
    return false;
  }

  private providerCap(provider: ProviderId): number {
    return this.perProvider[provider] ?? Number.POSITIVE_INFINITY;
  }

  private providerCount(provider: ProviderId): number {
    let count = 0;
    for (const group of this.inFlight.values()) {
      if (group.provider === provider) count += 1;
    }
    return count;
  }
}
