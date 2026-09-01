#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateMethodPolicy } from '../src/runtime-method-policy-validator.mjs';

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const desktopContractPaths = Object.freeze({
  manifest: path.join(contractsRoot, 'desktop', 'native-bridge-manifest.v1.json'),
  fixtures: path.join(contractsRoot, 'desktop', 'fixtures', 'native-bridge-fixtures.v1.json'),
  policy: path.join(contractsRoot, 'desktop', 'runtime-method-policy.v1.json'),
  rustContract: path.join(contractsRoot, 'generated', 'desktop', 'native_bridge_contract.rs'),
  rustHandler: path.join(contractsRoot, 'generated', 'desktop', 'native_bridge_handler.rs'),
  typescript: path.join(contractsRoot, 'generated', 'desktop', 'native-bridge-contract.ts'),
});

function exactKeys(value) {
  return Object.keys(value).sort();
}

function sameKeys(left, right) {
  return exactKeys(left).join('\n') === exactKeys(right).join('\n');
}

function assertExactShape(value, keys, code) {
  const expected = Object.fromEntries(keys.map((key) => [key, true]));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !sameKeys(value, expected)) {
    throw new Error(code);
  }
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(code);
  }
}

function validateManifest(manifest) {
  assertExactShape(manifest, ['schemaVersion', 'tauri', 'contentPolicy', 'commands', 'binaryTransports', 'events'], 'desktop_bridge_manifest_invalid');
  if (manifest.schemaVersion !== 1) throw new Error('desktop_bridge_manifest_invalid');
  assertExactShape(manifest.tauri, ['argumentKey', 'rejectUnknownCommands', 'responseEnvelope'], 'desktop_bridge_tauri_invalid');
  assertExactShape(manifest.tauri.responseEnvelope, ['schemaVersion', 'resultKey'], 'desktop_bridge_response_invalid');
  if (manifest.tauri.argumentKey !== 'input'
      || manifest.tauri.rejectUnknownCommands !== true
      || manifest.tauri.responseEnvelope.schemaVersion !== 1
      || manifest.tauri.responseEnvelope.resultKey !== 'result') {
    throw new Error('desktop_bridge_tauri_invalid');
  }
  validateContentPolicy(manifest.contentPolicy);
  for (const [name, entries, keyPattern, valuePattern] of [
    ['commands', manifest.commands, /^[a-z][A-Za-z0-9]*$/u, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u],
    ['events', manifest.events, /^[a-z][A-Za-z0-9]*$/u, /^orquesta-next:\/\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u],
  ]) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
      throw new Error(`desktop_bridge_${name}_invalid`);
    }
    if (Object.entries(entries).some(([key, value]) => !keyPattern.test(key) || typeof value !== 'string' || !valuePattern.test(value))) {
      throw new Error(`desktop_bridge_${name}_name_invalid`);
    }
    if (new Set(Object.values(entries)).size !== Object.keys(entries).length) {
      throw new Error(`desktop_bridge_${name}_duplicate_value`);
    }
  }
  if (!manifest.binaryTransports
      || typeof manifest.binaryTransports !== 'object'
      || Array.isArray(manifest.binaryTransports)
      || Object.keys(manifest.binaryTransports).length === 0) {
    throw new Error('desktop_bridge_binary_transports_invalid');
  }
  const modes = new Set(['json_envelope', 'raw_octet_stream']);
  for (const [command, transport] of Object.entries(manifest.binaryTransports)) {
    if (!Object.hasOwn(manifest.commands, command)) {
      throw new Error('desktop_bridge_binary_transport_command_unknown');
    }
    assertExactShape(transport, ['request', 'response'], 'desktop_bridge_binary_transport_invalid');
    if (!modes.has(transport.request) || !modes.has(transport.response)) {
      throw new Error('desktop_bridge_binary_transport_mode_invalid');
    }
    if (transport.request === 'json_envelope' && transport.response === 'json_envelope') {
      throw new Error('desktop_bridge_binary_transport_redundant');
    }
  }
}

function isBoundedPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateContentPolicy(policy) {
  assertExactShape(policy, ['schemaVersion', 'message', 'voice', 'attachments'], 'desktop_content_policy_invalid');
  assertExactShape(policy?.message, ['maxUtf8Bytes'], 'desktop_content_policy_message_invalid');
  assertExactShape(policy?.voice, ['transcriptMaxUtf8Bytes'], 'desktop_content_policy_voice_invalid');
  assertExactShape(policy?.attachments, [
    'maxPerDispatch',
    'maxImageBytes',
    'maxTextBytes',
    'maxTextBytesPerDispatch',
    'maxImagePreviewBytes',
    'formats',
  ], 'desktop_content_policy_attachments_invalid');
  if (policy.schemaVersion !== 1
      || !isBoundedPositiveInteger(policy.message.maxUtf8Bytes, 1_000_000)
      || !isBoundedPositiveInteger(policy.voice.transcriptMaxUtf8Bytes, 1_000_000)
      || policy.voice.transcriptMaxUtf8Bytes > policy.message.maxUtf8Bytes) {
    throw new Error('desktop_content_policy_text_invalid');
  }
  const attachments = policy.attachments;
  if (!isBoundedPositiveInteger(attachments.maxPerDispatch, 64)
      || !isBoundedPositiveInteger(attachments.maxImageBytes, 256 * 1024 * 1024)
      || !isBoundedPositiveInteger(attachments.maxTextBytes, 16 * 1024 * 1024)
      || !isBoundedPositiveInteger(attachments.maxTextBytesPerDispatch, 64 * 1024 * 1024)
      || !isBoundedPositiveInteger(attachments.maxImagePreviewBytes, attachments.maxImageBytes)
      || attachments.maxTextBytesPerDispatch < attachments.maxTextBytes
      || attachments.maxTextBytesPerDispatch > attachments.maxTextBytes * attachments.maxPerDispatch
      || !Array.isArray(attachments.formats)
      || attachments.formats.length === 0
      || attachments.formats.length > 256) {
    throw new Error('desktop_content_policy_attachment_limits_invalid');
  }
  const extensions = new Set();
  let imageFormats = 0;
  let textFormats = 0;
  for (const format of attachments.formats) {
    assertExactShape(format, ['extension', 'kind', 'mediaType'], 'desktop_content_policy_attachment_format_invalid');
    if (typeof format.extension !== 'string'
        || !/^\.[a-z0-9]+$/u.test(format.extension)
        || extensions.has(format.extension)
        || !['image', 'text'].includes(format.kind)
        || typeof format.mediaType !== 'string'
        || !/^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/u.test(format.mediaType)
        || (format.kind === 'image') !== format.mediaType.startsWith('image/')) {
      throw new Error('desktop_content_policy_attachment_format_invalid');
    }
    extensions.add(format.extension);
    if (format.kind === 'image') imageFormats += 1;
    else textFormats += 1;
  }
  if (imageFormats === 0 || textFormats === 0) {
    throw new Error('desktop_content_policy_attachment_formats_incomplete');
  }
}

function validateFixtures(manifest, fixtures, policy) {
  assertExactShape(fixtures, ['schemaVersion', 'commands', 'events', 'scenarios'], 'desktop_bridge_fixtures_invalid');
  if (fixtures.schemaVersion !== 1
      || !sameKeys(fixtures.commands || {}, manifest.commands)
      || !sameKeys(fixtures.events || {}, manifest.events)) {
    throw new Error('desktop_bridge_fixtures_mismatch');
  }
  for (const command of Object.keys(manifest.commands)) {
    const transport = manifest.binaryTransports[command] ?? {
      request: 'json_envelope',
      response: 'json_envelope',
    };
    const fixture = fixtures.commands[command];
    const args = fixture?.args;
    const response = fixture?.response;
    if (transport.request === 'raw_octet_stream') {
      if (!args || !sameKeys(args, { rawHeaders: true, rawBodyBase64: true })
          || typeof args.rawBodyBase64 !== 'string'
          || !args.rawHeaders || typeof args.rawHeaders !== 'object' || Array.isArray(args.rawHeaders)) {
        throw new Error('desktop_bridge_binary_fixture_request_invalid');
      }
    } else if (!args || !sameKeys(args, { input: true })
        || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)
        || args.input.schemaVersion !== 1) {
      throw new Error('desktop_bridge_json_fixture_request_invalid');
    }
    if (transport.response === 'raw_octet_stream') {
      if (!response || !sameKeys(response, { rawBodyBase64: true }) || typeof response.rawBodyBase64 !== 'string') {
        throw new Error('desktop_bridge_binary_fixture_response_invalid');
      }
    } else if (!response || !sameKeys(response, { schemaVersion: true, result: true })
        || response.schemaVersion !== 1) {
      throw new Error('desktop_bridge_json_fixture_response_invalid');
    }
  }
  const interrupt = fixtures.scenarios?.interruptAccepted;
  const method = interrupt && policy?.methods?.[interrupt.runtimeMethod];
  if (!interrupt
      || interrupt.nativeCommand !== 'interruptTurn'
      || manifest.commands[interrupt.nativeCommand] !== 'runtime_turn_interrupt'
      || interrupt.runtimeMethod !== 'runtime.turn.interrupt'
      || method?.mutationKind !== 'interrupt'
      || method?.recoveryStrategy !== 'exact_turn_interrupt'
      || method?.responseType !== interrupt.acceptedEvent?.type
      || interrupt.acceptedEvent?.type !== 'runtime.turn.interrupt.accepted') {
    throw new Error('desktop_bridge_interrupt_chain_mismatch');
  }
  const steer = fixtures.scenarios?.steerAccepted;
  const steerMethod = steer && policy?.methods?.[steer.runtimeMethod];
  if (!steer
      || steer.nativeCommand !== 'steerTurn'
      || manifest.commands[steer.nativeCommand] !== 'runtime_turn_steer'
      || steer.runtimeMethod !== 'runtime.turn.steer'
      || steerMethod?.mutationKind !== 'steer'
      || steerMethod?.recoveryStrategy !== 'exact_turn_steer'
      || steerMethod?.responseType !== steer.acceptedEvent?.type
      || steer.acceptedEvent?.type !== 'runtime.turn.steer.accepted') {
    throw new Error('desktop_bridge_steer_chain_mismatch');
  }
}

