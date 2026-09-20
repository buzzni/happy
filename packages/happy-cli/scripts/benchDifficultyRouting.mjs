#!/usr/bin/env node
// Local-only worker benchmark. Output contains aggregate metrics and labels, never prompts.
import { fork } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { cpus, platform, arch } from 'node:os'
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const modelDir = option('--model-dir')
if (!modelDir) throw new Error('--model-dir required')
const cycles = Number(option('--cycles') ?? 20)
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20) throw new Error('cycles must be 1..20')
const entry = resolve(option('--entry') ?? 'dist/index.mjs')
const source = entry.endsWith('.ts')
const rows = option('--holdout') ? (await readFile(option('--holdout'), 'utf8')).trim().split('\n').map(line => { const row = JSON.parse(line); return { ...row, text: row.text ?? row.prompt } }) : []
if (rows.some(r => typeof r.text !== 'string' || r.text.length > 8000 || !['hard','routine','trivial'].includes(r.label))) throw new Error('invalid holdout')
const runs = [], predictions = []
for (let cycle = 0; cycle < cycles; cycle++) {
  const child = fork(entry, source ? [] : ['difficulty-routing-worker'], {
    execArgv: source ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: '/nonexistent', NODE_ENV: 'production', HAPPY_DIFFICULTY_ROUTING_MODEL_DIR: modelDir },
  })
  function request(message, expected) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('worker deadline exceeded')) }, 60000)
      const onExit = () => { cleanup(); reject(new Error('worker exited')) }
      const onMessage = value => {
        if (value?.type === 'error') { cleanup(); reject(new Error(String(value.error))); return }
        if (value?.type !== expected || (message.requestId && value.requestId !== message.requestId)) return
        cleanup(); resolve(value)
      }
      function cleanup() { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit) }
      child.on('message', onMessage); child.once('exit', onExit); child.send(message)
    })
  }
  try {
    const coldStart = performance.now()
    const ready = await request({ type: 'prepare' }, 'ready')
    const coldMs = performance.now() - coldStart
    const latencies = [], rss = [ready.rssBytes]; let cpuMicros = ready.cpuMicros
    const inputs = cycle === 0 && rows.length ? rows : [
      { text: 'Fix the spelling error in the button label.' },
      { text: '동시 요청에서 중복 결제가 발생한다. 트랜잭션 격리와 멱등성 키 수명주기를 분석하고 재현 테스트를 설계해줘.' },
      { text: 'hello '.repeat(1333) },
    ]
    for (let i = 0; i < inputs.length; i++) {
      const started = performance.now()
      const result = await request({ type: 'classify', requestId: `${cycle}-${i}`, text: inputs[i].text, maxInputTokens: 512 }, 'result')
      latencies.push(performance.now() - started); rss.push(result.rssBytes); cpuMicros = result.cpuMicros
      if (cycle === 0 && rows.length) predictions.push({ id: inputs[i].id ?? i, expected: inputs[i].label, actual: result.difficulty })
    }
    runs.push({ cycle, cpuMicros, coldMs, warmMs: latencies, peakObservedRssBytes: Math.max(...rss), classifierRevision: ready.classifierRevision })
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL'); await exited
  }
}
const hard = predictions.filter(r => r.expected === 'hard')
const result = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, modelArtifactOnly: true, runs, quality: predictions.length ? { count: predictions.length, hardCount: hard.length, hardRecall: hard.filter(r => r.actual === 'hard').length / hard.length, binaryAccuracy: predictions.filter(r => (r.actual === 'hard') === (r.expected === 'hard')).length / predictions.length, predictions } : null }
if (option('--output')) await writeFile(option('--output'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ cycles: runs.length, peakObservedRssMiB: Math.max(...runs.map(r => r.peakObservedRssBytes)) / 1024 / 1024, coldMs: runs.map(r => Math.round(r.coldMs)), quality: result.quality ? { count: result.quality.count, hardRecall: result.quality.hardRecall, binaryAccuracy: result.quality.binaryAccuracy } : null }))
