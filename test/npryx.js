'use strict'
// Pure-logic tests for npryx. No network: every registry shape is a captured
// `npm view --json` fixture (cowsay / esbuild / sigstore, real shapes Jan 2026).

const test = require('tap').test
const { targetSpec, splitSpec, isRegistrySpec, pickVersion, summarize, typosquat, trustMatch } = require('../npryx.js')

// --- captured `npm view --json` fixtures (trimmed to fields npryx reads) ------
const COWSAY = { // clean: no install hooks, signed, popular
  name: 'cowsay',
  version: '1.6.0',
  maintainers: ['piuccio <piuccio@gmail.com>'],
  repository: { type: 'git', url: 'git+https://github.com/piuccio/cowsay.git' },
  time: { '1.6.0': '2024-01-26T06:24:22.739Z' },
  scripts: { prepare: 'rollup -c', test: 'tape test/**/*.js' },
  dist: { integrity: 'sha512-8C4H1jdrgNusTQr3Yu4SCm+ZKsAlDFbpa0KS0Z3im8u', signatures: [{ keyid: 'SHA256:jl3b', sig: 'MEYC' }] }
}
const ESBUILD = { // install script + provenance
  name: 'esbuild',
  version: '0.28.1',
  scripts: { postinstall: 'node install.js' },
  dist: { integrity: 'sha512-esbuildxxx', attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/esbuild@0.28.1', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }
}
const SIGSTORE = { // clean scripts + provenance
  name: 'sigstore',
  version: '5.0.0',
  scripts: { clean: 'shx rm -rf dist', build: 'tsc --build', test: 'jest' },
  dist: { integrity: 'sha512-sigstorexxx', attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }
}

test('targetSpec finds the package and skips flags + value-flag pairs', t => {
  t.equal(targetSpec(['cowsay', 'moo']), 'cowsay')
  t.equal(targetSpec(['-p', 'lol', '-c', 'x']), 'lol')
  t.equal(targetSpec(['--package=foo', 'bar']), 'foo')
  t.equal(targetSpec(['--cache', '/tmp/x', 'realpkg']), 'realpkg', 'value-flag value is not mistaken for the pkg')
  t.equal(targetSpec(['--node-arg', '--inspect', 'cowsay']), 'cowsay')
  t.equal(targetSpec(['--help']), null)
  t.equal(targetSpec([]), null)
  t.end()
})

test('splitSpec separates name@version and keeps @scope intact', t => {
  t.same(splitSpec('cowsay'), { name: 'cowsay', version: null })
  t.same(splitSpec('cowsay@1.2.3'), { name: 'cowsay', version: '1.2.3' })
  t.same(splitSpec('@scope/pkg'), { name: '@scope/pkg', version: null })
  t.same(splitSpec('@scope/pkg@2'), { name: '@scope/pkg', version: '2' })
  t.equal(splitSpec(null), null)
  t.end()
})

test('isRegistrySpec accepts registry names, rejects paths/urls/git', t => {
  t.equal(isRegistrySpec('cowsay'), true)
  t.equal(isRegistrySpec('@scope/pkg'), true)
  t.equal(isRegistrySpec('./local'), false)
  t.equal(isRegistrySpec('/abs/path'), false)
  t.equal(isRegistrySpec('github:piuccio/cowsay'), false)
  t.equal(isRegistrySpec('git+ssh://x/y.git'), false)
  t.equal(isRegistrySpec('user/repo'), false, 'github shorthand is not a registry name')
  t.end()
})

test('pickVersion takes the highest from an ascending array, else the object', t => {
  t.equal(pickVersion([{ version: '1.5.0' }, { version: '1.6.0' }]).version, '1.6.0')
  t.equal(pickVersion({ version: '2.0.0' }).version, '2.0.0')
  t.equal(pickVersion([]), null)
  t.end()
})

test('summarize: cowsay is clean (no install hooks, no provenance)', t => {
  const s = summarize(COWSAY)
  t.equal(s.name, 'cowsay')
  t.equal(s.version, '1.6.0')
  t.equal(s.runsInstallScripts, false)
  t.same(s.hooks, [])
  t.equal(s.provenance, null)
  t.equal(s.deprecated, null)
  t.equal(s.published, '2024-01-26T06:24:22.739Z')
  t.same(s.maintainers, ['piuccio'], 'name parsed out of "name <email>"')
  t.equal(s.repo, 'git+https://github.com/piuccio/cowsay.git')
  t.ok(s.integrity.startsWith('sha512-'))
  t.end()
})

test('summarize: esbuild flags the postinstall hook AND shows provenance', t => {
  const s = summarize(ESBUILD)
  t.equal(s.runsInstallScripts, true)
  t.same(s.hooks, ['postinstall'])
  t.equal(s.provenance, 'https://slsa.dev/provenance/v1')
  t.end()
})

test('summarize: sigstore has provenance but no install hooks', t => {
  const s = summarize(SIGSTORE)
  t.equal(s.runsInstallScripts, false)
  t.equal(s.provenance, 'https://slsa.dev/provenance/v1')
  t.end()
})

test('summarize picks the highest version when handed a range array', t => {
  const s = summarize([{ name: 'cowsay', version: '1.5.0' }, COWSAY])
  t.equal(s.version, '1.6.0')
  t.end()
})

test('typosquat catches one-edit lookalikes, not exact or scoped names', t => {
  t.equal(typosquat('crossenv'), 'cross-env', 'the real crossenv malware case')
  t.equal(typosquat('expres'), 'express')
  t.equal(typosquat('express'), null, 'exact match is the real package')
  t.equal(typosquat('cowsay'), null, 'popular exact name is not a squat')
  t.equal(typosquat('@scope/express'), null, 'scoped names are skipped')
  t.equal(typosquat('totally-unrelated-name'), null)
  t.end()
})

test('trustMatch: integrity hit = trusted, differ = changed, absent = unknown', t => {
  const s = summarize(ESBUILD)
  t.equal(trustMatch({ esbuild: { integrity: s.integrity } }, s).status, 'trusted')
  const changed = trustMatch({ esbuild: { integrity: 'sha512-OLD', version: '0.1.0' } }, s)
  t.equal(changed.status, 'changed')
  t.equal(changed.from, '0.1.0')
  t.equal(changed.to, '0.28.1')
  t.equal(trustMatch({}, s).status, 'unknown')
  t.end()
})
