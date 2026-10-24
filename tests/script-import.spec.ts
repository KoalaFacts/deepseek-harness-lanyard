/** Import-only child processes: stdin must not be mistaken for a script path. */
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each(['sync-dsh', 'install-next'])('imports %s from Node stdin without running its command', script => {
  const url = new URL(`../scripts/${script}.ts`, import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = () => { throw new Error('unexpected command during import'); };
      syncBuiltinESMExports();
      await import(${JSON.stringify(url)});
      console.log('import-only');
    `,
    encoding: 'utf8', timeout: 5_000,
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('import-only')
})
