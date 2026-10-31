/** Limit concurrent background work without putting foreground requests in its queue. */
export function createBackgroundWorkQueue(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  function drain(): void {
    while (active < concurrency && waiting.length > 0) {
      active++;
      waiting.shift()?.();
    }
  }

  return function run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            active--;
            drain();
          });
      });
      drain();
    });
  };
}
