export type AuthEmailResult = {
  sent: boolean;
  reason?: string;
};

export interface AuthEmailAdapter {
  sendInvite(input: { to: string; name: string; token: string }): Promise<AuthEmailResult>;
  sendPasswordReset(input: { to: string; name: string; token: string }): Promise<AuthEmailResult>;
}
