import {
  BUSINESS_ENGINE_CONTRACT_VERSION,
  BUSINESS_DESKTOP_READ_CONSUMER,
  BUSINESS_DESKTOP_READ_FEATURES,
  BUSINESS_EVENT_SCHEMA_VERSION,
  BUSINESS_PROJECTION_VERSION,
  BRANCH_STATES,
  BusinessPacketStoreError,
  BusinessProviderSettlementCutoverBoundaryError,
  DISPATCH_PACKET_CONTRACT_VERSION,
  DISPATCH_PACKET_STORE_LIMITS,
  DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION,
  EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION,
  EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  EFFECT_SETTLEMENT_SOURCES,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
  LIVE_RUNTIME_OBSERVATION_NAMES,
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  PROVIDER_SETTLEMENT_CONTRACT_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_ACTION,
  PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
  WORK_ORDER_STATES,
  buildProviderSettlementCutoverBatchV1,
  businessProjectionConfigurationV1,
  createBusinessCommandBoundary,
  createBusinessDesktopReadResultV1,
  createBusinessInternalActionBoundary,
  createBusinessObservationBoundary,
  createBusinessProviderSettlementCutoverBoundary,
  createDispatchPacketStore,
  decideWorkOrderV1,
  deriveProviderSettlementCutoverReadinessV1,
  deriveProviderSettlementEpochFromBatchV1,
  initialBusinessProjectionV1,
  normalizeBusinessRuntimeObservationEnvelope,
  normalizeEffectSettlementObservationEnvelopeV2,
  normalizeProviderSettlementCutoverEnvelopeV1,
  normalizeProviderSettlementCutoverReadinessEvidenceV1,
  normalizeProviderSettlementEpochV1,
  projectBusinessEventV1,
  replayBusinessProjectionV1,
  normalizeDispatchPacketV1,
  normalizeDispatchPacketSendAuthorizationVerificationV1,
  normalizeDispatchPacketVerificationReceiptV1,
  type BusinessDispatchPacketSendAuthorizationVerificationV1,
  type BusinessDesktopReadRequestV1,
  type BusinessDesktopReadResultV1,
  type BusinessDispatchPacketStoreOptionsV1,
  type BusinessDispatchPacketStoreV1,
  type BusinessDispatchPacketV1,
  type BusinessDispatchPacketVerificationReceiptV1,
  type BusinessProviderEffectIdentityV2,
  type BusinessProjectionConfigurationV1,
  type BusinessProviderSettlementCutoverBoundaryErrorCodeV1,
  type BusinessProviderSettlementCutoverBoundaryOptionsV1,
  type BusinessProviderSettlementCutoverBoundaryV1,
  type BusinessProviderSettlementCutoverBuiltBatchV1,
  type BusinessProviderSettlementCutoverEnvelopeV1,
  type BusinessProviderSettlementCutoverReadinessEvidenceV1,
  type BusinessProviderSettlementCutoverResultV1,
  type BusinessProviderSettlementEpochV1,
  type BusinessProviderSettlementProjectedReadinessV1,
  type BusinessProviderSettlementReceiptV1,
  type BusinessBranchStateName,
  type BusinessCommandBoundaryOptionsV1,
  type BusinessInternalActionBoundaryOptionsV1,
  type BusinessHistoricalInternalActionResultV1,
  type BusinessObservationBoundaryOptionsV1,
  type BusinessObservationBoundaryV1,
  type BusinessOutboxSendBeginResultV1,
  type BusinessOutboxLeaseRenewResultV1,
  type BusinessProviderEntryWindowContinuationV1,
  type BusinessProviderEntryWindowIndexV1,
  type BusinessSendAuthorizationBundleV1,
  type BusinessDecisionV1,
  type BusinessEventV1,
  type EffectSettlementObservationEnvelopeV2,
  type EffectSettlementObservationName,
  type EffectSettlementSource,
  type EffectSendExpiryObservationEnvelopeV2,
  type EffectSendExpiryObservationName,
  type EffectPresendFailureObservationEnvelopeV2,
  type EffectPresendFailureObservationName,
  type BusinessProjectionV1,
  type LiveRuntimeObservationName,
  type RuntimeObservationEnvelopeV1,
  type BusinessWorkOrderStateName,
} from "../src/index.js";

