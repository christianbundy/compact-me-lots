'use strict';

function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

// Like toInt, but returns null when v is absent OR unparseable. Lets callers
// tell "set to a real number" apart from "not set / a typo", so an invalid
// CML_IDLE_MS is never mistaken for an explicit pin.
function optInt(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  return v === '1' || v === 'true';
}

// Parse a TTL spec into milliseconds: "5m", "1h", or a bare number of SECONDS.
// Strict on purpose: a typo like "5min", "600s", or "1.5" must NOT silently
// become a few seconds and trigger near-instant compaction. Returns null if it
// can't be parsed to one of those exact forms.
function parseTtl(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '5m') return 300000;
  if (s === '1h') return 3600000;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n * 1000 : null;
}

const TTL_5M = 300000;
const TTL_1H = 3600000;
const DEFAULT_TTL_MS = TTL_1H; // Claude Code's default cache TTL on a subscription.

// The idle timer and the abandoned-grace window are both derived from the cache
// TTL, so the whole tool re-tunes itself when the TTL changes:
//   idle  = 80% of the TTL  -> bank the compaction while the cache is still warm,
//                              leaving a 20% margin before it lapses.
//   grace = 6x the TTL      -> past this the session is treated as abandoned.
// Both formulas reproduce the previous fixed 5-minute-TTL numbers exactly:
//   idle  = 300000 * 0.8 = 240000  (4 min, the old default)
//   grace = 300000 * 6   = 1800000 (30 min, the old default)
function idleFromTtl(ttlMs) { return Math.round(ttlMs * 0.8); }
function graceFromTtl(ttlMs) { return Math.round(ttlMs * 6); }

const DEFAULTS = {
  ttlMs: DEFAULT_TTL_MS,
  idleMs: idleFromTtl(DEFAULT_TTL_MS),   // 2,880,000 (48 min)
  graceMs: graceFromTtl(DEFAULT_TTL_MS), // 21,600,000 (6 h)
  sizeGate: 100000,
  settleQuietMs: 8000,
  minTurnMs: 10000,
  maxPhaseMs: 300000,
  sweepMs: 2000,
  injectDelayMs: 200,
  compactCmd: '/compact',
  savePrompt:
    'The prompt cache is about to expire and this context will be compacted shortly. ' +
    'Before that, persist any load-bearing state to disk (notes, TODO, handoff files) so ' +
    'nothing is lost across the compaction. If this session produced a reusable workflow ' +
    'or non-obvious gotcha, record it in the matching docs or skill. If background tasks ' +
    'or subagents are still running, note what they are and how to relaunch them - task ' +
    'handles do not survive compaction. Keep it concise. Once saved, stop and wait.',
  useTranscript: true,
  verbose: false,
};

// Resolve the cache TTL (and where the decision came from, for --verbose) using
// the same signals Claude Code itself uses to pick 5m vs 1h. Priority order:
//   1. --ttl                               - CLI override (applied in buildConfig)
//   2. CML_TTL                             - explicit override for this tool
//   3. transcript                          - the bucket the API actually used
//                                            (applied per sweep in applyObservedTtl)
//   4. FORCE_PROMPT_CACHING_5M=1           - Claude Code force-5m (wins over 1h opt-in)
//   5. ENABLE_PROMPT_CACHING_1H=1          - Claude Code 1h opt-in
//   6. API-key / third-party auth present  - those default to 5m in Claude Code
//   7. default                             - 1h (Claude Code's subscription default)
// Everything from 4 down is a guess about what Claude Code will ask for, which
// is why a transcript observation of what the API actually did outranks them.
function resolveTtl(env) {
  const explicit = parseTtl(env.CML_TTL);
  if (explicit != null) return { ttlMs: explicit, ttlSource: 'CML_TTL' };
  if (truthy(env.FORCE_PROMPT_CACHING_5M)) return { ttlMs: TTL_5M, ttlSource: 'FORCE_PROMPT_CACHING_5M' };
  if (truthy(env.ENABLE_PROMPT_CACHING_1H)) return { ttlMs: TTL_1H, ttlSource: 'ENABLE_PROMPT_CACHING_1H' };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ||
      truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) ||
      truthy(env.CLAUDE_CODE_USE_FOUNDRY)) {
    return { ttlMs: TTL_5M, ttlSource: 'api-key-auth' };
  }
  return { ttlMs: DEFAULT_TTL_MS, ttlSource: 'default-1h' };
}

// True if any DISABLE_PROMPT_CACHING[_MODEL] flag is on. With caching off there is
// no warm window to bank against, so the wrapper can warn (see wrapper.js).
function cachingDisabled(env) {
  return Object.keys(env).some(
    (k) => /^DISABLE_PROMPT_CACHING(_[A-Z0-9]+)?$/.test(k) && truthy(env[k])
  );
}

