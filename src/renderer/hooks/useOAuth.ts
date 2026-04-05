import type { OAuthProviderInfo } from '@shared/oauth'

// No-op OAuth hook for open-source edition

type OAuthResult =
  | { success: true }
  | { success: false; error?: string }

type OAuthStartLoginResult =
  | { success: true; authUrl?: string; instructions?: string }
  | { success: false; error?: string }

type OAuthDeviceStartResult =
  | { success: true; userCode?: string; verificationUri?: string }
  | { success: false; error?: string }

export function useOAuth(
  _providerId: string | undefined,
  _providerInfo?: OAuthProviderInfo,
  _oauthSettingsProviderId?: string,
  _providerSettingsId?: string
) {
  return {
    isDesktop: false,
    hasOAuth: false,
    isOAuthActive: false,
    isOAuthExpired: false,
    flowType: undefined as 'callback' | 'code-paste' | 'device-code' | undefined,
    loginCallback: async (): Promise<OAuthResult> => ({
      success: false as const,
      error: 'OAuth is unavailable in this edition',
    }),
    startLogin: async (): Promise<OAuthStartLoginResult> => ({
      success: false as const,
      error: 'OAuth is unavailable in this edition',
    }),
    exchangeCode: async (_code?: string): Promise<OAuthResult> => ({
      success: false as const,
      error: 'OAuth is unavailable in this edition',
    }),
    startDeviceFlow: async (): Promise<OAuthDeviceStartResult> => ({
      success: false as const,
      error: 'OAuth is unavailable in this edition',
    }),
    waitForDeviceToken: async (): Promise<OAuthResult> => ({
      success: false as const,
      error: 'OAuth is unavailable in this edition',
    }),
    cancel: async () => {},
    startLoginCallback: async () => ({ success: false as const }),
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    isLoading: false,
    error: null,
  }
}
