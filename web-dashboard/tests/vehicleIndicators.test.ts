import test from 'node:test';
import assert from 'node:assert/strict';
import { openingState, tireReading } from '../src/utils/vehicleIndicators.ts';

test('missing door/window state is not interpreted as closed', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) assert.equal(openingState(value), 'unknown');
  assert.equal(openingState(0), 'closed');
  assert.equal(openingState(1), 'open');
  assert.equal(openingState(2), 'open');
});
test('invalid or missing tire pressure is not shown as zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 0]) assert.equal(tireReading({ tpms_pressure_fl: value }, 'fl').bar, null);
  assert.equal(tireReading({ tpms_pressure_fl: 2.9 }, 'fl').bar, 2.9);
});
test('hard warning overrides soft and remains visible without pressure', () => {
  assert.equal(tireReading({ tpms_hard_warning_fl: true, tpms_soft_warning_fl: true }, 'fl').warning, 'hard');
  assert.equal(tireReading({ tpms_soft_warning_fr: true }, 'fr').warning, 'soft');
});
test('missing warning flags never imply no warning', () => {
  assert.equal(tireReading(undefined, 'fl').warning, 'unknown');
  assert.equal(tireReading({ tpms_pressure_fl: 2.9, tpms_hard_warning_fl: false }, 'fl').warning, 'unknown');
  assert.equal(tireReading({ tpms_hard_warning_fl: false, tpms_soft_warning_fl: false }, 'fl').warning, 'clear');
});
test('wheel positions do not mix their pressures and alerts', () => {
  const state = { tpms_pressure_fl: 2.1, tpms_pressure_fr: 2.2, tpms_pressure_rl: 2.3, tpms_pressure_rr: 2.4, tpms_hard_warning_rr: true };
  assert.deepEqual(['fl', 'fr', 'rl', 'rr'].map((position) => tireReading(state, position as 'fl' | 'fr' | 'rl' | 'rr').bar), [2.1, 2.2, 2.3, 2.4]);
  assert.equal(tireReading(state, 'rr').warning, 'hard');
  assert.equal(tireReading(state, 'rl').warning, 'unknown');
});
