const env = ((typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env) || {}) as Record<string, string | undefined>;

const readUrlEnv = (...values: Array<string | undefined>) => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, '');
  }
  return '';
};

export const APP_CONFIG = {
  apiBaseUrl: readUrlEnv(env.VITE_API_BASE_URL)
};
