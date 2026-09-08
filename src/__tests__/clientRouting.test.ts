import * as fs from 'fs';
import * as path from 'path';
import { MUTATING_TOOLS, SESSION_TOOLS } from '../lib/toolClasses';

/**
 * Reads only go through the stateless clone; anything that writes, holds or
 * releases a lock must stay on the stateful client, because the lock handle
 * belongs to that session.
 *
 * These are source-level checks because the mistake they guard against is a
 * naming one, and it already happened: handleUnlock serves the tool `unLock`,
 * so deriving the tool name from the method name produced `unlock`, which
 * matched nothing in the mutating list and quietly routed the release of a
 * lock into the wrong session.
 */
const handlerDir = path.resolve(__dirname, '..', 'handlers');
const indexSource = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
const dispatchedTools = new Set(
  [...indexSource.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1])
);

const handlerFiles = fs.readdirSync(handlerDir).filter(f => f.endsWith('.ts') && f !== 'BaseHandler.ts');

interface Block {
  file: string;
  method: string;
  tool: string;
  body: string;
}

const blocks: Block[] = [];
for (const file of handlerFiles) {
  const source = fs.readFileSync(path.join(handlerDir, file), 'utf8');
  // Every method is a boundary, not just the handle* ones: a private helper
  // sitting between two handlers would otherwise be read as part of the one
  // above it, and its reads blamed on a tool that never makes them.
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else']);
  const starts: { method: string; at: number }[] = [];
  // Files in here are indented with two or four spaces, so the indent is only
  // used to tell a member from a nested statement; keywords are filtered out.
  const re = /^ {2,4}(?:private |protected |public )?(?:async )?([A-Za-z0-9_]+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (KEYWORDS.has(m[1])) continue;
    starts.push({ method: m[1], at: m.index });
  }

  starts.forEach((start, i) => {
    if (!start.method.startsWith('handle') || start.method === 'handle') return;
    const end = i + 1 < starts.length ? starts[i + 1].at : source.length;
    const bare = start.method.replace(/^handle/, '');
    blocks.push({
      file,
      method: start.method,
      tool: bare.charAt(0).toLowerCase() + bare.slice(1),
      body: source.slice(start.at, end)
    });
  });
}

describe('handler methods', () => {
  it('finds handler methods to check', () => {
    expect(blocks.length).toBeGreaterThan(50);
  });

  /**
   * Two known exceptions, both spelling accidents rather than routing ones:
   * `unLock` (method handleUnlock) and `adtCompatibiliyGraph` (the tool name is
   * misspelled in the dispatcher, the method is not).
   */
  const KNOWN_NAME_MISMATCHES = new Set(['unlock', 'adtCompatibilityGraph']);

  it('derives a real tool name from every method name', () => {
    const unknown = blocks
      .filter(b => !dispatchedTools.has(b.tool) && !KNOWN_NAME_MISMATCHES.has(b.tool))
      .map(b => `${b.file}:${b.method}`);
    expect(unknown).toEqual([]);
  });
});

describe('client routing', () => {
  const mutatingBlocks = blocks.filter(b =>
    MUTATING_TOOLS.has(b.tool) ||
    SESSION_TOOLS.has(b.tool) ||
    b.tool === 'unlock' // handleUnlock serves unLock
  );

  it('has mutating handlers to check', () => {
    expect(mutatingBlocks.length).toBeGreaterThan(20);
  });

  it('never routes a mutating handler through the stateless clone', () => {
    const offenders = mutatingBlocks
      .filter(b => b.body.includes('this.readClient.'))
      .map(b => `${b.file}:${b.method} (tool ${b.tool})`);
    expect(offenders).toEqual([]);
  });

  it('keeps the debugger on the stateful client, reads included', () => {
    const debugSource = fs.readFileSync(path.join(handlerDir, 'DebugHandlers.ts'), 'utf8');
    expect(debugSource).not.toContain('this.readClient');
  });

  it('routes plain reads through the stateless clone', () => {
    const shouldRead = ['handleGetObjectSource', 'handleSearchObject', 'handleRunQuery', 'handleUserTransports'];
    for (const method of shouldRead) {
      const block = blocks.find(b => b.method === method);
      expect(block).toBeDefined();
      expect(block!.body).toContain('this.readClient.');
    }
  });
});
