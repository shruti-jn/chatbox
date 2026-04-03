// Re-export all types for convenience
export type {
  CBPMessage, CBPStateUpdate, CBPCommand, CBPLifecycle,
} from './schemas/cbp'

export type {
  MessageRole, TextPart, ToolCallPart, AppCardPart, ContentPart, Message,
} from './schemas/messages'

export type {
  AppStatus, InteractionModel, AppInstanceStatus, ToolDefinition, UIManifest, AppRegistration, AppReviewResult,
} from './schemas/apps'

export type {
  GradeBand, AIConfig, ClassroomCreate, ClassroomConfig, Whisper,
} from './schemas/classrooms'

export type {
  UserRole, JWTPayload, LoginRequest, LoginResponse,
} from './schemas/auth'

// Constants
export const GRADE_BAND_CONFIG = {
  k2: { fontSize: '18px', lineHeight: '1.8', touchTarget: '56px', streaming: false, maxChoices: 3 },
  g35: { fontSize: '16px', lineHeight: '1.6', touchTarget: '48px', streaming: true, maxChoices: 4 },
  g68: { fontSize: '15px', lineHeight: '1.5', touchTarget: '44px', streaming: true, maxChoices: 5 },
  g912: { fontSize: '15px', lineHeight: '1.5', touchTarget: '44px', streaming: true, maxChoices: 6 },
} as const

export const RATE_LIMITS = {
  student: 60,   // messages per minute
  teacher: 120,
  app: 100,      // API calls per minute
} as const

export const APP_RESOURCE_LIMITS = {
  maxMemoryMB: 50,
  maxRequestsPerMinute: 100,
  maxIframeWidthDesktop: 600,
  maxIframeWidthMobile: 400,
  maxIframeHeight: 800,
} as const
