'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildConfig, applyObservedTtl, parseTtl } = require('../lib/config');

test('command after -- is separated from flags', () => {
  const { command } = buildConfig(['--verbose', '--', 'claude', '--foo'], {});
  assert.deepEqual(command, ['claude', '--foo']);
});

test('flags override defaults and convert seconds to ms', () => {
  const { config } = buildConfig(['--idle', '30', '--size-gate', '5000', '--', 'claude'], {});
  assert.equal(config.idleMs, 30000);
  assert.equal(config.sizeGate, 5000);
});

test('help flag is detected and stripped from config', () => {
  const { help } = buildConfig(['--help'], {});
  assert.equal(help, true);
});

test('CML_* environment variables are read', () => {
  const { config } = buildConfig(['--', 'claude'], { CML_IDLE_MS: '99000', CML_NO_TRANSCRIPT: '1' });
  assert.equal(config.idleMs, 99000);
  assert.equal(config.useTranscript, false);
});

test('explicit flags win over environment', () => {
  const { config } = buildConfig(['--idle', '10', '--', 'claude'], { CML_IDLE_MS: '99000' });
  assert.equal(config.idleMs, 10000);
});

test('no command yields an empty command array', () => {
  const { command } = buildConfig(['--verbose'], {});
  assert.deepEqual(command, []);
});

test('compact-cmd and save-prompt pass through verbatim', () => {
  const { config } = buildConfig(['--compact-cmd', '/squash', '--save-prompt', 'save now', '--', 'x'], {});
  assert.equal(config.compactCmd, '/squash');
  assert.equal(config.savePrompt, 'save now');
});

test('parseTtl understands 5m, 1h, and bare seconds', () => {
  assert.equal(parseTtl('5m'), 300000);
  assert.equal(parseTtl('1h'), 3600000);
  assert.equal(parseTtl('600'), 600000);
  assert.equal(parseTtl('bogus'), null);
  assert.equal(parseTtl(''), null);
});

test('parseTtl is strict and rejects near-miss units that parseInt would accept', () => {
  assert.equal(parseTtl('5min'), null);
  assert.equal(parseTtl('5minutes'), null);
  assert.equal(parseTtl('600s'), null);
  assert.equal(parseTtl('600junk'), null);
  assert.equal(parseTtl('1.5'), null);
  assert.equal(parseTtl('0'), null);
});

test('default TTL is 1h and idle/grace derive from it', () => {
  const { config } = buildConfig(['--', 'claude'], {});
  assert.equal(config.ttlMs, 3600000);
  assert.equal(config.idleMs, 2880000);   // 80% of 1h
  assert.equal(config.graceMs, 21600000); // 6x 1h
});

test('--ttl 5m reproduces the historical 4m idle / 30m grace', () => {
  const { config } = buildConfig(['--ttl', '5m', '--', 'claude'], {});
  assert.equal(config.ttlMs, 300000);
  assert.equal(config.idleMs, 240000);
  assert.equal(config.graceMs, 1800000);
});

test('CML_TTL sets the TTL and derived windows', () => {
  const { config } = buildConfig(['--', 'claude'], { CML_TTL: '5m' });
  assert.equal(config.ttlMs, 300000);
  assert.equal(config.idleMs, 240000);
});

test('FORCE_PROMPT_CACHING_5M forces 5m and wins over ENABLE_1H', () => {
  assert.equal(buildConfig(['--', 'claude'], { FORCE_PROMPT_CACHING_5M: '1' }).config.ttlMs, 300000);
  assert.equal(
    buildConfig(['--', 'claude'], { FORCE_PROMPT_CACHING_5M: '1', ENABLE_PROMPT_CACHING_1H: '1' }).config.ttlMs,
    300000
  );
});

test('ENABLE_PROMPT_CACHING_1H selects 1h', () => {
  assert.equal(buildConfig(['--', 'claude'], { ENABLE_PROMPT_CACHING_1H: '1' }).config.ttlMs, 3600000);
});

