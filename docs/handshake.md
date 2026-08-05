# The transcript handshake

Claude mode needs the session's transcript. The wrapper finds it two ways.

**By guess.** `findTranscript` derives the project slug from the wrapper's own
working directory and accepts a transcript whose records name that same
directory. This needs no setup, and it is correct whenever the agent stays in the
directory you launched it from.

**By report.** The wrapper puts a path in `CML_HANDSHAKE` in the wrapped
command's environment. A Claude Code `SessionStart` hook writes the session's
real transcript path there, and the wrapper reads it instead of guessing. This is
exact, so it wins whenever the file is present.

## When you need the hook

Install it if the agent's working directory is not the wrapper's. The case that
forced this doc is `claude --worktree`, which creates a worktree and moves the
session into it. Every transcript record then names the worktree, the project
slug changes with it, and the guess misses — silently, because a session whose
transcript is never found simply never compacts.

Two shapes to watch for:

- `--worktree`, `--add-dir`, or any flag that relocates the session.
- A launcher that `cd`s to a repo root and lets the agent pick a subdirectory.

Concurrent sessions make this worse, not better. Loosening the guess to a prefix
match would let one wrapper latch onto a sibling session's transcript and inject
into its own child at the wrong moment. The handshake has no such ambiguity.

## Installing the hook

The hook and its install steps live in
[`extras/handshake-hook/`](../extras/handshake-hook/). It reads Claude Code's JSON
payload on stdin and writes `transcript_path` and `cwd` to the path in
`CML_HANDSHAKE`.

`SessionStart` fires on launch, on resume, and after a compaction, so the file
follows Claude Code into a new session file on its own.

Nothing breaks without the hook. An absent, empty, malformed, or stale handshake
file falls back to the guess, and `--verbose` prints the transcript path once the
report arrives.

`CML_HANDSHAKE` is inherited, so a *nested* agent launched from inside the wrapped
session reports over the outer session's path. The wrapper then watches a
transcript it is not driving. Unset `CML_HANDSHAKE` before you launch an agent
inside an agent.
