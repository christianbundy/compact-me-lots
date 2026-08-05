'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TTL_5M, TTL_1H } = require('./config');

// Claude Code writes a per-session JSONL transcript under
// ~/.claude/projects/<slug>/<uuid>.jsonl, where <slug> is the working directory
// with every non-alphanumeric character flattened to a dash,
// e.g. C:\Users\me\proj -> C--Users-me-proj. Reading it lets us gate on real
// context size and know when a turn has actually completed, rather than guessing
// from terminal output alone. Every function here is best-effort: on any mismatch
// it returns null and the caller treats the session as not yet observable.
//
// A turn is COMPLETE when the last message-bearing record is an assistant message
// whose stop_reason is a natural stop (end_turn / stop_sequence). An assistant
// record with stop_reason "tool_use" means Claude is mid-turn waiting on a tool,
// and a trailing "user" record means Claude still owes a reply — neither is
// settled, so we never inject then.

const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence']);

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Three slug spellings: all-non-alphanumerics-as-dashes (Claude Code's actual
// rule), dots-as-dashes, and dots-kept, so older or slightly different slug
// schemes still have a chance to match. The common plain path is identical
// under all three.
function slugCandidates(cwd) {
  const a = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const b = cwd.replace(/[:\\/.]/g, '-');
  const c = cwd.replace(/[:\\/]/g, '-');
  const out = [];
  for (const s of [a, b, c]) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function cwdMarker(cwd) {
  const marker = '"cwd":' + JSON.stringify(cwd);
  return process.platform === 'win32' ? marker.toLowerCase() : marker;
}

function fileMatchesCwd(file, marker) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    if (len <= 0) return false;
    const head = buf.toString('utf8', 0, len);
    return (process.platform === 'win32' ? head.toLowerCase() : head).includes(marker);
  } catch {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Newest *.jsonl touched at/after the wrap started whose head records name this
// exact cwd. The cwd check stops the wrapper from latching onto a DIFFERENT
// concurrent session's transcript (the multi-session case this tool exists
// for). Prefers the project dir(s) matching cwd; if none exist, scans every
// project dir so a slightly-off slug still locates the freshly-launched
// session. Callers re-run this every sweep: Claude Code continues in a NEW
// session file after a compaction, and the newest matching file follows it.
function findTranscript(cwd, since) {
  const root = projectsRoot();
  const marker = cwdMarker(cwd);
  const seen = new Set();
  let dirs = [];
  for (const slug of slugCandidates(cwd)) {
    const d = path.join(root, slug);
    if (!seen.has(d) && isDir(d)) { seen.add(d); dirs.push(d); }
  }
  if (!dirs.length) {
    try {
      dirs = fs.readdirSync(root).map((n) => path.join(root, n)).filter(isDir);
    } catch {
      return null;
    }
  }
  let best = null;
  let bestMtime = 0;
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(d, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= bestMtime && st.mtimeMs >= since - 5000 && fileMatchesCwd(full, marker)) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    }
  }
  return best;
}

// The transcript path the wrapped agent reported for itself, via the handshake
// file named in CML_HANDSHAKE (see docs/handshake.md). This is the only exact
// answer: findTranscript has to guess from cwd, and the guess fails outright
// when the agent chdirs after launch, as `claude --worktree` does. Best-effort,
// like everything here - a missing, malformed, or stale file returns null and
// the caller falls back to findTranscript.
function readHandshake(file) {
  if (!file) return null;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const p = obj && obj.transcript_path;
  if (typeof p !== 'string' || !p.endsWith('.jsonl')) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

function tailLines(file, maxBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// The TTL bucket a request's cache write actually landed in, as reported by the
// API. Exactly one of the two buckets is ever nonzero, so the nonzero one IS the
// live TTL - an observation, not the env-var guess in config.resolveTtl. Only
// the top-level usage.cache_creation is read: usage.iterations[] repeats the
// same counters per iteration and would double-count. Returns null when the
// object is absent, empty, or (never seen in practice) ambiguous.
function ttlFromUsage(u) {
  const c = u && u.cache_creation;
  if (!c || typeof c !== 'object') return null;
  const five = c.ephemeral_5m_input_tokens > 0;
  const hour = c.ephemeral_1h_input_tokens > 0;
  if (five && hour) return null;
  if (five) return TTL_5M;
  if (hour) return TTL_1H;
  return null;
}

// Derives, from the transcript tail:
//   contextTokens   input+cache size of the last assistant turn (approx size gate)
//   settled         last message record is an assistant turn that ended naturally
//   lastAssistantAt epoch ms of the last assistant record
//   observedTtlMs   cache TTL of the last assistant turn that wrote cache, or null
// Non-message record types (mode, file-history-snapshot, last-prompt, ai-title,
// permission-mode, ...) are skipped. Returns null if nothing usable was found.
function readState(file) {
  const lines = tailLines(file, 512 * 1024);
  if (!lines.length) return null;
  let contextTokens = null;
  let lastAssistantAt = null;
  let lastMsgType = null;
  let lastAssistantStop = null;
  let observedTtlMs = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj.type;
    if (type !== 'assistant' && type !== 'user') continue;
    lastMsgType = type;
    if (type === 'assistant') {
      const msg = obj.message || {};
      lastAssistantStop = msg.stop_reason || null;
      const u = msg.usage;
      if (u) {
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (t > 0) contextTokens = t;
        const ttl = ttlFromUsage(u);
        if (ttl != null) observedTtlMs = ttl;
      }
      if (obj.timestamp) {
        const ts = Date.parse(obj.timestamp);
        if (!Number.isNaN(ts)) lastAssistantAt = ts;
      }
    }
  }
  if (lastMsgType == null) return null;
  const settled = lastMsgType === 'assistant' && TERMINAL_STOP.has(lastAssistantStop);
  return { contextTokens, settled, lastAssistantAt, observedTtlMs };
}

function recordSubmitsBody(obj, body) {
  const c = obj && obj.message ? obj.message.content : null;
  const texts = [];
  if (typeof c === 'string') texts.push(c);
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && typeof b.text === 'string') texts.push(b.text);
    }
  }
  const want = body.trim();
  return texts.some((t) => t.trim() === want || t.includes('<command-name>' + want + '</command-name>'));
}

function appendedHasSubmit(file, fromByte, body) {
  const lineFilter = '"user"';
  try {
    const st = fs.statSync(file);
    if (st.size <= fromByte) return false;
    const len = Math.min(st.size - fromByte, 1_048_576);
    const buf = Buffer.allocUnsafe(len);
    const fd = fs.openSync(file, 'r');
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, len, fromByte);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes(lineFilter)) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.isSidechain !== true && recordSubmitsBody(obj, body)) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = { projectsRoot, slugCandidates, cwdMarker, fileMatchesCwd, findTranscript, readHandshake, tailLines, readState, ttlFromUsage, appendedHasSubmit, recordSubmitsBody };
