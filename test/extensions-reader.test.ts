import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExtensions } from '../src/main/extensions/extensions-reader.js';

/*
 * A home and a project on a temp tree, never the disk of whoever runs the tests.
 */

let root: string;
let home: string;
let project: string;

async function put(path: string, content: string | object): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string): string => `---\nname: ${name}\ndescription: The ${name} skill\n---\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'extensions-'));
  home = join(root, 'home');
  project = join(root, 'work', 'web-app');

  await put(join(home, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'log-stop' }] }] },
    enabledPlugins: { 'demo@example-market': true, 'idle@example-market': false },
  });
  await put(join(project, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'log-stop' }] }] },
  });

  await put(join(home, '.claude', 'skills', 'own', 'SKILL.md'), skill('own'));
  await put(join(home, '.claude', 'skills', 'synced', 'example-org', 'shared', 'SKILL.md'), skill('shared'));
  await put(join(project, '.claude', 'skills', 'linked', 'SKILL.md'), skill('linked'));
  await symlink(join(project, '.claude', 'skills', 'linked'), join(home, '.claude', 'skills', 'linked'), 'junction');

  const demo = join(home, '.claude', 'plugins', 'cache', 'example-market', 'demo', '1.0.0');
  const idle = join(home, '.claude', 'plugins', 'cache', 'example-market', 'idle', '2.0.0');
  await put(join(demo, '.claude-plugin', 'plugin.json'), {
    name: 'demo',
    description: 'A demo plugin',
    mcpServers: { inline: { command: 'inline-srv' } },
  });
  await put(join(demo, 'skills', 'from-plugin', 'SKILL.md'), skill('from-plugin'));
  await put(join(demo, 'hooks', 'hooks.json'), {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'plugin-guard' }] }] },
  });
  await put(join(idle, '.claude-plugin', 'plugin.json'), { name: 'idle' });
  await put(join(idle, 'skills', 'hidden', 'SKILL.md'), skill('hidden'));
  await put(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'demo@example-market': [{ scope: 'user', installPath: demo, version: '1.0.0' }],
      'idle@example-market': [{ scope: 'user', installPath: idle, version: '2.0.0' }],
    },
  });

  await put(join(home, '.claude.json'), {
    mcpServers: { tools: { command: 'tools-srv', env: { TOKEN: 'secret-value' } } },
    projects: { [project.replace(/\\/g, '/')]: { mcpServers: { localonly: { type: 'http', url: 'https://l.example.com' } } } },
  });
  await put(join(project, '.mcp.json'), { mcpServers: { tools: { command: 'tools-srv' } } });

  await put(
    join(home, '.codex', 'config.toml'),
    '[mcp_servers.web]\ncommand = "web-srv"\n\n[mcp_servers.web.env]\nKEY = "v"\n',
  );
  await put(join(home, '.codex', 'skills', '.system', 'installer', 'SKILL.md'), skill('installer'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readExtensions', () => {
  it('reads every kind of both agents, with scopes and duplicates', async () => {
    const { items, problems } = await readExtensions(
      home,
      [{ id: 'web-app', label: 'web-app', path: project }],
      null,
    );
    expect(problems).toEqual([]);
    const names = (agent: string, kind: string): string[] =>
      items.filter((item) => item.agent === agent && item.kind === kind).map((item) => `${item.name} [${item.scopeLabel}]`);

    expect(names('claude', 'hooks')).toEqual([
      'log-stop [user]',
      'log-stop [project: web-app]',
      'plugin-guard [plugin: demo]',
    ]);
    expect(items.find((item) => item.name === 'log-stop')?.duplicates).toEqual(['project: web-app']);
    expect(items.find((item) => item.name === 'plugin-guard')?.readOnly).toMatch(/demo plugin/);

    expect(names('claude', 'skills')).toEqual([
      'linked [user]',
      'own [user]',
      'shared [org]',
      'linked [project: web-app]',
      'from-plugin [plugin: demo]',
    ]);
    const linked = items.find((item) => item.name === 'linked' && item.scope === 'user');
    expect(linked?.duplicates).toEqual(['project: web-app']);
    expect(linked?.facts.some((fact) => fact.label === 'Links to')).toBe(true);

    expect(names('claude', 'plugins')).toEqual(['demo@example-market [user]', 'idle@example-market [user]']);
    expect(items.find((item) => item.name === 'idle@example-market')?.enabled).toBe(false);
    // A disabled plugin contributes nothing.
    expect(items.some((item) => item.name === 'hidden')).toBe(false);

    expect(names('claude', 'mcp')).toEqual([
      'tools [user]',
      'tools [project: web-app]',
      'localonly [local: web-app]',
      'inline [plugin: demo]',
    ]);
    const tools = items.find((item) => item.name === 'tools' && item.scope === 'user');
    expect(tools?.mcp?.envNames).toEqual(['TOKEN']);
    // The value itself never reaches what the renderer is sent.
    expect(JSON.stringify(items)).not.toContain('secret-value');

    expect(names('codex', 'mcp')).toEqual(['web [user]']);
    expect(names('codex', 'skills')).toEqual(['installer [system]']);
    expect(JSON.stringify(items)).not.toContain('"v"');
  });

  it('lists claude.ai connectors once their status has been checked', async () => {
    const { items } = await readExtensions(home, [], { 'claude.ai Example Docs': 'Connected', tools: 'Failed to connect' });
    const connector = items.find((item) => item.scope === 'claude.ai');
    expect(connector).toMatchObject({ name: 'Example Docs', verbs: [] });
    expect(items.find((item) => item.name === 'tools')?.facts.find((fact) => fact.label === 'Status')?.value).toBe(
      'Failed to connect',
    );
  });

  it('answers an empty list for a machine with neither agent', async () => {
    const { items, problems } = await readExtensions(join(root, 'nobody'), [], null);
    expect(items).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('reports a settings file it cannot parse instead of hiding it', async () => {
    await writeFile(join(home, '.claude', 'settings.json'), '{ not json');
    const { problems } = await readExtensions(home, [], null);
    expect(problems.some((problem) => problem.includes('settings.json'))).toBe(true);
  });
});
