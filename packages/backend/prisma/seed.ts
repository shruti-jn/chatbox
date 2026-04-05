/**
 * TASK-DB-002: Seed data for ChatBridge v2
 *
 * Idempotent — uses deterministic UUIDs and upsert throughout.
 * Safe to run multiple times without duplicating data.
 */
import { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'

const prisma = new PrismaClient()

// Deterministic UUIDs for idempotent upserts
const IDS = {
  districts: {
    westside: '00000000-0000-4000-a000-000000000001',
    eastside: '00000000-0000-4000-a000-000000000002',
  },
  schools: {
    westsideElem: '00000000-0000-4000-b000-000000000001',
    eastsideHigh: '00000000-0000-4000-b000-000000000002',
  },
  classrooms: {
    westsideK2: '00000000-0000-4000-c000-000000000001',
    westside35: '00000000-0000-4000-c000-000000000002',
    eastside912: '00000000-0000-4000-c000-000000000003',
  },
  users: {
    studentK2: '00000000-0000-4000-d000-000000000001',
    student912: '00000000-0000-4000-d000-000000000002',
    teacher: '00000000-0000-4000-d000-000000000003',
    adminWestside: '00000000-0000-4000-d000-000000000004',
    adminEastside: '00000000-0000-4000-d000-000000000005',
  },
  apps: {
    chess: '00000000-0000-4000-e000-000000000001',
    weather: '00000000-0000-4000-e000-000000000002',
    spotify: '00000000-0000-4000-e000-000000000003',
  },
  catalog: {
    westsideChess: '00000000-0000-4000-f000-000000000001',
    westsideWeather: '00000000-0000-4000-f000-000000000002',
    westsideSpotify: '00000000-0000-4000-f000-000000000003',
    eastsideChess: '00000000-0000-4000-f000-000000000004',
  },
  memberships: {
    studentK2Room1: '00000000-0000-4000-f100-000000000001',
    student912Room3: '00000000-0000-4000-f100-000000000002',
  },
  consent: {
    studentK2: '00000000-0000-4000-f200-000000000001',
  },
} as const

function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex')
}

