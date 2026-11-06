/** Runs async work one task at a time per key; see `createKeyedSerializer`. */
export type KeyedSerializer = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Run async work one task at a time per key, in call order, while different
 * keys run concurrently. A failed task does not block the next one for its
 * key, and an idle key keeps no state.
 */
export function createKeyedSerializer(): KeyedSerializer {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
