import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://chatbridge:chatbridge@localhost:5435/chatbridge'
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'dev-secret-change-in-production'
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

const district = await prisma.district.create({ data: { name: 'SHR124 E2E District' } })
const teacher = await prisma.user.create({ data: { districtId: district.id, role: 'teacher', displayName: 'SHR124 Teacher' } })
const classroom = await prisma.classroom.create({
  data: {
    districtId: district.id,
    teacherId: teacher.id,
    name: 'SHR124 Mission Control',
    joinCode: 'MC124A1',
    gradeBand: 'g68',
    aiConfig: { mode: 'direct', subject: 'science', tone: 'neutral' },
  },
})

const students = []
for (let i = 1; i <= 30; i++) {
  const student = await prisma.user.create({
    data: {
      districtId: district.id,
      role: 'student',
      displayName: `Student ${String(i).padStart(2, '0')}`,
      gradeBand: 'g68',
    },
  })
  students.push(student)
  await prisma.classroomMembership.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: student.id },
  })
  await prisma.conversation.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: student.id },
  })
}

const conversation = await prisma.conversation.findFirst({ where: { classroomId: classroom.id, studentId: students[0].id } })
const teacherToken = jwt.sign({ userId: teacher.id, role: 'teacher', districtId: district.id }, JWT_SECRET, { expiresIn: '1h' })
const studentToken = jwt.sign({ userId: students[0].id, role: 'student', districtId: district.id, gradeBand: 'g68' }, JWT_SECRET, { expiresIn: '1h' })

console.log(JSON.stringify({
  districtId: district.id,
  teacherId: teacher.id,
  classroomId: classroom.id,
  conversationId: conversation.id,
  teacherToken,
  studentId: students[0].id,
  studentToken,
}))

await prisma.$disconnect()
