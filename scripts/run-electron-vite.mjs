import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const electronViteCli = resolve('node_modules/electron-vite/bin/electron-vite.js')
const child = spawn(process.execPath, [electronViteCli, ...process.argv.slice(2)], {
  env: environment,
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.error('electron-vite를 실행하지 못했습니다.', error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
