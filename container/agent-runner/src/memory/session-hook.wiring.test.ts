import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Claude memory hook wiring', () => {
  const providerSource = fs.readFileSync(path.join(import.meta.dir, '..', 'providers', 'claude.ts'), 'utf-8');
  const runnerSource = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');
  const groupInitSource = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', '..', '..', 'src', 'group-init.ts'),
    'utf-8',
  );

  it('passes the shared hook to Claude without a second SDK hook path', () => {
    // Workstream C15: index.ts no longer calls provider.registerMemorySessionHook
    // directly — it goes through the module-level registerProviderMemorySessionHook
    // (provider-contracts/realize.ts), which resolves the contract's memory
    // capability and calls the provider's own method internally. Still exactly
    // one path from the shared hook to the provider, just one level removed.
    expect(runnerSource).toMatch(/registerProviderMemorySessionHook\(providerName, provider, MEMORY_SESSION_HOOK\)/);
    expect(providerSource).toMatch(/registerMemorySessionHook\(hook: MemorySessionHookRegistration, memory\?: unknown\)/);
    expect(providerSource).not.toContain('memorySessionStartHook');
    expect(providerSource).not.toContain('providesMemorySessionHook');
    expect(groupInitSource).not.toContain('MEMORY_SESSION_START_MATCHER');
  });
});
