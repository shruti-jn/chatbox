# @chatbridge/sdk

TypeScript SDK for building ChatBridge apps without dealing with raw `postMessage` or JSON-RPC wiring.

## What it provides

- `ChatBridgeApp` lifecycle-aware app client
- `onActivate`, `onSuspend`, `onResume`, `onTerminate` hook registration
- `sendStateUpdate()` and `signalCompletion()` helpers
- `registerTool()` helper for local tool metadata
- exported TypeScript types for app configuration and tool schemas

## Example

```ts
import { ChatBridgeApp, type StateUpdate, type ToolSchema } from '@chatbridge/sdk'

const app = new ChatBridgeApp({ allowedOrigins: ['https://chatbridge.school'] })

app
  .onActivate((instanceId) => {
    console.log('activated', instanceId)
  })
  .onSuspend(() => {
    console.log('suspended')
  })
  .onTerminate(() => {
    console.log('terminated')
  })

app.registerTool({
  name: 'start_game',
  description: 'Start a game',
  inputSchema: { type: 'object' },
} satisfies ToolSchema)

const update: StateUpdate = { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' }
app.sendStateUpdate(update)
```

## Design notes

- The SDK uses `window.parent.postMessage(...)` internally.
- App developers should call typed methods like `sendStateUpdate()` instead of constructing raw CBP messages.
- `allowedOrigins` should be set in production so outbound and inbound messaging is origin-restricted.
