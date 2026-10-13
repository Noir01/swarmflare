import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export async function resolvePathExecutable(name: string, path = process.env.PATH ?? ''): Promise<string> {
  for (const directory of path.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      const canonical = await realpath(candidate);
      const stat = await lstat(canonical);
      if (!stat.isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { /* try the next PATH entry */ }
  }
  throw new Error(`Cannot locate executable "${name}" on PATH; install it and ensure its absolute directory is on PATH`);
}
