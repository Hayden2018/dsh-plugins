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
the number of sessions that will be deleted.

## Limits

- Session logs must expose a filesystem `location` (the shipped JSONL backend
  does); other backends are reported as missing rather than guessed at.
- Unloading a resident session has no public Host API. It runs the
  `agentLoop.lifecycle(<id>)` Cordis effect disposer found on its owning fiber,
  which is the same teardown the Host performs on shutdown. Two private Cordis
  fields are read (`Fiber._disposables` and the effect-label symbol); if an
  upgrade changes them the release becomes a no-op and the session is reported
  as in use, so a restart of DSH is still the fallback.
- Attachments are content-addressed and shared, so they are not reclaimed.
- The session store is `DSH_HOME`-wide, so a purge affects every profile of the
  same installation.
