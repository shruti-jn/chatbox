import { z } from 'zod/v3'

export const UserRoleSchema = z.enum(['student', 'teacher', 'district_admin'])

export const JWTPayloadSchema = z.object({
  userId: z.string().uuid(),
  role: UserRoleSchema,
  districtId: z.string().uuid(),
  schoolId: z.string().uuid().optional(),
  gradeBand: z.enum(['k2', 'g35', 'g68', 'g912']).optional(),
  iat: z.number(),
  exp: z.number(),
})

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const LoginResponseSchema = z.object({
  token: z.string(),
  role: UserRoleSchema,
  displayName: z.string(),
})

export type UserRole = z.infer<typeof UserRoleSchema>
export type JWTPayload = z.infer<typeof JWTPayloadSchema>
export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type LoginResponse = z.infer<typeof LoginResponseSchema>
