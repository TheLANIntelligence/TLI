const test = require('node:test');
const assert = require('node:assert/strict');
const {compareReadings} = require('../js/game-trials.js');

test('FPS and 1% low improvements use the original reading as the baseline', () => {
  for (const metric of ['fps', 'low-fps']) {
    const gain = compareReadings('60', '75', metric);
    assert.equal(gain.percent, 25);
    assert.equal(gain.improved, true);
    assert.equal(gain.unit, 'FPS');
    const loss = compareReadings(75, 60, metric);
    assert.equal(loss.percent, -20);
    assert.equal(loss.improved, false);
  }
});
test('lower frame time is favorable; higher frame time is unfavorable', () => {
  const gain = compareReadings('20', '15', 'frame-time');
  assert.equal(gain.percent, -25);
  assert.equal(gain.direction, 'lower');
  assert.equal(gain.improved, true);
  assert.equal(gain.unit, 'ms');
  assert.equal(compareReadings(15,20,'frame-time').improved, false);
});
test('equal readings do not imply an improvement', () => {
  const result = compareReadings(60,60,'fps');
  assert.equal(result.direction,'unchanged');
  assert.equal(result.percent,0);
  assert.equal(result.improved,false);
});
test('missing, nonnumeric and implausible readings cannot become reported gains', () => {
  for (const value of ['', ' ', null, undefined, false, true, {}, [], NaN, Infinity, -1, 0, 1e-309, 1001]) {
    assert.throws(() => compareReadings(value,60,'fps'), String(value));
    assert.throws(() => compareReadings(60,value,'fps'), String(value));
  }
  assert.throws(() => compareReadings(16,10001,'frame-time'));
  assert.throws(() => compareReadings(60,80,'cpu'));
  assert.ok(Number.isFinite(compareReadings(0.01,1000,'fps').percent));
});
