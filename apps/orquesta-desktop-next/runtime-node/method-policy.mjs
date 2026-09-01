import fs from 'node:fs';
import { validateMethodPolicy } from '../../../packages/contracts/src/runtime-method-policy-validator.mjs';

export function loadPackagedMethodPolicy(policyPath) {
  const bytes = fs.readFileSync(policyPath);
  let input;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error('runtime_method_policy_json_invalid', { cause });
  }
  return Object.freeze({
    bytes,
    policy: validateMethodPolicy(input),
  });
}
