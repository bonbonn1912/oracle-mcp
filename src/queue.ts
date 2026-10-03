/** Serializes database tool requests and skips work cancelled while waiting in line. */
export class RequestCancelledError extends Error {
  constructor() {
    super("Request was cancelled before execution.");
    this.name = "RequestCancelledError";
  }
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = (): Promise<T> => {
      if (signal?.aborted) throw new RequestCancelledError();
      return task();
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
