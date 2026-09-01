/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'src-tauri', 'src', name), 'utf8');
const rustTokens = (value: string) => value.replace(/\s+/gu, '').replace(/,([}\])])/gu, '$1');
const expectRustTokens = (rust: string, expected: string) => expect(rustTokens(rust)).toContain(rustTokens(expected));
describe('native lifecycle root contracts', () => {
  // Actual spawn, timeout, and process-tree rollback behavior needs a controlled
  // process supervisor. This intentionally stays a single source-wiring guard;
  // it must not be read as an end-to-end lifecycle behavior test.
  it('guards exact-generation rollback wiring and lifecycle lock order', () => {
    const rust = source('sidecar.rs');
    expectRustTokens(rust, 'pub struct RuntimeStartResult { pub status: RuntimeStatus, pub runtime_generation: String, pub started_here: bool }');
    expectRustTokens(rust, 'UnownedStartRollback::new(self.clone(), generation.clone())');
    expectRustTokens(rust, 'stop_unowned_generation_exact');
    const timeout = rust.slice(rust.indexOf('runtime_start_timeout'), rust.indexOf('async fn fail_start'));
    expect(timeout).toContain('drop(transition);');
    expect(timeout).toContain('stop_unowned_generation_exact(&generation)');
    expect(timeout).not.toContain('stop_generation_exact(&generation)');
    expect(rust).toContain('if state.phase != RuntimePhase::Stopping');
    expect(rust).toContain('Runtime generation changed before conditional stop acquired the lifecycle barrier');
    const spawnFailure = rust.slice(
      rust.indexOf('Err(error) => {', rust.indexOf('match self.spawn_generation')),
      rust.indexOf('async fn fail_start'),
    );
    expectRustTokens(spawnFailure, 'self.fail_start::<()>(generation.clone(), original.clone()).await');
    expectRustTokens(spawnFailure, 'drop(transition);');
    expectRustTokens(spawnFailure, 'self.stop_unowned_generation_exact(&generation).await');
    expectRustTokens(spawnFailure, 'rollback.disarm()');
  });

  // This checks the IPC-to-lease wiring only. Receiver-loss behavior belongs to
  // the contained-process live gate; this source guard is not behavior evidence.
  it('guards transaction-lease cleanup wiring at the IPC response boundary', () => {
    const rust = source('commands.rs');
    expect(rust).toContain('struct RuntimeTransactionLease');
    expect(rust).toContain('impl Drop for RuntimeTransactionLease');
    expectRustTokens(rust, 'let mut lease = RuntimeTransactionLease::new(operation');
    expectRustTokens(rust, 'if sender.send(result).is_err()');
    expectRustTokens(rust, 'let _ = lease.rollback().await;');
  });

  it('wires cancel and confirmed shutdown into the Tauri boundary', () => {
    const rust = source('lib.rs');
    const handler = readFileSync(resolve(process.cwd(), '..', '..', 'packages', 'contracts', 'generated', 'desktop', 'native_bridge_handler.rs'), 'utf8');
    expect(handler).toContain('commands::renderer_session_cancel');
    expect(rust).toContain('commands::shutdown_for_exit(&state).await');
    expect(rust).toContain('WindowEvent::CloseRequested');
    expect(rust).toContain('api.prevent_close()');
    expect(rust).toContain('begin_confirmed_shutdown(window.app_handle().clone())');
    expect(rust).toContain('window.show()');
    expect(rust).toContain('api.prevent_exit()');
  });

});
