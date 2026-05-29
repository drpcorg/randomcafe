import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from './types.js';

function apiKeyEnvName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type CreateAgentSessionOptions = NonNullable<Parameters<PiSdk['createAgentSession']>[0]>;
type ConfiguredPiSessionOptions = Omit<CreateAgentSessionOptions, 'authStorage' | 'modelRegistry' | 'model'>;

type StoredApiKeyCredential = {
  type?: string;
  key?: string;
};

function readStoredApiKey(pi: PiSdk, provider: string): string | undefined {
  const authPath = join(pi.getAgentDir(), 'auth.json');
  if (!existsSync(authPath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, StoredApiKeyCredential | undefined>;
    const rawKey = data[provider]?.type === 'api_key' ? data[provider]?.key?.trim() : undefined;
    if (!rawKey) return undefined;
    return process.env[rawKey] || rawKey;
  } catch {
    return undefined;
  }
}

export async function createConfiguredPiSession(pi: PiSdk, config: RuntimeConfig, options: ConfiguredPiSessionOptions) {
  const provider = config.piProvider.trim();
  const modelId = config.piModel.trim();
  const authStorage = pi.AuthStorage.inMemory();
  const storedApiKey = readStoredApiKey(pi, provider);
  if (storedApiKey) authStorage.setRuntimeApiKey(provider, storedApiKey);

  const modelRegistry = pi.ModelRegistry.create(authStorage);
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Pi model ${provider}/${modelId} is not available`);

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`No API key found for ${provider}/${modelId}. Mount ~/.pi/agent or set ${apiKeyEnvName(provider)}.`);
  }

  return pi.createAgentSession({
    ...options,
    authStorage,
    modelRegistry,
    model,
  });
}
