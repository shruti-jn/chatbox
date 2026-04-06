const PORT = Number(process.env.DEVELOPER_PLATFORM_PORT ?? 3101)
const STORE_PATH = process.env.DEVELOPER_PLATFORM_STORE_PATH
const ADMIN_API_KEY = process.env.DEVELOPER_PLATFORM_ADMIN_API_KEY
import { buildDeveloperPlatformServer } from './app.js'

const server = await buildDeveloperPlatformServer({
  storePath: STORE_PATH,
  adminApiKey: ADMIN_API_KEY,
})
server.listen({ host: '0.0.0.0', port: PORT }).catch((error) => {
  server.log.error(error)
  process.exit(1)
})
