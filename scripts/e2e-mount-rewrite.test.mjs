/**
 * e2e-mount-rewrite contract: auto mode packs every workspace family
 * dependency from this checkout into a patched file: tarball (the corporate
 * fork never mounts its registry twins — same-numbered npm releases are
 * upstream code) and keeps family dependencies outside this workspace
 * (extracted satellites) on the registry; the manual family-dir override
 * still rewrites everything it covers; nested family edges are patched
 * inside the packed tarballs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rewriteDependencies, findWorkspacePackage, packWorkspace } from './e2e-mount-rewrite'
import { TAR_LOCAL } from './tar-args.cjs'

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rewrite-test-'))
}

function writePkg(dir, body) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'package.json')
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n')
  return file
}

function makeWorkspace(root) {
  writePkg(path.join(root, 'packages', 'dsh-a'), { name: '@linxin666/dsh-a', version: '0.1.0' })
  writePkg(path.join(root, 'packages', 'dsh-b'), { name: '@linxin666/dsh-b', version: '0.2.0' })
  writePkg(path.join(root, 'packages', 'dsh-skin-x'), { name: '@linxin666/dsh-skin-x', version: '0.1.0' })
}

function makeTarballPkg(dir) {
  return writePkg(dir, {
    name: '@linxin666/dsh-web-all',
    version: '9.9.9',
    dependencies: {
      '@linxin666/dsh-a': '0.1.0',
      '@linxin666/dsh-b': '0.2.0',
      'dsh-external-fixture': '0.13.0',
      react: '^18.3.1',
    },
  })
}

function makeTgz(dir, pkgBody) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tgz-stage-'))
  writePkg(path.join(staging, 'package'), pkgBody)
  const tgz = path.join(dir, pkgBody.name.split('/').pop() + '.tgz')
  execFileSync('tar', [...TAR_LOCAL, '-czf', tgz, '-C', staging, 'package'])
  fs.rmSync(staging, { recursive: true, force: true })
  return tgz
}

/** A pack fake: pack the workspace package.json as a real tarball. */
function packFake(packed) {
  return (dir, outDir) => {
    packed.push(dir)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return makeTgz(outDir, pkg)
  }
}

/** Read the package.json embedded in a tarball. */
function readTgzPkg(tgz) {
  const raw = execFileSync('tar', [...TAR_LOCAL, '-xzf', tgz, '-O', 'package/package.json'], { stdio: 'pipe' }).toString()
  return JSON.parse(raw)
}

test('auto mode: workspace family deps pack locally, satellites stay on the registry', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  const pkgPath = writePkg(path.join(tmp, 'tarball'), {
    name: '@linxin666/dsh-web-all',
    version: '9.9.9',
    dependencies: {
      '@linxin666/dsh-a': '0.1.0',
      '@linxin666/dsh-b': '0.2.0',
      '@linxin666/dsh-pet': '^0.3.24',
      'dsh-external-fixture': '0.13.0',
      react: '^18.3.1',
    },
  })
  const packed = []
  const report = await rewriteDependencies({ pkgPath, root, pack: packFake(packed) })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const tgzA = pkg.dependencies['@linxin666/dsh-a']
  const tgzB = pkg.dependencies['@linxin666/dsh-b']
  assert.match(tgzA, /^file:.*dsh-a\.tgz$/)
  assert.match(tgzB, /^file:.*dsh-b\.tgz$/)
  assert.notEqual(tgzA, tgzB)
  assert.equal(pkg.dependencies['@linxin666/dsh-pet'], '^0.3.24')
  assert.equal(pkg.dependencies['react'], '^18.3.1')
  assert.equal(pkg.dependencies['dsh-external-fixture'], '0.13.0')
  assert.equal(packed.length, 2)
  assert.ok(report.some(line => line.includes('保持 registry 安装')))
})

test('auto mode: pack returning the same tarball twice fails loudly', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  const pkgPath = makeTarballPkg(path.join(tmp, 'tarball'))
  let first = null
  await assert.rejects(
    rewriteDependencies({
      pkgPath,
      root,
      pack: (dir, outDir) => {
        if (first !== null) return first
        first = makeTgz(outDir, { name: '@linxin666/dsh-a', version: '0.1.0' })
        return first
      },
    }),
    /已占用的 tarball/,
  )
})

