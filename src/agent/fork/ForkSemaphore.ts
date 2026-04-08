export class ForkSemaphore {
  private running = 0;

  constructor(private readonly maxConcurrent: number) {}

  tryAcquire(): boolean {
    if (this.running >= this.maxConcurrent) return false;
    this.running++;
    return true;
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
  }

  getRunning(): number {
    return this.running;
  }
}
