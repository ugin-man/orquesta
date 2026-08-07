export type AuditExportPolicy = {
  mode: "local-only";
  remoteRetentionDays: null;
};

export function currentAuditExportPolicy(): AuditExportPolicy {
  return {
    mode: "local-only",
    remoteRetentionDays: null
  };
}