function fromEnv(env) {
  env = env || {};
  const { ttlMs, ttlSource } = resolveTtl(env);
  // idle/grace honor an explicit, PARSEABLE CML_* override, else derive from the
  // resolved TTL. A malformed override falls through to the derived value.
  const idleOverride = optInt(env.CML_IDLE_MS);
  const graceOverride = optInt(env.CML_GRACE_MS);
  return {
    ttlMs,
    ttlSource,
    idleMs: idleOverride != null ? idleOverride : idleFromTtl(ttlMs),
    graceMs: graceOverride != null ? graceOverride : graceFromTtl(ttlMs),
    idlePinned: idleOverride != null,
    gracePinned: graceOverride != null,
    sizeGate: toInt(env.CML_SIZE_GATE, DEFAULTS.sizeGate),
    settleQuietMs: toInt(env.CML_SETTLE_QUIET_MS, DEFAULTS.settleQuietMs),
    minTurnMs: toInt(env.CML_MIN_TURN_MS, DEFAULTS.minTurnMs),
    maxPhaseMs: toInt(env.CML_MAX_PHASE_MS, DEFAULTS.maxPhaseMs),
    sweepMs: toInt(env.CML_SWEEP_MS, DEFAULTS.sweepMs),
    injectDelayMs: toInt(env.CML_INJECT_DELAY_MS, DEFAULTS.injectDelayMs),
    compactCmd: env.CML_COMPACT_CMD || DEFAULTS.compactCmd,
    savePrompt: env.CML_SAVE_PROMPT || DEFAULTS.savePrompt,
    useTranscript: env.CML_NO_TRANSCRIPT ? false : DEFAULTS.useTranscript,
    verbose: env.CML_VERBOSE ? true : DEFAULTS.verbose,
    cachingDisabled: cachingDisabled(env),
  };
}

function warnFlag(name, raw, expected) {
  const shown = raw === undefined ? '(missing value)' : JSON.stringify(raw);
  process.stderr.write('compact-me-lots: ignoring ' + name + ' ' + shown + ' - ' + (expected || 'expected a number') + '\n');
}

// Splits argv into flags (before `--`) and the wrapped command (after `--`).
function parseArgs(argv) {
  argv = argv || [];
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv.slice() : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const opts = {};
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const next = () => flags[++i];
    switch (f) {
      case '--ttl': { const raw = next(); const ms = parseTtl(raw); if (ms != null) opts.ttlMs = ms; else warnFlag('--ttl', raw, 'expected 5m, 1h, or a positive number of seconds'); break; }
      case '--idle': { const raw = next(); const s = toInt(raw, NaN); if (Number.isFinite(s)) opts.idleMs = s * 1000; else warnFlag('--idle', raw); break; }
      case '--grace': { const raw = next(); const s = toInt(raw, NaN); if (Number.isFinite(s)) opts.graceMs = s * 1000; else warnFlag('--grace', raw); break; }
      case '--size-gate': { const raw = next(); const t = toInt(raw, NaN); if (Number.isFinite(t)) opts.sizeGate = t; else warnFlag('--size-gate', raw); break; }
      case '--compact-cmd': opts.compactCmd = next(); break;
      case '--save-prompt': opts.savePrompt = next(); break;
      case '--no-transcript': opts.useTranscript = false; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--version': case '-V': opts.version = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: break;
    }
  }
  return { opts, command };
}

function buildConfig(argv, env) {
  env = env || {};
  const base = fromEnv(env);
  const { opts, command } = parseArgs(argv);
  const help = !!opts.help;
  const version = !!opts.version;
  delete opts.help;
  delete opts.version;

  const config = Object.assign({}, base);
  // A pin is an explicit flag or a PARSEABLE CML_* env; it survives every later
  // re-derivation, including the per-sweep one in applyObservedTtl.
  config.idlePinned = config.idlePinned || opts.idleMs !== undefined;
  config.gracePinned = config.gracePinned || opts.graceMs !== undefined;

  // A CLI --ttl overrides every env signal and re-derives idle/grace, unless
  // idle/grace are pinned.
  if (opts.ttlMs !== undefined) {
    config.ttlMs = opts.ttlMs;
    config.ttlSource = '--ttl';
    if (!config.idlePinned) config.idleMs = idleFromTtl(opts.ttlMs);
    if (!config.gracePinned) config.graceMs = graceFromTtl(opts.ttlMs);
  }

  for (const k of Object.keys(opts)) {
    if (opts[k] !== undefined) config[k] = opts[k];
  }
  return { config, command, help, version };
}

// Sources the user set deliberately for THIS tool; a transcript observation
// never overrules them.
const PINNED_TTL_SOURCES = new Set(['--ttl', 'CML_TTL']);

// Fold a TTL observed in the transcript into an already-built config, returning
// a new config when it changes anything and the SAME object otherwise. The
// wrapper calls this every sweep, so an account-wide flip from 1h to 5m
// mid-session re-tunes idle/grace instead of leaving the tool banking a
// compaction long after the cache went cold.
function applyObservedTtl(config, observedTtlMs) {
  if (observedTtlMs == null) return config;
  if (PINNED_TTL_SOURCES.has(config.ttlSource)) return config;
  if (config.ttlSource === 'transcript' && config.ttlMs === observedTtlMs) return config;
  const next = Object.assign({}, config, { ttlMs: observedTtlMs, ttlSource: 'transcript' });
  if (!config.idlePinned) next.idleMs = idleFromTtl(observedTtlMs);
  if (!config.gracePinned) next.graceMs = graceFromTtl(observedTtlMs);
  return next;
}

module.exports = {
  DEFAULTS, fromEnv, parseArgs, buildConfig, applyObservedTtl,
  parseTtl, resolveTtl, idleFromTtl, graceFromTtl,
  TTL_5M, TTL_1H,
};
