// Once-per-isolate guard for the modules' self-migrations.
//
// Every route module keeps its tables current with a run of
// "CREATE TABLE IF NOT EXISTS …" + "ALTER TABLE … ADD COLUMN" (try/catch)
// statements, and used to run that whole battery on EVERY request. Each
// statement is a D1 round trip (~200 ms from a Worker that isn't sitting next
// to the database), so a trivial endpoint paid 7–10 round trips before doing
// any real work — the main reason the portal read "slow" on 9 Sep 2026.
//
// Wrapping a migration in onceMigration() runs it once per isolate: the
// first call does the work and every later call (in this isolate) awaits the
// same promise. Concurrent first calls share one run. A FAILED run is
// forgotten so the next request retries — a transient D1 error never leaves
// the isolate believing the tables are ready when they aren't.
//
// The tables live in D1, not the isolate, so "once per isolate" is exactly as
// safe as "once per request" was: a fresh isolate re-checks, an existing one
// already did.
export function onceMigration(fn) {
  let pending = null;
  function onceWrapped(...args) {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => fn.apply(this, args))
      .catch((e) => { pending = null; throw e; });
    return pending;
  }
  onceWrapped.reset = () => { pending = null; };   // tests only: a fresh mock DB needs the migration again
  return onceWrapped;
}