test('packWorkspace: two packs into the same parent dir stay distinct', () => {
  const tmp = makeTmp()
  const a = path.join(tmp, 'dsh-a')
  const b = path.join(tmp, 'dsh-b')
  writePkg(a, { name: '@linxin666/dsh-a', version: '0.0.0-test' })
  writePkg(b, { name: '@linxin666/dsh-b', version: '0.0.0-test' })
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(outDir)
  const tgzA = packWorkspace(a, outDir)
  const tgzB = packWorkspace(b, outDir)
  assert.notEqual(tgzA, tgzB)
  assert.match(tgzA, /dsh-a/)
  assert.match(tgzB, /dsh-b/)
  assert.equal(fs.readdirSync(path.dirname(tgzA)).filter(name => name.endsWith('.tgz')).length, 1)
  assert.equal(fs.readdirSync(path.dirname(tgzB)).filter(name => name.endsWith('.tgz')).length, 1)
})

test('auto mode: default packWorkspace packs and patches workspace deps', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  const pkgPath = makeTarballPkg(path.join(tmp, 'tarball'))
  await rewriteDependencies({ pkgPath, root })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.match(pkg.dependencies['@linxin666/dsh-b'], /^file:.*dsh-b.*\.tgz$/)
  // The packed tarball is a real tar and survives the in-place patch.
  assert.equal(JSON.parse(execFileSync('tar', [...TAR_LOCAL, '-xzf', pkg.dependencies['@linxin666/dsh-b'].slice(5), '-O', 'package/package.json'], { stdio: 'pipe' }).toString()).name, '@linxin666/dsh-b')
})

test('auto mode: a private workspace dep packs locally (the fork has no publish gate)', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  writePkg(path.join(root, 'packages', 'dsh-private'), {
    name: '@linxin666/dsh-private',
    version: '0.1.0',
    private: true,
  })
  const pkgPath = writePkg(path.join(tmp, 'tarball'), {
    name: '@linxin666/dsh-web-all',
    version: '9.9.9',
    dependencies: { '@linxin666/dsh-private': '0.1.0' },
  })
  await rewriteDependencies({ pkgPath, root, pack: packFake([]) })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.match(pkg.dependencies['@linxin666/dsh-private'], /^file:.*dsh-private\.tgz$/)
})

test('family-dir mode: every family dep rewrites to a patched same-named copy', async () => {
  const tmp = makeTmp()
  const familyDir = path.join(tmp, 'family')
  fs.mkdirSync(familyDir, { recursive: true })
  const tgzA = makeTgz(familyDir, { name: '@linxin666/dsh-a', version: '0.1.0' })
  const tgzB = makeTgz(familyDir, { name: '@linxin666/dsh-b', version: '0.2.0' })
  const pkgPath = makeTarballPkg(path.join(tmp, 'tarball'))
  await rewriteDependencies({ pkgPath, root: tmp, familyDir })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const fileA = pkg.dependencies['@linxin666/dsh-a']
  const fileB = pkg.dependencies['@linxin666/dsh-b']
  assert.match(fileA, /^file:.*dsh-a\.tgz$/)
  assert.match(fileB, /^file:.*dsh-b\.tgz$/)
  assert.notEqual(fileA, 'file:' + tgzA)
  assert.notEqual(fileB, 'file:' + tgzB)
  assert.equal(fs.existsSync(fileA.slice(5)), true)
  assert.equal(fs.existsSync(fileB.slice(5)), true)
  assert.equal(pkg.dependencies['react'], '^18.3.1')
})

test('family-dir mode: a workspace package the directory misses fails loudly', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  const familyDir = path.join(tmp, 'family')
  fs.mkdirSync(familyDir, { recursive: true })
  makeTgz(familyDir, { name: '@linxin666/dsh-a', version: '0.1.0' })
  const pkgPath = makeTarballPkg(path.join(tmp, 'tarball'))
  await assert.rejects(
    rewriteDependencies({ pkgPath, root, familyDir }),
    /缺少本地 tarball/,
  )
})

