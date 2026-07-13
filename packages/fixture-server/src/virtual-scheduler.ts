export interface ScheduledTask {
  readonly atMs: number;
  readonly order: number;
  readonly run: () => void;
}

export class VirtualScheduler {
  private nowValue = 0;
  private orderValue = 0;
  private tasks: ScheduledTask[] = [];

  get now(): number {
    return this.nowValue;
  }

  schedule(delayMs: number, run: () => void): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new RangeError("delayMs must be a non-negative integer");
    }
    this.tasks.push({ atMs: this.nowValue + delayMs, order: this.orderValue++, run });
    this.tasks.sort((a, b) => a.atMs - b.atMs || a.order - b.order);
  }

  advanceBy(deltaMs: number): void {
    this.advanceTo(this.nowValue + deltaMs);
  }

  advanceTo(targetMs: number): void {
    if (!Number.isSafeInteger(targetMs) || targetMs < this.nowValue) {
      throw new RangeError("virtual time cannot move backwards");
    }
    while (this.tasks.length > 0 && this.tasks[0]!.atMs <= targetMs) {
      const task = this.tasks.shift()!;
      this.nowValue = task.atMs;
      task.run();
    }
    this.nowValue = targetMs;
  }

  pending(): number {
    return this.tasks.length;
  }

  clear(): void {
    this.tasks = [];
  }
}
