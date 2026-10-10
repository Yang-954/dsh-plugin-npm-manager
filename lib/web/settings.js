/**
 * Settings 面板注册 — 出现在 DSH Settings → Plugins 里
 *
 * 按 dsh-market/settings.ts 真参考 + dsh-plugin-conformance §2
 */
import { Config } from '../config.js';
export function installSettingsPanel(ctx, state) {
    return ctx.effect(() => {
        // 注册命名空间 + schema + 当前值(base 层 = 部署配置)
        const scope = ctx.settings.register('npm-manager', Config, {
            base: state.config,
        });
        // 把作用域交给 state —— 面板的写入通道（POST /settings）需要它
        state.setSettingsScope(scope);
        // 监听变化(热生效 — 不重启 DSH)
        scope.watch((next) => {
            state.updateConfig(next);
            ctx.logger.info(`[npm-manager] settings changed = ${next.scope}`);
        });
        return () => {
            state.setSettingsScope(null);
            scope.dispose?.();
        };
    }, 'npm-manager: settings panel');
}
//# sourceMappingURL=settings.js.map