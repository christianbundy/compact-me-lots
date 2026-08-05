#!/usr/bin/env node
'use strict';

const { buildConfig } = require('../lib/config');

const HELP = `compact-me-lots - keep an idle agent CLI cheap to resume.

Wraps a command in a pseudo-terminal and, when the session goes idle while its
prompt cache is still warm, banks a cheap compaction. When you come back the cold
re-entry pays input cost on a small summary instead of the whole conversation.

Usage:
  compact-me-lots [options] -- <command> [args...]

Examples:
  compact-me-lots -- claude
  compact-me-lots --ttl 5m -- claude          # API key / Bedrock / Vertex / Foundry (5-min cache)
  compact-me-lots --idle 240 --verbose -- claude
  compact-me-lots --no-transcript --compact-cmd "/compact" -- some-agent-cli

Options:
  --ttl <5m|1h|seconds>  Prompt-cache lifetime to tune the idle timer to; the idle
                         and grace windows derive from it. Auto-detected from
                         Claude Code's cache env vars and auth when unset, and
                         defaults to 1h (the Claude subscription default). Pass
                         --ttl 5m on an API key / Bedrock / Vertex / Foundry.
  --idle <seconds>       Idle time before a compaction is banked
                         (default: 80% of the TTL - 240 at 5m, 2880 at 1h)
  --grace <seconds>      Past this, the session is treated as abandoned and left
                         alone (default: 6x the TTL - 1800 at 5m, 21600 at 1h)
  --size-gate <tokens>   Minimum context size worth compacting; only applies in
                         Claude transcript mode (default 100000)
  --compact-cmd <text>   Command injected to compact (default "/compact")
  --save                 Run a built-in save-state turn before compacting. Off by
                         default: it is a whole extra turn, and on a 5m cache it
                         can burn the window the compaction had to fit inside.
  --save-prompt <text>   Same, with your own prompt
  --no-save              No save turn, overriding CML_SAVE / CML_SAVE_PROMPT
  --no-transcript        Do not read the Claude transcript; rely on terminal
                         quiet time only (use for non-Claude CLIs)
  --verbose, -v          Log decisions to stderr
  --version, -V          Print the version and exit
  --help, -h             Show this help

All options can also be set via CML_* environment variables (CML_TTL, CML_IDLE_MS,
CML_GRACE_MS, CML_SIZE_GATE, CML_COMPACT_CMD, CML_SAVE, CML_SAVE_PROMPT,
CML_NO_TRANSCRIPT, CML_VERBOSE).

In Claude mode the transcript is located from the working directory. If the agent
moves elsewhere (claude --worktree), install the SessionStart hook in
extras/handshake-hook/ so the session reports its transcript instead.
`;

function main() {
  const { config, command, help, version } = buildConfig(process.argv.slice(2), process.env);
  if (version) {
    process.stdout.write(require('../package.json').version + '\n');
    process.exit(0);
  }
  if (help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!command.length) {
    process.stderr.write('compact-me-lots: no command given.\n\n' + HELP);
    process.exit(2);
  }
  const { run } = require('../lib/wrapper');
  run(command, config);
}

main();
