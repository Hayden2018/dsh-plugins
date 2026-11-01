# Archive cleanup

A Plugins-page tab that reclaims space from archived sessions: two counts and
two two-step destructive actions.

## What it shows

- **Archived sessions** — every id in the harness archive set, with the total
  size of the logs that still exist on disk.
- **Inactive for 7+ days** — archived sessions whose latest activity, the last
  write to the session log, is at least seven days old.

The harness archive set stores session ids only. It has no archive timestamp,
so the second count is deliberately **not** "sessions archived seven days
ago"; the page states this next to the number and shows the exact cutoff time.

## What it does

- **Purge every archived session** deletes every archived session's log.
- **Purge sessions inactive for 7+ days** deletes only the subset whose last
  log write predates the cutoff.

Both actions require a second click on the same button; the armed label names
the number of sessions that will be deleted. A purge, per session:

1. skips it when it is live or another writer holds it;
2. claims the write handle, closes it, then removes the session's artifact
   directory;
3. drops the derived projection-cache row;
4. removes the id from the archive set and detaches it from every workspace
   that still accounted it.

The Host recomputes the eligible set when the request arrives, so a stale page
cannot delete a different set than it displayed. Deletion is user-only: no
agent tool reaches it.

## Limits

- Session logs must expose a filesystem `location` (the shipped JSONL backend
  does); other backends are reported as missing rather than guessed at.
- Attachments are content-addressed and shared, so they are not reclaimed.
- The session store is `DSH_HOME`-wide, so a purge affects every profile of the
  same installation.
- The sidebar keeps its cached session list until the page reloads; the result
  card offers that reload.
