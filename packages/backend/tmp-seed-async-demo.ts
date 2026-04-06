import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DEFAULT_DISTRICT_ID = '00000000-0000-4000-a000-000000000001'
const EMAIL = 'student-async-demo@chatbridge.test'

async function main() {
  const emailHash = crypto.createHash('sha256').update(EMAIL.toLowerCase()).digest('hex')
  const teacher = await prisma.user.findFirst({
    where: { districtId: DEFAULT_DISTRICT_ID, role: 'teacher' },
    orderBy: { createdAt: 'asc' },
  })
  if (!teacher) throw new Error('No default teacher')

  let classroom = await prisma.classroom.findFirst({
    where: { districtId: DEFAULT_DISTRICT_ID, name: 'Async Browser Demo' },
  })

  if (!classroom) {
    classroom = await prisma.classroom.create({
      data: {
        districtId: DEFAULT_DISTRICT_ID,
        teacherId: teacher.id,
        name: 'Async Browser Demo',
        joinCode: 'ASYNC01',
        gradeBand: 'g68',
        aiConfig: { mode: 'direct', subject: 'general' },
      },
    })
  }

  const student = await prisma.user.upsert({
    where: { id: '11111111-1111-4111-8111-111111111123' },
    update: {
      districtId: DEFAULT_DISTRICT_ID,
      role: 'student',
      displayName: 'Async Demo Student',
      gradeBand: 'g68',
      emailHash,
    },
    create: {
      id: '11111111-1111-4111-8111-111111111123',
      districtId: DEFAULT_DISTRICT_ID,
      role: 'student',
      displayName: 'Async Demo Student',
      gradeBand: 'g68',
      emailHash,
    },
  })

  const chess = await prisma.app.findFirst({
    where: {
      OR: [
        { id: '00000000-0000-4000-e000-000000000001' },
        { name: 'Chess' },
      ],
      reviewStatus: 'approved',
    },
  })
  if (!chess) throw new Error('No chess app')

  const existing = await prisma.classroomAppConfig.findFirst({
    where: { classroomId: classroom.id, appId: chess.id },
  })

  if (!existing) {
    await prisma.classroomAppConfig.create({
      data: {
        classroomId: classroom.id,
        districtId: DEFAULT_DISTRICT_ID,
        appId: chess.id,
        enabled: true,
      },
    })
  }

  console.log(JSON.stringify({
    email: EMAIL,
    password: 'dev-mode1',
    classroomId: classroom.id,
    studentId: student.id,
    apiHost: 'http://localhost:3001',
  }))
}

main().finally(async () => {
  await prisma.$disconnect()
})
