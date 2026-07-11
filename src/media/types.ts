// [XJC] 媒体生成类型（图像生成/对话式改图/视频生成 · T-B7）

export interface MediaStatus {
  /** 文生图已配置 */
  imageConfigured: boolean
  /** 改图（指令编辑）已配置（需 editModel） */
  imageEditConfigured: boolean
  /** 视频生成已配置 */
  videoConfigured: boolean
}

export interface MediaFileResult {
  /** 产物落盘绝对路径 */
  filePath: string
  /** 产物文件名 */
  filename: string
}

export const MEDIA_NOT_CONFIGURED = 'MEDIA_NOT_CONFIGURED'
export const MEDIA_PROVIDER_ERROR = 'MEDIA_PROVIDER_ERROR'
export const MEDIA_INVALID_INPUT = 'MEDIA_INVALID_INPUT'
export const MEDIA_AUTHORIZATION_REQUIRED = 'MEDIA_AUTHORIZATION_REQUIRED'
export const MEDIA_CALL_LIMIT = 'MEDIA_CALL_LIMIT'

export class MediaError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
