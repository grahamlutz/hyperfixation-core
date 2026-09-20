#!/usr/bin/env node
// Fails a PR that changes a published package's `src` or a committed `etc/*.api.md` without
// adding a changeset. Plain node with no dependencies so the job needs neither `pnpm install`
// nor Postgres.
//
// Deliberately narrower than `changeset status --since`, which flags any file under a package
// directory — including tests and READMEs — and so would fail PRs that change nothing a
// consumer can observe.
//
// The `Version packages` PR passes without a special case: it deletes changesets and rewrites
// package.json and CHANGELOG.md, touching no `src` and no API report.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const base = (process.env.CHANGESET_CHECK_BASE || 'main').replace(/^refs\/heads\//, '')
const baseRef = process.env.CHANGESET_CHECK_BASE_REF || `origin/${base}`

const mergeBase = git('merge-base', baseRef, 'HEAD')
const changed = git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean)
const added = git('diff', '--name-only', '--diff-filter=A', mergeBase, 'HEAD')
  .split('\n')
  .filter(Boolean)

const ignored = new Set(JSON.parse(readFileSync('.changeset/config.json', 'utf8')).ignore ?? [])

const isPublished = (dir) => {
  const manifest = `packages/${dir}/package.json`
  if (!existsSync(manifest)) return false
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  return !pkg.private && !ignored.has(pkg.name)
}

const isReleaseWorthy = (file) => {
  const match = /^packages\/([^/]+)\/(.+)$/.exec(file)
  if (!match) return false
  const [, dir, rest] = match
  if (!isPublished(dir)) return false
  if (/^etc\/[^/]+\.api\.md$/.test(rest)) return true
  if (!rest.startsWith('src/')) return false
  return !/(^|\/)(__tests__|__fixtures__)\//.test(rest) && !/\.(test|spec)\.tsx?$/.test(rest)
}

const releaseWorthy = changed.filter(isReleaseWorthy)
const changesets = added.filter((f) => f.startsWith('.changeset/') && f.endsWith('.md') && !f.endsWith('README.md'))

if (releaseWorthy.length === 0) {
  console.log(`No published source or API report changed since ${baseRef} — no changeset needed.`)
  process.exit(0)
}

if (changesets.length > 0) {
  console.log(`${releaseWorthy.length} released file(s) changed, covered by: ${changesets.join(', ')}`)
  process.exit(0)
}

console.error(`These files change published package source or a committed API report since ${baseRef}:

${releaseWorthy.map((f) => `  ${f}`).join('\n')}

...but this branch adds no changeset, so the next release would ship them unversioned.

Fix it with:

  pnpm changeset

and commit the generated .changeset/*.md. Choose patch or minor per
planning/hyperfixation-versioning-policy.md — minor only for a breaking change.`)
process.exit(1)
