'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slugCandidates, cwdMarker, fileMatchesCwd, readHandshake, readState } = require('../lib/transcript');

// Fixtures mirror Claude Code's real JSONL: assistant records carry
// message.stop_reason + message.usage; user records carry tool results or user
// text; many non-message record types are interleaved.
function tmpFile(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-'));
  const f = path.join(dir, 'session.jsonl');
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const asst = (stop, tokens) => ({
  type: 'assistant',
  timestamp: '2026-07-11T10:00:00.000Z',
  message: {
    role: 'assistant',
    stop_reason: stop,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 },
  },
});
const usr = () => ({ type: 'user', timestamp: '2026-07-11T10:00:01.000Z', message: { role: 'user' } });
const meta = (t) => ({ type: t });
// An assistant record that also reports which bucket the cache write landed in.
const asstCache = (stop, cacheCreation, tokens) => {
  const r = asst(stop, tokens || 200000);
  r.message.usage.cache_creation = cacheCreation;
  return r;
};
const bucket5m = (n) => ({ ephemeral_5m_input_tokens: n, ephemeral_1h_input_tokens: 0 });
const bucket1h = (n) => ({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n });

test('slug: each :, \\, / and . becomes its own dash', () => {
  assert.equal(slugCandidates('C:\\Users\\dev\\my-app')[0], 'C--Users-dev-my-app');
  assert.equal(slugCandidates('C:\\Users\\dev\\.config\\tool')[0], 'C--Users-dev--config-tool');
});

test('slug: the primary candidate flattens underscores like Claude Code does', () => {
  const cands = slugCandidates('C:\\dev\\my_app');
  assert.equal(cands[0], 'C--dev-my-app');
  assert.ok(cands.includes('C--dev-my_app'));
});

test('a transcript is only accepted when its head names the same cwd', () => {
  const f = tmpFile([{ type: 'user', cwd: 'C:\\dev\\proj', message: { role: 'user' } }]);
  assert.equal(fileMatchesCwd(f, cwdMarker('C:\\dev\\proj')), true);
  assert.equal(fileMatchesCwd(f, cwdMarker('C:\\dev\\other')), false);
});

test('cwd marker matching preserves JSON escaping', () => {
  const cwd = 'C:\\dev\\a"b';
  const f = tmpFile([{ type: 'user', cwd, message: { role: 'user' } }]);
  assert.equal(fileMatchesCwd(f, cwdMarker(cwd)), true);
});

function tmpHandshake(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-hs-'));
  const f = path.join(dir, 'handshake.json');
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
}

test('the handshake resolves to the transcript path the agent reported', () => {
  const t = tmpFile([asst('end_turn', 200000)]);
  assert.equal(readHandshake(tmpHandshake({ transcript_path: t })), t);
});

test('a handshake that is missing, empty or malformed resolves to nothing', () => {
  assert.equal(readHandshake(null), null);
  assert.equal(readHandshake('/nonexistent/handshake.json'), null);
  assert.equal(readHandshake(tmpHandshake('')), null);
  assert.equal(readHandshake(tmpHandshake('not json')), null);
  assert.equal(readHandshake(tmpHandshake({})), null);
  assert.equal(readHandshake(tmpHandshake({ transcript_path: 42 })), null);
});

test('the handshake rejects a path that is not an existing .jsonl file', () => {
  const t = tmpFile([asst('end_turn', 200000)]);
  assert.equal(readHandshake(tmpHandshake({ transcript_path: t + '.bak' })), null);
  const dir = path.join(path.dirname(t), 'directory.jsonl');
  fs.mkdirSync(dir);
  assert.equal(readHandshake(tmpHandshake({ transcript_path: dir })), null);
  fs.unlinkSync(t);
  assert.equal(readHandshake(tmpHandshake({ transcript_path: t })), null);
});

test('settled TRUE when the last message record is an assistant end_turn', () => {
  const f = tmpFile([meta('mode'), asst('tool_use', 200000), usr(), asst('end_turn', 210000), meta('last-prompt'), meta('ai-title')]);
  const s = readState(f);
  assert.equal(s.settled, true);
  assert.equal(s.contextTokens, 210000);
});

test('settled FALSE when the last assistant is awaiting a tool (tool_use)', () => {
  const f = tmpFile([asst('end_turn', 100000), usr(), asst('tool_use', 205000)]);
  assert.equal(readState(f).settled, false);
});

test('settled FALSE when a user record trails a completed turn', () => {
  const f = tmpFile([asst('end_turn', 150000), usr(), usr(), usr()]);
  assert.equal(readState(f).settled, false);
});

test('non-message meta records after end_turn do not unsettle it', () => {
  const f = tmpFile([asst('end_turn', 120000), meta('file-history-snapshot'), meta('mode'), meta('permission-mode')]);
  assert.equal(readState(f).settled, true);
});

test('contextTokens = input + cache_read + cache_creation of the last assistant', () => {
  const f = tmpFile([asst('end_turn', 175000)]);
  assert.equal(readState(f).contextTokens, 175000);
});

test('readState returns null when there are no message records', () => {
  const f = tmpFile([meta('mode'), meta('permission-mode')]);
  assert.equal(readState(f), null);
});

test('observedTtlMs is 5m when the 5m cache bucket is the nonzero one', () => {
  const f = tmpFile([asstCache('end_turn', bucket5m(18000))]);
  assert.equal(readState(f).observedTtlMs, 300000);
});

test('observedTtlMs is 1h when the 1h cache bucket is the nonzero one', () => {
  const f = tmpFile([asstCache('end_turn', bucket1h(18000))]);
  assert.equal(readState(f).observedTtlMs, 3600000);
});

test('observedTtlMs is null when no assistant record reports a cache bucket', () => {
  const f = tmpFile([asst('end_turn', 175000), usr(), asst('end_turn', 180000)]);
  assert.equal(readState(f).observedTtlMs, null);
});

test('observedTtlMs is null when both buckets are zero', () => {
  const f = tmpFile([asstCache('end_turn', { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })]);
  assert.equal(readState(f).observedTtlMs, null);
});

test('observedTtlMs follows a mid-session flip to the last bucket written', () => {
  const f = tmpFile([asstCache('end_turn', bucket1h(9000)), usr(), asstCache('end_turn', bucket5m(9000))]);
  assert.equal(readState(f).observedTtlMs, 300000);
});

test('an assistant turn that writes no cache leaves the last observed TTL standing', () => {
  const f = tmpFile([asstCache('end_turn', bucket5m(9000)), usr(), asst('end_turn', 210000)]);
  assert.equal(readState(f).observedTtlMs, 300000);
});

test('per-iteration usage copies are ignored so a bucket cannot be double-read', () => {
  const r = asstCache('end_turn', bucket5m(9000));
  r.message.usage.iterations = [{ cache_creation: bucket1h(9000) }];
  assert.equal(readState(tmpFile([r])).observedTtlMs, 300000);
});

test('an ambiguous record with both buckets nonzero observes nothing', () => {
  const f = tmpFile([asstCache('end_turn', { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 5 })]);
  assert.equal(readState(f).observedTtlMs, null);
});

test('a malformed cache_creation does not throw and observes nothing', () => {
  for (const bad of ['5m', 42, null, [], { ephemeral_5m_input_tokens: 'lots' }]) {
    assert.equal(readState(tmpFile([asstCache('end_turn', bad)])).observedTtlMs, null);
  }
});

test('a missing transcript file yields no state at all', () => {
  assert.equal(readState(path.join(os.tmpdir(), 'cml-does-not-exist', 'session.jsonl')), null);
});
