/** ProactiveAgent core 初始化选项 */
export interface ProactiveCoreOptions {
  /** 宿主 automation 标题列表提供者（suggest 去重源；Proma Electron 注入，外部宿主可不传） */
  automationTitles?: () => string[]
}