const projection: Readonly<BusinessProjectionV1> = initialBusinessProjectionV1();
declare const desktopRequest: BusinessDesktopReadRequestV1;
const desktopResult: Readonly<BusinessDesktopReadResultV1> =
  createBusinessDesktopReadResultV1({
    request: desktopRequest,
    projection,
    cursor: {
      journalSequence: 0,
      lastBatchId: null,
      journalHash: "0".repeat(64),
      projectionHash: "0".repeat(64),
    },
    continuity: "initial",
    runtimeProjectId: desktopRequest.projectId,
  });
const desktopConsumer: "orquesta.business-work-orders.read" =
  BUSINESS_DESKTOP_READ_CONSUMER;
const desktopFeatures: readonly string[] = BUSINESS_DESKTOP_READ_FEATURES;
const workOrderStates: readonly BusinessWorkOrderStateName[] = WORK_ORDER_STATES;
const branchStates: readonly BusinessBranchStateName[] = BRANCH_STATES;
const liveObservationNames: readonly LiveRuntimeObservationName[] = LIVE_RUNTIME_OBSERVATION_NAMES;
const settlementObservationNames: readonly EffectSettlementObservationName[] =
  EFFECT_SETTLEMENT_OBSERVATION_NAMES;
const settlementSources: readonly EffectSettlementSource[] = EFFECT_SETTLEMENT_SOURCES;
const expiryObservationNames: readonly EffectSendExpiryObservationName[] =
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES;
const presendFailureObservationNames: readonly EffectPresendFailureObservationName[] =
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES;
const settlementEnvelopeVersion: 2 = EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION;
const engineContractVersion: 2 = BUSINESS_ENGINE_CONTRACT_VERSION;
const schemaVersion: 1 = BUSINESS_EVENT_SCHEMA_VERSION;
const projectionVersion: 2 = BUSINESS_PROJECTION_VERSION;
const packetContractVersion: 1 = DISPATCH_PACKET_CONTRACT_VERSION;
const packetReceiptVersion: 1 = DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION;
const packetMaximumBytes: number = DISPATCH_PACKET_STORE_LIMITS.max_packet_bytes;
const packetStoreErrorConstructor: typeof BusinessPacketStoreError = BusinessPacketStoreError;
const cutoverErrorConstructor: typeof BusinessProviderSettlementCutoverBoundaryError =
  BusinessProviderSettlementCutoverBoundaryError;
const cutoverAction: "provider_settlement.v2.activate" =
  PROVIDER_SETTLEMENT_CUTOVER_ACTION;
const cutoverEnvelopeVersion: 1 = PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION;
const cutoverSchemaVersion: 1 = PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION;
const cutoverProjectionVersion: 2 =
  PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION;
const settlementContractVersion: 2 = PROVIDER_SETTLEMENT_CONTRACT_VERSION;
const cutoverSource: "provider_settlement_cutover" =
  PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE;
const activationEventType: "business.provider_settlement.v2_activated" =
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT;
const cutoverReceiptEventType: "business.provider_settlement.cutover_received" =
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT;
const projectionConfiguration: BusinessProjectionConfigurationV1 =
  businessProjectionConfigurationV1();

const event: BusinessEventV1 = {
  event_id: "BVE-11111111111111111111111111111111",
  schema_version: 1,
  type: "business.command.received",
  payload: {},
  evidence_refs: [],
};

const projected: Readonly<BusinessProjectionV1> = projectBusinessEventV1(
  projection,
  event,
);
const replayed: Readonly<BusinessProjectionV1> = replayBusinessProjectionV1([]);
const decide: typeof decideWorkOrderV1 = decideWorkOrderV1;
const createBoundary: (
  options: BusinessCommandBoundaryOptionsV1,
) => ReturnType<typeof createBusinessCommandBoundary> = createBusinessCommandBoundary;
const createObservationBoundary: (
  options: BusinessObservationBoundaryOptionsV1,
) => ReturnType<typeof createBusinessObservationBoundary> = createBusinessObservationBoundary;
const createInternalActionBoundary: (
  options: BusinessInternalActionBoundaryOptionsV1,
) => ReturnType<typeof createBusinessInternalActionBoundary> = createBusinessInternalActionBoundary;
declare const cutoverEnvelope: BusinessProviderSettlementCutoverEnvelopeV1;
declare const projectedReadinessInput: BusinessProviderSettlementProjectedReadinessV1;
declare const cutoverReadinessEvidence:
  BusinessProviderSettlementCutoverReadinessEvidenceV1;
