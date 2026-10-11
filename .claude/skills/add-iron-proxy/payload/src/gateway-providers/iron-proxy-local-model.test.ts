import { describe, expect, it } from 'vitest';

import { LOCAL_MODEL_HOST, localModelOrigins } from './iron-proxy-local-model.js';

const SETTINGS = { port: 8080 };

describe('localModelOrigins', () => {
  it('admits a declared host.docker.internal authority on a real port', () => {
    const origins = localModelOrigins(SETTINGS, [{ modelAuthorities: ['host.docker.internal:11434'] }]);
    expect(origins).toEqual(['host.docker.internal:11434']);
  });

  it('excludes an authority on a non-local host', () => {
    const origins = localModelOrigins(SETTINGS, [{ modelAuthorities: ['api.example.com:443'] }]);
    expect(origins).toEqual([]);
  });

  it('excludes the default port 80, even on the local host', () => {
    const origins = localModelOrigins(SETTINGS, [{ modelAuthorities: [`${LOCAL_MODEL_HOST}:80`] }]);
    expect(origins).toEqual([]);
  });

  it('excludes a zero-padded "080" the same as "80" (numeric, not string, comparison)', () => {
    const origins = localModelOrigins(SETTINGS, [{ modelAuthorities: [`${LOCAL_MODEL_HOST}:080`] }]);
    expect(origins).toEqual([]);
  });

  it('excludes a port colliding with Iron\'s own front listener', () => {
    const origins = localModelOrigins({ port: 8080 }, [{ modelAuthorities: [`${LOCAL_MODEL_HOST}:8080`] }]);
    expect(origins).toEqual([]);
  });

  it('excludes a port colliding with the macOS approval TLS transport', () => {
    const origins = localModelOrigins({ port: 8080, approvalPort: 20392 }, [
      { modelAuthorities: [`${LOCAL_MODEL_HOST}:20392`] },
    ]);
    expect(origins).toEqual([]);
  });

  it('dedupes and sorts across multiple providers', () => {
    const origins = localModelOrigins(SETTINGS, [
      { modelAuthorities: [`${LOCAL_MODEL_HOST}:11435`, `${LOCAL_MODEL_HOST}:11434`] },
      { modelAuthorities: [`${LOCAL_MODEL_HOST}:11434`] },
    ]);
    expect(origins).toEqual([`${LOCAL_MODEL_HOST}:11434`, `${LOCAL_MODEL_HOST}:11435`]);
  });

  it('returns nothing when no provider declares a local authority', () => {
    expect(localModelOrigins(SETTINGS, [{}, { modelAuthorities: [] }])).toEqual([]);
  });
});