test('family-dir mode: a family package outside this workspace stays on the registry', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  // The extracted satellites are family-scoped but not built here, so the
  // override cannot cover them and they must keep resolving from npm.
  const familyDir = path.join(tmp, 'family')
  fs.mkdirSync(familyDir, { recursive: true })
  makeTgz(familyDir, { name: '@linxin666/dsh-a', version: '0.1.0' })
  const pkgPath = writePkg(path.join(tmp, 'tarball'), {
    name: '@linxin666/dsh-web-all',
    version: '9.9.9',
    dependencies: {
      '@linxin666/dsh-a': '0.1.0',
      '@linxin666/dsh-pet': '^0.3.24',
    },
  })
  const report = await rewriteDependencies({ pkgPath, root, familyDir })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.match(pkg.dependencies['@linxin666/dsh-a'], /^file:.*dsh-a\.tgz$/)
  assert.equal(pkg.dependencies['@linxin666/dsh-pet'], '^0.3.24')
  assert.ok(report.some(line => line.includes('保持 registry 安装')))
})

test('auto mode: nested workspace family deps rewrite inside the packed tarball', async () => {
  const tmp = makeTmp()
  const root = path.join(tmp, 'repo')
  makeWorkspace(root)
  // dsh-b depends on the workspace skin-x: the nested edge must be
  // rewritten inside the packed dsh-b tarball (dsh-skins -> skin-center).
  writePkg(path.join(root, 'packages', 'dsh-b'), {
    name: '@linxin666/dsh-b',
    version: '0.2.0',
    dependencies: { '@linxin666/dsh-skin-x': '0.1.0' },
  })
  const pkgPath = writePkg(path.join(tmp, 'tarball'), {
    name: '@linxin666/dsh-web-all',
    version: '9.9.9',
    dependencies: {
      '@linxin666/dsh-a': '0.1.0',
      '@linxin666/dsh-b': '0.2.0',
      '@linxin666/dsh-skin-x': '0.1.0',
    },
  })
  const packed = []
  await rewriteDependencies({ pkgPath, root, pack: packFake(packed) })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const fileB = pkg.dependencies['@linxin666/dsh-b'].slice(5)
  const fileX = pkg.dependencies['@linxin666/dsh-skin-x'].slice(5)
  // The nested dep resolves to the same patched skin-x tarball the aggregate uses.
  assert.equal(readTgzPkg(fileB).dependencies['@linxin666/dsh-skin-x'], 'file:' + fileX)
  // skin-x is packed exactly once and shared by both edges.
  assert.equal(packed.length, 3)
})

test('family-dir mode: nested family deps rewrite inside the patched copies', async () => {
  const tmp = makeTmp()
  const familyDir = path.join(tmp, 'family')
  fs.mkdirSync(familyDir, { recursive: true })
  makeTgz(familyDir, { name: '@linxin666/dsh-a', version: '0.1.0' })
  makeTgz(familyDir, {
    name: '@linxin666/dsh-b',
    version: '0.2.0',
    dependencies: { '@linxin666/dsh-a': '0.1.0' },
  })
  const pkgPath = makeTarballPkg(path.join(tmp, 'tarball'))
  await rewriteDependencies({ pkgPath, root: tmp, familyDir })
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const fileB = pkg.dependencies['@linxin666/dsh-b'].slice(5)
  const fileA = pkg.dependencies['@linxin666/dsh-a'].slice(5)
  assert.equal(readTgzPkg(fileB).dependencies['@linxin666/dsh-a'], 'file:' + fileA)
})

test('findWorkspacePackage scans packages/', () => {
  const tmp = makeTmp()
  makeWorkspace(tmp)
  assert.match(findWorkspacePackage(tmp, '@linxin666/dsh-a'), /packages[/\\]dsh-a$/)
  assert.match(findWorkspacePackage(tmp, '@linxin666/dsh-skin-x'), /packages[/\\]dsh-skin-x$/)
  assert.equal(findWorkspacePackage(tmp, '@linxin666/nope'), null)
})


