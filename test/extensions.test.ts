import { describe, expect, it } from 'vitest';
import {
  addHook,
  claudeMcpJson,
  codexAddArgs,
  codexHooks,
  codexMcpServers,
  draftProblem,
  isValidName,
  isValidPluginId,
  listHooks,
  markDuplicates,
  normalizePathKey,
  parseFrontmatter,
  parseMcpList,
  readClaudeMcp,
  readExtensionAction,
  readToml,
  removeHook,
  replaceHook,
  resolveDraft,
  setTomlKey,
  type ExtensionItem,
} from '../src/shared/extensions.js';
import { cmdLine, pickWhereResult, quoteArgument } from '../src/main/extensions/agent-cli.js';

const SETTINGS = {
  model: 'default',
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-a' }, { type: 'command', command: 'guard-b', timeout: 5 }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'check-c' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'log-d' }] }],
  },
};

describe('claude hooks', () => {
  it('flattens every command with its location', () => {
    const hooks = listHooks(SETTINGS);
    expect(hooks.map((hook) => hook.command)).toEqual(['guard-a', 'guard-b', 'check-c', 'log-d']);
    expect(hooks[1]).toMatchObject({ event: 'PreToolUse', matcher: 'Bash', group: 0, index: 1, timeout: 5 });
    expect(hooks[3]).toMatchObject({ event: 'Stop', matcher: '' });
  });

  it('removes one hook and tidies the containers it empties', () => {
    const once = removeHook(SETTINGS, { event: 'Stop', group: 0, index: 0 });
    expect(once['hooks']).not.toHaveProperty('Stop');
    const all = [
      { event: 'PreToolUse', group: 1, index: 0 },
      { event: 'PreToolUse', group: 0, index: 1 },
      { event: 'PreToolUse', group: 0, index: 0 },
    ].reduce<Record<string, unknown>>((settings, at) => removeHook(settings, at), once);
    expect(all).toEqual({ model: 'default' });
    // The input is never mutated.
    expect(listHooks(SETTINGS)).toHaveLength(4);
  });

  it('adds to the group that has the matcher, or opens a new one', () => {
    const joined = addHook(SETTINGS, { event: 'PreToolUse', matcher: 'Edit', command: 'check-e', timeout: null });
    expect(listHooks(joined).filter((hook) => hook.matcher === 'Edit').map((hook) => hook.command)).toEqual([
      'check-c',
      'check-e',
    ]);
    const fresh = addHook({}, { event: 'SessionStart', matcher: '', command: 'hello', timeout: 3 });
    expect(fresh).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'hello', timeout: 3 }] }] } });
  });

  it('edits in place, and moves a hook whose matcher changes', () => {
    const inPlace = replaceHook(SETTINGS, { event: 'PreToolUse', group: 0, index: 1 }, {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'guard-b2',
      timeout: null,
    });
    expect(listHooks(inPlace)[1]).toMatchObject({ command: 'guard-b2', group: 0, index: 1, timeout: null });
    const moved = replaceHook(SETTINGS, { event: 'PreToolUse', group: 0, index: 0 }, {
      event: 'PreToolUse',
      matcher: 'Write',
      command: 'guard-a',
      timeout: null,
    });
    const bash = listHooks(moved).filter((hook) => hook.matcher === 'Bash').map((hook) => hook.command);
    expect(bash).toEqual(['guard-b']);
    expect(listHooks(moved).find((hook) => hook.matcher === 'Write')?.command).toBe('guard-a');
  });
});