function rustEntries(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `    (${JSON.stringify(key)}, ${JSON.stringify(value)}),`)
    .join('\n');
}

function rustGeneratedConstantName(prefix, key) {
  const snake = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toUpperCase();
  return `${prefix}_${snake}`;
}

function rustNamedConstants(prefix, entries) {
  return Object.entries(entries)
    .map(([key, value]) => `pub const ${rustGeneratedConstantName(prefix, key)}: &str = ${JSON.stringify(value)};`)
    .join('\n');
}

function rustHandlerEntries(commands) {
  return Object.values(commands)
    .map((command) => `            commands::${command},`)
    .join('\n');
}

function rustBinaryTransportEntries(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `    (${JSON.stringify(key)}, ${JSON.stringify(value.request)}, ${JSON.stringify(value.response)}),`)
    .join('\n');
}

function rustAttachmentFormatEntries(formats) {
  return formats
    .map(({ extension, kind, mediaType }) => (
      `    (${JSON.stringify(extension)}, ${JSON.stringify(kind)}, ${JSON.stringify(mediaType)}),`
    ))
    .join('\n');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function renderRustContract(manifest, manifestBytes, fixtureBytes) {
  return `// @generated by packages/contracts/scripts/generate-desktop-bindings.mjs\n\
// Source: packages/contracts/desktop/native-bridge-manifest.v1.json\n\
// Manifest SHA-256: ${digest(manifestBytes)}\n\
// Fixture SHA-256: ${digest(fixtureBytes)}\n\
\n\
pub const GENERATED_NATIVE_BRIDGE_COMMANDS: &[(&str, &str)] = &[\n\
${rustEntries(manifest.commands)}\n\
];\n\
\n\
pub const GENERATED_NATIVE_BRIDGE_EVENTS: &[(&str, &str)] = &[\n\
${rustEntries(manifest.events)}\n\
];\n\
\n\
${rustNamedConstants('GENERATED_NATIVE_EVENT', manifest.events)}\n\
\n\
pub const GENERATED_NATIVE_BRIDGE_BINARY_TRANSPORTS: &[(&str, &str, &str)] = &[\n\
${rustBinaryTransportEntries(manifest.binaryTransports)}\n\
];\n\
\n\
pub const GENERATED_CONTENT_POLICY_SCHEMA_VERSION: u32 = ${manifest.contentPolicy.schemaVersion};\n\
pub const GENERATED_MESSAGE_TEXT_MAX_UTF8_BYTES: usize = ${manifest.contentPolicy.message.maxUtf8Bytes};\n\
pub const GENERATED_VOICE_TRANSCRIPT_MAX_UTF8_BYTES: usize = ${manifest.contentPolicy.voice.transcriptMaxUtf8Bytes};\n\
pub const GENERATED_ATTACHMENT_MAX_PER_DISPATCH: usize = ${manifest.contentPolicy.attachments.maxPerDispatch};\n\
pub const GENERATED_ATTACHMENT_MAX_IMAGE_BYTES: u64 = ${manifest.contentPolicy.attachments.maxImageBytes};\n\
pub const GENERATED_ATTACHMENT_MAX_TEXT_BYTES: u64 = ${manifest.contentPolicy.attachments.maxTextBytes};\n\
pub const GENERATED_ATTACHMENT_MAX_TEXT_BYTES_PER_DISPATCH: u64 = ${manifest.contentPolicy.attachments.maxTextBytesPerDispatch};\n\
pub const GENERATED_ATTACHMENT_MAX_IMAGE_PREVIEW_BYTES: u64 = ${manifest.contentPolicy.attachments.maxImagePreviewBytes};\n\
pub const GENERATED_ATTACHMENT_FORMATS: &[(&str, &str, &str)] = &[\n\
${rustAttachmentFormatEntries(manifest.contentPolicy.attachments.formats)}\n\
];\n`;
}

function renderRustHandler(manifest, manifestBytes) {
  return `// @generated by packages/contracts/scripts/generate-desktop-bindings.mjs\n\
// Source: packages/contracts/desktop/native-bridge-manifest.v1.json\n\
// Manifest SHA-256: ${digest(manifestBytes)}\n\
\n\
macro_rules! generated_native_bridge_handler {\n\
    () => {\n\
        tauri::generate_handler![\n\
${rustHandlerEntries(manifest.commands)}\n\
        ]\n\
    };\n\
}\n`;
}

function renderTypescript(manifest, manifestBytes) {
  return `// @generated by packages/contracts/scripts/generate-desktop-bindings.mjs\n\
// Source: packages/contracts/desktop/native-bridge-manifest.v1.json\n\
// Manifest SHA-256: ${digest(manifestBytes)}\n\
\n\
export const NATIVE_BRIDGE_SCHEMA_VERSION = ${manifest.schemaVersion} as const;\n\
export const NATIVE_BRIDGE_TAURI = Object.freeze(${JSON.stringify(manifest.tauri, null, 2)} as const);\n\
export const NATIVE_CONTENT_POLICY = Object.freeze(${JSON.stringify(manifest.contentPolicy, null, 2)} as const);\n\
export const NATIVE_ATTACHMENT_PICKER_ACCEPT = ${JSON.stringify(manifest.contentPolicy.attachments.formats.map(({ extension }) => extension).join(','))} as const;\n\
export const NATIVE_COMMANDS = Object.freeze(${JSON.stringify(manifest.commands, null, 2)} as const);\n\
export const NATIVE_BINARY_TRANSPORTS = Object.freeze(${JSON.stringify(manifest.binaryTransports, null, 2)} as const);\n\
export const NATIVE_EVENTS = Object.freeze(${JSON.stringify(manifest.events, null, 2)} as const);\n\
export type NativeCommandName = keyof typeof NATIVE_COMMANDS;\n\
export type NativeEventName = keyof typeof NATIVE_EVENTS;\n`;
}

export function renderDesktopBindings(manifestBytes, fixtureBytes, policyBytes) {
  const manifest = parseJson(manifestBytes, 'desktop_bridge_manifest_json_invalid');
  const fixtures = parseJson(fixtureBytes, 'desktop_bridge_fixtures_json_invalid');
  const policy = parseJson(policyBytes, 'runtime_method_policy_json_invalid');
  validateManifest(manifest);
  const validatedPolicy = validateMethodPolicy(policy);
  validateFixtures(manifest, fixtures, validatedPolicy);
  return Object.freeze({
    rustContract: renderRustContract(manifest, manifestBytes, fixtureBytes),
    rustHandler: renderRustHandler(manifest, manifestBytes),
    typescript: renderTypescript(manifest, manifestBytes),
  });
}

export function assertGeneratedContent(actual, expected, outputPath) {
  if (actual !== expected) {
    throw new Error(`desktop_bridge_bindings_stale:${path.basename(outputPath)}`);
  }
}

export async function generateDesktopBindings({ check = false } = {}) {
  const [manifestBytes, fixtureBytes, policyBytes] = await Promise.all([
    readFile(desktopContractPaths.manifest),
    readFile(desktopContractPaths.fixtures),
    readFile(desktopContractPaths.policy),
  ]);
  const rendered = renderDesktopBindings(manifestBytes, fixtureBytes, policyBytes);
  const outputs = [
    [desktopContractPaths.rustContract, rendered.rustContract],
    [desktopContractPaths.rustHandler, rendered.rustHandler],
    [desktopContractPaths.typescript, rendered.typescript],
  ];
  if (check) {
    for (const [outputPath, expected] of outputs) {
      const actual = await readFile(outputPath, 'utf8').catch(() => '');
      assertGeneratedContent(actual, expected, outputPath);
    }
    return desktopContractPaths;
  }
  await Promise.all(outputs.map(async ([outputPath, expected]) => {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, expected, 'utf8');
  }));
  return desktopContractPaths;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--check')) {
    throw new Error('desktop_bridge_direct_generation_retired_use_locked_desktop_build');
  }
  await generateDesktopBindings({ check: true });
  console.log('Desktop bridge bindings are current');
}
