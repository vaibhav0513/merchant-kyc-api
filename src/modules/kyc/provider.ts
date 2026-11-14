import crypto from 'crypto';
import { config } from '../../config/env';

export type ProviderResult = {
  providerRef: string;
  outcome: 'SUCCESS' | 'FAILED' | 'PENDING' | 'TIMEOUT';
};

// Mock of an external KYC provider. A real one would be an HTTPS call
// authenticated with config.kycApiKey. Everything here is simulated.
export async function callProvider(identityRef: string): Promise<ProviderResult> {
  if (!config.kycApiKey) throw new Error('KYC provider key not configured');

  const providerRef = 'PRV-' + crypto.randomBytes(8).toString('hex');
  const last = identityRef.slice(-1);

  const map: Record<string, ProviderResult['outcome']> = {
    '0': 'SUCCESS',
    '1': 'FAILED',
    '2': 'PENDING',
    '3': 'TIMEOUT',
  };
  return { providerRef, outcome: map[last] ?? 'SUCCESS' };
}