describe('claude MCP', () => {
  it('reads a server without a type as stdio, and one with a URL only as http', () => {
    expect(readClaudeMcp({ command: 'srv', args: ['--x'], env: { TOKEN: 'v' } })).toMatchObject({
      transport: 'stdio',
      command: 'srv',
      args: ['--x'],
      env: { TOKEN: 'v' },
    });
    expect(readClaudeMcp({ url: 'https://mcp.example.com' })?.transport).toBe('http');
    expect(readClaudeMcp({ type: 'sse', url: 'https://mcp.example.com/sse' })?.transport).toBe('sse');
  });

  it('keeps a stored value for every name the draft left blank', () => {
    const previous = readClaudeMcp({ command: 'srv', env: { TOKEN: 'secret', OTHER: 'x' } });
    const resolved = resolveDraft(
      {
        transport: 'stdio',
        command: 'srv ',
        args: ['', '--y'],
        url: '',
        env: [
          { name: 'TOKEN', value: '' },
          { name: 'NEW', value: 'n' },
        ],
        headers: [],
        bearerEnv: '',
      },
      previous,
    );
    expect(resolved).toMatchObject({ command: 'srv', args: ['--y'], env: { TOKEN: 'secret', NEW: 'n' } });
    expect(resolved.env).not.toHaveProperty('OTHER');
  });

  it('builds the add-json body and the codex arguments', () => {
    const stdio = resolveDraft(
      { transport: 'stdio', command: 'srv', args: ['--a'], url: '', env: [{ name: 'K', value: 'v' }], headers: [], bearerEnv: '' },
      null,
    );
    expect(JSON.parse(claudeMcpJson(stdio))).toEqual({ type: 'stdio', command: 'srv', args: ['--a'], env: { K: 'v' } });
    expect(codexAddArgs('web', stdio, '')).toEqual(['mcp', 'add', 'web', '--env', 'K=v', '--', 'srv', '--a']);
    const http = resolveDraft(
      { transport: 'http', command: '', args: [], url: 'https://mcp.example.com', env: [], headers: [], bearerEnv: '' },
      null,
    );
    expect(codexAddArgs('web', http, 'WEB_TOKEN')).toEqual([
      'mcp',
      'add',
      'web',
      '--url',
      'https://mcp.example.com',
      '--bearer-token-env-var',
      'WEB_TOKEN',
    ]);
  });

  it('refuses what an agent cannot store', () => {
    const sse = resolveDraft(
      { transport: 'sse', command: '', args: [], url: 'https://mcp.example.com', env: [], headers: [], bearerEnv: '' },
      null,
    );
    expect(draftProblem(sse, 'claude')).toBeNull();
    expect(draftProblem(sse, 'codex')).toMatch(/Codex/);
    expect(draftProblem({ ...sse, transport: 'stdio', command: '' }, 'claude')).toMatch(/command/);
    expect(draftProblem({ ...sse, url: 'ftp://x' }, 'claude')).toMatch(/URL/);
  });

  it('parses the status lines of claude mcp list', () => {
    const text = [
      'Checking MCP server health…',
      '',
      'claude.ai Example Docs: https://mcp.example.com/docs - ✓ Connected',
      'local-tool: C:/tools/local-tool.exe  - ✗ Failed to connect',
      'plugin:demo:web: https://a.example.com/x - y - ! Needs authentication',
    ].join('\n');
    expect(parseMcpList(text)).toEqual([
      { name: 'claude.ai Example Docs', target: 'https://mcp.example.com/docs', status: 'Connected' },
      { name: 'local-tool', target: 'C:/tools/local-tool.exe', status: 'Failed to connect' },
      { name: 'plugin:demo:web', target: 'https://a.example.com/x - y', status: 'Needs authentication' },
    ]);
  });
});

const CODEX = [
  'model = "example-model"',
  'notify = ["notify-tool", "--quiet"]',
  '',
  '[mcp_servers.web]',
  'command = "C:/tools/web.exe"',
  'args = [',
  '  "--port",',
  '  "4000", # trailing comment',
  ']',
  '',
  '[mcp_servers.web.env]',
  'API_KEY = "secret"',
  '',
  '[mcp_servers."remote"]',
  'url = "https://mcp.example.com"',
  'enabled = false',
  'bearer_token_env_var = "REMOTE_TOKEN"',
  '',
  '# >>> some-tool block',
  '[[hooks.SessionStart]]',
  'matcher = "startup"',
  '[[hooks.SessionStart.hooks]]',
  'type = "command"',
  'command = "hello # not a comment"',
  '# <<< some-tool block',
  '',
].join('\r\n');

describe('codex config.toml', () => {
  it('reads the servers, their env names and their state', () => {
    const servers = codexMcpServers(readToml(CODEX));
    expect(servers.map((entry) => entry.name)).toEqual(['web', 'remote']);
    expect(servers[0]).toMatchObject({
      enabled: true,
      server: { transport: 'stdio', command: 'C:/tools/web.exe', args: ['--port', '4000'], env: { API_KEY: 'secret' } },
    });
    expect(servers[1]).toMatchObject({
      enabled: false,
      bearerEnv: 'REMOTE_TOKEN',
      server: { transport: 'http', url: 'https://mcp.example.com' },
    });
  });

  it('reads the hooks and notify', () => {
    const hooks = codexHooks(readToml(CODEX)).map((entry) => entry.hook);
    expect(hooks).toEqual([
      { event: 'SessionStart', matcher: 'startup', command: 'hello # not a comment', timeout: null },
      { event: 'notify', matcher: '', command: 'notify-tool --quiet', timeout: null },
    ]);
  });

  it('flips one key and leaves every other byte alone', () => {
    const off = setTomlKey(CODEX, ['mcp_servers', 'web'], 'enabled', false);
    expect(off).not.toBeNull();
    expect(off?.split('\r\n')).toEqual([...CODEX.split('\r\n').slice(0, 4), 'enabled = false', ...CODEX.split('\r\n').slice(4)]);
    const on = setTomlKey(CODEX, ['mcp_servers', 'remote'], 'enabled', true);
    expect(on).toBe(CODEX.replace('enabled = false', 'enabled = true'));
    expect(setTomlKey(CODEX, ['mcp_servers', 'missing'], 'enabled', true)).toBeNull();
  });
});