test('an API key implies the 5-minute default', () => {
  const { config } = buildConfig(['--', 'claude'], { ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  assert.equal(config.ttlMs, 300000);
  assert.equal(config.idleMs, 240000);
});

test('CLAUDE_CODE_USE_FOUNDRY implies the 5-minute default', () => {
  const { config } = buildConfig(['--', 'claude'], { CLAUDE_CODE_USE_FOUNDRY: '1' });
  assert.equal(config.ttlMs, 300000);
  assert.equal(config.idleMs, 240000);
});

test('--ttl overrides env detection', () => {
  const { config } = buildConfig(['--ttl', '1h', '--', 'claude'], { ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  assert.equal(config.ttlMs, 3600000);
  assert.equal(config.idleMs, 2880000);
});

test('explicit --idle wins over the --ttl derivation; grace still derives', () => {
  const { config } = buildConfig(['--ttl', '1h', '--idle', '120', '--', 'claude'], {});
  assert.equal(config.ttlMs, 3600000);
  assert.equal(config.idleMs, 120000);
  assert.equal(config.graceMs, 21600000);
});

test('CML_IDLE_MS pins idle even when --ttl is given', () => {
  const { config } = buildConfig(['--ttl', '1h', '--', 'claude'], { CML_IDLE_MS: '90000' });
  assert.equal(config.idleMs, 90000);
});

test('an invalid CML_IDLE_MS is not treated as a pin; idle derives from --ttl', () => {
  const { config } = buildConfig(['--ttl', '1h', '--', 'claude'], { CML_TTL: '5m', CML_IDLE_MS: 'bogus' });
  assert.equal(config.ttlMs, 3600000);
  assert.equal(config.idleMs, 2880000); // derived from 1h, not stuck at the 5m/240000 value
});

test('an observed 5m TTL beats the 1h default and re-derives idle/grace', () => {
  const { config } = buildConfig(['--', 'claude'], {});
  const tuned = applyObservedTtl(config, 300000);
  assert.equal(tuned.ttlMs, 300000);
  assert.equal(tuned.ttlSource, 'transcript');
  assert.equal(tuned.idleMs, 240000);
  assert.equal(tuned.graceMs, 1800000);
});

test('an observed 1h TTL beats the API-key 5m heuristic', () => {
  const { config } = buildConfig(['--', 'claude'], { ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  const tuned = applyObservedTtl(config, 3600000);
  assert.equal(tuned.ttlMs, 3600000);
  assert.equal(tuned.idleMs, 2880000);
});

test('an observation beats FORCE_PROMPT_CACHING_5M and ENABLE_PROMPT_CACHING_1H', () => {
  const forced = buildConfig(['--', 'claude'], { FORCE_PROMPT_CACHING_5M: '1' }).config;
  assert.equal(applyObservedTtl(forced, 3600000).ttlMs, 3600000);
  const optedIn = buildConfig(['--', 'claude'], { ENABLE_PROMPT_CACHING_1H: '1' }).config;
  assert.equal(applyObservedTtl(optedIn, 300000).ttlMs, 300000);
});

test('no observation leaves the env-resolved config untouched', () => {
  const { config } = buildConfig(['--', 'claude'], {});
  assert.equal(applyObservedTtl(config, null), config);
  assert.equal(config.ttlSource, 'default-1h');
  assert.equal(config.idleMs, 2880000);
});

test('CML_TTL outranks an observation', () => {
  const { config } = buildConfig(['--', 'claude'], { CML_TTL: '1h' });
  assert.equal(applyObservedTtl(config, 300000), config);
  assert.equal(config.ttlMs, 3600000);
});

test('--ttl outranks an observation', () => {
  const { config } = buildConfig(['--ttl', '5m', '--', 'claude'], {});
  assert.equal(applyObservedTtl(config, 3600000), config);
  assert.equal(config.ttlMs, 300000);
});

test('a pinned idle survives an observation; grace still re-derives', () => {
  const { config } = buildConfig(['--idle', '120', '--', 'claude'], {});
  const tuned = applyObservedTtl(config, 300000);
  assert.equal(tuned.idleMs, 120000);
  assert.equal(tuned.graceMs, 1800000);
});

test('CML_GRACE_MS pins grace across an observation', () => {
  const { config } = buildConfig(['--', 'claude'], { CML_GRACE_MS: '77000' });
  const tuned = applyObservedTtl(config, 300000);
  assert.equal(tuned.graceMs, 77000);
  assert.equal(tuned.idleMs, 240000);
});

test('a mid-session flip re-derives the windows again', () => {
  const { config } = buildConfig(['--', 'claude'], {});
  const asOneHour = applyObservedTtl(config, 3600000);
  const flipped = applyObservedTtl(asOneHour, 300000);
  assert.equal(flipped.ttlMs, 300000);
  assert.equal(flipped.idleMs, 240000);
  assert.equal(flipped.graceMs, 1800000);
});

test('re-observing the same TTL returns the identical config object', () => {
  const { config } = buildConfig(['--', 'claude'], {});
  const tuned = applyObservedTtl(config, 300000);
  assert.equal(applyObservedTtl(tuned, 300000), tuned);
});
