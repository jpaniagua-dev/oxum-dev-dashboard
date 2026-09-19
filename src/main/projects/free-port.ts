import { createServer } from 'node:net';

/**
 * A port nothing is listening on, right now.
 *
 * Asked of the operating system rather than guessed: binding to port 0 makes it hand back one it
 * considers free, which is the only answer that accounts for everything else running on the machine.
 * A scan of "is 4201 free, is 4202 free" would be this plus a race, written by hand.
 *
 * **The number this returns is a hint, not a promise.** The socket is closed before the value is
 * used, so the port can be taken between the probe and the launch, and a dev server told to use a
 * busy port says so and picks another. That is why the port shown in the app is the one the process
 * **announced** (`readPort` in the output parser) and never the one that was asked for: those two
 * disagree rarely, and when they do the truth is what the process says.
 */
export async function findFreePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Puts a port into a dev server command, replacing one it already carries.
 *
 * **Replaced and not appended**, which is the whole reason this is a function rather than a string
 * concatenation. Most of these commands already say `--port 4200`; adding a second flag would make
 * the result depend on which one the CLI keeps, and that is a different answer per tool and per
 * version. A command with no port at all gets one appended, which is the only case where adding is
 * the right move.
 *
 * Pure and exported, because getting it wrong means a second dev server quietly fighting the first
 * one for a port, and the symptom is a page that loads the wrong application.
 */
export function withPort(command: string, port: number): string {
  const existing = /(--port[= ]|-p )(\d+)/;
  if (existing.test(command)) {
    return command.replace(existing, (_match, flag: string) => `${flag}${port}`);
  }
  return `${command} --port ${port}`;
}
