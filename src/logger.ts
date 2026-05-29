import pino from 'pino';

const secretKeys = ['token', 'secret', 'authorization', 'cookie', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        '*.token',
        '*.secret',
        '*.authorization',
        '*.cookie',
        'SLACK_BOT_TOKEN',
        'SLACK_APP_TOKEN',
        'SLACK_SIGNING_SECRET',
        'payload.token',
        'payload.api_app_id',
        'payload.response_url',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}

export function sanitizeForLog(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (secretKeys.some((secretKey) => lowerKey.includes(secretKey.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    } else if (lowerKey === 'payload' || lowerKey === 'view' || lowerKey === 'message') {
      sanitized[key] = '[OMITTED]';
    } else {
      sanitized[key] = sanitizeForLog(nested);
    }
  }
  return sanitized;
}