describe('names and paths', () => {
  it('accepts plain names only', () => {
    expect(isValidName('web-tool_2.x')).toBe(true);
    expect(isValidName('../escape')).toBe(false);
    expect(isValidName('two words')).toBe(false);
    expect(isValidPluginId('demo@example-market')).toBe(true);
    expect(isValidPluginId('demo@market;rm')).toBe(false);
  });

  it('compares project keys whatever the slashes and the drive case', () => {
    expect(normalizePathKey('C:\\work\\web-app\\')).toBe(normalizePathKey('c:/work/web-app'));
  });

  it('reads a frontmatter name and description', () => {
    expect(parseFrontmatter('---\nname: demo\ndescription: "Does a thing"\n---\n# Demo')).toEqual({
      name: 'demo',
      description: 'Does a thing',
    });
    expect(parseFrontmatter('# no frontmatter')).toEqual({ name: null, description: null });
  });
});

describe('duplicates', () => {
  const item = (id: string, scopeLabel: string, identity: string): ExtensionItem => ({
    id,
    agent: 'claude',
    kind: 'hooks',
    name: id,
    description: '',
    scope: 'user',
    scopeLabel,
    projectId: null,
    enabled: null,
    facts: [],
    file: null,
    folder: null,
    link: null,
    readOnly: null,
    verbs: [],
    duplicates: [],
    identity,
    mcp: null,
    hook: null,
  });

  it('names the other scopes declaring the same thing', () => {
    const marked = markDuplicates([item('a', 'user', 'x'), item('b', 'project: web-app', 'x'), item('c', 'user', 'y')]);
    expect(marked.map((entry) => entry.duplicates)).toEqual([['project: web-app'], ['user'], []]);
  });
});

describe('readExtensionAction', () => {
  it('accepts a well-formed action and refuses anything else', () => {
    expect(readExtensionAction({ type: 'remove', id: 'x' })).toEqual({ type: 'remove', id: 'x' });
    expect(readExtensionAction({ type: 'remove' })).toBeNull();
    expect(readExtensionAction({ type: 'format-disk', id: 'x' })).toBeNull();
    expect(
      readExtensionAction({
        type: 'save-hook',
        id: null,
        scope: 'user',
        projectId: null,
        hook: { event: 'Stop', matcher: '', command: 'log', timeout: null },
      }),
    ).toMatchObject({ type: 'save-hook', hook: { command: 'log' } });
    expect(
      readExtensionAction({
        type: 'save-mcp',
        id: null,
        agent: 'claude',
        scope: 'galaxy',
        projectId: null,
        name: 'x',
        draft: {},
      }),
    ).toBeNull();
  });
});

describe('running a .cmd through cmd.exe', () => {
  it('quotes arguments the way the C runtime reads them back', () => {
    expect(quoteArgument('plain')).toBe('plain');
    expect(quoteArgument('two words')).toBe('"two words"');
    expect(quoteArgument('{"type":"stdio"}')).toBe('"{\\"type\\":\\"stdio\\"}"');
    expect(quoteArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
    expect(quoteArgument('')).toBe('""');
  });

  it('builds one line, and refuses what cmd would expand', () => {
    expect(cmdLine('C:\\Program Files\\tool\\codex.cmd', ['mcp', 'list', '--json'])).toBe(
      '""C:\\Program Files\\tool\\codex.cmd" mcp list --json"',
    );
    expect(cmdLine('codex.cmd', ['mcp', 'add', 'x', '--env', 'K=%PATH%'])).toBeNull();
    expect(cmdLine('codex.cmd', ['a&b'])).toBeNull();
    expect(cmdLine('codex.cmd', ['say "hi"'])).toBeNull();
  });

  it('prefers a real executable over a batch shim', () => {
    expect(pickWhereResult('C:\\a\\codex\r\nC:\\a\\codex.cmd\r\n')).toEqual({ file: 'C:\\a\\codex.cmd', viaCmd: true });
    expect(pickWhereResult('C:\\a\\claude.exe\r\nC:\\b\\claude.cmd')).toEqual({ file: 'C:\\a\\claude.exe', viaCmd: false });
    expect(pickWhereResult('')).toBeNull();
  });
});
