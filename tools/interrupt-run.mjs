// Acceptance harness: spawns `npm run research` in the shared console,
// waits for the N-th "✓ volume:" line, then raises a real Ctrl+C
// (GenerateConsoleCtrlEvent(0, 0)) so the child performs a graceful pause.
//
// Usage: node tools/interrupt-run.mjs <volume-line-count> -- --seeds <path>
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const count = Number.parseInt(process.argv[2] ?? '2', 10);
const args = process.argv.slice(3);

let hits = 0;
let sent = false;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/research.ts', ...args], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});

process.on('SIGINT', () => {
  console.log('[harness] SIGINT received, ignoring (waiting for the child to pause)');
});

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  console.log(line);
  if (!sent && line.includes('✓ volume:')) {
    hits += 1;
    if (hits >= count) {
      sent = true;
      console.log(`[harness] observed ${hits} volume lines; raising Ctrl+C in the shared console`);
      ctrlC();
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

child.on('exit', (code, signal) => {
  console.log(`[harness] research exited with code ${code} (signal ${signal})`);
  process.exit(code === null ? 1 : code);
});

function ctrlC() {
  const script = [
    "Add-Type -Namespace W -Name C -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'",
    '[W.C]::GenerateConsoleCtrlEvent(0, 0) | Out-Null',
  ].join('; ');
  try {
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'inherit' });
  } catch {
    // The shared console may already be tearing down; the child decides.
  }
}