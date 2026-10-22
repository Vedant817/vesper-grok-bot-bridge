import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Build a documentation-only download. Never inspect the user's installed
// bridge home, native-provider credentials, environment URL, or account state.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'build', 'releases'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this builder with npm run pack:onboarding');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'grok-t3-onboarding-'));
try {
  await mkdir(join(staging, 'docs'));
  for (const name of ['T3_CONNECT_QUICKSTART.md', 'T3_BOT_INSTRUCTIONS.md']) {
    await copyFile(join(root, 'docs', name), join(staging, 'docs', name));
  }
  await copyFile(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  await writeFile(join(staging, 'README.md'), `# Grok Bot + T3 Connect onboarding kit\n\nStart with [the setup guide](docs/T3_CONNECT_QUICKSTART.md), then copy [the bot instructions](docs/T3_BOT_INSTRUCTIONS.md).\n\nExtract this archive; no npm installation or code execution is needed. T3 already provides the MCP server. Each user supplies their own public endpoint and completes native OAuth approval.\n\nVersion: ${version}. This is an unofficial community integration guide, not an xAI or T3 product or certification.\n`);
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: 'grok-bot-t3-connect-kit', version, private: true, license: 'MIT',
    description: 'Documentation and reusable bot instructions for native Grok Bot to T3 Connect MCP enrollment',
    files: ['README.md', 'LICENSE', 'docs/T3_CONNECT_QUICKSTART.md', 'docs/T3_BOT_INSTRUCTIONS.md'],
  }, null, 2) + '\n');
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], {
    cwd: staging, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (packed.error || packed.status !== 0) throw new Error(packed.stderr || packed.error?.message || 'npm pack failed');
  const [receipt] = JSON.parse(packed.stdout);
  const archive = join(output, receipt.filename);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${receipt.filename}\n`);
  console.log(JSON.stringify({ archive, sha256, files: receipt.files.map(file => file.path) }, null, 2));
} finally {
  // staging is an exact directory created above, never a user-configured path.
  await rm(staging, { recursive: true, force: true });
}
