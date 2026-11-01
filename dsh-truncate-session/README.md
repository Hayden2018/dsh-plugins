# Truncate session

A **truncate** control (scissors) in the assistant action strip of the Web UI,
beside the shipped branch (fork) control.

The branch control owns the transcript tail, so this one is offered on every
earlier completed turn and **hidden at the tail**, where there is nothing to
cut. One click, in this order:

1. **Fork** the Session at that turn's `turn/end` boundary — the same inclusive
   cut the branch control sends.
2. **Select the fork.** It opens immediately, with the source title (no
   `(2)` suffix: the fork inherits the title event).
3. **Restore the dropped prompt.** When the cut takes exactly one prompt with
   it — the clicked assistant message is the model message just before the
   Session's last user message — that prompt returns to the fork's input box.
   The test is positional, so an answer that is already streaming does not
   cancel it. The write is retried while the box stays empty, and read back,
   because the new composer may mount a moment after the fork opens.
4. **Archive the original.** Archive keeps the log, so this is recoverable
   (Unarchive in the sidebar restores its position). Anything still running in
   the source is stopped, because everything from that turn on is being
   dropped.

## Where the button is

`conversation.chat.assistant-actions`, so it renders inside the same icon row
as copy, feedback and branch — at each completed turn before the last, left of
the branch icon (the shipped row draws plugin actions in the gap between copy
and branch).

## Limits

- **Conversation only.** Files written, terminals, and subagent work from the
  dropped turns are not rolled back. The log is what truncates.
- **Text only.** A restored prompt loses its images, file attachments and
  `@`-mention chips, because the draft API takes text.
- **Archive, not deletion.** The original log stays on disk. Reclaim it with
  the Archive cleanup page (the `dsh-archive-purge` bundle) after a reload.
- **No undo control.** Unarchive the original from the sidebar's archived
  filter if the truncation was a mistake; the fork remains as a separate row.
- A prompt that is still only queued in the inbox — not yet a transcript row —
  does not count as truncatable content.
- English and Chinese copy only; other locales fall back to English.
