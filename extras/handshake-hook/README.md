# Transcript handshake hook (Claude Code extra)

Makes `compact-me-lots` find the session transcript exactly, instead of inferring
it from the wrapper's working directory. Install it if the agent's working
directory is not the wrapper's — `claude --worktree` is the common case. See
[`docs/handshake.md`](../../docs/handshake.md) for why the inference misses there,
and why it misses *silently*.

## Install

Copy `cml-handshake` somewhere stable (e.g. `~/.claude/hooks/`), make it
executable, then register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/cml-handshake" }] }
    ]
  }
}
```

Needs `jq`. Reports nothing when `CML_HANDSHAKE` is unset, so a session that no
wrapper started is unaffected.

## Verify

Launch with `--verbose`. One line confirms the report arrived:

```
[compact-me-lots] the agent reported its transcript: /Users/you/.claude/projects/.../<id>.jsonl
```

Without that line the wrapper is still guessing from the working directory.
