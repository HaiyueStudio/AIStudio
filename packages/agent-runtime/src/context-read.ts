/** Bounded read scope. The reader must honor its signal before publishing late results. */
export async function contextRead<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 1500): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const stop = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(signal?.reason); reject(signal?.reason ?? new Error('Context preparation cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Context read exceeded its deadline.'), { code: 'context.read-timeout' });
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([read(controller.signal), stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