declare const cutoverEpoch: BusinessProviderSettlementEpochV1;
declare const cutoverBuiltBatch: BusinessProviderSettlementCutoverBuiltBatchV1;
declare const cutoverBoundaryOptions: BusinessProviderSettlementCutoverBoundaryOptionsV1;
declare const settlementReceipt: BusinessProviderSettlementReceiptV1;
const normalizedCutoverEnvelope: Readonly<BusinessProviderSettlementCutoverEnvelopeV1> =
  normalizeProviderSettlementCutoverEnvelopeV1(cutoverEnvelope);
const projectedReadiness: Readonly<BusinessProviderSettlementProjectedReadinessV1> =
  deriveProviderSettlementCutoverReadinessV1(projection, 0);
const normalizedReadiness:
  Readonly<BusinessProviderSettlementCutoverReadinessEvidenceV1> =
  normalizeProviderSettlementCutoverReadinessEvidenceV1(
    cutoverReadinessEvidence,
    projectedReadinessInput,
  );
const normalizedEpoch: Readonly<BusinessProviderSettlementEpochV1> =
  normalizeProviderSettlementEpochV1(cutoverEpoch);
const derivedEpoch: Readonly<BusinessProviderSettlementEpochV1> =
  deriveProviderSettlementEpochFromBatchV1(cutoverBuiltBatch.request);
const cutoverBoundary: Readonly<BusinessProviderSettlementCutoverBoundaryV1> =
  createBusinessProviderSettlementCutoverBoundary(cutoverBoundaryOptions);
const cutoverResult: Promise<Readonly<BusinessProviderSettlementCutoverResultV1>> =
  cutoverBoundary.execute({
    cutover: cutoverEnvelope,
    authentication: null,
  });
const builtCutover: Readonly<BusinessProviderSettlementCutoverBuiltBatchV1> =
  buildProviderSettlementCutoverBatchV1({
    cutover: cutoverEnvelope,
    principal: { type: "system", id: cutoverEnvelope.actor.actor_id },
    projection,
    journal_sequence: projectedReadiness.journal_sequence,
    readiness: cutoverReadinessEvidence,
    occurred_at: "2026-08-10T00:00:00.000Z",
  });
const cutoverErrorCode: BusinessProviderSettlementCutoverBoundaryErrorCodeV1 =
  "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY";
const dedicatedSettlementSource: "provider_settlement" = settlementReceipt.source_type;
const settlementBundleCutover: string = settlementReceipt.settlement_bundle.cutover_id;
const cutoverSendAuthorizationVersion: 2 =
  cutoverEnvelope.send_authorization_contract_version;
const readinessSendAuthorizationVersion: 2 =
  projectedReadiness.send_authorization_contract_version;
const epochSendAuthorizationVersion: 2 =
  cutoverEpoch.send_authorization_contract_version;
declare const packetStoreOptions: BusinessDispatchPacketStoreOptionsV1<object, object>;
declare const packetInput: BusinessDispatchPacketV1;
declare const effectIdentity: BusinessProviderEffectIdentityV2;
declare const packetReceiptInput: BusinessDispatchPacketVerificationReceiptV1;
declare const sendAuthorizationVerificationInput:
  BusinessDispatchPacketSendAuthorizationVerificationV1;
declare const sendBeginResult: BusinessOutboxSendBeginResultV1;
declare const leaseRenewResult: BusinessOutboxLeaseRenewResultV1;
declare const historicalInternalResult: BusinessHistoricalInternalActionResultV1;
const normalizedPacket: Readonly<BusinessDispatchPacketV1> =
  normalizeDispatchPacketV1(packetInput);
const normalizedPacketReceipt:
  Readonly<BusinessDispatchPacketVerificationReceiptV1> =
  normalizeDispatchPacketVerificationReceiptV1(packetReceiptInput);
const normalizedSendAuthorizationVerification:
  Readonly<BusinessDispatchPacketSendAuthorizationVerificationV1> =
  normalizeDispatchPacketSendAuthorizationVerificationV1(
    sendAuthorizationVerificationInput,
  );
const packetStore: Readonly<BusinessDispatchPacketStoreV1> =
  createDispatchPacketStore(packetStoreOptions);
const internalActionPacketStorePort:
  NonNullable<BusinessInternalActionBoundaryOptionsV1["packetStore"]> = {
    verifyForSendAuthorization: packetStore.verifyForSendAuthorization,
  };
