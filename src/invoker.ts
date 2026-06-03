import type { Plugin } from "obsidian";

/**
 * Install the global invoker on window.z5Linter if not present.
 * Call this once from plugin.onload().
 */
export function registerActionInvoker(plugin: Plugin) {
  if ((window as any).z5Linter) return (window as any).z5Linter;

  (window as any).z5Linter = {
    _actions: {} as Record<string, (args?: any) => Promise<any> | any>,

    register(actionName: string, fn: (args?: any) => Promise<any> | any) {
      this._actions[actionName] = fn;
    },

    async invoke(actionName: string, args?: any) {
      const fn = this._actions[actionName];
      if (!fn) throw new Error(`z5Linter: unknown action ${actionName}`);
      console.info(`[z5Linter.invoker] invoking ${actionName}`, args);
      if (typeof args === "object" && args !== null && (args as any).__forbidden) {
        throw new Error("z5Linter: forbidden args");
      }
      const res = await fn(args);
      console.info(`[z5Linter.invoker] ${actionName} returned`, res);
      return res;
    }
  };

  return (window as any).z5Linter;
}

/**
 * Ensure the invoker is present. Useful for other modules that run before plugin.onload
 * or that want a clear failure mode if the invoker wasn't registered.
 *
 * If you prefer silent auto-install, this can create a minimal invoker; here we throw
 * so callers must call registerActionInvoker() from onload.
 */
export function ensureInvokerRegistered() {
  if (!(window as any).z5Linter) {
    throw new Error("z5Linter invoker not registered. Call registerActionInvoker(plugin) in plugin.onload()");
  }
}
