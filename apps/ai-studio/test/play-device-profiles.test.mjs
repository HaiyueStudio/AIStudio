import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAY_DEVICE_PROFILES,
  calculatePlayViewportScale,
  findPlayDeviceProfile,
  normalizePlayViewportSize,
  rotatePlayViewportSize,
} from '../dist/play-device-profiles.js';

test('play page exposes mainstream phone and tablet profiles', () => {
  assert.ok(PLAY_DEVICE_PROFILES.filter((profile) => profile.category === 'phone').length >= 4);
  assert.ok(PLAY_DEVICE_PROFILES.filter((profile) => profile.category === 'tablet').length >= 2);
  assert.deepEqual(findPlayDeviceProfile('iphone-15-pro'), {
    id: 'iphone-15-pro', label: 'iPhone 15 Pro', category: 'phone', width: 393, height: 852,
  });
});

test('custom play sizes clamp, rotate and fit without changing logical pixels', () => {
  assert.deepEqual(normalizePlayViewportSize(100, 9_000), { width: 240, height: 3_840 });
  assert.deepEqual(rotatePlayViewportSize({ width: 393, height: 852 }), { width: 852, height: 393 });
  assert.equal(calculatePlayViewportScale({ width: 393, height: 852 }, { width: 1_200, height: 800 }), 752 / 852);
  assert.equal(calculatePlayViewportScale({ width: 393, height: 852 }, { width: 1_600, height: 1_200 }), 1);
});
