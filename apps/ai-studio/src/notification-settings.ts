export interface NotificationPreferences {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly sound: boolean;
  readonly backgroundOnly: boolean;
  readonly language: 'zh-CN' | 'en';
}
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({ schemaVersion: 1, enabled: true, sound: true, backgroundOnly: true, language: 'zh-CN' });
export function parseNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid notification preferences.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'backgroundOnly,enabled,language,schemaVersion,sound' || v.schemaVersion !== 1
    || typeof v.enabled !== 'boolean' || typeof v.sound !== 'boolean' || typeof v.backgroundOnly !== 'boolean' || !['zh-CN', 'en'].includes(String(v.language))) throw new TypeError('Invalid notification preferences.');
  return Object.freeze({ schemaVersion: 1, enabled: v.enabled, sound: v.sound, backgroundOnly: v.backgroundOnly, language: v.language as 'zh-CN' | 'en' });
}
