import { watch, type FSWatcher } from "node:fs";

export interface Handle { close(): void }

export function watchConfig(path: string, onChange: (p: string) => void): Handle {
  const watcher: FSWatcher = watch(path);
  const timer = setInterval(() => watcher.ref(), 30_000);

  watcher.on("change", () => {
    try {
      onChange(path);
    } catch (err) {
      watcher.close();
      throw err;
    }
  });

  return {
    close() {
      watcher.close();
      clearInterval(timer);
    },
  };
}
