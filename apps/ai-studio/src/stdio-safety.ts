interface ErrorEventSource {
  on(event: 'error', listener: (cause: unknown) => void): unknown;
}

export function installStdioErrorGuards(streams: readonly (ErrorEventSource | null | undefined)[], onUnexpected?: (cause: unknown) => void): void {
  for (const stream of streams) stream?.on('error', (cause) => {
    if (errorCode(cause) !== 'EPIPE') onUnexpected?.(cause);
  });
}

function errorCode(value: unknown): string | null {
  return value instanceof Error && 'code' in value && typeof value.code === 'string' ? value.code : null;
}
