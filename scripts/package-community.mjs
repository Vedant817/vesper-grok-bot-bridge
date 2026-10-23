import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Only explicit public source directories enter the template kit. Never inspect
// managed homes, account stores, installed clients, environment URLs or Git logs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'build', 'releases'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run with npm run pack:community');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });
function pack(cwd, ignoreScripts = false) {
  const result = spawnSync(process.execPath, [npmCli, 'pack', ...(ignoreScripts ? ['--ignore-scripts'] : []), '--json', '--pack-destination', output], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'npm pack failed');
  const [receipt] = JSON.parse(result.stdout);
  return receipt;
}
async function checksum(receipt, kind) {
  const archive = join(output, receipt.filename);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${receipt.filename}\n`);
  return { kind, file: receipt.filename, sha256, bytes: receipt.size, files: receipt.files.map(file => file.path) };
}
const runtime = await checksum(pack(root), 'cli-mcp-runtime');
const staging = await mkdtemp(join(tmpdir(), 'grok-community-template-'));
let template;
try {
  for (const directory of ['community', 'docs', 'examples']) await cp(join(root, directory), join(staging, directory), { recursive: true });
  await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  await writeFile(join(staging, 'README.md'), `# Coding Agent Supervisor template kit\n\nOpen [the template guide](community/README.md), then [the profile](community/PROFILE.md) and [full role](docs/GROK_BOT_INSTRUCTIONS.md).\n\nExtract this documentation-only archive; do not install it with npm. It is not a native Grok Bot import file or marketplace listing. Each recipient separately installs the matching grok-bot-mcp-agent-${version}.tgz runtime and enrolls their own CLI, repository and HTTPS/OAuth connector. No code, credentials or configured endpoint are included.\n`);
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: 'grok-coding-supervisor-template', version, private: true, license: 'MIT',
    description: 'Profile, role, listing copy and onboarding for a community Grok Bot template',
    files: ['README.md', 'LICENSE', 'community', 'docs', 'examples'],
  }, null, 2) + '\n');
  template = await checksum(pack(staging, true), 'bot-template-kit');
} finally {
  // The exact absolute directory came from mkdtemp above, never from user input.
  await rm(staging, { recursive: true, force: true });
}
const manifest = { version, artifacts: [template, runtime], publication: { npm: false, marketplace: false, nativeTemplateLink: null } };
await writeFile(join(output, 'community-release.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
