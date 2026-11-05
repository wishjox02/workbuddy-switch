/**
 * 关联会话入口已从 WorkBuddy 产品界面移除。
 * 保留本文件的空导出，兼容旧版本构建缓存和外部引用。
 */
export function isSessionsNavEnabled(): boolean {
  return false;
}

export function setSessionsNavEnabled(_enabled: boolean): void {
  // 旧设置不再影响 WorkBuddy 界面。
}

export function useSessionsNavEnabled(): boolean {
  return false;
}
