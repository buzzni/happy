import { loadRun, spawnAgentSession, sessionClient, waitForTranscript, now } from './realAgentHarness'
async function main() {
    const ctx = loadRun('h2')
    const { sessionId } = await spawnAgentSession(ctx, `probe-${Date.now().toString(36)}`)
    console.log('session', sessionId)
    const t = now()
    await sessionClient('send', sessionId, 'Reply with the single word ready. Do not use tools.')
    const rows = await waitForTranscript(sessionId, (l) => l.some((r) => r.t === 'turn-end' && r.time > t), 120_000)
    console.log(JSON.stringify(rows.filter((r) => r.time > t).map((r) => [r.t, (r.text ?? r.name ?? '').slice(0, 200)])))
}
void main().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1) })
