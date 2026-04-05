import { ownerPrisma } from './src/middleware/rls.js'
import { signJWT } from './src/middleware/auth.js'

async function main() {
  const district = await ownerPrisma.district.create({ data: { name: 'A1-Assertion-' + Date.now() } })
  const teacher = await ownerPrisma.user.create({ data: { districtId: district.id, role: 'teacher', displayName: 'Assertion Teacher' } })
  const student = await ownerPrisma.user.create({ data: { districtId: district.id, role: 'student', displayName: 'Assertion Student', gradeBand: 'g68' } })
  const classroom = await ownerPrisma.classroom.create({ 
    data: { 
      districtId: district.id, teacherId: teacher.id, name: 'Assertion Class', 
      joinCode: 'ASS' + Date.now(), gradeBand: 'g68', 
      aiConfig: { mode: 'direct', subject: 'math' } 
    } 
  })
  const conversation = await ownerPrisma.conversation.create({ 
    data: { districtId: district.id, classroomId: classroom.id, studentId: student.id } 
  })
  
  const token = signJWT({ userId: student.id, role: 'student', districtId: district.id, gradeBand: 'g68' })
  const teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId: district.id })
  
  // Tenant B for isolation test
  const districtB = await ownerPrisma.district.create({ data: { name: 'TenantB-Assertion-' + Date.now() } })
  const studentB = await ownerPrisma.user.create({ data: { districtId: districtB.id, role: 'student', displayName: 'TenantB Student', gradeBand: 'g68' } })
  const tokenB = signJWT({ userId: studentB.id, role: 'student', districtId: districtB.id, gradeBand: 'g68' })
  
  const result = { 
    districtId: district.id, conversationId: conversation.id, 
    studentToken: token, studentId: student.id, teacherToken,
    districtBId: districtB.id, tokenB, studentBId: studentB.id
  }
  console.log(JSON.stringify(result))
  await ownerPrisma.$disconnect()
}
main().catch(e => { console.error(String(e)); process.exit(1) })
