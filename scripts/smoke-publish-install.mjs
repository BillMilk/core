import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDir = path.join(repoRoot, 'packages/server/publish');
const publishPackagePath = path.join(publishDir, 'package.json');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(publishPackagePath)) {
  throw new Error('Publish package not found. Run pnpm build:publish first.');
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-tower-publish-smoke-'));
const packDir = path.join(tempRoot, 'pack');
const installPrefix = path.join(tempRoot, 'prefix');

try {
  mkdirSync(packDir, { recursive: true });
  const tarballName = execFileSync(
    npmCommand,
    ['pack', '--silent', '--pack-destination', packDir],
    { cwd: publishDir, encoding: 'utf8' },
  ).trim().split(/\r?\n/).at(-1);
  if (!tarballName) throw new Error('npm pack did not return a tarball name.');

  const tarballPath = path.join(packDir, tarballName);
  execFileSync(
    npmCommand,
    [
      'install',
      '--global',
      '--prefix',
      installPrefix,
      tarballPath,
      '--no-audit',
      '--no-fund',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  const globalRoot = execFileSync(
    npmCommand,
    ['root', '--global', '--prefix', installPrefix],
    { encoding: 'utf8' },
  ).trim();
  const installedRoot = path.join(globalRoot, 'agent-tower');
  const clientPackagePath = path.join(installedRoot, 'node_modules/@prisma/client/package.json');
  const generatedClientDir = path.join(installedRoot, 'node_modules/.prisma/client');
  const generatedClientPath = path.join(generatedClientDir, 'index.js');
  const clientPackage = JSON.parse(readFileSync(clientPackagePath, 'utf8'));

  if (clientPackage.scripts?.generate || clientPackage.scripts?.postinstall) {
    throw new Error('Bundled @prisma/client still contains an install-time generator.');
  }
  execFileSync(process.execPath, ['--check', generatedClientPath], { stdio: 'inherit' });
  const appPrismaModuleUrl = pathToFileURL(path.join(installedRoot, 'dist/utils/index.js')).href;
  const importAppPrismaScript = [
    `const module = await import(${JSON.stringify(appPrismaModuleUrl)})`,
    "if (!module.prisma || typeof module.prisma.$disconnect !== 'function') process.exit(1)",
    'await module.prisma.$disconnect()',
  ].join('; ');
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', importAppPrismaScript],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  const engineFiles = readdirSync(generatedClientDir).filter(name => (
    name.includes('query_engine') || name.includes('libquery_engine')
  ));
  if (engineFiles.length === 0) {
    throw new Error('Prisma generate did not install a query engine.');
  }

  console.log(`[publish-smoke] status=passed prisma=${clientPackage.version} engines=${engineFiles.join(',')}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