const packetVerification: Promise<Readonly<BusinessDispatchPacketVerificationReceiptV1>> =
  packetStore.verifyForEffect(effectIdentity);
const sendAuthorizationVerification:
  Promise<Readonly<BusinessDispatchPacketSendAuthorizationVerificationV1>> =
  packetStore.verifyForSendAuthorization(effectIdentity);
const sendBeginReceipt: BusinessDispatchPacketVerificationReceiptV1 =
  sendBeginResult.packet_verification_receipt;
const sendAuthorizationBundle: BusinessSendAuthorizationBundleV1 =
  sendBeginResult.send_authorization_bundle;
const providerEntryWindowIndex: Readonly<BusinessProviderEntryWindowIndexV1> | undefined =
  projection.provider_entry_windows[effectIdentity.effect_id];
const renewalContinuation: BusinessProviderEntryWindowContinuationV1 | undefined =
  "provider_entry_window_continuation" in leaseRenewResult
    ? leaseRenewResult.provider_entry_window_continuation
    : undefined;
const historicalPacketReceipt: BusinessDispatchPacketVerificationReceiptV1 | undefined =
  historicalInternalResult.packet_verification_receipt;
const historicalSendAuthorizationBundle: BusinessSendAuthorizationBundleV1 | undefined =
  historicalInternalResult.send_authorization_bundle;
type Decision = BusinessDecisionV1;
declare const observationBoundary: BusinessObservationBoundaryV1;
declare const historicalObservation: RuntimeObservationEnvelopeV1;
declare const settlementObservation: EffectSettlementObservationEnvelopeV2;
declare const expiryObservation: EffectSendExpiryObservationEnvelopeV2;
declare const presendFailureObservation: EffectPresendFailureObservationEnvelopeV2;
const normalizedSettlement: Readonly<EffectSettlementObservationEnvelopeV2> =
  normalizeEffectSettlementObservationEnvelopeV2(settlementObservation);
const normalizedBusinessObservation = normalizeBusinessRuntimeObservationEnvelope(
  settlementObservation,
);
const normalizedExpiryObservation = normalizeBusinessRuntimeObservationEnvelope(
  expiryObservation,
);
const normalizedPresendFailureObservation = normalizeBusinessRuntimeObservationEnvelope(
  presendFailureObservation,
);
const historicalReplay = observationBoundary.execute({
  observation: historicalObservation,
  authentication: null,
  replay_only: true,
});

void workOrderStates;
void branchStates;
void liveObservationNames;
void settlementObservationNames;
void settlementSources;
void expiryObservationNames;
void presendFailureObservationNames;
void settlementEnvelopeVersion;
void engineContractVersion;
void schemaVersion;
void projectionVersion;
void packetContractVersion;
void packetReceiptVersion;
void packetMaximumBytes;
void packetStoreErrorConstructor;
void cutoverErrorConstructor;
void cutoverAction;
void cutoverEnvelopeVersion;
void cutoverSchemaVersion;
void cutoverProjectionVersion;
void settlementContractVersion;
void cutoverSource;
void activationEventType;
void cutoverReceiptEventType;
void projectionConfiguration;
void projected;
void replayed;
void decide;
void createBoundary;
void createObservationBoundary;
void createInternalActionBoundary;
void normalizedCutoverEnvelope;
void projectedReadiness;
void normalizedReadiness;
void normalizedEpoch;
void derivedEpoch;
void cutoverBoundary;
void cutoverResult;
void builtCutover;
void cutoverErrorCode;
void dedicatedSettlementSource;
void settlementBundleCutover;
void cutoverSendAuthorizationVersion;
void readinessSendAuthorizationVersion;
void epochSendAuthorizationVersion;
void normalizedPacket;
void normalizedPacketReceipt;
void normalizedSendAuthorizationVerification;
void packetStore;
void internalActionPacketStorePort;
void packetVerification;
void sendAuthorizationVerification;
void sendBeginReceipt;
void sendAuthorizationBundle;
void providerEntryWindowIndex;
void renewalContinuation;
void historicalPacketReceipt;
void historicalSendAuthorizationBundle;
void historicalReplay;
void normalizedSettlement;
void normalizedBusinessObservation;
void normalizedExpiryObservation;
void normalizedPresendFailureObservation;
void (null as Decision | null);
