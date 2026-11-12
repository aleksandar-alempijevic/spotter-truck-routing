import type { components } from './schema';

export async function fetchHealth(): Promise<components['schemas']['HealthOut']> {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}`);
  }
  return response.json();
}