async function main() {
  console.log('Seeding ChatBridge database...')

  // --- Districts ---
  const westside = await prisma.district.upsert({
    where: { id: IDS.districts.westside },
    update: { name: 'Westside Unified' },
    create: {
      id: IDS.districts.westside,
      name: 'Westside Unified',
      config: { defaultAiMode: 'tutor', maxTokensPerTurn: 500 },
    },
  })
  const eastside = await prisma.district.upsert({
    where: { id: IDS.districts.eastside },
    update: { name: 'Eastside Academy' },
    create: {
      id: IDS.districts.eastside,
      name: 'Eastside Academy',
      config: { defaultAiMode: 'socratic', maxTokensPerTurn: 800 },
    },
  })
  console.log(`  Districts: ${westside.name}, ${eastside.name}`)

  // --- Schools ---
  const westsideElem = await prisma.school.upsert({
    where: { id: IDS.schools.westsideElem },
    update: { name: 'Westside Elementary' },
    create: {
      id: IDS.schools.westsideElem,
      districtId: westside.id,
      name: 'Westside Elementary',
    },
  })
  const eastsideHigh = await prisma.school.upsert({
    where: { id: IDS.schools.eastsideHigh },
    update: { name: 'Eastside High School' },
    create: {
      id: IDS.schools.eastsideHigh,
      districtId: eastside.id,
      name: 'Eastside High School',
    },
  })
  console.log(`  Schools: ${westsideElem.name}, ${eastsideHigh.name}`)

  // --- Users ---
  const teacher = await prisma.user.upsert({
    where: { id: IDS.users.teacher },
    update: { displayName: 'E2E Teacher' },
    create: {
      id: IDS.users.teacher,
      districtId: westside.id,
      schoolId: westsideElem.id,
      role: 'teacher',
      displayName: 'E2E Teacher',
      emailHash: hashEmail('e2e-teacher@test.invalid'),
      gradeBand: 'g35',
    },
  })

  const studentK2 = await prisma.user.upsert({
    where: { id: IDS.users.studentK2 },
    update: { displayName: 'Test Student K-2' },
    create: {
      id: IDS.users.studentK2,
      districtId: westside.id,
      schoolId: westsideElem.id,
      role: 'student',
      displayName: 'Test Student K-2',
      emailHash: hashEmail('test-student-k2@test.invalid'),
      gradeBand: 'k2',
    },
  })

  const student912 = await prisma.user.upsert({
    where: { id: IDS.users.student912 },
    update: { displayName: 'Test Student 9-12' },
    create: {
      id: IDS.users.student912,
      districtId: eastside.id,
      schoolId: eastsideHigh.id,
      role: 'student',
      displayName: 'Test Student 9-12',
      emailHash: hashEmail('test-student-912@test.invalid'),
      gradeBand: 'g912',
    },
  })

  const adminWestside = await prisma.user.upsert({
    where: { id: IDS.users.adminWestside },
    update: { displayName: 'Westside Admin' },
    create: {
      id: IDS.users.adminWestside,
      districtId: westside.id,
      role: 'district_admin',
      displayName: 'Westside Admin',
      emailHash: hashEmail('westside-admin@test.invalid'),
    },
  })

  const adminEastside = await prisma.user.upsert({
    where: { id: IDS.users.adminEastside },
    update: { displayName: 'Eastside Admin' },
    create: {
      id: IDS.users.adminEastside,
      districtId: eastside.id,
      role: 'district_admin',
      displayName: 'Eastside Admin',
      emailHash: hashEmail('eastside-admin@test.invalid'),
    },
  })
  console.log(`  Users: ${[teacher, studentK2, student912, adminWestside, adminEastside].map(u => u.displayName).join(', ')}`)

  // --- Classrooms (teacher must exist first) ---
  const westsideK2 = await prisma.classroom.upsert({
    where: { id: IDS.classrooms.westsideK2 },
    update: { name: 'K-2 Reading Room' },
    create: {
      id: IDS.classrooms.westsideK2,
      districtId: westside.id,
      schoolId: westsideElem.id,
      teacherId: teacher.id,
      name: 'K-2 Reading Room',
      joinCode: 'SEED-K2-WEST',
      gradeBand: 'k2',
      aiConfig: { mode: 'tutor', subject: 'reading', tone: 'encouraging', complexity: 'simple' },
    },
  })

  const westside35 = await prisma.classroom.upsert({
    where: { id: IDS.classrooms.westside35 },
    update: { name: '3-5 Math Lab' },
    create: {
      id: IDS.classrooms.westside35,
      districtId: westside.id,
      schoolId: westsideElem.id,
      teacherId: teacher.id,
      name: '3-5 Math Lab',
      joinCode: 'SEED-35-WEST',
      gradeBand: 'g35',
      aiConfig: { mode: 'socratic', subject: 'math', tone: 'neutral', complexity: 'moderate' },
    },
  })

  const eastside912 = await prisma.classroom.upsert({
    where: { id: IDS.classrooms.eastside912 },
    update: { name: '9-12 AP History' },
    create: {
      id: IDS.classrooms.eastside912,
      districtId: eastside.id,
      schoolId: eastsideHigh.id,
      teacherId: teacher.id,
      name: '9-12 AP History',
      joinCode: 'SEED-912-EAST',
      gradeBand: 'g912',
      aiConfig: { mode: 'socratic', subject: 'history', tone: 'academic', complexity: 'advanced' },
    },
  })
  console.log(`  Classrooms: ${westsideK2.name}, ${westside35.name}, ${eastside912.name}`)

  // --- Apps ---
  const chess = await prisma.app.upsert({
    where: { id: IDS.apps.chess },
    update: {
      name: 'Chess Tutor',
      toolDefinitions: [
        {
          name: 'start_game',
          description: 'Start a new chess game',
          inputSchema: { type: 'object' },
        },
        {
          name: 'make_move',
          description: 'Make a chess move using algebraic notation',
          inputSchema: {
            type: 'object',
            properties: {
              move: { type: 'string', description: 'Algebraic notation, e.g. e2e4' },
              fen: { type: 'string', description: 'Current board state in FEN' },
            },
            required: ['move'],
          },
        },
        {
          name: 'get_legal_moves',
          description: 'Get legal moves for current position',
          inputSchema: {
            type: 'object',
            properties: {
              fen: { type: 'string', description: 'Current board state in FEN' },
            },
          },
        },
      ],
    },
    create: {
      id: IDS.apps.chess,
      name: 'Chess Tutor',
      description: 'Interactive chess learning app with AI opponent and move analysis',
      version: '1.0.0',
      reviewStatus: 'approved',
      toolDefinitions: [
        {
          name: 'start_game',
          description: 'Start a new chess game',
          inputSchema: { type: 'object' },
        },
        {
          name: 'make_move',
          description: 'Make a chess move using algebraic notation',
          inputSchema: {
            type: 'object',
            properties: {
              move: { type: 'string', description: 'Algebraic notation, e.g. e2e4' },
              fen: { type: 'string', description: 'Current board state in FEN' },
            },
            required: ['move'],
          },
        },
        {
          name: 'get_legal_moves',
          description: 'Get legal moves for current position',
          inputSchema: {
            type: 'object',
            properties: {
              fen: { type: 'string', description: 'Current board state in FEN' },
            },
          },
        },
      ],
      uiManifest: { url: 'https://apps.test.invalid/chess', width: 600, height: 600, sandboxAttrs: ['allow-scripts'] },
      permissions: { scopes: ['read:board_state', 'write:moves'] },
      complianceMetadata: { coppa: true, ferpa: true, dataRetentionDays: 90, piiCollected: false },
    },
  })

  const weather = await prisma.app.upsert({
    where: { id: IDS.apps.weather },
    update: {
      name: 'Weather Explorer',
      toolDefinitions: [
        {
          name: 'get_forecast',
          description: 'Retrieve weather forecast for a given location',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name or zip code' },
              days: { type: 'number', description: 'Number of forecast days (1-7)' },
            },
            required: ['location'],
          },
        },
      ],
    },
    create: {
      id: IDS.apps.weather,
      name: 'Weather Explorer',
      description: 'Explore real-time weather data for geography and science lessons',
      version: '1.0.0',
      reviewStatus: 'approved',
      toolDefinitions: [
        {
          name: 'get_forecast',
          description: 'Retrieve weather forecast for a given location',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name or zip code' },
              days: { type: 'number', description: 'Number of forecast days (1-7)' },
            },
            required: ['location'],
          },
        },
      ],
      uiManifest: { url: 'https://apps.test.invalid/weather', width: 500, height: 400, sandboxAttrs: ['allow-scripts'] },
      permissions: { scopes: ['read:location'] },
      complianceMetadata: { coppa: true, ferpa: true, dataRetentionDays: 30, piiCollected: false },
    },
  })

  const spotify = await prisma.app.upsert({
    where: { id: IDS.apps.spotify },
    update: {
      name: 'Music Lab',
      toolDefinitions: [
        {
          name: 'search_tracks',
          description: 'Search for age-appropriate tracks by keyword or genre',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              genre: { type: 'string', description: 'Genre filter' },
            },
            required: ['query'],
          },
        },
        {
          name: 'create_playlist',
          description: 'Create a new playlist with selected tracks',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Playlist name' },
              description: { type: 'string', description: 'Playlist description' },
              trackIds: { type: 'array', items: { type: 'string' }, description: 'Spotify track IDs to add' },
            },
            required: ['name'],
          },
        },
      ],
    },
    create: {
      id: IDS.apps.spotify,
      name: 'Music Lab',
      description: 'Curated music exploration for classroom use with Spotify integration',
      version: '1.0.0',
      reviewStatus: 'approved',
      toolDefinitions: [
        {
          name: 'search_tracks',
          description: 'Search for age-appropriate tracks by keyword or genre',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              genre: { type: 'string', description: 'Genre filter' },
            },
            required: ['query'],
          },
        },
        {
          name: 'create_playlist',
          description: 'Create a new playlist with selected tracks',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Playlist name' },
              description: { type: 'string', description: 'Playlist description' },
              trackIds: { type: 'array', items: { type: 'string' }, description: 'Spotify track IDs to add' },
            },
            required: ['name'],
          },
        },
      ],
      uiManifest: { url: 'https://apps.test.invalid/music', width: 400, height: 300, sandboxAttrs: ['allow-scripts'] },
      permissions: { scopes: ['read:playlists', 'write:queue'] },
      complianceMetadata: { coppa: true, ferpa: true, dataRetentionDays: 30, piiCollected: false, oauthRequired: true },
    },
  })
  console.log(`  Apps: ${chess.name}, ${weather.name}, ${spotify.name}`)

  // --- ClassroomMembership ---
  await prisma.classroomMembership.upsert({
    where: { classroomId_studentId: { classroomId: westsideK2.id, studentId: studentK2.id } },
    update: {},
    create: {
      id: IDS.memberships.studentK2Room1,
      classroomId: westsideK2.id,
      studentId: studentK2.id,
      districtId: westside.id,
    },
  })
  await prisma.classroomMembership.upsert({
    where: { classroomId_studentId: { classroomId: eastside912.id, studentId: student912.id } },
    update: {},
    create: {
      id: IDS.memberships.student912Room3,
      classroomId: eastside912.id,
      studentId: student912.id,
      districtId: eastside.id,
    },
  })
  console.log('  ClassroomMemberships: 2 enrolled')

  // --- DistrictAppCatalog ---
  for (const [id, districtId, appId] of [
    [IDS.catalog.westsideChess, westside.id, chess.id],
    [IDS.catalog.westsideWeather, westside.id, weather.id],
    [IDS.catalog.westsideSpotify, westside.id, spotify.id],
    [IDS.catalog.eastsideChess, eastside.id, chess.id],
  ] as const) {
    await prisma.districtAppCatalog.upsert({
      where: { districtId_appId: { districtId, appId } },
      update: {},
      create: {
        id,
        districtId,
        appId,
        status: 'approved',
        approvedBy: districtId === westside.id ? adminWestside.id : adminEastside.id,
        approvedAt: new Date(),
      },
    })
  }
  console.log('  DistrictAppCatalog: 4 approvals (3 Westside, 1 Eastside)')

  // --- ParentalConsent for K-2 student ---
  await prisma.parentalConsent.upsert({
    where: { studentId: studentK2.id },
    update: { consentStatus: 'granted' },
    create: {
      id: IDS.consent.studentK2,
      studentId: studentK2.id,
      districtId: westside.id,
      parentEmailHash: hashEmail('parent-of-k2-student@test.invalid'),
      consentStatus: 'granted',
      consentDate: new Date(),
    },
  })
  console.log('  ParentalConsent: granted for Test Student K-2')

  console.log('\nSeed complete.')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

// Export IDS for use by test fixtures
export { IDS }
