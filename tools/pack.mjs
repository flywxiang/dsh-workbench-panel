/**
 * Package the plugin for distribution.
 *
 * Runs `npm pack` inside `plugin/` so npm applies `files`, writes the tarball to
 * `dist/`, and prints the exact install command for the result. The package has
 * no runtime dependencies: the host half uses only Node built-ins, and the
 * browser half is the pre-built bundle in `lib/client/`.
 *
 * Usage: node tools/pack.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', 'plugin')
const distDir = join(here, '..', 'dist')

const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
mkdirSync(distDir, { recursive: true })

// Windows ships npm as `npm.cmd`, which execFileSync cannot spawn without a shell;
// quoting the destination keeps a profile path with spaces intact.
const output =
  process.platform === 'win32'
    ? execSync(`npm pack --pack-destination "${distDir}" --json`, { cwd: pluginDir, encoding: 'utf8' })
    : execFileSync('npm', ['pack', '--pack-destination', distDir, '--json'], {
        cwd: pluginDir,
        encoding: 'utf8',
      })
const [report] = JSON.parse(output)
const tarball = join(distDir, report.filename)
const size = statSync(tarball).size

// npm pack leaves a stray cache entry out of the tree; the tarball is the artifact.
rmSync(join(pluginDir, 'node_modules'), { recursive: true, force: true })

console.log(`打包完成 → ${tarball}（${(size / 1024).toFixed(1)} KB，${report.entryCount} 个文件）`)
console.log('文件清单：')
for (const entry of report.files.map((file) => file.path).sort()) console.log(`  - ${entry}`)
console.log('\n对方安装（二选一）：')
console.log(`  npx -y @deepseek-ai/dsh plugin --profile web add ${tarball}`)
console.log(`  npx -y @deepseek-ai/dsh plugin --profile web add ${manifest.name}@${manifest.version}  # 发布到 npm 之后`)
