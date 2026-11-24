// One job at a time per key (shop): product events and the nightly check for
// the same shop never change the same plans at the same moment.
const chains = new Map();

export function runExclusive(key, fn) {
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
