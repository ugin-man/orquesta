const MUTATION_KINDS = new Set([
  'read_only', 'lifecycle', 'dispatch', 'interrupt', 'steer', 'approval',
  'inspection', 'bootstrap', 'projection',
]);
const PROJECT_REQUIREMENTS = new Set(['none', 'activated', 'internal_root']);
const RECOVERY_STRATEGIES = new Set([
  'none', 'native_lifecycle', 'dispatch_outbox', 'native_exact_approval',
  'core_inspection_operation', 'project_bootstrap_saga',
  'projection_internal', 'exact_turn_interrupt', 'exact_turn_steer', 'internal_unavailable',
]);
const EXACT_RECOVERY = Object.freeze({
  read_only: 'none',
  lifecycle: 'native_lifecycle',
  dispatch: 'dispatch_outbox',
  interrupt: 'exact_turn_interrupt',
  steer: 'exact_turn_steer',
  approval: 'native_exact_approval',
  inspection: 'core_inspection_operation',
  bootstrap: 'project_bootstrap_saga',
  projection: 'projection_internal',
});
const ROOT_KEYS = Object.freeze(['methods', 'schemaVersion']);
const ENTRY_KEYS = Object.freeze([
  'attachmentsAllowed', 'defaultTimeoutMs', 'mutationKind', 'projectRequirement',
  'recoveryStrategy', 'rendererExposed', 'responseType',
]);

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

export function validateMethodPolicy(input) {
  if (!hasExactKeys(input, ROOT_KEYS)) throw new Error('runtime_method_policy_shape_invalid');
  if (input.schemaVersion !== 1) throw new Error('runtime_method_policy_schema_unsupported');
  if (!isObject(input.methods)) throw new Error('runtime_method_policy_methods_invalid');

  const validatedMethods = {};
  for (const [method, item] of Object.entries(input.methods)) {
    if (!/^[a-z][a-z0-9.-]{1,127}$/u.test(method)) {
      throw new Error(`runtime_method_policy_name_invalid:${method}`);
    }
    if (!hasExactKeys(item, ENTRY_KEYS)) {
      throw new Error(`runtime_method_policy_entry_shape_invalid:${method}`);
    }
    if (item.responseType !== null
        && (typeof item.responseType !== 'string' || item.responseType.trim().length === 0)) {
      throw new Error(`runtime_method_policy_response_invalid:${method}`);
    }
    if (typeof item.rendererExposed !== 'boolean' || typeof item.attachmentsAllowed !== 'boolean') {
      throw new Error(`runtime_method_policy_boolean_invalid:${method}`);
    }
    if (!MUTATION_KINDS.has(item.mutationKind)
        || !PROJECT_REQUIREMENTS.has(item.projectRequirement)
        || !RECOVERY_STRATEGIES.has(item.recoveryStrategy)) {
      throw new Error(`runtime_method_policy_enum_invalid:${method}`);
    }
    if (!Number.isSafeInteger(item.defaultTimeoutMs)
        || item.defaultTimeoutMs < 1_000
        || item.defaultTimeoutMs > 600_000) {
      throw new Error(`runtime_method_policy_timeout_invalid:${method}`);
    }
    if (item.rendererExposed && item.recoveryStrategy === 'internal_unavailable') {
      throw new Error(`runtime_method_policy_unavailable_exposed:${method}`);
    }
    const expectedRecovery = EXACT_RECOVERY[item.mutationKind];
    const internalUnavailable = !item.rendererExposed
      && item.recoveryStrategy === 'internal_unavailable';
    if (item.recoveryStrategy !== expectedRecovery && !internalUnavailable) {
      throw new Error(`runtime_method_policy_recovery_mismatch:${method}`);
    }
    if (item.attachmentsAllowed
        && !(item.mutationKind === 'dispatch' && item.recoveryStrategy === 'dispatch_outbox')) {
      throw new Error(`runtime_method_policy_attachment_mismatch:${method}`);
    }
    validatedMethods[method] = Object.freeze({ ...item });
  }

  const send = validatedMethods['runtime.send'];
  if (!send
      || send.responseType !== 'runtime.dispatch.accepted'
      || send.rendererExposed !== false
      || send.mutationKind !== 'dispatch'
      || send.projectRequirement !== 'activated'
      || send.attachmentsAllowed !== true
      || send.recoveryStrategy !== 'dispatch_outbox'
      || send.defaultTimeoutMs !== 180_000) {
    throw new Error('runtime_send_must_be_typed_native_dispatch');
  }
  return Object.freeze({ schemaVersion: 1, methods: Object.freeze(validatedMethods) });
}
