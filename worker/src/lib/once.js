// Once-per-isolate guard for the modules' self-migrations.
//
// Every route module keeps its tables current with a run of
// "CREATE TABLE IF NOT EXISTS …" + "ALTER TABLE … ADD COLUMN" (try/catch)
// statements, and used to run that whole battery on EVERY request. Each
// statement is a D1 round trip (~200 ms from a Worker that isn't sitting next
// to the database), so a trivial endpoint paid 7–10 round trips before doing
// any real work — the main reason the portal read "slow" on 9 Sep 2026.
//
// Wrapping a migration in onceMigration() runs it once per isolate: the first
// call to FINISH marks it done and every later call (in this isolate) returns
// straight away. A FAILED run marks nothing, so the next request retries — a
// transient D1 error never leaves the isolate believing the tables are ready
// when they aren't.
//
// The tables live in D1, not the isolate, so "once per isolate" is exactly as
// safe as "once per request" was: a fresh isolate re-checks, an existing one
// already did.
//
// NEVER share the in-flight PROMISE between requests (18 Nov 2026). The first
// version kept `pending` and handed that same promise to every caller. On
// Workers a promise belongs to the request that created it: if that request
// ends first (phone closes the page, user navigates away) the promise can never
// settle, and every later request in the isolate that awaits it dies with
// "This promise was created by a request that has since ended" — a 500 on every
// endpoint behind that migration until the isolate is recycled. So each request
// runs the migration ITSELF until one has completed; only the plain done flag
// and result are shared. Concurrent first calls each run it — the statements are
// idempotent (CREATE IF NOT EXISTS / ALTER in try-catch), as they were when this
// ran on every request.
export function onceMigration(fn) {
  let done = false, result;
  async function onceWrapped(...args) {
    if (done) return result;
    const r = await fn.apply(this, args);
    done = true; result = r;
    return r;
  }
  onceWrapped.reset = () => { done = false; result = undefined; };   // tests only: a fresh mock DB needs the migration again
  return onceWrapped;
}
