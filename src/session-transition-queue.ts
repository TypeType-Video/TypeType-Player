export class SessionTransitionQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get active(): boolean {
    return this.pending > 0;
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => this.settle(),
      () => this.settle(),
    );
    return result;
  }

  private settle(): void {
    this.pending -= 1;
  }
}
