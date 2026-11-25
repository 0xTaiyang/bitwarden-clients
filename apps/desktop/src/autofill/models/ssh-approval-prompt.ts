export interface SshApprovalPrompt {
  title: string;
  message: string;
  warningTitle?: string;
  warningMessage?: string;
  authorizeLabel: string;
  denyLabel: string;
  expiresAt?: number;
  requestedAt?: number;
  hostFingerprint?: string;
}
