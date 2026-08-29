import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';

const registry = new ComponentRegistry();
let sequence = 0;
const component = (type, value = {}) => registry.create({ id: `component:g08-visual-${++sequence}`, type, version: '1.0.0', value });

const pass = (kind, order, enabled = true) => ({ kind, enabled, order, radius: 1, sigma: 2, feedback: 0.9, sharpness: 0.15, intensity: 1, sampleCount: 12, maxBlurPixels: 32, blendMode: 'add', quality: 'medium', visibleColor: [1, 1, 1, 1], hiddenColor: [0.1, 0.04, 0.02, 1] });

export const genreVisualFixtures = Object.freeze([
  { genre: 'snake', oracle: ['board-readability', 'player-food-differentiation', 'camera-framing'], components: [component('haiyue.render.profile', { clearColor: [0.015, 0.025, 0.02, 1] }), component('haiyue.material.pbr', { baseColor: [0.1, 0.9, 0.35, 1], roughness: 0.8 })] },
  { genre: 'match-3', oracle: ['board-readability', 'tile-differentiation', 'match-feedback'], components: [component('haiyue.render.postprocess-stack', { passes: [pass('fxaa', 10)] }), component('haiyue.particles.2d', { startColor: [1, 0.4, 0.8, 1] })] },
  { genre: 'tetris', oracle: ['board-readability', 'active-piece-differentiation', 'line-clear-feedback'], components: [component('haiyue.render.postprocess-stack', { passes: [pass('outline', 10), pass('fxaa', 20)] })] },
  { genre: 'jigsaw', oracle: ['piece-boundaries', 'target-differentiation', 'snap-feedback'], components: [component('haiyue.material.pbr', { metallic: 0, roughness: 0.9 })] },
  { genre: 'platformer', oracle: ['player-goal-differentiation', 'camera-framing', 'depth-cues'], components: [component('haiyue.render.fog', { distanceStart: 30, distanceEnd: 80 }), component('haiyue.light.environment')] },
  { genre: 'racing', oracle: ['track-readability', 'vehicle-differentiation', 'speed-feedback'], components: [component('haiyue.render.postprocess-stack', { passes: [pass('motion-blur', 10, false), pass('fxaa', 20)] })] },
  { genre: 'shooter', oracle: ['player-enemy-differentiation', 'aim-feedback', 'hit-feedback'], components: [component('haiyue.particles.3d', { burst: 24, emissionRate: 0, loop: false }), component('haiyue.render.postprocess-stack', { passes: [pass('outline', 10)] })] },
]);
