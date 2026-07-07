// 三套主题色常量（pptxgenjs 颜色为不带 # 的十六进制）
import type { ThemeName } from './schema.ts'

export interface ThemeColors {
  /** 内容页背景 */
  bg: string
  /** 主色：封面/结尾页背景、表头填充 */
  primary: string
  /** 主色上的文字 */
  onPrimary: string
  /** 主色上的次级文字（封面副标题等） */
  onPrimarySub: string
  /** 强调色：标题条色块、项目符号、目录编号 */
  accent: string
  /** 正文文字 */
  text: string
  /** 次级文字 */
  subText: string
  /** 浅色底（section 页背景、目录行底色） */
  band: string
  /** 表格隔行底色 */
  rowAlt: string
  /** 表格边框 */
  border: string
  /** 页脚文字 */
  footer: string
}

export const THEMES: Record<ThemeName, ThemeColors> = {
  // 深蓝商务
  business: {
    bg: 'FFFFFF',
    primary: '1F3864',
    onPrimary: 'FFFFFF',
    onPrimarySub: 'BDD0EA',
    accent: '2E75B6',
    text: '212B36',
    subText: '5A6B7B',
    band: 'EEF3FA',
    rowAlt: 'F4F8FC',
    border: 'C9D6E8',
    footer: '8A97A6',
  },
  // 黑白极简
  minimal: {
    bg: 'FFFFFF',
    primary: '111111',
    onPrimary: 'FFFFFF',
    onPrimarySub: 'BBBBBB',
    accent: '111111',
    text: '1A1A1A',
    subText: '666666',
    band: 'F5F5F5',
    rowAlt: 'F7F7F7',
    border: 'DDDDDD',
    footer: '999999',
  },
  // 品牌橘 #f97316 系
  orange: {
    bg: 'FFFFFF',
    primary: 'F97316',
    onPrimary: 'FFFFFF',
    onPrimarySub: 'FFE4CC',
    accent: 'EA580C',
    text: '44352E',
    subText: '9A7B6C',
    band: 'FFF1E6',
    rowAlt: 'FFF7ED',
    border: 'FDBA74',
    footer: 'C08457',
  },
}
