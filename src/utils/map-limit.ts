/** Bounded-concurrency map preserving input order in the result array. */
export async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
