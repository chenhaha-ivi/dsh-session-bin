/**
 * dsh-workspace-bin — Host 半边入口（包根出口）。
 *
 * 真正的实现按职责拆在 `src/host/` 下：
 *   - trash.js     回收站目录、manifest、状态机、启动扫描
 *   - workspace.js 删除 / 恢复 / 永久删除工作区
 *   - session.js   删除 / 恢复会话、跨区移动事务
 *   - routes.js    /api/workspace-bin 的 plan/move/list/restore/empty
 *
 * 这个文件只做转发，保证 `dsh.bundle.patch` 里那一行的入口稳定。
 */
export { name, inject, apply } from './src/host/index.js'
