export interface PlayViewportSize { readonly width: number; readonly height: number; }
export interface PlayDeviceProfile extends PlayViewportSize { readonly id: string; readonly label: string; readonly category: 'phone' | 'tablet'; }

export const MIN_PLAY_VIEWPORT_SIZE = 240;
export const MAX_PLAY_VIEWPORT_SIZE = 3_840;

export const PLAY_DEVICE_PROFILES: readonly PlayDeviceProfile[] = Object.freeze([
  Object.freeze({ id: 'iphone-15-pro', label: 'iPhone 15 Pro', category: 'phone', width: 393, height: 852 }),
  Object.freeze({ id: 'iphone-se', label: 'iPhone SE', category: 'phone', width: 375, height: 667 }),
  Object.freeze({ id: 'pixel-8', label: 'Pixel 8', category: 'phone', width: 412, height: 915 }),
  Object.freeze({ id: 'galaxy-s24', label: 'Galaxy S24', category: 'phone', width: 360, height: 780 }),
  Object.freeze({ id: 'ipad-11', label: 'iPad 11″', category: 'tablet', width: 820, height: 1_180 }),
  Object.freeze({ id: 'ipad-mini', label: 'iPad mini', category: 'tablet', width: 744, height: 1_133 }),
]);

export function findPlayDeviceProfile(id: string): PlayDeviceProfile | null {
  return PLAY_DEVICE_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function normalizePlayViewportSize(width: number, height: number): PlayViewportSize {
  return Object.freeze({ width: clampDimension(width), height: clampDimension(height) });
}

export function rotatePlayViewportSize(size: PlayViewportSize): PlayViewportSize {
  return Object.freeze({ width: size.height, height: size.width });
}

export function calculatePlayViewportScale(size: PlayViewportSize, available: PlayViewportSize, padding = 48): number {
  const safeWidth = Math.max(1, available.width - Math.max(0, padding));
  const safeHeight = Math.max(1, available.height - Math.max(0, padding));
  return Math.max(0.05, Math.min(1, safeWidth / size.width, safeHeight / size.height));
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_PLAY_VIEWPORT_SIZE;
  return Math.min(MAX_PLAY_VIEWPORT_SIZE, Math.max(MIN_PLAY_VIEWPORT_SIZE, Math.round(value)));
}
