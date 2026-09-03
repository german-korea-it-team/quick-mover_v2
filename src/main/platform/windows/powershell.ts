import { spawn } from 'node:child_process'
import { SdManagerError } from '../../services/errors'

function powerShellStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function buildPowerShellCommand(script: string, args: readonly string[]): string {
  if (args.length === 0) return script

  const argumentValues = args.map(powerShellStringLiteral).join(', ')
  return String.raw`
$quickMoverArguments = @(${argumentValues})
& {
${script}
} @quickMoverArguments
`
}

export async function runPowerShell(script: string, args: readonly string[] = []): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildPowerShellCommand(script, args)
      ],
      { shell: false, windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => reject(new SdManagerError('FORMAT_FAILED', 'PowerShell을 실행할 수 없습니다.', error.message)))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new SdManagerError('FORMAT_FAILED', 'Windows 디스크 작업이 실패했습니다.', stderr.trim()))
    })
  })
}
