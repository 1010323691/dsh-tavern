import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = path.join(root, 'bin', 'dsh-tavern.mjs')
const action = process.argv[2]
const windows = process.platform === 'win32'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('请先安装 Node.js 22.19 或更新版本。')
  if (action !== 'start' && action !== 'stop') throw new Error('请指定 start 或 stop。')
  process.env.DSH_TAVERN_RUNTIME_HOST = 'cli'
  if (!existsSync(path.join(root, 'node_modules', 'yaml', 'package.json'))) {
    if (action === 'stop') throw new Error('缺少仓库依赖。请先双击启动脚本完成安装。')
    console.log('首次启动，正在安装仓库依赖……')
    if (windows) run('pnpm install --frozen-lockfile', [], { shell: true })
    else run('pnpm', ['install', '--frozen-lockfile'])
  }
  if (action === 'start') {
    const { PROFILE_DIR } = await import('../../bin/launcher-environment.mjs')
    if (!['package.json', 'cordis.patch.yml'].every(file => existsSync(path.join(PROFILE_DIR, file)))) {
      console.log('正在安装 DSH Tavern 命令行版……')
      run(process.execPath, [cli, 'install', '--host', 'cli'])
    }
    run(process.execPath, [cli, 'start'], { env: { ...process.env, DSH_TAVERN_NO_OPEN: '1' } })
    if (process.env.DSH_TAVERN_NO_OPEN !== '1') run(process.execPath, [cli, 'open'])
  } else {
    run(process.execPath, [cli, 'stop'])
  }
} catch (error) {
  console.error(error.code === 'ENOENT' && error.path === 'pnpm'
    ? '找不到 pnpm。首次启动需要先安装 pnpm。'
    : error.message)
  process.exitCode = 1
}
