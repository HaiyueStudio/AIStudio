import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { Camera3D, SphericalTransform3D, type Scene } from '@haiyue/engine';

export const PROJECT_CAMERA_SETTING_KEY = 'studio.camera.main';

export interface ProjectCameraSnapshot {
  readonly projection: 'perspective' | 'orthographic';
  readonly target: Readonly<{ x: number; y: number; z: number }>;
  readonly distance: number;
  readonly azimuthDegrees: number;
  readonly elevationDegrees: number;
  readonly fovDegrees: number;
  readonly orthographicSize: number;
  readonly near: number;
  readonly far: number;
}

export const DEFAULT_PROJECT_CAMERA: ProjectCameraSnapshot = freezeCamera({
  projection: 'perspective',
  target: { x: 0, y: 0, z: 0 },
  distance: 10,
  azimuthDegrees: 45,
  elevationDegrees: 35,
  fovDegrees: 45,
  orthographicSize: 20,
  near: 0.1,
  far: 1_000,
});

export function projectCameraFromSettings(settings: JsonObject): ProjectCameraSnapshot {
  const value = settings[PROJECT_CAMERA_SETTING_KEY];
  return value === undefined ? DEFAULT_PROJECT_CAMERA : normalizeProjectCamera(value);
}

export function normalizeProjectCamera(value: unknown): ProjectCameraSnapshot {
  if (!isRecord(value)) throw new TypeError('Camera must be an object.');
  exactKeys(value, ['projection', 'target', 'distance', 'azimuthDegrees', 'elevationDegrees', 'fovDegrees', 'orthographicSize', 'near', 'far']);
  if (value.projection !== 'perspective' && value.projection !== 'orthographic') throw new TypeError('Camera projection must be perspective or orthographic.');
  if (!isRecord(value.target)) throw new TypeError('Camera target must be an object.');
  exactKeys(value.target, ['x', 'y', 'z']);
  const camera = freezeCamera({
    projection: value.projection,
    target: {
      x: boundedNumber(value.target.x, 'Camera target x', -10_000, 10_000),
      y: boundedNumber(value.target.y, 'Camera target y', -10_000, 10_000),
      z: boundedNumber(value.target.z, 'Camera target z', -10_000, 10_000),
    },
    distance: boundedNumber(value.distance, 'Camera distance', 0.5, 500),
    azimuthDegrees: boundedNumber(value.azimuthDegrees, 'Camera azimuth', -360, 360),
    elevationDegrees: boundedNumber(value.elevationDegrees, 'Camera elevation', -89.9, 90),
    fovDegrees: boundedNumber(value.fovDegrees, 'Camera field of view', 10, 120),
    orthographicSize: boundedNumber(value.orthographicSize, 'Camera orthographic size', 0.5, 500),
    near: boundedNumber(value.near, 'Camera near plane', 0.01, 100),
    far: boundedNumber(value.far, 'Camera far plane', 0.1, 10_000),
  });
  if (camera.far <= camera.near) throw new TypeError('Camera far plane must be greater than its near plane.');
  return camera;
}

export function applyProjectCamera(scene: Scene, camera: ProjectCameraSnapshot, aspect: number): void {
  const transform = scene.cameraEntity.getComponent(SphericalTransform3D);
  if (!transform) throw new Error('Main camera transform is unavailable.');
  const radians = Math.PI / 180;
  const phi = Math.min(Math.PI - 0.005, Math.max(0.005, (90 - camera.elevationDegrees) * radians));
  transform.setTarget(camera.target.x, camera.target.y, camera.target.z);
  transform.set(camera.distance, camera.azimuthDegrees * radians, phi);
  applyProjectCameraProjection(scene, camera, aspect);
}

export function applyProjectCameraProjection(scene: Scene, camera: ProjectCameraSnapshot, aspect: number): void {
  const component = scene.cameraEntity.getComponent(Camera3D);
  if (!component) throw new Error('Main camera projection is unavailable.');
  const radians = Math.PI / 180;
  component.projectionType = camera.projection;
  component.fov = camera.fovDegrees * radians;
  component.near = camera.near;
  component.far = camera.far;
  component.updateAspect(Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
  const halfHeight = camera.orthographicSize / 2;
  const halfWidth = halfHeight * component.aspect;
  component.orthoLeft = -halfWidth;
  component.orthoRight = halfWidth;
  component.orthoBottom = -halfHeight;
  component.orthoTop = halfHeight;
}

function freezeCamera(value: ProjectCameraSnapshot): ProjectCameraSnapshot {
  return Object.freeze({ ...value, target: Object.freeze({ ...value.target }) });
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError(`Camera requires exactly: ${allowed.join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
